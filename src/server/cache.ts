// One Attic cache: whether the closures a host builds for the fleet are built from the flake's latest revision and pushed.
//
// Every `interval` the building host runs one check of every tracked target as a long run that outlives a restart of the
// server; later cycles poll it every `job_poll`, and the finished run's whole output becomes the new reading. While it
// runs the previous reading stands. A target whose evaluation fails is failed; one not yet built, or not fully pushed,
// is `pending_status`. Each target can also be built or pushed by hand, one job at a time, and the job's own check of
// that target updates its row once it ends. Build all builds every target in one job, keeping how each one's build ended.

// ── Imports ──────────────────────────────────────────────────────────────────

import { randomBytes } from "node:crypto";

import { AgentError, type AgentPool } from "./agents/agent.ts";
import { record_builds } from "./builds.ts";
import { probe_cache_server, type CacheServerReading, type Fetcher } from "./cache_server.ts";
import { level_of_status, type CacheSettings, type Status } from "./config.ts";
import type { Message } from "./deployment.ts";
import {
  build_all_command, build_command, check_command, parse_report, push_command, report_mark, rows_status, target_row, targets, type Report, type TargetRow,
} from "./nixos/attic.ts";
import { timed_out_exit_code } from "./nixos/commands.ts";
import { parse_metadata } from "./nixos/flake.ts";
import { follow } from "./runs.ts";
import type { Job, JobKind, JobWithOutput, Store } from "./store.ts";
import { format_duration } from "./durations.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export type CacheActionId = "build" | "push";

export const cache_action_ids: CacheActionId[] = ["build", "push"];

// How the last Build all ended for each target: ok, failed, push_failed, eval_failed or not_reported.
export interface BuildAllOutcome {
  job_id: number;
  finished_epoch: number;
  results: { name: string; result: string; seconds: number | null }[];
}

// What the last finished check found.
export interface CacheReading {
  status: Status;
  checked_epoch: number;
  messages: Message[];
  revision: string | null;
  rows: TargetRow[];
  // Absent from readings saved before Build all existed.
  build_all?: BuildAllOutcome | null;
}

export interface CacheActionOutcome {
  ok: boolean;
  message: string;
  job_id: number | null;
}

export interface CacheOptions {
  store: Store;
  agents: AgentPool;
  // The time in seconds, which tests set.
  now?: () => number;
  // How the cache server's endpoints are fetched, which tests set.
  fetch?: Fetcher;
}

const cache_job_kinds: JobKind[] = ["check", "build-target", "build-all", "push"];

const action_kinds: Record<CacheActionId, JobKind> = { build: "build-target", push: "push" };

const action_words: Record<CacheActionId, string> = { build: "Build", push: "Push" };

// ── Cache ────────────────────────────────────────────────────────────────────

