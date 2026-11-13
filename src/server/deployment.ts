// One NixOS deployment: whether the running system is the one its flake evaluates to, and the jobs that bring it there.
//
// Every cycle reads the host's running system, booted system, generation and version with one cheap read. Every
// `eval_interval` it also evaluates the host's toplevel from the flake and reads `nix flake metadata`, as one long run
// that outlives a restart of the server; later cycles poll it and judge drift against the stored evaluation until it
// ends. A failed evaluation is retried after `retry_interval`. Build and switch run as long runs on the agent the
// settings name, one at a time, and every action lands in the job history with its output. With `auto_switch`, drift
// lasting `auto_switch_after` starts a switch once per target closure, and `build_at` starts a daily build. Updating
// the flake's lock is the flake's own job (see flake.ts).
// The store, boot entries and reboot are the host's own (see host.ts). A pin, from the settings
// or set on the page, fixes evaluation, build and switch at one commit or tag instead of the branch head.
//
// A switch runs in one of nixos-rebuild's modes, from the cache with switch_from_cache, and with pre_switch_checks,
// health checks or magic_rollback it runs guarded (see nixos/switch.ts): while it waits for confirmation, each poll runs
// the HTTP checks and confirms, and once it ends its marker lines say whether it was refused or rolled back and why.
// A switch, started by a person, a fleet run or the drift, first runs what it depends on, and its job shows each step
// before its own run starts. A switch from the cache with no evaluation evaluates first; one whose system the cache lacks
// has the cache that tracks the host build and push it, or else builds on the build agents and, when that is another
// host, waits for the system to reach the cache. A plain switch builds on the build agents first only when they are
// another host and a cache carries the result back; otherwise nixos-rebuild builds it itself. Only the automatic switch
// does so: a direct action, which the API, and so the page, MCP and fleet runs, ask for, never waits on a cache. Build runs
// on the build agents and a switch runs nixos-rebuild, ending a switch that still waits, while any cache build runs on.
// Rollback activates any earlier generation of the system profile. Before a switch the page asks for the package diff between the running and the built closure,
// which runs as a job and is kept with the evaluation, and the closure browser reads any generation's dependency graph.
// A Build with build_progress reads nix's structured log into counts of what is building and downloading.

// ── Imports ──────────────────────────────────────────────────────────────────

import { randomBytes } from "node:crypto";

import { format_age, format_duration } from "@x-tech-laboratories/x-libs/durations";

import { AgentError, type AgentPool, type RunResult } from "./agents/agent.ts";
import { built_store_path, record_builds } from "./builds.ts";
import type { Cache } from "./cache.ts";
import type { Host } from "./host.ts";
import { parse_report } from "./nixos/attic.ts";
import { level_of_status, worse, type DeploymentSettings, type Status, type TimeOfDay } from "./config.ts";
import { empty_progress, read_build_log, summarise, type BuildProgress } from "./nixos/build_log.ts";
import {
  closure_operation, closure_size_operation, closure_sizes, diff_operation, is_store_path, parse_closure, parse_diff, type ClosureDiff, type ClosureTree,
} from "./nixos/closure.ts";
import {
  build_operation, cache_holds_operation, eval_operation, split_eval_output, switch_modes, timed_out_exit_code, type SwitchMode,
} from "./nixos/commands.ts";
import {
  confirm_operation, generations_operation, parse_generations, rollback_operation, rollback_signal_operation, switch_job_operation, switch_verdict, watch_token,
  type Generation,
} from "./nixos/switch.ts";
import { is_pin, parse_metadata, pinned_flake, short_revision } from "./nixos/flake.ts";
import { parse_probe, probe_operation, reboot_required, type ProbeFields } from "./nixos/probe.ts";
import { overdue_text } from "./overdue.ts";
import { follow, start_run, track_wake, type Followed, type Translate } from "./runs.ts";
import type { EventLevel, Job, JobKind, Store } from "./store.ts";
import { operation_of, type Operation } from "../shared/operations.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export type ScheduledKind = "build";
export type ActionId = "build" | "switch" | "reboot" | "boot" | "test" | "dry-activate";

export const action_ids: ActionId[] = ["build", "switch", "reboot", "boot", "test", "dry-activate"];

// The actions that run as a job of their own kind.
type JobAction = Exclude<ActionId, "reboot">;

// The last evaluation and what the deployment remembers between cycles.
export interface Evaluation {
  evaluated_epoch: number | null;
  target: string | null;
  eval_error: string | null;
  // The evaluating host never answered, which measures nothing, unlike an evaluation that ran and failed.
  eval_unreachable: boolean;
  metadata_error: string | null;
  flake_revision: string | null;
  flake_last_modified_epoch: number | null;
  oldest_input: string | null;
  inputs_last_modified_epoch: number | null;
  drift_target: string | null;
  drift_since_epoch: number | null;
  auto_switch_target: string | null;
  // The last slot of each daily job that has been handled.
  scheduled: Partial<Record<ScheduledKind, number>>;
  // The pin set on the page, null to follow the branch head, or absent to use the settings' pin.
  pin_override?: string | null;
  // The last package diff between a running closure and a built one.
  last_diff: ClosureDiff | null;
  // A switch waiting on what it depends on before its run starts; absent when none waits.
  switch_wait?: SwitchWait;
}

// What a switch waits on: an evaluation naming its system, a build on the build agents, a build in the cache, or the
// system reaching the cache.
export type SwitchStep = "evaluate" | "build" | "cache-build" | "push";

// A switch job whose run starts once the steps it depends on have succeeded.
export interface SwitchWait {
  job_id: number;
  step: SwitchStep;
  // The step's own job, null until it starts or for a step that has none.
  step_job_id: number | null;
  // The store path the switch fetches from the cache, null until an evaluation or a build names it.
  target: string | null;
  // When the step began, so a wait for the cache gives up in time.
  since_epoch: number;
  // How much of the step's job output the switch's job already shows; absent for none.
  copied?: number;
}

export interface Message {
  level: EventLevel;
  text: string;
}

// What the last cycle read from the host and made of it.
export interface Reading {
  status: Status;
  checked_epoch: number;
  messages: Message[];
  hostname: string | null;
  current: string | null;
  booted: string | null;
  version: string | null;
  generation: number | null;
  switched_epoch: number | null;
  up_to_date: boolean | null;
  reboot_required: boolean | null;
  flake_reachable: boolean | null;
}

export interface ActionOutcome {
  ok: boolean;
  message: string;
  job_id: number | null;
}

export interface DeploymentOptions {
  store: Store;
  agents: AgentPool;
  // The time in seconds, which tests set.
  now?: () => number;
  // Fetches a health check's URL, answering null when it passed or why it failed; tests set it.
  http_check?: (url: string) => Promise<string | null>;
  // The caches that may build a system a switch from the cache finds missing.
  caches?: Cache[];
  // The host the deployment runs on, which reboots it.
  host?: Host;
  // Has the cache that evaluates for this deployment check now, as a push or a person asks.
  check_cache?: (cache: Cache) => void;
}

// What a request for the package diff answers: the diff, or why there is none.
export interface DiffOutcome {
  diff: ClosureDiff | null;
  message: string | null;
}

const empty_evaluation: Evaluation = {
  evaluated_epoch: null, target: null, eval_error: null, eval_unreachable: false, metadata_error: null, flake_revision: null,
  flake_last_modified_epoch: null, oldest_input: null, inputs_last_modified_epoch: null, drift_target: null, drift_since_epoch: null,
  auto_switch_target: null, scheduled: {}, last_diff: null,
};

// The jobs that hold the deployment's buttons, and any update still running under its id; an evaluation runs beside them.
const main_job_kinds: JobKind[] = ["update", "build", "switch", "boot", "test", "dry-activate", "rollback", "collect"];

const probe_timeout_in_seconds = 60;
const diff_timeout_in_seconds = 300;
const closure_timeout_in_seconds = 120;
// How long confirming a switch or telling its watchdog to roll back may take.
const signal_timeout_in_seconds = 60;
const cache_check_timeout_in_seconds = 60;
// How long a switch waits for a system built on another host to reach the cache.
const push_wait_in_seconds = 900;
// How long one health check's URL may take to answer.
const http_check_timeout_in_milliseconds = 10_000;

