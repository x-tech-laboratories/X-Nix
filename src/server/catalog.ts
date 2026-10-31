// One deployment's searchable options and packages, from its own nixpkgs pin.
//
// Generate runs the options command as a long run on the deployment's evaluating host and lands in the job history.
// Once it ends, the server fetches each file it made, keeps a compact copy in the state folder, and removes the host's
// temporary folder. NixOS and Home Manager options are kept per deployment and pin, since the flake's own modules add
// options; packages depend on the pin alone, so every deployment on one pin shares them and the search is skipped.

// ── Imports ──────────────────────────────────────────────────────────────────

import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import type { AgentPool } from "./agents/agent.ts";
import type { ActionOutcome, Deployment } from "./deployment.ts";
import { format_duration } from "./durations.ts";
import {
  cleanup_command, compact_options, compact_packages, fetch_command, nixpkgs_key, option_path, options_command, parse_generated, search, value_command,
  type OptionEntry, type OptionSource, type PackageEntry, type SearchAnswer,
} from "./nixos/options.ts";
import { timed_out_exit_code } from "./nixos/commands.ts";
import { follow } from "./runs.ts";
import type { Job, Store } from "./store.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

// What the last generation kept, as the page shows it.
export interface CatalogInfo {
  key: string;
  nixpkgs: string;
  revision: string | null;
  generated_epoch: number;
  counts: { nixos: number; home_manager: number; packages: number };
  errors: string[];
}

export interface CatalogOptions {
  store: Store;
  agents: AgentPool;
  // The folder the lists are kept in, under the state folder.
  directory: string;
  now?: () => number;
}

const fetch_timeout_in_seconds = 300;
const value_length_limit = 20_000;

// ── Catalog ──────────────────────────────────────────────────────────────────

export class Catalog {
  readonly deployment: Deployment;
  private readonly store: Store;
  private readonly agents: AgentPool;
  private readonly directory: string;
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();
  // The lists last read from disk, by file name.
  private loaded: { file: string; entries: unknown[] }[] = [];

  constructor(deployment: Deployment, options: CatalogOptions) {
    this.deployment = deployment;
    this.store = options.store;
    this.agents = options.agents;
    this.directory = options.directory;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    mkdirSync(this.directory, { recursive: true });
  }

  get id(): string {
    return this.deployment.id;
  }

  private serial<Answer>(work: () => Promise<Answer>): Promise<Answer> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  // ── Files ────────────────────────────────────────────────────────────────

  private info_file(): string {
    return join(this.directory, `catalog-${this.id}.json`);
  }

  private options_file(source: OptionSource, key: string): string {
    return join(this.directory, `${source}-${this.id}-${key}.json`);
  }

  private packages_file(key: string): string {
    return join(this.directory, `packages-${key}.json`);
  }

  info(): CatalogInfo | null {
    try {
      return JSON.parse(readFileSync(this.info_file(), "utf8")) as CatalogInfo;
    } catch {
      return null;
    }
  }

  // The pins whose packages are already kept, so a generation skips searching them.
  private cached_keys(): string[] {
    return readdirSync(this.directory).map((name) => /^packages-([a-z0-9]{32})\.json$/.exec(name)?.[1]).filter((key): key is string => key !== undefined);
  }

  private write_atomically(file: string, value: unknown): void {
    const part = `${file}.part`;
    writeFileSync(part, JSON.stringify(value));
    renameSync(part, file);
  }

  private entries<Entry>(file: string): Entry[] {
    const found = this.loaded.find((candidate) => candidate.file === file);
    if (found !== undefined) return found.entries as Entry[];
    let entries: Entry[] = [];
    try {
      entries = JSON.parse(readFileSync(file, "utf8")) as Entry[];
    } catch {
      // A list never generated reads as empty.
    }
    // Only the latest lists stay in memory: the options in use and their pin's packages.
    this.loaded = [{ file, entries }, ...this.loaded].slice(0, 3);
    return entries;
  }

  // ── Searching ────────────────────────────────────────────────────────────

  options(source: OptionSource): OptionEntry[] {
    const info = this.info();
    return info === null ? [] : this.entries<OptionEntry>(this.options_file(source, info.key));
  }

  search_options(query: string, source: OptionSource, limit: number): SearchAnswer<OptionEntry> {
    return search(this.options(source), query, (entry) => entry.name, (entry) => entry.description, limit);
  }

  search_packages(query: string, limit: number): SearchAnswer<PackageEntry> {
    const info = this.info();
    const entries = info === null ? [] : this.entries<PackageEntry>(this.packages_file(info.key));
    return search(entries, query, (entry) => entry.attribute, (entry) => `${entry.name} ${entry.description}`, limit);
  }

  option(name: string, source: OptionSource = "nixos"): OptionEntry | null {
    return this.options(source).find((entry) => entry.name === name) ?? null;
  }

  // ── Generating ───────────────────────────────────────────────────────────

  running_job(): Job | null {
    return this.store.running_job(this.id, ["options"]);
  }

  private agent_host(): string | null {
    return this.deployment.settings.eval_agent ?? this.deployment.settings.host;
  }

