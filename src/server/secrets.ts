// Uploads each deployment's secrets to its host outside the Nix store, into /run/keys, through the host's agent.
//
// A secret's value is read from its source file on this server only to upload or check it, and is never stored, logged
// or shown: it travels to the agent inside one request, and the agent's key writer takes it on stdin and puts it in
// place with its owner, group and mode. A check sends a fresh salt and compares the salted hash the host returns with
// the source's, so the value never travels back. Jobs and the page carry only names, sizes, paths, owners and modes.

// ── Imports ──────────────────────────────────────────────────────────────────

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import type { AgentPool, KeyState } from "./agents/agent.ts";
import type { SecretSettings } from "./config.ts";
import type { ActionOutcome, Deployment } from "./deployment.ts";
import type { Store } from "./store.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

// How the copy on the host compares with the source: unknown when either could not be read.
export type KeyCondition = "current" | "stale" | "missing" | "unknown";

export interface SecretView {
  name: string;
  source: string;
  destination: string;
  owner: string;
  group: string;
  mode: string;
  // The source's size in bytes, or null when it could not be read.
  source_size: number | null;
  source_error: string | null;
  on_host: KeyCondition;
  // What differs on the host, in words, such as its owner or mode.
  difference: string | null;
}

export interface SecretsReading {
  checked_epoch: number;
  // Why the host could not be read, or null when it was.
  error: string | null;
  secrets: SecretView[];
}