// ── Schedules ────────────────────────────────────────────────────────────────

// The epoch of the latest local time of day no later than now.
export function latest_slot(at: TimeOfDay, now: number): number {
  const slot = new Date(now * 1000);
  slot.setHours(at.hour, at.minute, 0, 0);
  if (slot.getTime() > now * 1000) slot.setDate(slot.getDate() - 1);
  return Math.floor(slot.getTime() / 1000);
}

// ── Deployment ───────────────────────────────────────────────────────────────

export class Deployment {
  readonly settings: DeploymentSettings;
  private readonly store: Store;
  private readonly agents: AgentPool;
  private readonly now: () => number;
  // Set when a job ends or the running closure changes, so the next cycle evaluates at once.
  private force_eval = false;
  // The target an automatic switch is due for on the next cycle.
  private auto_switch_due: string | null = null;
  // Cycles and actions run one at a time.
  private queue: Promise<unknown> = Promise.resolve();
  private readonly http_check: (url: string) => Promise<string | null>;
  private readonly caches: Cache[];
  readonly host: Host | null;
  private readonly check_cache: (cache: Cache) => void;
  // Switch jobs this server has confirmed or told to roll back, which need nothing more from it.
  private readonly tended_switches = new Set<number>();
  // When each switch first waited for its HTTP checks.
  private readonly http_checks_started = new Map<number, number>();

  constructor(settings: DeploymentSettings, options: DeploymentOptions) {
    this.settings = settings;
    this.store = options.store;
    this.agents = options.agents;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.http_check = options.http_check ?? fetch_check;
    this.caches = options.caches ?? [];
    this.host = options.host ?? null;
    this.check_cache = options.check_cache ?? (() => {});
  }

  get id(): string {
    return this.settings.id;
  }

  // ── Reading state ────────────────────────────────────────────────────────

  evaluation(): Evaluation {
    return { ...empty_evaluation, ...this.store.evaluation<Evaluation>(this.id) };
  }

  reading(): Reading | null {
    return this.store.reading<Reading>(this.id);
  }

  running_job(): Job | null {
    return this.store.running_job(this.id, main_job_kinds);
  }

  // The deployment's own running evaluation, or the check of the cache that evaluates for it.
  running_evaluation(): Job | null {
    const own = this.store.running_job(this.id, ["eval"]);
    if (own !== null) return own;
    const job = this.evaluating_cache()?.cache.running_job() ?? null;
    return job !== null && (job.kind === "check" || job.kind === "build-all") ? job : null;
  }

  // The cache whose check evaluates this deployment's system in its place, or null when it evaluates on its own.
  evaluating_cache(): { cache: Cache; name: string } | null {
    return this.builds_in_cache();
  }

  // Whether the deployment is waiting on a long run, so the poller looks again sooner.
  busy(): boolean {
    return this.running_job() !== null || this.running_evaluation() !== null || this.auto_switch_due !== null;
  }

  // How soon a busy deployment is polled again: every health_period while a guarded switch may await confirmation.
  poll_interval(): number {
    const job = this.running_job();
    if (job !== null && watch_token(job.command) !== null) return Math.min(this.settings.job_poll, this.settings.health_period);
    return this.settings.job_poll;
  }

  // Why an action cannot run now, or null when it can; a direct action never waits on the cache.
  action_refusal(action: ActionId, direct = false): string | null {
    if (action === "build" && !direct && this.settings.cache_id !== null && this.pin() === null) {
      const building = this.builds_in_cache();
      if (building === null) return `The ${this.settings.cache_id} cache does not track ${this.attribute() ?? "this host's configuration"}`;
      return building.cache.action_refusal("build", building.name);
    }
    const running = this.running_job();
    // A direct action takes the place of a switch still waiting on what it depends on, such as the cache.
    if (running !== null && !(direct && action !== "reboot" && this.evaluation().switch_wait?.job_id === running.id)) return "A job is already running for this deployment";
    return null;
  }

  // ── Pin ──────────────────────────────────────────────────────────────────

  // The commit or tag the deployment is fixed at, or null when it follows the branch head.
  pin(): string | null {
    const override = this.evaluation().pin_override;
    return override === undefined ? this.settings.pin : override;
  }

  // Whether the pin was set on the page rather than taken from the settings.
  pin_overridden(): boolean {
    return this.evaluation().pin_override !== undefined;
  }

  // The settings with the flake reference fixed at the pin, which evaluation, build and switch use.
  effective_settings(): DeploymentSettings {
    const pin = this.pin();
    const flake = pin === null ? null : pinned_flake(this.settings.flake, pin);
    return flake === null ? this.settings : { ...this.settings, flake };
  }

  // Why this pin cannot be set, or null when it can.
  pin_refusal(pin: string | null): string | null {
    if (pin === null) return null;
    if (!is_pin(pin)) return "A pin must be a full commit hash or a tag name";
    if (pinned_flake(this.settings.flake, pin) === null) return `Cannot pin ${this.settings.flake}: only a git or forge flake can be pinned`;
    return null;
  }

  // Sets the pin, or with reset goes back to the settings' pin, then evaluates afresh on the next cycle.
  set_pin(pin: string | null, reset = false): Promise<ActionOutcome> {
    return this.serial(async () => {
      const refusal = reset ? null : this.pin_refusal(pin);
      if (refusal !== null) return { ok: false, message: refusal, job_id: null };
      const evaluation = this.evaluation();
      if (reset) delete evaluation.pin_override;
      else evaluation.pin_override = pin;
      this.store.save_evaluation(this.id, evaluation);
      this.force_eval = true;
      const now_pinned = this.pin();
      const message = now_pinned === null ? "Following the branch head" : `Pinned at ${now_pinned}`;
      this.store.add_event(this.id, this.now(), "info", reset ? `${message}, as the settings say` : message);
      return { ok: true, message, job_id: null };
    });
  }

  // ── Cycle ────────────────────────────────────────────────────────────────

  // Asks for an evaluation on the next cycle, even one that follows an evaluation running now, as after a push.
  request_evaluation(): void {
    this.force_eval = true;
    const evaluating = this.evaluating_cache();
    if (evaluating !== null) this.check_cache(evaluating.cache);
  }

  // Whether the deployment waits on a fresh evaluation before its drift can be trusted.
  sync_pending(): boolean {
    return this.running_evaluation() !== null || this.due_for_evaluation();
  }

  // Runs one cycle; asked for by a person, it evaluates unless an evaluation is already running.
  cycle(options: { force_eval?: boolean } = {}): Promise<void> {
    return this.serial(async () => {
      if (options.force_eval && this.running_evaluation() === null) this.request_evaluation();
      const job = this.running_job();
      if (job !== null) return this.poll_job(job);
      if (this.auto_switch_due !== null) return this.launch_auto_switch(this.auto_switch_due);
      const due = this.scheduled_due();
      if (due !== null) return this.launch_scheduled(due.kind, due.slot);
      return this.probe_cycle();
    });
  }

  private serial<Answer>(work: () => Promise<Answer>): Promise<Answer> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  private async probe_cycle(): Promise<void> {
    const evaluation_job = this.store.running_job(this.id, ["eval"]);
    const from_cache = evaluation_job === null ? this.evaluating_cache() : null;
    let evaluating: Promise<Evaluation | null> = Promise.resolve(null);
    if (evaluation_job !== null) evaluating = this.poll_evaluation(evaluation_job);
    else if (from_cache !== null) evaluating = Promise.resolve(this.fold_cache_check(from_cache.cache, from_cache.name));
    // An evaluation on another host needs the target's attribute name, which the first probe supplies.
    else if (this.due_for_evaluation() && !(this.settings.eval_agent !== null && this.attribute() === null)) evaluating = this.launch_evaluation();
    const [probe, folded] = await Promise.all([this.agents.get(this.settings.host).run(probe_operation(), { timeout_in_seconds: probe_timeout_in_seconds }), evaluating]);
    const evaluation = folded ?? this.evaluation();

    const fields = parse_probe(probe.stdout);
    if (fields === null) {
      return this.save_unavailable(`Could not read the deployed system: ${clip(probe.stderr || probe.stdout, 200) || `status ${probe.exit_code}`}`, evaluation);
    }
    if (fields.current === null) return this.save_unavailable("/run/current-system is unreadable; is this a NixOS host?", evaluation);
    this.assemble(fields, evaluation, folded !== null);
  }

