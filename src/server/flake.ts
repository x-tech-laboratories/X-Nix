// One flake: its lock's inputs and how old they are, and the Update that moves them on, for every deployment and cache naming it.
//
// Every `interval` the flake's host reads `nix flake metadata`, which gives the revision, when the flake last changed and
// each locked input. Update runs as a long run on that host that outlives a restart of the server: a local checkout's
// lock is written in place, and a github: flake with a `push_ssh_key` is cloned, updated and pushed back. With
// `update_at` it also runs daily. Once an update ends well, or a read finds the flake changed since the last one, every
// deployment and cache naming the flake evaluates afresh.

// ── Imports ──────────────────────────────────────────────────────────────────

import { randomBytes } from "node:crypto";

import { AgentError, type AgentPool } from "./agents/agent.ts";
import { level_of_status, worse, type FlakeSettings, type Status } from "./config.ts";
import { latest_slot, type Message } from "./deployment.ts";
import { format_age, format_duration } from "./durations.ts";
import { can_update, metadata_operation, update_operation } from "./nixos/commands.ts";
import { parse_metadata, short_revision, type LockedInput } from "./nixos/flake.ts";
import { follow, start_run, track_wake } from "./runs.ts";
import type { Job, Store } from "./store.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export type FlakeActionId = "update";

// What the last read of the flake found.
export interface FlakeReading {
  status: Status;
  checked_epoch: number;
  messages: Message[];
  revision: string | null;
  last_modified_epoch: number | null;
  oldest_input: string | null;
  inputs_last_modified_epoch: number | null;
  inputs: LockedInput[];
  // Why the last read failed, or null when it worked.
  metadata_error: string | null;
}

// How the last update ended.
export interface UpdateOutcome {
  job_id: number;
  succeeded: boolean;
  finished_epoch: number;
  // Its last line: the commit it pushed, or that every input was already current.
  summary: string;
}

// What the flake remembers between cycles.
export interface FlakeState {
  // The last daily update slot handled.
  scheduled_update?: number;
  last_update?: UpdateOutcome;
}

export interface FlakeActionOutcome {
  ok: boolean;
  message: string;
  job_id: number | null;
}

export interface FlakeOptions {
  store: Store;
  agents: AgentPool;
  // Tells every deployment and cache naming the flake to evaluate afresh, once an update or a push has changed it.
  on_updated?: (flake: Flake) => void;
  // The time in seconds, which tests set.
  now?: () => number;
}

const flake_job_kinds: Job["kind"][] = ["update"];

// ── Flake ────────────────────────────────────────────────────────────────────

export class Flake {
  readonly settings: FlakeSettings;
  private readonly store: Store;
  private readonly agents: AgentPool;
  private readonly on_updated: (flake: Flake) => void;
  private readonly now: () => number;
  // Cycles and actions run one at a time.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(settings: FlakeSettings, options: FlakeOptions) {
    this.settings = settings;
    this.store = options.store;
    this.agents = options.agents;
    this.on_updated = options.on_updated ?? (() => {});
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  get id(): string {
    return this.settings.id;
  }

  reading(): FlakeReading | null {
    return this.store.reading<FlakeReading>(this.id);
  }

  state(): FlakeState {
    return this.store.evaluation<FlakeState>(this.id) ?? {};
  }

  running_job(): Job | null {
    return this.store.running_job(this.id, flake_job_kinds);
  }

  // Whether the flake is waiting on a long run, so the poller looks again sooner.
  busy(): boolean {
    return this.running_job() !== null;
  }

  // Why Update cannot run now, or null when it can.
  update_refusal(): string | null {
    if (!can_update(this.settings)) {
      return `Cannot update ${this.settings.url}: only a local checkout, or a github: flake with a push_ssh_key, has a lock file X-Nix can write`;
    }
    if (this.running_job() !== null) return "An update is already running for this flake";
    return null;
  }

  // ── Cycle ────────────────────────────────────────────────────────────────

  // Follows the running update, starts a daily one that is due, or reads the flake's metadata.
  cycle(): Promise<void> {
    return this.serial(async () => {
      const job = this.running_job();
      if (job !== null) return this.poll_job(job);
      const slot = this.update_due();
      if (slot !== null) return this.launch_scheduled(slot);
      if (await this.read()) this.on_updated(this);
    });
  }