export class Cache {
  readonly settings: CacheSettings;
  private readonly store: Store;
  private readonly agents: AgentPool;
  private readonly now: () => number;
  private readonly fetcher: Fetcher;
  // Cycles and actions run one at a time.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(settings: CacheSettings, options: CacheOptions) {
    this.settings = settings;
    this.store = options.store;
    this.agents = options.agents;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.fetcher = options.fetch ?? fetch;
  }

  get id(): string {
    return this.settings.id;
  }

  reading(): CacheReading | null {
    return this.store.cache_reading<CacheReading>(this.id);
  }

  server_reading(): CacheServerReading | null {
    return this.store.cache_server_reading<CacheServerReading>(this.id);
  }

  running_job(): Job | null {
    return this.store.running_job(this.id, cache_job_kinds);
  }

  // Whether the cache is waiting on a long run, so the poller looks again sooner.
  busy(): boolean {
    return this.running_job() !== null;
  }

  // Why an action cannot run on this target now, or null when it can.
  action_refusal(action: CacheActionId, name: string): string | null {
    if (!targets(this.settings).some(([tracked]) => tracked === name)) return `'${name}' is not a tracked target`;
    if (action === "push") {
      if (this.settings.push_command === null) return "No push_command is set, so X-Nix cannot push";
      const row = this.reading()?.rows.find((candidate) => candidate.name === name);
      if (row?.built !== true) return `${name} is not built from the latest flake, so there is nothing to push`;
      if (!row.local) return `${name} is kept only in the cache, so there is nothing here to push; build it again`;
    }
    if (this.running_job() !== null) return "A job is already running for this cache";
    return null;
  }

  // Why Build all cannot run now, or null when it can.
  build_all_refusal(): string | null {
    return this.running_job() === null ? null : "A job is already running for this cache";
  }

  // ── Cycle ────────────────────────────────────────────────────────────────

  // Follows the running job, or starts a check when none runs, and reads the cache server's endpoints beside either.
  cycle(): Promise<void> {
    return this.serial(async () => {
      const job = this.running_job();
      await Promise.all([job !== null ? this.poll_job(job) : this.launch_check(), this.probe_server()]);
    });
  }

  // Saves what the cache server's endpoints answered, noting a change of their status once one was known.
  private async probe_server(): Promise<void> {
    const reading = await probe_cache_server(this.settings, this.fetcher, this.now());
    if (reading === null) return;
    const previous = this.server_reading();
    this.store.save_cache_server_reading(this.id, reading);
    if (previous === null || previous.status === reading.status) return;
    const level = level_of_status[reading.status];
    const reason = reading.messages.find((message) => message.level === level && level !== "info");
    this.store.add_event(this.id, reading.checked_epoch, level, `Cache server now ${reading.status}${reason ? `: ${reason.text}` : ""}`);
  }

  private serial<Answer>(work: () => Promise<Answer>): Promise<Answer> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  private async launch_check(): Promise<void> {
    const launched = await this.launch("check", check_command(this.settings));
    if (launched.job_id === null) this.save_unavailable(`Could not start the check: ${launched.error}`);
  }

  private async poll_job(job: Job): Promise<void> {
    const timed_out = (exit_code: number) => (exit_code === timed_out_exit_code && job.kind === "check" ? `Timed out after ${format_duration(this.settings.timeout)}` : null);
    const followed = await follow(this.store, this.agents, job, this.now, timed_out);
    if (followed.outcome === "unreachable") {
      this.store.add_event(this.id, this.now(), "warning", `Could not poll the running ${job.kind}: ${followed.error}`);
      return;
    }
    const finished = this.store.job(job.id)!;
    const report = parse_report(finished.output);
    // The last line is often a report line, which says nothing to a person.
    const last_line = finished.output.split("\n").map((text) => text.trim()).filter((text) => text !== "" && !text.startsWith(report_mark)).pop();
    if (job.kind === "check") this.store.set_progress(job.id, `${report.targets.size} of ${targets(this.settings).length} targets evaluated`);
    else if (last_line !== undefined) this.store.set_progress(job.id, last_line);
    if (followed.outcome === "running") return;

    if (job.kind === "check") {
      if (report.targets.size === 0) {
        const tail = finished.output.trim().slice(-200);
        return this.save_unavailable(`Could not check the tracked targets: ${tail || finished.error || "no output"}`);
      }
      const rows = targets(this.settings).map(([name]) => target_row(this.settings, name, report.targets.get(name)));
      const revision = report.metadata === null ? null : parse_metadata(report.metadata)?.revision ?? null;
      const extra: Message[] = finished.error === null ? [] : [{ level: "warning", text: `The check ended badly: ${finished.error}` }];
      this.save_rows(rows, revision ?? this.reading()?.revision ?? null, extra);
      return;
    }

    if (job.kind === "build-all") return this.finish_build_all(finished, report);
    if (job.kind === "build-target") {
      const attempted = [...report.targets].map(([built_name, facts]) => ({ target: built_name, store_path: facts.target ?? null, succeeded: finished.state === "succeeded" }));
      await record_builds(this.store, this.agents, finished, attempted, this.now());
    }

    // A build or push names its target in its report; with no report it changed nothing that can be read.
    const [name] = report.targets.keys();
    const word = job.kind === "push" ? "Push" : "Build";
    const what = name === undefined ? word : `${word} of ${name}`;
    if (finished.state === "succeeded") this.store.add_event(this.id, this.now(), "info", `${what} finished`);
    else this.store.add_event(this.id, this.now(), "error", `${what} failed: ${finished.error}`);
    const previous = this.reading();
    if (name === undefined || previous === null) return;
    const rows = previous.rows.map((row) => (report.targets.has(row.name) ? target_row(this.settings, row.name, report.targets.get(row.name)) : row));
    this.save_rows(rows, previous.revision, []);
  }

  // Updates every row Build all reported on, keeps how each target's build ended, and records each in the build history.
  private async finish_build_all(job: JobWithOutput, report: Report): Promise<void> {
    const results = targets(this.settings).map(([name]) => {
      const facts = report.targets.get(name);
      const seconds = facts?.build_seconds === undefined ? null : Number(facts.build_seconds);
      return { name, result: facts?.build ?? "not_reported", seconds: seconds !== null && Number.isFinite(seconds) ? seconds : null };
    });
    const built = `${results.filter((result) => result.result === "ok").length} of ${results.length} targets built`;
    if (job.state === "succeeded") this.store.add_event(this.id, this.now(), "info", `Build all finished: ${built}`);
    else this.store.add_event(this.id, this.now(), "error", `Build all failed: ${built}; ${job.error}`);
    const previous = this.reading();
    const rows = targets(this.settings).map(([name]) => report.targets.has(name)
      ? target_row(this.settings, name, report.targets.get(name))
      : previous?.rows.find((row) => row.name === name) ?? target_row(this.settings, name, undefined));
    this.save_rows(rows, previous?.revision ?? null, [], { job_id: job.id, finished_epoch: this.now(), results });
    const attempted = results.filter((result) => result.result !== "not_reported").map((result) => ({
      target: result.name, store_path: report.targets.get(result.name)?.target ?? null, succeeded: result.result === "ok",
    }));
    await record_builds(this.store, this.agents, job, attempted, this.now());
  }

  // Saves a whole set of rows with their counts and worst-of status, keeping the last Build all unless given a new one.
  private save_rows(rows: TargetRow[], revision: string | null, extra: Message[], build_all: BuildAllOutcome | null = this.reading()?.build_all ?? null): void {
    const built = rows.filter((row) => row.built === true).length;
    const pushed = rows.filter((row) => row.pushed_ok).length;
    const messages: Message[] = [{ level: "info", text: `${built} of ${rows.length} targets built, ${pushed} fully pushed` }];
    for (const row of rows) if (row.status !== "online") messages.push({ level: level_of_status[row.status], text: `${row.name}: ${row.summary}` });
    messages.push(...extra);
    this.save_reading({ status: rows_status(rows), checked_epoch: this.now(), messages, revision, rows, build_all });
  }

  private save_unavailable(text: string): void {
    const previous = this.reading();
    this.save_reading({
      status: "unavailable", checked_epoch: this.now(), messages: [{ level: "warning", text }],
      revision: previous?.revision ?? null, rows: previous?.rows ?? [], build_all: previous?.build_all ?? null,
    });
  }

  // Saves the reading, noting a change of status as an event.
  private save_reading(reading: CacheReading): void {
    const previous = this.reading();
    this.store.save_cache_reading(this.id, reading);
    if (previous?.status === reading.status) return;
    const level = level_of_status[reading.status];
    const reason = reading.messages.find((message) => message.level === level && level !== "info");
    this.store.add_event(this.id, reading.checked_epoch, level, reason ? `Now ${reading.status}: ${reason.text}` : `Now ${reading.status}`);
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  act(action: CacheActionId, name: string): Promise<CacheActionOutcome> {
    return this.serial(async () => {
      const refusal = this.action_refusal(action, name);
      if (refusal !== null) return { ok: false, message: refusal, job_id: null };
      const row = this.reading()?.rows.find((candidate) => candidate.name === name);
      const command = action === "build" ? build_command(this.settings, name) : push_command(this.settings, name, row!.target!);
      const what = `${action_words[action]} of ${name}`;
      const launched = await this.launch(action_kinds[action], command);
      if (launched.job_id === null) {
        this.store.add_event(this.id, this.now(), "error", `Could not start the ${what.toLowerCase()}: ${launched.error}`);
        return { ok: false, message: `Could not start the ${what.toLowerCase()}: ${launched.error}`, job_id: null };
      }
      this.store.add_event(this.id, this.now(), "info", `${what} started`);
      return { ok: true, message: `${what} started`, job_id: launched.job_id };
    });
  }

  // Evaluates every target in one pass and builds each as soon as it is evaluated, pushing it when there is a push_command.
  build_all(): Promise<CacheActionOutcome> {
    return this.serial(async () => {
      const refusal = this.build_all_refusal();
      if (refusal !== null) return { ok: false, message: refusal, job_id: null };
      const launched = await this.launch("build-all", build_all_command(this.settings));
      if (launched.job_id === null) {
        this.store.add_event(this.id, this.now(), "error", `Could not start Build all: ${launched.error}`);
        return { ok: false, message: `Could not start Build all: ${launched.error}`, job_id: null };
      }
      this.store.add_event(this.id, this.now(), "info", "Build all started");
      return { ok: true, message: "Build all started", job_id: launched.job_id };
    });
  }

  private async launch(kind: JobKind, command: string): Promise<{ job_id: number | null; error: string }> {
    const run_id = `${this.id}-${kind}-${this.now()}-${randomBytes(3).toString("hex")}`;
    try {
      await this.agents.get(this.settings.host).start(run_id, command);
    } catch (error) {
      return { job_id: null, error: error instanceof AgentError ? error.message : String(error) };
    }
    const trigger = kind === "check" ? "schedule" : "manual";
    return { job_id: this.store.create_job({ deployment_id: this.id, kind, command, agent: this.settings.host, run_id, trigger, started_epoch: this.now() }), error: "" };
  }
}