  private save_unavailable(text: string, evaluation: Evaluation): void {
    this.store.save_evaluation(this.id, evaluation);
    const previous = this.reading();
    this.save_reading({
      ...(previous ?? blank_reading()),
      status: "unavailable",
      checked_epoch: this.now(),
      messages: [{ level: "warning", text }],
    });
  }

  // Turns the probe's facts and the evaluation into this cycle's reading and worst-of status.
  private assemble(fields: ProbeFields, evaluation: Evaluation, evaluated: boolean): void {
    const now = this.now();
    const messages: Message[] = [];
    let status: Status = "online";
    const raise = (next: Status) => (status = worse(status, next));
    const version = fields.version ?? "unknown";
    const generation = fields.generation ?? "?";
    messages.push({
      level: "info",
      text: fields.switched_epoch === null
        ? `Running NixOS ${version}, generation ${generation}`
        : `Running NixOS ${version}, generation ${generation}, switched ${format_age(now - fields.switched_epoch)}`,
    });

    let up_to_date: boolean | null = null;
    this.auto_switch_due = null;
    if (evaluation.eval_error !== null) {
      raise(evaluation.eval_unreachable ? "unavailable" : "failed");
      messages.push({ level: evaluation.eval_unreachable ? "warning" : "error", text: `Flake evaluation failed: ${evaluation.eval_error}` });
    }
    const previous_current = this.reading()?.current ?? null;
    const target = evaluation.target;
    if (target !== null && !evaluated && previous_current !== null && previous_current !== fields.current && target !== fields.current) {
      // A closure that changed since the last evaluation is judged against a fresh one, not a stale target.
      this.force_eval = true;
      messages.push({ level: "info", text: `Running closure changed to ${fields.current}; evaluating the flake again before judging drift` });
    } else if (target !== null) {
      up_to_date = target === fields.current;
      if (up_to_date) {
        evaluation.drift_target = null;
        evaluation.drift_since_epoch = null;
        messages.push({ level: "info", text: "System matches the flake" });
      } else {
        raise(this.settings.drift_status);
        messages.push({ level: level_of_status[this.settings.drift_status], text: `System is out of date: ${this.effective_settings().flake} evaluates to ${target}, running ${fields.current}` });
        if (evaluation.drift_target !== target) {
          evaluation.drift_target = target;
          evaluation.drift_since_epoch = now;
        }
        messages.push(...this.consider_auto_switch(fields, evaluation, target, now));
      }
    }

    if (evaluation.metadata_error !== null) {
      raise("unavailable");
      messages.push({ level: "warning", text: `Could not read flake metadata: ${evaluation.metadata_error}` });
    }
    if (evaluation.flake_last_modified_epoch !== null) {
      const at = evaluation.flake_revision ? ` at ${short_revision(evaluation.flake_revision)}` : "";
      messages.push({ level: "info", text: `Flake last changed ${format_age(now - evaluation.flake_last_modified_epoch)}${at}` });
    }
    if (evaluation.inputs_last_modified_epoch !== null) {
      messages.push({ level: "info", text: `Oldest locked input ${evaluation.oldest_input ?? "?"} is ${format_age(now - evaluation.inputs_last_modified_epoch)}` });
    }

    // A schedule seen for the first time starts at its next slot, never at once.
    for (const [kind, at] of this.schedule()) evaluation.scheduled[kind] ??= latest_slot(at, now);

    for (const job of this.store.all_running_jobs(this.id)) {
      const text = overdue_text(this.store, job, now);
      if (text === null) continue;
      raise("warning");
      messages.push({ level: "warning", text });
    }

    const reboot = reboot_required(fields.booted_parts, fields.current_parts);
    if (reboot === true) {
      raise(this.settings.reboot_status);
      messages.push({ level: level_of_status[this.settings.reboot_status], text: "Reboot required: the booted kernel, initrd or systemd is not the current one" });
    }

    this.store.save_evaluation(this.id, evaluation);
    this.save_reading({
      status, checked_epoch: now, messages,
      hostname: fields.hostname, current: fields.current, booted: fields.booted, version: fields.version, generation: fields.generation,
      switched_epoch: fields.switched_epoch, up_to_date, reboot_required: reboot, flake_reachable: evaluation.evaluated_epoch === null ? null : evaluation.metadata_error === null,
    });
  }

  // Saves the reading, noting a change of the deployment's status as an event.
  private save_reading(reading: Reading): void {
    const previous = this.reading();
    this.store.save_reading(this.id, reading);
    this.note_change(previous?.status ?? null, reading.status, reading.messages, reading.checked_epoch, "Now");
  }

  private note_change(previous: Status | null, status: Status, messages: Message[], epoch: number, prefix: string): void {
    if (previous === status) return;
    const level = level_of_status[status];
    const reason = messages.find((message) => message.level === level && level !== "info");
    this.store.add_event(this.id, epoch, level, reason ? `${prefix} ${status}: ${reason.text}` : `${prefix} ${status}`);
  }

  // ── Evaluation ───────────────────────────────────────────────────────────

  // The nixosConfigurations attribute: the configured name, else the hostname the last probe read.
  attribute(): string | null {
    return this.settings.configuration ?? this.reading()?.hostname ?? null;
  }

  due_for_evaluation(): boolean {
    if (this.evaluating_cache() !== null) return false;
    if (this.force_eval) return true;
    const evaluation = this.evaluation();
    if (evaluation.evaluated_epoch === null) return true;
    // A failed evaluation waits only retry_interval, so a fix is seen soon.
    const failed = evaluation.eval_error !== null || evaluation.metadata_error !== null;
    return this.now() - evaluation.evaluated_epoch >= (failed ? this.settings.retry_interval : this.settings.eval_interval);
  }

  // Takes the target, revision and flake facts the cache's last check found for this host's configuration, which a
  // check that could not run leaves as they were.
  private fold_cache_check(cache: Cache, name: string): Evaluation {
    this.force_eval = false;
    const evaluation = this.evaluation();
    const reading = cache.reading();
    const row = reading?.rows.find((candidate) => candidate.name === name);
    if (reading == null || row === undefined || reading.evaluated_epoch == null) return evaluation;
    evaluation.evaluated_epoch = reading.evaluated_epoch;
    // A row saved before the cache's check evaluated deployments has no eval_error at all.
    const eval_error = row.eval_error ?? null;
    if (eval_error !== null) {
      evaluation.eval_error = `${cache.settings.name} cache: ${eval_error}`;
      evaluation.eval_unreachable = false;
    } else if (row.target !== null) {
      evaluation.target = row.target;
      evaluation.eval_error = null;
      evaluation.eval_unreachable = false;
    }
    evaluation.flake_revision = reading.revision;
    evaluation.flake_last_modified_epoch = reading.flake?.last_modified_epoch ?? evaluation.flake_last_modified_epoch;
    evaluation.oldest_input = reading.flake?.oldest_input ?? evaluation.oldest_input;
    evaluation.inputs_last_modified_epoch = reading.flake?.inputs_last_modified_epoch ?? evaluation.inputs_last_modified_epoch;
    evaluation.metadata_error = null;
    return evaluation;
  }

  // Starts the evaluation, answering with a failed evaluation if it could not start.
  private async launch_evaluation(): Promise<Evaluation | null> {
    this.force_eval = false;
    const launched = await this.launch("eval", eval_operation(this.effective_settings(), this.attribute()), "schedule", false);
    if (launched.job_id !== null) return null;
    const failure: RunResult = { exit_code: launched.unreachable ? -1 : 1, stdout: "", stderr: `Could not start the evaluation: ${launched.error}` };
    return this.fold_evaluation(failure, failure);
  }