  private serial<Answer>(work: () => Promise<Answer>): Promise<Answer> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  // Reads the metadata and lock, keeping the last good values when the read fails, and answers whether the flake changed
  // since the last good read.
  private async read(): Promise<boolean> {
    const result = await this.agents.get(this.settings.host).run(metadata_operation(this.settings), this.settings.timeout);
    const metadata = result.exit_code === 0 ? parse_metadata(result.stdout) : null;
    const previous = this.reading();
    const timed_out = result.exit_code === -1 && result.stderr.startsWith("Timed out") ? `Timed out after ${format_duration(this.settings.timeout)}` : null;
    const error = metadata !== null ? null : timed_out ?? (clip(result.stderr || result.stdout, 400) || `nix flake metadata exited ${result.exit_code}`);
    this.save_reading({
      status: "online",
      checked_epoch: this.now(),
      messages: [],
      revision: metadata?.revision ?? previous?.revision ?? null,
      last_modified_epoch: metadata?.last_modified_epoch ?? previous?.last_modified_epoch ?? null,
      oldest_input: metadata?.oldest_input ?? previous?.oldest_input ?? null,
      inputs_last_modified_epoch: metadata?.inputs_last_modified_epoch ?? previous?.inputs_last_modified_epoch ?? null,
      inputs: metadata?.inputs ?? previous?.inputs ?? [],
      metadata_error: error,
    });
    return metadata !== null && previous !== null
      && (metadata.revision !== previous.revision || metadata.last_modified_epoch !== previous.last_modified_epoch);
  }

  // Judges the reading's status and messages from its facts and the last update, then saves it.
  private save_reading(facts: FlakeReading): void {
    const now = this.now();
    const messages: Message[] = [];
    let status: Status = "online";
    const raise = (next: Status) => (status = worse(status, next));
    if (facts.metadata_error !== null) {
      raise("unavailable");
      messages.push({ level: "warning", text: `Could not read the flake: ${facts.metadata_error}` });
    }
    if (facts.last_modified_epoch !== null) {
      const at = facts.revision ? ` at ${short_revision(facts.revision)}` : "";
      messages.push({ level: "info", text: `Last changed ${format_age(now - facts.last_modified_epoch)}${at}` });
    }
    if (facts.inputs_last_modified_epoch !== null) {
      const age = now - facts.inputs_last_modified_epoch;
      const stale = this.settings.max_input_age !== null && age > this.settings.max_input_age;
      if (stale) raise("warning");
      messages.push({
        level: stale ? "warning" : "info",
        text: `Oldest locked input ${facts.oldest_input ?? "?"} is ${format_age(age)}${stale ? `, over the ${format_duration(this.settings.max_input_age!)} limit` : ""}`,
      });
    }
    const last = this.state().last_update;
    if (last !== undefined && !last.succeeded) {
      raise("warning");
      messages.push({ level: "warning", text: `The last update failed ${format_age(now - last.finished_epoch)}: ${last.summary}` });
    }
    if (this.settings.update_at !== null && !can_update(this.settings)) {
      raise("warning");
      messages.push({ level: "warning", text: `Scheduled update never runs: ${this.settings.url} has no lock file X-Nix can write` });
    }
    const reading = { ...facts, status, messages };
    const previous = this.reading();
    this.store.save_reading(this.id, reading);
    if (previous?.status === reading.status) return;
    const level = level_of_status[reading.status];
    const reason = messages.find((message) => message.level === level && level !== "info");
    this.store.add_event(this.id, reading.checked_epoch, level, reason ? `Now ${reading.status}: ${reason.text}` : `Now ${reading.status}`);
  }

  // ── Daily update ─────────────────────────────────────────────────────────

  // The latest daily slot when it is newer than the one last handled; a schedule seen for the first time starts at its next slot.
  update_due(): number | null {
    if (this.settings.update_at === null || !can_update(this.settings)) return null;
    const slot = latest_slot(this.settings.update_at, this.now());
    const state = this.state();
    if (state.scheduled_update === undefined) {
      this.store.save_evaluation(this.id, { ...state, scheduled_update: slot });
      return null;
    }
    return slot > state.scheduled_update ? slot : null;
  }