  // Starts generating the lists on the evaluating host, unless a generation is already running.
  generate(trigger: string): Promise<ActionOutcome> {
    return this.serial(async () => {
      if (this.running_job() !== null) return { ok: false, message: "The option lists are already being generated", job_id: null };
      const attribute = this.deployment.attribute();
      if (attribute === null) return { ok: false, message: "The host's configuration name is not known yet; name its configuration or wait for the first read", job_id: null };
      const settings = this.deployment.settings;
      const command = options_command(settings, attribute, settings.options_timeout, this.cached_keys());
      const host = this.agent_host();
      const run_id = `${this.id}-options-${this.now()}-${randomBytes(3).toString("hex")}`;
      try {
        await this.agents.get(host).start(run_id, command);
      } catch (error) {
        return { ok: false, message: `Could not start generating the option lists: ${(error as Error).message}`, job_id: null };
      }
      const job_id = this.store.create_job({ deployment_id: this.id, kind: "options", command, agent: host, run_id, trigger, started_epoch: this.now() });
      return { ok: true, message: "Generating the option lists", job_id };
    });
  }

  // Follows a running generation, and once it ends fetches and keeps what it made.
  follow(): Promise<void> {
    return this.serial(async () => {
      const job = this.running_job();
      if (job === null) return;
      const timeout = format_duration(this.deployment.settings.options_timeout);
      const followed = await follow(this.store, this.agents, job, this.now, (exit_code) => (exit_code === timed_out_exit_code ? `Timed out after ${timeout}` : null));
      if (followed.outcome !== "ended") return;
      await this.keep(this.store.job(job.id)!);
    });
  }

  private async fetch_json(host: string | null, path: string): Promise<unknown> {
    const result = await this.agents.get(host).run(fetch_command(path), fetch_timeout_in_seconds);
    if (result.exit_code !== 0) throw new Error(`could not read ${path}: ${(result.stderr || result.stdout).slice(0, 200)}`);
    return JSON.parse(gunzipSync(Buffer.from(result.stdout, "base64")).toString("utf8"));
  }

  // Fetches each file the finished generation made, keeps it, and notes what it kept in the job's output.
  private async keep(job: Job & { output: string }): Promise<void> {
    const files = parse_generated(job.output);
    const host = job.agent;
    const key = files.nixpkgs === null ? null : nixpkgs_key(files.nixpkgs);
    const notes: string[] = [];
    const errors: string[] = [];
    if (key !== null && files.nixpkgs !== null) {
      const previous = this.info();
      const counts = { nixos: 0, home_manager: 0, packages: 0 };
      const sources: [OptionSource, string | null, "nixos" | "home_manager"][] = [["nixos", files.nixos, "nixos"], ["home-manager", files.home_manager, "home_manager"]];
      for (const [source, path, count] of sources) {
        if (path === null) continue;
        try {
          const entries = compact_options(await this.fetch_json(host, path), source);
          this.write_atomically(this.options_file(source, key), entries);
          counts[count] = entries.length;
          notes.push(`Kept ${entries.length} ${source === "nixos" ? "NixOS" : "Home Manager"} options`);
        } catch (error) {
          errors.push(`${source} options: ${(error as Error).message}`);
        }
      }
      if (files.packages === "cached") {
        counts.packages = this.entries<PackageEntry>(this.packages_file(key)).length;
        notes.push(`Kept the ${counts.packages} packages already listed for this nixpkgs`);
      } else if (files.packages !== null) {
        try {
          const entries = compact_packages(await this.fetch_json(host, files.packages));
          this.write_atomically(this.packages_file(key), entries);
          counts.packages = entries.length;
          notes.push(`Kept ${entries.length} packages`);
        } catch (error) {
          errors.push(`packages: ${(error as Error).message}`);
        }
      }
      if (counts.nixos + counts.home_manager + counts.packages > 0) {
        this.loaded = [];
        this.write_atomically(this.info_file(), { key, nixpkgs: files.nixpkgs, revision: files.revision, generated_epoch: this.now(), counts, errors } satisfies CatalogInfo);
        // Lists of an earlier pin of this deployment are no longer read.
        if (previous !== null && previous.key !== key) {
          for (const source of ["nixos", "home-manager"] as const) rmSync(this.options_file(source, previous.key), { force: true });
        }
      }
    } else {
      errors.push("The generation never named its nixpkgs");
    }
    const cleanup = files.folder === null ? null : cleanup_command(files.folder);
    if (cleanup !== null) await this.agents.get(host).run(cleanup, 60);
    this.store.append_output(job.id, [...notes, ...errors.map((error) => `Could not keep ${error}`)].map((line) => `${line}\n`).join(""));
    if (errors.length > 0 && job.state === "succeeded") this.store.finish_job(job.id, "failed", job.exit_code, errors[0], this.now());
    this.store.add_event(this.id, this.now(), errors.length === 0 ? "info" : "warning", errors.length === 0 ? "Option lists generated" : `Option lists generated with errors: ${errors[0]}`);
  }

  // ── Values ───────────────────────────────────────────────────────────────

  // The option's value in the deployment's configuration as JSON, evaluated on the evaluating host.
  async current_value(name: string): Promise<{ value: string | null; error: string | null }> {
    const steps = option_path(name);
    if (steps === null) return { value: null, error: "This option names no single value" };
    const attribute = this.deployment.attribute();
    if (attribute === null) return { value: null, error: "The host's configuration name is not known yet" };
    const settings = this.deployment.settings;
    const result = await this.agents.get(this.agent_host()).run(value_command(settings, attribute, steps), settings.eval_timeout);
    if (result.exit_code !== 0) return { value: null, error: (result.stderr || result.stdout).trim().split("\n").slice(-3).join("\n").slice(0, 400) || `nix eval exited ${result.exit_code}` };
    return { value: result.stdout.trim().slice(0, value_length_limit), error: null };
  }
}