  // Advances the running evaluation, answering with its result once it has ended.
  private async poll_evaluation(job: Job): Promise<Evaluation | null> {
    const followed = await this.follow(job);
    if (followed.outcome === "unreachable") {
      const unreachable: RunResult = { exit_code: -1, stdout: "", stderr: `Could not poll the running evaluation: ${followed.error}` };
      return this.fold_evaluation(unreachable, unreachable);
    }
    if (followed.outcome === "running") return null;
    const finished = this.store.job(job.id)!;
    const parts = split_eval_output(finished.output, `The evaluation ended before reporting: ${finished.error ?? "no output"}`);
    return this.fold_evaluation(parts.eval, parts.metadata);
  }

  // Folds an evaluation and the flake metadata into the stored state, keeping the last good values of a half that failed.
  private fold_evaluation(eval_result: RunResult, metadata_result: RunResult): Evaluation {
    const evaluation = this.evaluation();
    evaluation.evaluated_epoch = this.now();
    const out = eval_result.stdout.trim();
    if (eval_result.exit_code === 0 && out !== "") {
      evaluation.target = out.split("\n").pop()!.trim();
      evaluation.eval_error = null;
      evaluation.eval_unreachable = false;
    } else {
      evaluation.eval_error = clip(eval_result.stderr || eval_result.stdout, 400) || `nix eval exited ${eval_result.exit_code}`;
      evaluation.eval_unreachable = eval_result.exit_code === -1;
    }
    const metadata = metadata_result.exit_code === 0 ? parse_metadata(metadata_result.stdout) : null;
    if (metadata !== null) {
      evaluation.flake_revision = metadata.revision;
      evaluation.flake_last_modified_epoch = metadata.last_modified_epoch;
      evaluation.oldest_input = metadata.oldest_input;
      evaluation.inputs_last_modified_epoch = metadata.inputs_last_modified_epoch;
      evaluation.metadata_error = null;
    } else {
      evaluation.metadata_error = clip(metadata_result.stderr || metadata_result.stdout, 400) || `nix flake metadata exited ${metadata_result.exit_code}`;
    }
    return evaluation;
  }

  // ── Automatic switch ─────────────────────────────────────────────────────

  // Decides whether this drift switches on the next cycle, answering with messages that explain a hold.
  private consider_auto_switch(fields: ProbeFields, evaluation: Evaluation, target: string, now: number): Message[] {
    if (!this.settings.auto_switch || evaluation.eval_error !== null || evaluation.auto_switch_target === target) return [];
    const created = fields.profile_created_epoch ?? fields.switched_epoch;
    // A generation newer than the flake came from elsewhere, such as an unpushed checkout, and switching would undo it.
    if (created === null || evaluation.flake_last_modified_epoch === null || evaluation.flake_last_modified_epoch <= created) {
      return [{ level: "info", text: "Not switching automatically: the running generation is newer than the flake" }];
    }
    const waited = now - (evaluation.drift_since_epoch ?? now);
    if (waited < this.settings.auto_switch_after) {
      return [{ level: "info", text: `Switching automatically once the drift has lasted ${format_duration(this.settings.auto_switch_after)}` }];
    }
    this.auto_switch_due = target;
    return [{ level: "warning", text: `Drift has lasted ${format_age(waited)}; switching automatically` }];
  }

  private async launch_auto_switch(target: string): Promise<void> {
    this.auto_switch_due = null;
    const operation = this.operation_for("switch");
    // The switch runs what it depends on first, as one a person starts does.
    const waiting = await this.wait_for_dependencies("switch", operation, "automatic");
    if (waiting !== null) {
      const evaluation = this.evaluation();
      evaluation.auto_switch_target = target;
      this.store.save_evaluation(this.id, evaluation);
      return;
    }
    const launched = await this.launch("switch", operation, "automatic", false);
    // A host that never answered started nothing, so a later cycle may try again.
    if (launched.unreachable) {
      this.store.add_event(this.id, this.now(), "warning", `Could not start the automatic switch: ${launched.error}`);
      return;
    }
    const evaluation = this.evaluation();
    evaluation.auto_switch_target = target;
    this.store.save_evaluation(this.id, evaluation);
    if (launched.job_id === null) this.record_failed_launch("switch", operation, "automatic", launched.error);
    else this.store.add_event(this.id, this.now(), "info", "Automatic switch started");
  }

  private async cache_holds(target: string, host: string | null = this.agent_for("switch")): Promise<boolean> {
    const result = await this.agents.get(host).run(cache_holds_operation(this.settings, target), { timeout_in_seconds: cache_check_timeout_in_seconds });
    return result.exit_code === 0;
  }

  // ── Daily jobs ───────────────────────────────────────────────────────────

  private schedule(): [ScheduledKind, TimeOfDay][] {
    const entries: [ScheduledKind, TimeOfDay | null][] = [["build", this.settings.build_at]];
    return entries.filter((entry): entry is [ScheduledKind, TimeOfDay] => entry[1] !== null);
  }

  // The first daily job whose latest slot is newer than the one last handled.
  scheduled_due(): { kind: ScheduledKind; slot: number } | null {
    const handled = this.evaluation().scheduled;
    const now = this.now();
    for (const [kind, at] of this.schedule()) {
      const slot = latest_slot(at, now);
      const last = handled[kind];
      if (last !== undefined && slot > last) return { kind, slot };
    }
    return null;
  }