  private async launch_scheduled(slot: number): Promise<void> {
    const launched = await this.launch("schedule");
    // A host that never answered started nothing, so a later cycle may try again.
    if (launched.unreachable) {
      this.store.add_event(this.id, this.now(), "warning", `Could not start the scheduled update: ${launched.error}`);
      return;
    }
    this.store.save_evaluation(this.id, { ...this.state(), scheduled_update: slot });
    if (launched.job_id === null) this.record_failed_launch("schedule", launched.error);
    else this.store.add_event(this.id, this.now(), "info", "Scheduled update started");
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  // Updates the flake's lock, naming in the job what started it.
  update(trigger = "manual"): Promise<FlakeActionOutcome> {
    return this.serial(async () => {
      const refusal = this.update_refusal();
      if (refusal !== null) return { ok: false, message: refusal, job_id: null };
      const launched = await this.launch(trigger);
      if (launched.job_id === null) {
        const job_id = this.record_failed_launch(trigger, launched.error);
        return { ok: false, message: `Could not start the update: ${launched.error}`, job_id };
      }
      this.store.add_event(this.id, this.now(), "info", "Update started");
      return { ok: true, message: "Update started", job_id: launched.job_id };
    });
  }

  // ── Jobs ─────────────────────────────────────────────────────────────────

  private async launch(trigger: string): Promise<{ job_id: number | null; error: string; unreachable: boolean }> {
    const operation = update_operation(this.settings);
    const run_id = `${this.id}-update-${this.now()}-${randomBytes(3).toString("hex")}`;
    let waking: Promise<void> | null;
    try {
      ({ waking } = await start_run(this.agents, this.settings.host, run_id, operation));
    } catch (error) {
      const unreachable = error instanceof AgentError && error.unreachable;
      return { job_id: null, error: (error as Error).message, unreachable };
    }
    const job_id = this.store.create_job({ deployment_id: this.id, kind: "update", command: JSON.stringify(operation), agent: this.settings.host, run_id, trigger, started_epoch: this.now() });
    if (waking !== null) {
      track_wake(this.store, job_id, this.settings.host ?? this.agents.own_host, waking, this.now, (error) => {
        this.store.add_event(this.id, this.now(), "error", `Could not start the update: ${error}`);
      });
    }
    return { job_id, error: "", unreachable: false };
  }

  // Keeps an update that could not start in the history, with why.
  private record_failed_launch(trigger: string, error: string): number {
    const job_id = this.store.create_job({
      deployment_id: this.id, kind: "update", command: JSON.stringify(update_operation(this.settings)), agent: this.settings.host, run_id: null, trigger, started_epoch: this.now(),
    });
    this.store.append_output(job_id, `${error}\n`);
    this.store.finish_job(job_id, "failed", null, "The job could not be started", this.now());
    this.store.add_event(this.id, this.now(), "error", `Could not start the update: ${error}`);
    return job_id;
  }

  private async poll_job(job: Job): Promise<void> {
    const followed = await follow(this.store, this.agents, job, this.now);
    if (followed.outcome === "unreachable") {
      this.store.add_event(this.id, this.now(), "warning", `Could not poll the running update: ${followed.error}`);
      return;
    }
    const finished = this.store.job(job.id)!;
    const last_line = finished.output.split("\n").map((line) => line.trim()).filter(Boolean).pop() ?? "";
    if (last_line !== "") this.store.set_progress(job.id, last_line);
    if (followed.outcome === "running") return;
    const succeeded = finished.state === "succeeded";
    const summary = succeeded ? last_line || "Finished" : finished.error ?? "The update failed";
    this.store.save_evaluation(this.id, { ...this.state(), last_update: { job_id: job.id, succeeded, finished_epoch: this.now(), summary } });
    this.store.add_event(this.id, this.now(), succeeded ? "info" : "error", succeeded ? `Update finished: ${summary}` : `Update failed: ${summary}`);
    const changed = await this.read();
    if (succeeded || changed) this.on_updated(this);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function clip(text: string, length: number): string {
  return text.trim().slice(0, length);
}