export interface SecretsOptions {
  store: Store;
  agents: AgentPool;
  now?: () => number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function read_source(secret: SecretSettings): { content: Buffer | null; error: string | null } {
  try {
    return { content: readFileSync(secret.source), error: null };
  } catch (error) {
    return { content: null, error: (error as NodeJS.ErrnoException).code ?? "unreadable" };
  }
}

function salted_hash(salt: string, content: Buffer): string {
  return createHash("sha256").update(salt).update(content).digest("hex");
}

// What differs between the source and the copy on the host, in words, or null when nothing does.
export function key_difference(secret: SecretSettings, state: KeyState, expected_hash: string): string | null {
  const differences: string[] = [];
  if (state.salted_hash !== expected_hash) differences.push("contents");
  if (state.owner !== secret.owner) differences.push(`owner ${state.owner}`);
  if (state.group !== secret.group) differences.push(`group ${state.group}`);
  if (state.mode === null || Number.parseInt(state.mode, 8) !== Number.parseInt(secret.mode, 8)) differences.push(`mode ${state.mode}`);
  return differences.length === 0 ? null : `Differs on the host: ${differences.join(", ")}`;
}

function describe(secret: SecretSettings, size: number): string {
  return `${secret.name} to ${secret.destination} (${size} bytes, ${secret.owner}:${secret.group} ${secret.mode})`;
}

// ── Secrets ──────────────────────────────────────────────────────────────────

export class Secrets {
  private readonly store: Store;
  private readonly agents: AgentPool;
  private readonly now: () => number;
  private readonly readings = new Map<string, SecretsReading>();
  // Checks and uploads of one deployment run one at a time.
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(options: SecretsOptions) {
    this.store = options.store;
    this.agents = options.agents;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  // The last check of the deployment's secrets, or null before the first.
  reading(deployment: Deployment): SecretsReading | null {
    return this.readings.get(deployment.id) ?? null;
  }

  private serial<Answer>(deployment: Deployment, work: () => Promise<Answer>): Promise<Answer> {
    const next = (this.queues.get(deployment.id) ?? Promise.resolve()).then(work, work);
    this.queues.set(deployment.id, next.catch(() => {}));
    return next;
  }

  // ── Checking ─────────────────────────────────────────────────────────────

  check(deployment: Deployment): Promise<SecretsReading> {
    return this.serial(deployment, () => this.check_now(deployment));
  }

  private async check_now(deployment: Deployment): Promise<SecretsReading> {
    const secrets = deployment.settings.secrets;
    const salt = randomBytes(16).toString("hex");
    const sources = secrets.map(read_source);
    let states: KeyState[] | null = null;
    let error: string | null = null;
    try {
      states = await this.agents.get(deployment.settings.host).check_keys(secrets.map((secret) => secret.destination), salt, deployment.settings.require_sudo);
    } catch (failure) {
      error = (failure as Error).message;
    }
    const views = secrets.map((secret, index): SecretView => {
      const { content, error: source_error } = sources[index];
      const view: SecretView = {
        name: secret.name, source: secret.source, destination: secret.destination, owner: secret.owner, group: secret.group, mode: secret.mode,
        source_size: content?.length ?? null, source_error, on_host: "unknown", difference: null,
      };
      const state = states?.[index];
      if (state === undefined) return view;
      if (!state.present) return { ...view, on_host: "missing" };
      if (content === null) return view;
      const difference = key_difference(secret, state, salted_hash(salt, content));
      return { ...view, on_host: difference === null ? "current" : "stale", difference };
    });
    const reading = { checked_epoch: this.now(), error, secrets: views };
    this.readings.set(deployment.id, reading);
    return reading;
  }

  // ── Uploading ────────────────────────────────────────────────────────────

  // Uploads the deployment's secrets, or with only_needed just those missing or stale, keeping a job when any is written.
  upload(deployment: Deployment, trigger: string, only_needed = false): Promise<ActionOutcome> {
    return this.serial(deployment, async () => {
      const secrets = deployment.settings.secrets;
      if (secrets.length === 0) return { ok: false, message: "This deployment declares no secrets", job_id: null };
      let chosen = secrets;
      if (only_needed) {
        const reading = await this.check_now(deployment);
        if (reading.error !== null) return { ok: false, message: `Could not check the secrets: ${reading.error}`, job_id: null };
        const needed = new Set(reading.secrets.filter((view) => view.on_host === "missing" || view.on_host === "stale").map((view) => view.name));
        chosen = secrets.filter((secret) => needed.has(secret.name));
        if (chosen.length === 0) return { ok: true, message: "Every secret is already on the host", job_id: null };
      }
      return this.write(deployment, chosen, trigger);
    });
  }

  private async write(deployment: Deployment, secrets: SecretSettings[], trigger: string): Promise<ActionOutcome> {
    const host = deployment.settings.host;
    const agent = this.agents.get(host);
    const job_id = this.store.create_job({
      deployment_id: deployment.id, kind: "secrets", command: `Upload ${secrets.map((secret) => `${secret.name} to ${secret.destination}`).join(", ")}`,
      agent: host, run_id: null, trigger, started_epoch: this.now(),
    });
    const failed: string[] = [];
    for (const secret of secrets) {
      const { content, error } = read_source(secret);
      if (content === null) {
        failed.push(secret.name);
        this.store.append_output(job_id, `Could not read the source of ${secret.name}, ${secret.source}: ${error}\n`);
        continue;
      }
      try {
        const result = await agent.write_key({
          destination: secret.destination, owner: secret.owner, group: secret.group, mode: secret.mode, content_base64: content.toString("base64"),
          sudo: deployment.settings.require_sudo,
        });
        if (result.exit_code !== 0) throw new Error(`the key writer exited ${result.exit_code}: ${(result.stderr || result.stdout).slice(0, 300)}`);
        this.store.append_output(job_id, `Wrote ${describe(secret, content.length)}\n`);
      } catch (failure) {
        failed.push(secret.name);
        this.store.append_output(job_id, `Could not write ${secret.name}: ${(failure as Error).message}\n`);
      }
    }
    const ok = failed.length === 0;
    this.store.finish_job(job_id, ok ? "succeeded" : "failed", null, ok ? null : `Could not upload ${failed.join(", ")}`, this.now());
    const message = ok ? `Uploaded ${secrets.length} secret${secrets.length === 1 ? "" : "s"}` : `Could not upload ${failed.join(", ")}`;
    this.store.add_event(deployment.id, this.now(), ok ? "info" : "error", message);
    await this.check_now(deployment);
    return { ok, message, job_id };
  }
}