  private async launch_scheduled(kind: ScheduledKind, slot: number): Promise<void> {
    const operation = this.operation_for(kind);
    const launched = await this.launch(kind, operation, "schedule", false);
    // A host that never answered started nothing, so a later cycle may try again.
    if (launched.unreachable) {
      this.store.add_event(this.id, this.now(), "warning", `Could not start the scheduled ${kind}: ${launched.error}`);
      return;
    }
    const evaluation = this.evaluation();
    evaluation.scheduled = { ...evaluation.scheduled, [kind]: slot };
    this.store.save_evaluation(this.id, evaluation);
    if (launched.job_id === null) this.record_failed_launch(kind, operation, "schedule", launched.error);
    else this.store.add_event(this.id, this.now(), "info", `Scheduled ${kind} started`);
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  // Runs an action, naming in the job what started it, such as a person or a fleet run. A direct action, as a person or an
  // API caller asks, runs nixos-rebuild at once on its own agents rather than building in or switching from the cache.
  act(action: ActionId, trigger = "manual", direct = false): Promise<ActionOutcome> {
    return this.serial(async () => {
      const refusal = this.action_refusal(action, direct);
      if (refusal !== null) return { ok: false, message: refusal, job_id: null };
      if (action === "reboot") return this.host === null ? { ok: false, message: "No host to reboot", job_id: null } : this.host.act("reboot", trigger);
      if (direct) this.preempt_wait(action);
      const building = action === "build" && !direct ? this.builds_in_cache() : null;
      if (building !== null) return building.cache.act("build", building.name, trigger === "manual" ? `deployment ${this.id}` : trigger);
      const operation = this.operation_for(action, direct);
      if (is_switch_kind(action) && !direct) {
        const waiting = await this.wait_for_dependencies(action, operation, trigger);
        if (waiting !== null) return waiting;
      }
      const launched = await this.launch(action, operation, trigger, true);
      if (launched.job_id === null) {
        const job_id = this.record_failed_launch(action, operation, trigger, launched.error);
        return { ok: false, message: `Could not start the ${job_noun(action)}: ${launched.error}`, job_id };
      }
      return { ok: true, message: `${capitalise(job_noun(action))} started`, job_id: launched.job_id };
    });
  }

  // ── What a switch depends on ────────────────────────────────────────────

  // The cache that builds this host's configuration into the cache it switches from, and its name for it there.
  building_cache(): { cache: Cache; name: string } | null {
    const name = this.attribute();
    const url = this.settings.cache_url;
    if (name === null || url === null) return null;
    const same = (other: string) => other.replace(/\/+$/, "") === url.replace(/\/+$/, "");
    const cache = this.caches.find((candidate) => (this.settings.cache_id === null ? same(candidate.settings.cache_url) : candidate.id === this.settings.cache_id)
      && candidate.settings.configurations.includes(name));
    return cache === undefined ? null : { cache, name };
  }

  // The cache that builds this deployment's system in its place: the one it names, unless it is pinned off the head the cache builds.
  private builds_in_cache(): { cache: Cache; name: string } | null {
    return this.settings.cache_id === null || this.pin() !== null ? null : this.building_cache();
  }

  // What a switch waits on before its run can start, or null when it can start at once.
  private async next_step(target: string | null): Promise<SwitchStep | null> {
    const from_cache = this.settings.switch_from_cache;
    const building = from_cache ? this.building_cache() : this.builds_in_cache();
    // A cache that evaluates for this deployment names the system its build makes, so no evaluation of its own is needed.
    if (from_cache && target === null) return building !== null && this.evaluating_cache() !== null ? "cache-build" : "evaluate";
    // nixos-rebuild builds on the switching host itself, so building first only helps elsewhere, with a cache to bring the result back.
    const builds_elsewhere = this.settings.cache_url !== null && !this.same_host(this.agent_for("build"), this.agent_for("switch"));
    if (!from_cache && building === null && !builds_elsewhere) return null;
    if (target === null) return building !== null ? "cache-build" : "build";
    // Checked from a host that is awake, unlike a switching host that may sleep until its run wakes it.
    const checker = building?.cache.host(false) ?? this.agents.pick([this.agent_for("switch"), ...this.build_agents()], false);
    if (await this.cache_holds(target, checker).catch(() => true)) return null;
    return building !== null ? "cache-build" : "build";
  }

  // Starts a switch as a job that runs what it depends on first, or answers null when the switch can start at once.
  private async wait_for_dependencies(kind: SwitchMode, operation: Operation, trigger: string): Promise<ActionOutcome | null> {
    const target = this.cached_target();
    const step = await this.next_step(target);
    if (step === null) return null;
    const run_id = `${this.id}-${kind}-${this.now()}-${randomBytes(3).toString("hex")}`;
    const job_id = this.store.create_job({
      deployment_id: this.id, kind, command: JSON.stringify(operation), agent: this.agent_for(kind), run_id, trigger, started_epoch: this.now(),
    });
    this.save_wait({ job_id, step, step_job_id: null, target, since_epoch: this.now() });
    const words = this.step_words(this.evaluation().switch_wait!);
    await this.advance_wait(this.store.job(job_id)!, this.evaluation().switch_wait!);
    const job = this.store.job(job_id)!;
    const noun = job_noun(kind);
    if (job.state === "failed") return { ok: false, message: job.error ?? `Could not start the ${noun}`, job_id };
    const started = trigger === "automatic" ? `Automatic ${noun}` : capitalise(noun);
    this.store.add_event(this.id, this.now(), "info", `${started} started; ${words.first} first`);
    return { ok: true, message: `${capitalise(words.first)} first; the ${noun} starts once ${words.then}`, job_id };
  }

  // What a switch does first in this step, and what it waits for, as its event and answer say.
  private step_words(waiting: SwitchWait): { first: string; then: string } {
    if (waiting.step === "evaluate") return { first: "evaluating the flake", then: "it names the system" };
    if (waiting.step === "build") return { first: `building on ${this.host_name(this.agent_for("build"))}`, then: "it is built" };
    if (waiting.step === "push") return { first: "waiting for the system to reach the cache", then: "it is there" };
    const building = this.building_cache()!;
    return { first: `building ${building.name} in the ${building.cache.settings.name} cache`, then: "it is pushed" };
  }

  // Moves a waiting switch along: starts its step once it can, follows it, and starts the switch's own run once nothing is left.
  private async advance_wait(job: Job, waiting: SwitchWait): Promise<void> {
    if (this.store.job(job.id)?.state !== "running") return this.save_wait(null);
    if (waiting.step === "evaluate") return this.advance_evaluation(job, waiting);
    if (waiting.step === "build") return this.advance_build(job, waiting);
    if (waiting.step === "push") return this.advance_push(job, waiting);
    return this.advance_cache_build(job, waiting);
  }

  // Evaluates the flake, or follows the evaluation already running, then moves on to what the system it names needs.
  private async advance_evaluation(job: Job, waiting: SwitchWait): Promise<void> {
    if (waiting.step_job_id === null) {
      // An evaluation on another host needs the target's attribute name, which the first probe supplies.
      if (this.settings.eval_agent !== null && this.attribute() === null) return this.end_wait(job, "The host's configuration is not known until it is first read; set configuration or try again");
      let evaluation_id = this.store.running_job(this.id, ["eval"])?.id ?? null;
      if (evaluation_id === null) {
        this.force_eval = false;
        const launched = await this.launch("eval", eval_operation(this.effective_settings(), this.attribute()), job.trigger, false, true);
        if (launched.job_id === null) return this.end_wait(job, `Could not start the evaluation: ${launched.error}`);
        evaluation_id = launched.job_id;
      }
      this.save_wait({ ...waiting, step_job_id: evaluation_id });
      this.store.append_output(job.id, "No evaluation names the system yet, so the flake is evaluated first\n");
      return this.store.set_progress(job.id, "Evaluating the flake");
    }
    const evaluation_job = this.store.job(waiting.step_job_id);
    if (evaluation_job === null) return this.end_wait(job, "The evaluation is gone from the history");
    if (evaluation_job.state === "running") {
      const evaluated = await this.poll_evaluation(evaluation_job);
      // A host that did not answer the poll leaves the evaluation running, to be read on the next one.
      if (evaluated === null || this.store.job(evaluation_job.id)!.state === "running") return this.store.set_progress(job.id, "Evaluating the flake");
      this.store.save_evaluation(this.id, evaluated);
    }
    const target = this.cached_target();
    if (target === null) return this.end_wait(job, `The evaluation failed: ${this.evaluation().eval_error ?? "it named no system"}`);
    this.store.append_output(job.id, `The flake evaluates to ${target}\n`);
    const step = await this.next_step(target);
    if (step === null) return this.start_switch(job, target);
    this.save_wait({ job_id: job.id, step, step_job_id: null, target, since_epoch: this.now() });
    return this.advance_wait(job, this.evaluation().switch_wait!);
  }

  // Builds on the build agents, then switches, after the system reaches the cache when the build ran on another host.
  private async advance_build(job: Job, waiting: SwitchWait): Promise<void> {
    if (waiting.step_job_id === null) {
      const launched = await this.launch("build", build_operation(this.effective_settings(), this.attribute()), job.trigger, false);
      if (launched.job_id === null) return this.end_wait(job, `Could not start the build: ${launched.error}`);
      this.save_wait({ ...waiting, step_job_id: launched.job_id });
      const where = this.host_name(this.store.job(launched.job_id)!.agent);
      this.store.append_output(job.id, `Building on ${where} first, job #${launched.job_id}\n`);
      return this.store.set_progress(job.id, `Building on ${where}`);
    }
    const build = this.store.job(waiting.step_job_id);
    if (build === null) return this.end_wait(job, "The build is gone from the history");
    this.copy_step_output(job, waiting, build);
    const where = this.host_name(build.agent);
    if (build.state === "running") return this.store.set_progress(job.id, `Building on ${where}${build.progress ? `: ${build.progress}` : ""}`);
    if (build.state === "failed") return this.end_wait(job, `The build on ${where} failed: ${build.error}`);
    if (!this.settings.switch_from_cache) return this.start_switch(job, null);
    const built = built_store_path(build.output) ?? waiting.target;
    if (built === null) return this.end_wait(job, `The build on ${where} finished without naming the system it built`);
    // The build evaluates the flake afresh, so it may bring a newer system than the evaluation named.
    if (waiting.target !== null && built !== waiting.target) {
      this.force_eval = true;
      this.store.append_output(job.id, `The flake moved since ${waiting.target} was evaluated, so this ${job_noun(job.kind)} takes ${built}, which the build made\n`);
    }
    if (this.same_host(build.agent, job.agent)) return this.start_switch(job, built);
    this.save_wait({ job_id: job.id, step: "push", step_job_id: null, target: built, since_epoch: this.now() });
    return this.advance_push(job, this.evaluation().switch_wait!);
  }

  // Waits for a system built on another host to reach the cache, as a store watcher there pushes it.
  private async advance_push(job: Job, waiting: SwitchWait): Promise<void> {
    const target = waiting.target!;
    const checker = this.agents.pick([job.agent, ...this.build_agents()], false);
    if (await this.cache_holds(target, checker).catch(() => false)) {
      this.store.append_output(job.id, "The cache holds the system; switching\n");
      return this.start_switch(job, target);
    }
    if (this.now() - waiting.since_epoch < push_wait_in_seconds) return this.store.set_progress(job.id, `Waiting for ${target} to reach the cache`);
    return this.end_wait(job, `${target} was built but never reached the cache; push it there, as attic watch-store does, and switch again`);
  }

  // Starts the cache's build once the cache is free, then the switch's own run once that build has pushed the system.
  private async advance_cache_build(job: Job, waiting: SwitchWait): Promise<void> {
    const building = this.building_cache();
    if (building === null) return this.end_wait(job, "No cache in the config builds this host's configuration");
    const { cache, name } = building;
    const what = `${name} in the ${cache.settings.name} cache`;
    if (waiting.step_job_id === null) {
      // A cache runs one job at a time, so a switch clicked during its check waits for the check to end.
      const running = cache.running_job();
      if (running !== null) return this.store.set_progress(job.id, `Waiting for the ${cache.settings.name} cache to finish its ${running.kind}`);
      const started = await cache.act("build", name);
      if (started.job_id === null) {
        if (cache.running_job() !== null) return;
        return this.end_wait(job, `Could not build ${what}: ${started.message}`);
      }
      this.save_wait({ ...waiting, step_job_id: started.job_id });
      const lacking = waiting.target === null ? "No evaluation names the system yet" : `The ${cache.settings.name} cache does not hold ${waiting.target} yet`;
      this.store.append_output(job.id, `${lacking}, so it builds ${name} first\nBuilding ${what}, job #${started.job_id}\n`);
      return this.store.set_progress(job.id, `Building ${what}`);
    }
    const build = this.store.job(waiting.step_job_id);
    if (build === null) return this.end_wait(job, `The build of ${what} is gone from the history`);
    this.copy_step_output(job, waiting, build);
    if (build.state === "running") return this.store.set_progress(job.id, `Building ${what}${build.progress ? `: ${build.progress}` : ""}`);
    if (build.state === "failed") return this.end_wait(job, `The build of ${what} failed: ${build.error}`);
    // nixos-rebuild substitutes what the cache built, or builds whatever it still lacks.
    if (!this.settings.switch_from_cache) return this.start_switch(job, null);
    // The cache builds the flake's head, which may have moved past the evaluation this switch fetches; the switch then
    // takes what the cache built from the same flake, unless a pin holds the deployment at another revision.
    let target = waiting.target;
    if (target === null || !(await this.cache_holds(target, cache.host(false)).catch(() => false))) {
      const built = parse_report(build.output).targets.get(name)?.target ?? null;
      const follows_head = cache.settings.flake === this.settings.flake && this.pin() === null;
      const usable = built !== null && built !== target && is_store_path(built) && follows_head
        && (await this.cache_holds(built, cache.host(false)).catch(() => false));
      // Either way the evaluation is behind the flake, so the next cycle evaluates afresh.
      this.force_eval = true;
      if (!usable) {
        const lacks = target === null ? "named no system the cache holds" : `the cache still lacks ${target}; evaluate again and switch`;
        return this.end_wait(job, `The build of ${what} finished, but ${lacks}`);
      }
      const taken = `this ${job_noun(job.kind)} takes ${built}, which the cache built`;
      this.store.append_output(job.id, `${target === null ? capitalise(taken) : `The flake moved since ${target} was evaluated, so ${taken}`}\n`);
      target = built;
    }
    this.store.append_output(job.id, "The cache holds the system; switching\n");
    return this.start_switch(job, target);
  }

  // Starts the waiting switch's own run, activating the store path it waited for when it switches from the cache.
  private async start_switch(job: Job, target: string | null): Promise<void> {
    this.save_wait(null);
    if (this.settings.switch_from_cache) {
      if (target === null) return this.end_wait(job, "No evaluation or build named the system to switch to");
      const token = watch_token(job.command) ?? randomBytes(8).toString("hex");
      this.store.set_command(job.id, JSON.stringify(switch_job_operation(this.effective_settings(), job.kind as SwitchMode, token, target)));
    }
    const command = this.store.job(job.id)!.command;
    let waking: Promise<void> | null;
    try {
      ({ waking } = await start_run(this.agents, job.agent, job.run_id!, operation_of(command)!));
    } catch (error) {
      this.store.append_output(job.id, `${(error as Error).message}\n`);
      this.store.finish_job(job.id, "failed", null, "The job could not be started", this.now());
      this.store.add_event(this.id, this.now(), "error", `Could not start the ${job_noun(job.kind)}: ${(error as Error).message}`);
      return;
    }
    this.store.set_progress(job.id, "Switching");
    if (waking !== null) {
      track_wake(this.store, job.id, job.agent ?? this.agents.own_host, waking, this.now, (error) => {
        this.store.add_event(this.id, this.now(), "error", `Could not start the ${job_noun(job.kind)}: ${error}`);
      });
    }
  }

  // Ends a switch still waiting on what it depends on, so a direct action runs in its place; a cache build it started carries on.
  private preempt_wait(action: ActionId): void {
    const waiting = this.evaluation().switch_wait;
    const job = waiting === undefined ? null : this.store.job(waiting.job_id);
    if (job === null || job.state !== "running") return;
    this.save_wait(null);
    const reason = `A direct ${job_noun(action)} took its place before it started`;
    this.store.append_output(job.id, `${reason}\n`);
    this.store.finish_job(job.id, "failed", null, reason, this.now());
    this.store.add_event(this.id, this.now(), "info", `${capitalise(job_noun(job.kind))} #${job.id} ended: ${reason.toLowerCase()}`);
  }

  // Fails a switch whose steps never brought the system, before its run started.
  private end_wait(job: Job, reason: string): void {
    this.save_wait(null);
    this.store.append_output(job.id, `${reason}\n`);
    this.store.finish_job(job.id, "failed", null, reason, this.now());
    this.store.add_event(this.id, this.now(), "error", `${capitalise(job_noun(job.kind))} failed: ${reason}`);
  }

  // Shows in the switch's job what its step's job printed since the last poll, ending its last line once the step is done.
  private copy_step_output(job: Job, waiting: SwitchWait, step: Job & { output: string }): void {
    const copied = waiting.copied ?? 0;
    // A running step's last line may not have ended yet, so only whole lines are shown until it is done.
    const until = step.state === "running" ? step.output.lastIndexOf("\n") + 1 : step.output.length;
    if (until <= copied) return;
    const text = step.output.slice(copied, until);
    this.store.append_output(job.id, text.endsWith("\n") ? text : `${text}\n`);
    this.save_wait({ ...waiting, copied: until });
  }

  private save_wait(waiting: SwitchWait | null): void {
    const evaluation = this.evaluation();
    if (waiting === null) delete evaluation.switch_wait;
    else evaluation.switch_wait = waiting;
    this.store.save_evaluation(this.id, evaluation);
  }

  private same_host(first: string | null, second: string | null): boolean {
    return this.host_name(first) === this.host_name(second);
  }

  // A job's host by name, the server's own for null.
  private host_name(host: string | null): string {
    return host ?? this.agents.own_host;
  }

  private operation_for(kind: JobAction, direct = false): Operation {
    if (kind === "build") return build_operation(this.effective_settings(), this.attribute());
    const store_path = this.settings.switch_from_cache && !direct ? this.cached_target() : null;
    // Each switch has its own token, naming the folder its watchdog and X-Nix share on the host.
    return switch_job_operation(this.effective_settings(), kind, randomBytes(8).toString("hex"), store_path);
  }

  // The store path a switch from the cache activates: the last evaluation's, unless that evaluation failed.
  cached_target(): string | null {
    const evaluation = this.evaluation();
    return evaluation.eval_error === null && evaluation.target !== null && is_store_path(evaluation.target) ? evaluation.target : null;
  }

  // ── Jobs ─────────────────────────────────────────────────────────────────

  // The hosts that may run Build, most preferred first.
  build_agents(): (string | null)[] {
    return this.settings.build_agents.length > 0 ? this.settings.build_agents : [this.settings.host];
  }

  // The host whose agent runs a job of this kind; the build may run apart from the switch.
  agent_for(kind: JobKind): string | null {
    if (kind === "eval") return this.settings.eval_agent ?? this.settings.host;
    if (kind === "build") return this.agents.pick(this.build_agents());
    if (kind === "reboot" || kind === "diff") return this.settings.host;
    return this.settings.switch_agent ?? this.settings.host;
  }

  private async launch(
    kind: JobKind, operation: Operation, trigger: string, announce: boolean, wake = kind !== "eval",
  ): Promise<{ job_id: number | null; error: string; unreachable: boolean }> {
    const agent = this.agent_for(kind);
    const run_id = `${this.id}-${kind}-${this.now()}-${randomBytes(3).toString("hex")}`;
    let waking: Promise<void> | null;
    try {
      // A sleeping host is woken for any job but the periodic evaluation, which would keep it from ever sleeping.
      ({ waking } = await start_run(this.agents, agent, run_id, operation, null, wake));
    } catch (error) {
      const unreachable = error instanceof AgentError && error.unreachable;
      return { job_id: null, error: (error as Error).message, unreachable };
    }
    const job_id = this.store.create_job({ deployment_id: this.id, kind, command: JSON.stringify(operation), agent, run_id, trigger, started_epoch: this.now() });
    if (waking !== null) {
      track_wake(this.store, job_id, agent ?? this.agents.own_host, waking, this.now, (error) => {
        this.store.add_event(this.id, this.now(), "error", `Could not start the ${job_noun(kind)}: ${error}`);
      });
    }
    if (announce) this.store.add_event(this.id, this.now(), "info", `${capitalise(job_noun(kind))} started`);
    return { job_id, error: "", unreachable: false };
  }

  // Keeps a job that could not start in the history, with why.
  private record_failed_launch(kind: JobKind, operation: Operation, trigger: string, error: string): number {
    const job_id = this.store.create_job({ deployment_id: this.id, kind, command: JSON.stringify(operation), agent: this.agent_for(kind), run_id: null, trigger, started_epoch: this.now() });
    this.store.append_output(job_id, `${error}\n`);
    this.store.finish_job(job_id, "failed", null, "The job could not be started", this.now());
    this.store.add_event(this.id, this.now(), "error", `Could not start the ${job_noun(kind)}: ${error}`);
    return job_id;
  }

  private follow(job: Job): Promise<Followed> {
    const timed_out = (exit_code: number) => (exit_code === timed_out_exit_code && job.kind === "eval" ? `Timed out after ${format_duration(this.settings.eval_timeout)}` : null);
    return follow(this.store, this.agents, job, this.now, timed_out, this.translation(job));
  }

  // A build that prints nix's structured log is read into its live progress and readable lines.
  private translation(job: Job): Translate | null {
    if (job.kind !== "build" || !job.command.includes("internal-json")) return null;
    return (current, chunk, ended) => {
      const progress = this.live_progress(current.id);
      const text = read_build_log(progress, chunk, ended);
      this.store.set_live(current.id, progress);
      return text;
    };
  }

  private live_progress(job_id: number): BuildProgress {
    const live = this.store.job(job_id)?.live ?? null;
    return live === null ? empty_progress() : { ...empty_progress(), ...(JSON.parse(live) as BuildProgress) };
  }

  private async poll_job(job: Job): Promise<void> {
    // A switch waiting on what it depends on has no run of its own to follow yet.
    const waiting = this.evaluation().switch_wait;
    if (waiting?.job_id === job.id) return this.advance_wait(job, waiting);
    const followed = await this.follow(job);
    if (followed.outcome === "unreachable") {
      this.store.add_event(this.id, this.now(), "warning", `Could not poll the running ${job.kind}: ${followed.error}`);
      return;
    }
    // The job's progress names what is building rather than the last line printed.
    if (this.translation(job) !== null) this.store.set_progress(job.id, summarise(this.live_progress(job.id)));
    // A switch waiting on this job shows its output as it comes.
    if (waiting?.step_job_id === job.id) this.copy_step_output(this.store.job(waiting.job_id)!, waiting, this.store.job(job.id)!);
    if (followed.outcome === "running") return this.tend_switch(job);
    this.tended_switches.delete(job.id);
    this.http_checks_started.delete(job.id);
    let finished = this.store.job(job.id)!;
    // Whatever the job changed, the next cycle evaluates afresh.
    this.force_eval = true;
    if (job.kind === "build") {
      const target = this.attribute() ?? this.id;
      await record_builds(this.store, this.agents, finished, [{ target, store_path: built_store_path(finished.output), succeeded: finished.state === "succeeded" }], this.now());
    }
    const noun = capitalise(job_noun(job.kind));
    let event: { level: EventLevel; text: string } = finished.state === "succeeded"
      ? { level: "info", text: `${noun} finished` }
      : { level: "error", text: `${noun} failed: ${finished.error}` };
    if (is_switch_kind(job.kind)) {
      const judged = this.judge_switch(finished, noun);
      if (judged !== null) event = judged;
      finished = this.store.job(job.id)!;
    }
    this.store.add_event(this.id, this.now(), event.level, event.text);
    // A build on the host itself is compared with the running system at once, so the page shows what a switch changes.
    if (job.kind === "build" && finished.state === "succeeded" && job.agent === this.settings.host) await this.compute_diff(false, "schedule");
    // A switch waiting on this build moves on as soon as it ends.
    const switching = waiting?.step === "build" && waiting.step_job_id === job.id ? this.store.job(waiting.job_id) : null;
    if (switching != null) await this.advance_wait(switching, this.evaluation().switch_wait!);
  }

  // Reads a finished switch's marker lines, giving its job the reason it was refused or rolled back; null when plain.
  private judge_switch(finished: Job & { output: string }, noun: string): { level: EventLevel; text: string } | null {
    const verdict = switch_verdict(finished.output);
    const fail = (error: string) => this.store.finish_job(finished.id, "failed", finished.exit_code, error, finished.finished_epoch ?? this.now());
    if (verdict.refused !== null) {
      fail(`Refused before anything changed: ${verdict.refused}`);
      return { level: "error", text: `${noun} refused: ${verdict.refused}` };
    }
    const outcome = verdict.outcome;
    if (outcome === null) return null;
    if (outcome.kind === "rolled-back") {
      fail(`Rolled back to the previous system: ${outcome.reason}`);
      return { level: "error", text: `${noun} rolled back to the previous system: ${outcome.reason}` };
    }
    if (outcome.kind === "rollback-failed") {
      fail(`The rollback failed: ${outcome.reason}`);
      return { level: "error", text: `${noun} could not be rolled back: ${outcome.reason}` };
    }
    if (outcome.kind === "kept") return { level: "warning", text: `${noun} kept unconfirmed: ${outcome.reason}` };
    if (outcome.kind === "unknown") {
      fail(outcome.reason || "The watchdog never reported an outcome");
      return { level: "error", text: `${noun} ended without a word from its watchdog: ${outcome.reason}` };
    }
    return null;
  }

  // Confirms a guarded switch awaiting confirmation once its HTTP checks pass, or tells its watchdog to roll back.
  private async tend_switch(job: Job): Promise<void> {
    const token = watch_token(job.command);
    if (!is_switch_kind(job.kind) || token === null || this.tended_switches.has(job.id)) return;
    const verdict = switch_verdict(this.store.job(job.id)!.output);
    if (!verdict.awaiting_confirmation || verdict.outcome !== null) return;
    const agent = this.agents.get(this.agent_for(job.kind));
    const failure = await this.http_failure();
    if (failure !== null) {
      const started = this.http_checks_started.get(job.id) ?? this.now();
      this.http_checks_started.set(job.id, started);
      if (this.now() - started < this.settings.health_timeout) {
        this.store.set_progress(job.id, `Waiting for the HTTP checks: ${failure}`);
        return;
      }
      const reason = `HTTP health check failed: ${failure}`;
      const signalled = await agent.run(rollback_signal_operation(token, reason), { timeout_in_seconds: signal_timeout_in_seconds });
      if (signalled.exit_code !== 0) return;
      this.tended_switches.add(job.id);
      this.store.append_output(job.id, `${reason}; told the watchdog to roll back\n`);
      return;
    }
    const confirmed = await agent.run(confirm_operation(token), { timeout_in_seconds: signal_timeout_in_seconds });
    // A host X-Nix cannot reach now is tried again on the next poll, until the watchdog gives up on it.
    if (confirmed.exit_code !== 0) return;
    this.tended_switches.add(job.id);
    const checks = this.settings.health_urls.length > 0 ? `, every HTTP check passed,` : "";
    this.store.append_output(job.id, `X-Nix reached the host after the activation${checks} and confirmed the switch\n`);
  }

  // The first health check URL that fails, with why, or null when every one passes.
  private async http_failure(): Promise<string | null> {
    for (const url of this.settings.health_urls) {
      const failure = await this.http_check(url);
      if (failure !== null) return `${url}: ${failure}`;
    }
    return null;
  }

  // ── Package diff ─────────────────────────────────────────────────────────

  // Compares the running closure with the flake's, running the diff unless the last one compared the same two.
  diff(force: boolean): Promise<DiffOutcome> {
    return this.serial(() => this.compute_diff(force, "manual"));
  }

  private async compute_diff(force: boolean, trigger: string): Promise<DiffOutcome> {
    const from = this.reading()?.current ?? null;
    const evaluation = this.evaluation();
    const to = evaluation.target;
    if (from === null) return { diff: null, message: "The running system has not been read yet" };
    if (to === null) return { diff: null, message: "The flake has not been evaluated yet" };
    if (from === to) return { diff: null, message: "The running system is already the flake's" };
    if (!is_store_path(from) || !is_store_path(to)) return { diff: null, message: "The running or the flake's closure is not a store path" };
    const last = evaluation.last_diff;
    if (!force && last !== null && last.from === from && last.to === to && last.built && last.error === null) return { diff: last, message: null };
    const operation = diff_operation(this.settings, from, to);
    const result = await this.agents.get(this.settings.host).run(operation, { timeout_in_seconds: diff_timeout_in_seconds });
    if (result.exit_code === -1) return { diff: null, message: `Could not compare the closures: ${clip(result.stderr || result.stdout, 200)}` };
    const job_id = this.store.create_job({ deployment_id: this.id, kind: "diff", command: JSON.stringify(operation), agent: this.settings.host, run_id: null, trigger, started_epoch: this.now() });
    this.store.append_output(job_id, [result.stdout, result.stderr].filter(Boolean).join("\n"));
    const diff = parse_diff(result.stdout, from, to, this.now(), job_id);
    const ok = result.exit_code === 0 && diff.error === null;
    this.store.finish_job(job_id, ok ? "succeeded" : "failed", result.exit_code, ok ? null : diff.error ?? `Exited with status ${result.exit_code}`, this.now());
    const saved = this.evaluation();
    saved.last_diff = diff;
    this.store.save_evaluation(this.id, saved);
    return { diff, message: diff.built ? null : "The flake's closure is not in the host's store yet; Build it first, or the switch builds it" };
  }

  // ── Generations and rollback ─────────────────────────────────────────────

  // Reads every generation of the host's system profile.
  async generations(): Promise<{ generations: Generation[]; error: string | null }> {
    const result = await this.agents.get(this.settings.host).run(generations_operation(), { timeout_in_seconds: probe_timeout_in_seconds });
    const generations = parse_generations(result.stdout);
    if (generations.length === 0) return { generations, error: `Could not read the system profile's generations: ${clip(result.stderr || result.stdout, 200) || "none found"}` };
    return { generations, error: null };
  }

  // The closure size of each system generation, newest first, leaving out any nix could not size.
  async generation_sizes(): Promise<{ sizes: { generation: number; closure_size_bytes: number }[]; error: string | null }> {
    const { generations, error } = await this.generations();
    if (error !== null) return { sizes: [], error };
    const paths = generations.map((generation) => generation.path).filter(is_store_path);
    const result = await this.agents.get(this.settings.host).run(closure_size_operation(this.settings, paths), { timeout_in_seconds: closure_timeout_in_seconds });
    const sized = closure_sizes(result.stdout);
    if (sized.size === 0) return { sizes: [], error: `Could not size the system generations: ${clip(result.stderr || result.stdout, 200) || `status ${result.exit_code}`}` };
    const sizes = generations.flatMap((generation) => {
      const size = sized.get(generation.path);
      return size === undefined ? [] : [{ generation: generation.generation, closure_size_bytes: size }];
    });
    return { sizes, error: null };
  }

  // Activates an earlier generation of the system profile, recording why.
  roll_back(generation: number, reason: string): Promise<ActionOutcome> {
    return this.serial(async () => {
      if (this.running_job() !== null) return { ok: false, message: "A job is already running for this deployment", job_id: null };
      const { generations, error } = await this.generations();
      if (error !== null) return { ok: false, message: error, job_id: null };
      const chosen = generations.find((candidate) => candidate.generation === generation);
      if (chosen === undefined) return { ok: false, message: `Generation ${generation} is not one of the host's system generations`, job_id: null };
      if (chosen.current && chosen.profile) return { ok: false, message: `Generation ${generation} is already running`, job_id: null };
      const operation = rollback_operation(this.settings, generation, reason);
      const launched = await this.launch("rollback", operation, "manual", false);
      if (launched.job_id === null) {
        const job_id = this.record_failed_launch("rollback", operation, "manual", launched.error);
        return { ok: false, message: `Could not start the rollback: ${launched.error}`, job_id };
      }
      this.store.add_event(this.id, this.now(), "warning", `Rolling back to generation ${generation}: ${reason}`);
      return { ok: true, message: `Rollback to generation ${generation} started`, job_id: launched.job_id };
    });
  }

  // ── Closure browser ──────────────────────────────────────────────────────

  // Reads the dependency graph of the running closure, the flake's, or a generation's.
  async closure(selector: { which?: "current" | "target"; generation?: number }): Promise<{ tree: ClosureTree | null; error: string | null }> {
    let path: string | null;
    if (selector.generation !== undefined) {
      const { generations, error } = await this.generations();
      if (error !== null) return { tree: null, error };
      path = generations.find((candidate) => candidate.generation === selector.generation)?.path ?? null;
      if (path === null) return { tree: null, error: `Generation ${selector.generation} is not one of the host's system generations` };
    } else {
      path = selector.which === "target" ? this.evaluation().target : this.reading()?.current ?? null;
      if (path === null) return { tree: null, error: selector.which === "target" ? "The flake has not been evaluated yet" : "The running system has not been read yet" };
    }
    if (!is_store_path(path)) return { tree: null, error: `${path} is not a store path` };
    const result = await this.agents.get(this.settings.host).run(closure_operation(this.settings, path), { timeout_in_seconds: closure_timeout_in_seconds });
    if (result.exit_code !== 0) {
      const missing = selector.which === "target" ? "; the flake's closure may not be built on the host yet" : "";
      return { tree: null, error: `Could not read the closure of ${path}: ${clip(result.stderr || result.stdout, 300)}${missing}` };
    }
    const tree = parse_closure(result.stdout, path);
    return tree.paths.length === 0 ? { tree: null, error: `nix path-info printed nothing readable for ${path}` } : { tree, error: null };
  }
}

// ── Health checks ────────────────────────────────────────────────────────────

// Fetches a health check's URL from X-Nix, passing on any 2xx answer after redirects.
async function fetch_check(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(http_check_timeout_in_milliseconds) });
    await response.body?.cancel();
    return response.ok ? null : `answered ${response.status} ${response.statusText}`.trim();
  } catch (error) {
    return (error as Error).message;
  }
}

function is_switch_kind(kind: JobKind): kind is SwitchMode {
  return (switch_modes as string[]).includes(kind);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function blank_reading(): Reading {
  return {
    status: "unavailable", checked_epoch: 0, messages: [], hostname: null, current: null, booted: null, version: null, generation: null,
    switched_epoch: null, up_to_date: null, reboot_required: null, flake_reachable: null,
  };
}

// What the history and events call a job of this kind.
function job_noun(kind: JobKind): string {
  const nouns: Partial<Record<JobKind, string>> = {
    collect: "collection", "next-boot": "next boot", boot: "switch for the next boot", test: "test switch", "dry-activate": "dry activation",
    diff: "closure diff",
  };
  return nouns[kind] ?? kind;
}

function clip(text: string, length: number): string {
  return text.trim().slice(0, length);
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
