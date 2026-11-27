// One NixOS deployment: whether the running system is the one its flake evaluates to, and the jobs that bring it there.
//
// Every cycle reads the host's running system, booted system, generation and version with one cheap read. Every
// `eval_interval` it also evaluates the host's toplevel from the flake and reads `nix flake metadata`, as one long run
// that outlives a restart of the server; later cycles poll it and judge drift against the stored evaluation until it
// ends. A failed evaluation is retried after `retry_interval`. Build and switch run as long runs on the agent the
// settings name, one at a time, and every action lands in the job history with its output. With `auto_switch`, drift
// lasting `auto_switch_after` starts a switch once per target closure, once no earlier fleet stage holds it, and
// `build_at` starts a daily build. Updating
// the flake's lock is the flake's own job (see flake.ts).
// The store, boot entries and reboot are the host's own (see host.ts). A pin, from the settings
// or set on the page, fixes evaluation, build and switch at one commit or tag instead of the branch head.
//
// A switch runs in one of nixos-rebuild's modes, and with pre_switch_checks, health checks or magic_rollback it runs
// guarded (see nixos/switch.ts): while it waits for confirmation, each poll runs the HTTP checks and confirms, and once it
// ends its marker lines say whether it was refused or rolled back and why. No action waits on a cache, which only speeds
// things up: Build and a switch, started by a person, a fleet run or the drift, build where direct_on says. Built on the
// switching host, a switch runs nixos-rebuild at once; built elsewhere, its job builds there first, waiting while any other
// system build runs on that host, the build pushes the
// system to cache_url, and the switch fetches and activates it, but only when the build made the store path the
// evaluation named. Builds and switches use the commit last evaluated, and a switch waits for a fresh evaluation when
// that commit disagrees with the pin or with the flake's own reading on another host. A new action ends a switch still building first.
// Rollback activates any earlier generation of the system profile. Before a switch the page asks for the package diff between the running and the built closure,
// which runs as a job and is kept with the evaluation, and the closure browser reads any generation's dependency graph.
// With build_progress, a Build and a switch building on its host read nix's structured log into counts and a tree of what is
// building and downloading (see live_builds.ts).

// ── Imports ──────────────────────────────────────────────────────────────────

import { randomBytes } from "node:crypto";

import { format_age, format_duration } from "@x-tech-laboratories/x-libs/durations";

import { AgentError, type AgentPool, type RunResult } from "./agents/agent.ts";
import { built_store_path, record_builds } from "./builds.ts";
import type { Cache } from "./cache.ts";
import type { FlakeReading } from "./flake.ts";
import type { Host } from "./host.ts";
import { build_operation as cache_build_operation, parse_report } from "./nixos/attic.ts";
import { level_of_status, worse, type DeploymentSettings, type Status, type TimeOfDay } from "./config.ts";
import {
  closure_operation, closure_size_operation, closure_sizes, diff_operation, is_store_path, parse_closure, parse_diff, type ClosureDiff, type ClosureTree,
} from "./nixos/closure.ts";
import {
  build_operation, cache_holds_operation, eval_operation, split_eval_output, switch_modes, timed_out_exit_code, type SwitchMode,
} from "./nixos/commands.ts";
import {
  confirm_operation, generations_operation, has_health_checks, parse_generations, rollback_operation, rollback_signal_operation, switch_job_operation, switch_verdict, watch_token,
  type Generation,
} from "./nixos/switch.ts";
import { is_pin, local_path, parse_metadata, pinned_flake, short_revision } from "./nixos/flake.ts";
import { parse_probe, probe_operation, reboot_required, type ProbeFields } from "./nixos/probe.ts";
import { overdue_text } from "./overdue.ts";
import { build_translation, tend_build } from "./live_builds.ts";
import { follow, start_run, track_wake, type Followed } from "./runs.ts";
import { output_cut_line, type EventLevel, type Job, type JobKind, type JobWithOutput, type Store } from "./store.ts";
import {
  command_marker_token, marker_token_of, one_line, operation_of, quote_markers, unfetchable_exit_code, with_marker_token, type Operation,
} from "../shared/operations.ts";

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
  // The host that read flake_revision, the server's own when null; absent when unknown.
  evaluated_on?: string | null;
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
  // The Build job held until no other system builds on its host; absent when none is held.
  held_build?: number;
  // A switch set for the next boot, and the system running when it was, until the host runs another; absent when none waits.
  deferred_switch?: { reason: string; running: string | null };
  // The units that failed to start in the system a switch kept, until the host runs another; running is that system once read.
  units_failed?: { units: string; running: string | null };
  // The revision the host has run in sync with since when; absent while it drifts.
  in_sync?: { revision: string | null; since_epoch: number };
  // The revision the last switch failed or rolled back at, and why; absent once a switch succeeds.
  switch_failure?: { revision: string | null; reason: string };
  // The target an automatic switch was last noted as held for, so each hold is noted once.
  auto_switch_held?: string;
}

// What a switch waits on: a build on another host, or the system it built reaching the cache.
export type SwitchStep = "build" | "push";

// A switch job whose run starts once the steps it depends on have succeeded.
export interface SwitchWait {
  job_id: number;
  step: SwitchStep;
  // The step's own job, null until it starts or for a step that has none.
  step_job_id: number | null;
  // The store path the switch fetches from the cache, null until its build names it.
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
  // Has the flake with this id read its metadata again now, so its revision can be compared with the evaluation's.
  read_flake?: (flake_id: string) => void;
  // Why an automatic switch to this revision waits on other deployments, such as earlier fleet stages, or null when it need not.
  auto_switch_hold?: (deployment: Deployment, revision: string | null) => Message | null;
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

// The jobs that build a whole system, of which a Build or a switch's build starts only when none runs on that host: a
// fleet's systems drift together when their flake changes, and building them all at once on one host runs it out of memory.
const system_build_kinds: JobKind[] = ["build", "build-target", "build-all"];
// The hosts a build is starting on, held from before its run starts until its job names the run.
const starting_builds = new Set<string>();

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
  private readonly read_flake: (flake_id: string) => void;
  private readonly auto_switch_hold: (deployment: Deployment, revision: string | null) => Message | null;
  // The disagreement between the evaluation's revision and the flake's own reading last asked about, so each is asked about once.
  private revision_mismatch_asked: string | null = null;
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
    this.read_flake = options.read_flake ?? (() => {});
    this.auto_switch_hold = options.auto_switch_hold ?? (() => null);
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
    return this.settings.cache_id === null || this.pin() !== null ? null : this.building_cache();
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

  // Why an action cannot run now, or null when it can.
  action_refusal(action: ActionId): string | null {
    if (is_switch_kind(action) && this.build_step() !== null && this.settings.cache_url === null) {
      return `direct_on builds on ${this.host_name(this.agent_for("build"))}, which needs a cache_url to bring the system to ${this.host_name(this.agent_for("switch"))}`;
    }
    const running = this.running_job();
    const waiting = this.evaluation().switch_wait;
    // An action takes the place of a switch still building first, whose build is the running job until it ends.
    const replaceable = waiting !== undefined && running !== null && (running.id === waiting.job_id || running.id === waiting.step_job_id);
    if (running !== null && !(action !== "reboot" && replaceable)) return "A job is already running for this deployment";
    if (is_switch_kind(action) && this.build_step() !== null && this.evaluation().target === null) {
      return `The flake has not been evaluated yet, and a system built on ${this.host_name(this.agent_for("build"))} is only activated once it matches the evaluation`;
    }
    if (is_switch_kind(action)) return this.host?.collection_refusal() ?? this.revision_refusal();
    return null;
  }

  // Why the evaluation's revision disagrees with what the deployment's pin or the flake's own host says, or null when nothing independent disagrees.
  revision_refusal(evaluation: Evaluation = this.evaluation()): string | null {
    const revision = evaluation.flake_revision;
    if (revision === null) return null;
    const pin = this.pin();
    if (pin !== null) {
      if (!/^[0-9a-f]{40}$/.test(pin) || revision === pin) return null;
      return `The evaluation reports revision ${short_revision(revision)}, but the deployment is pinned at ${short_revision(pin)}`;
    }
    if (this.settings.flake_id === null || local_path(this.settings.flake) !== null) return null;
    const reading = this.store.reading<FlakeReading>(this.settings.flake_id);
    // Only a reading by another host than the evaluating one is independent of it.
    if (reading === null || reading.host === undefined || reading.revision === null || evaluation.evaluated_on === undefined) return null;
    if (this.same_host(reading.host, evaluation.evaluated_on)) return null;
    const reader = this.host_name(reading.host);
    const evaluator = this.host_name(evaluation.evaluated_on);
    if (reading.revision !== revision) {
      return `${evaluator} evaluated revision ${short_revision(revision)}, but ${reader} reads the flake at ${short_revision(reading.revision)}`;
    }
    const stamp = evaluation.flake_last_modified_epoch;
    if (reading.last_modified_epoch !== null && stamp !== null && reading.last_modified_epoch !== stamp) {
      return `${evaluator} reports revision ${short_revision(revision)} last changed at ${stamp}, but ${reader} reads ${reading.last_modified_epoch}`;
    }
    return null;
  }

  // Evaluates again and has the flake read again, once for each disagreement, recording it as an event.
  private ask_about_revision(mismatch: string): void {
    if (this.revision_mismatch_asked === mismatch) return;
    this.revision_mismatch_asked = mismatch;
    this.store.add_event(this.id, this.now(), "warning", `Not switching: ${mismatch}; evaluating again`);
    this.request_evaluation();
    if (this.settings.flake_id !== null) this.read_flake(this.settings.flake_id);
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

  // The settings with the flake reference fixed at the pin, which evaluation uses, and build and switch before any evaluation.
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
      if (job !== null) {
        await this.poll_job(job);
        // A check the cache finished while the job runs reaches the page now, not once the job ends.
        if (this.running_job() !== null && this.cache_check_unread()) await this.probe_cycle();
        return;
      }
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
        if (evaluation.in_sync === undefined || evaluation.in_sync.revision !== evaluation.flake_revision) evaluation.in_sync = { revision: evaluation.flake_revision, since_epoch: now };
        messages.push({ level: "info", text: "System matches the flake" });
      } else {
        delete evaluation.in_sync;
        raise(this.settings.drift_status);
        messages.push({ level: level_of_status[this.settings.drift_status], text: `System is out of date: ${this.effective_settings().flake} evaluates to ${target}, running ${fields.current}` });
        if (evaluation.drift_target !== target) {
          evaluation.drift_target = target;
          evaluation.drift_since_epoch = now;
        }
        // Armed only between jobs, so drift judged while a switch replaces the system never starts another after it.
        if (this.running_job() === null) messages.push(...this.consider_auto_switch(fields, evaluation, target, now));
      }
    }

    if (this.settings.auto_switch && !this.settings.magic_rollback && !has_health_checks(this.settings)) {
      raise("warning");
      messages.push({ level: "warning", text: "Switches automatically with nothing to roll a bad switch back: turn on magic_rollback or add health checks" });
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

    if (evaluation.deferred_switch !== undefined && evaluation.deferred_switch.running !== fields.current) delete evaluation.deferred_switch;
    if (evaluation.deferred_switch !== undefined) {
      raise(this.settings.reboot_status);
      messages.push({ level: level_of_status[this.settings.reboot_status], text: `Waiting on a reboot: ${evaluation.deferred_switch.reason}` });
    }
    const failed = evaluation.units_failed;
    if (failed !== undefined && failed.running === null) failed.running = fields.current;
    if (failed !== undefined && failed.running !== fields.current) delete evaluation.units_failed;
    if (evaluation.units_failed !== undefined) {
      raise("warning");
      messages.push({ level: "warning", text: `Some units failed to start after the last switch: ${evaluation.units_failed.units}` });
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

  // Whether the cache that evaluates this deployment finished a check newer than the evaluation last taken from it.
  private cache_check_unread(): boolean {
    const evaluating = this.evaluating_cache();
    const checked = evaluating?.cache.reading()?.evaluated_epoch ?? null;
    if (checked === null) return false;
    const taken = this.evaluation().evaluated_epoch;
    return taken === null || checked > taken;
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
    evaluation.evaluated_on = row.host;
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
    return this.fold_evaluation(failure, failure, this.agent_for("eval"));
  }

  // Advances the running evaluation, answering with its result once it has ended.
  private async poll_evaluation(job: Job): Promise<Evaluation | null> {
    const followed = await this.follow(job);
    if (followed.outcome === "unreachable") {
      const unreachable: RunResult = { exit_code: -1, stdout: "", stderr: `Could not poll the running evaluation: ${followed.error}` };
      return this.fold_evaluation(unreachable, unreachable, job.agent);
    }
    if (followed.outcome === "running") return null;
    const finished = this.store.job(job.id)!;
    const parts = split_eval_output(finished.output, `The evaluation ended before reporting: ${finished.error ?? "no output"}`, command_marker_token(finished.command));
    return this.fold_evaluation(parts.eval, parts.metadata, job.agent);
  }

  // Folds an evaluation and the flake metadata into the stored state, keeping the last good values of a half that failed.
  private fold_evaluation(eval_result: RunResult, metadata_result: RunResult, evaluated_on: string | null): Evaluation {
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
      evaluation.evaluated_on = evaluated_on;
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
    // The evaluation is saved after this, so the revision is judged from the one being assembled.
    const mismatch = this.revision_refusal(evaluation);
    if (mismatch !== null) {
      this.ask_about_revision(mismatch);
      return [{ level: "warning", text: `Not switching automatically: ${mismatch}; evaluating again` }];
    }
    const created = fields.profile_created_epoch ?? fields.switched_epoch;
    // A generation newer than the flake came from elsewhere, such as an unpushed checkout, and switching would undo it.
    if (created === null || evaluation.flake_last_modified_epoch === null || evaluation.flake_last_modified_epoch <= created) {
      return [{ level: "info", text: "Not switching automatically: the running generation is newer than the flake" }];
    }
    const stale = this.stale_inputs(evaluation, now);
    if (stale !== null) return [{ level: "warning", text: `Not switching automatically: ${stale}` }];
    const waited = now - (evaluation.drift_since_epoch ?? now);
    if (waited < this.settings.auto_switch_after) {
      return [{ level: "info", text: `Switching automatically once the drift has lasted ${format_duration(this.settings.auto_switch_after)}` }];
    }
    const hold = this.auto_switch_hold(this, evaluation.flake_revision);
    if (hold !== null) {
      const text = `Not switching automatically: ${hold.text}`;
      if (evaluation.auto_switch_held !== target) this.store.add_event(this.id, now, hold.level, text);
      evaluation.auto_switch_held = target;
      return [{ level: hold.level, text }];
    }
    const absent = this.absent_agent();
    if (absent !== null) return [{ level: "info", text: `Waiting to switch automatically: ${absent}` }];
    this.auto_switch_due = target;
    return [{ level: "warning", text: `Drift has lasted ${format_age(waited)}; switching automatically` }];
  }

  // Why the locked inputs are too old to switch to by itself, or null when auto_switch_max_input_age allows them or their age is unknown.
  private stale_inputs(evaluation: Evaluation, now: number): string | null {
    const limit = this.settings.auto_switch_max_input_age;
    const oldest = evaluation.inputs_last_modified_epoch;
    if (limit === null || oldest === null || now - oldest <= limit) return null;
    return `the oldest locked input ${evaluation.oldest_input ?? "?"} changed ${format_age(now - oldest)}, longer ago than the ${format_duration(limit)} auto_switch_max_input_age allows`;
  }

  private async launch_auto_switch(target: string): Promise<void> {
    this.auto_switch_due = null;
    // An agent that went away since the cycle that found the switch due starts nothing, and a later cycle tries again.
    if (this.absent_agent() !== null) return;
    // A collection on the host holds the switch off, and a later cycle finds it due again.
    if (this.host?.collection_refusal() != null) return;
    const mismatch = this.revision_refusal();
    if (mismatch !== null) return this.ask_about_revision(mismatch);
    // A hold that began since the cycle that found the switch due is noted by the next one.
    if (this.auto_switch_hold(this, this.evaluation().flake_revision) !== null) return;
    const operation = this.operation_for("switch");
    // Built elsewhere, the switch builds there first, as any switch does.
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

  // Why an agent the automatic switch needs is away and cannot be woken, or null when every one is connected or can be woken.
  private absent_agent(): string | null {
    const needed = this.build_step() === null ? [this.agent_for("switch")] : [this.agent_for("build"), this.agent_for("switch")];
    const absent = needed.find((host) => !this.agents.connected(host) && !this.agents.can_wake(host));
    return absent === undefined ? null : `agent '${this.host_name(absent)}' is not connected`;
  }

  // Whether the cache holds the system and the host can fetch all of it, the cache holds it but the host cannot, or neither.
  private async cache_holds(target: string, host: string | null = this.agent_for("switch")): Promise<"held" | "unfetchable" | "absent"> {
    const result = await this.agents.get(host).run(cache_holds_operation(this.settings, target), { timeout_in_seconds: cache_check_timeout_in_seconds });
    if (result.exit_code === 0) return "held";
    return result.exit_code === unfetchable_exit_code ? "unfetchable" : "absent";
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
    const held = this.hold_build("schedule");
    if (held !== null) {
      const evaluation = this.evaluation();
      evaluation.scheduled = { ...evaluation.scheduled, [kind]: slot };
      this.store.save_evaluation(this.id, evaluation);
      this.store.add_event(this.id, this.now(), "info", `Scheduled ${kind} waits: ${held.blocker}`);
      return;
    }
    const operation = this.operation_for(kind);
    const launched = await this.launch_guarded(kind, operation, "schedule", false);
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

  // Runs an action, naming in the job what started it, such as a person or a fleet run.
  act(action: ActionId, trigger = "manual"): Promise<ActionOutcome> {
    return this.serial(async () => {
      const refusal = this.action_refusal(action);
      const mismatch = is_switch_kind(action) ? this.revision_refusal() : null;
      if (refusal !== null && refusal === mismatch) {
        this.ask_about_revision(mismatch);
        return { ok: false, message: `${mismatch}; evaluating again before switching`, job_id: null };
      }
      if (refusal !== null) return { ok: false, message: refusal, job_id: null };
      if (action === "reboot") return this.host === null ? { ok: false, message: "No host to reboot", job_id: null } : this.host.act("reboot", trigger);
      const building = this.waiting_build();
      // A Build asked for while a switch builds first is that build, and the switch goes on.
      if (action === "build" && building !== null) return { ok: true, message: `Build already running, job #${building}`, job_id: building };
      this.preempt_wait(action, building);
      const operation = this.operation_for(action);
      if (is_switch_kind(action)) {
        const waiting = await this.wait_for_dependencies(action, operation, trigger, building);
        if (waiting !== null) return waiting;
      }
      if (action === "build") {
        const held = this.hold_build(trigger);
        if (held !== null) return { ok: true, message: `Build waits: ${held.blocker}; it starts once that ends`, job_id: held.job_id };
      }
      const launched = await this.launch_guarded(action, operation, trigger, true);
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

  // The hosts an action builds on, most preferred first, as direct_on says: the switching host, the server, or the hosts
  // of the cache that builds this deployment's system, else its build agents.
  private direct_agents(): (string | null)[] {
    if (this.settings.direct_on === "host") return [this.agent_for("switch")];
    if (this.settings.direct_on === "server") return [null];
    return this.building_cache()?.cache.settings.hosts ?? this.build_agents();
  }

  private direct_agent(): string | null {
    return this.agents.pick(this.direct_agents());
  }

  // What a switch builds first: nothing when it builds on the switching host, or with target_host, where nixos-rebuild builds it.
  private build_step(): SwitchStep | null {
    return this.settings.target_host !== null || this.same_host(this.agent_for("build"), this.agent_for("switch")) ? null : "build";
  }

  // What a build runs: its cache's build, which pushes what it built, at the commit last evaluated, else at the deployment's pin.
  private build_operation(): Operation {
    const building = this.building_cache();
    const settings = this.evaluated_settings();
    if (building === null) return build_operation(settings, this.attribute());
    return cache_build_operation({ ...building.cache.settings, flake: settings.flake }, building.name);
  }

  // The store path a build job made, read from a cache's build report or from what nix printed.
  private built_by(job: JobWithOutput): string | null {
    return parse_report(job.output, command_marker_token(job.command)).targets.get(this.attribute() ?? "")?.target ?? built_store_path(job.output);
  }

  // Why a system another host built may not be activated, or null when it is the system the deployment evaluated.
  private built_refusal(built: string): string | null {
    if (!is_store_path(built)) return `The build named ${JSON.stringify(clip(built, 200))} as the system it built, which is not a store path`;
    const target = this.evaluation().target;
    if (target === null) return `The build made ${built}, but there is no evaluation to check it against`;
    if (built !== target) return `The build made ${built}, but the flake evaluates to ${target}; only the evaluated system is activated`;
    return null;
  }

  // Fails a waiting switch whose build did not make the evaluated system, and evaluates again.
  private refuse_built(job: Job, reason: string): void {
    this.end_wait(job, `${reason}; nothing was activated, so evaluate and switch again`);
    this.request_evaluation();
  }

  // Starts a switch as a job that runs what it depends on first, or answers null when the switch can start at once; it
  // follows the build already running when given one, as when it takes the place of another switch.
  private async wait_for_dependencies(kind: SwitchMode, operation: Operation, trigger: string, building: number | null = null): Promise<ActionOutcome | null> {
    const step = this.build_step();
    if (step === null) return null;
    const run_id = `${this.id}-${kind}-${this.now()}-${randomBytes(3).toString("hex")}`;
    const job_id = this.store.create_job({
      deployment_id: this.id, kind, command: JSON.stringify(operation), agent: this.agent_for(kind), run_id, trigger, started_epoch: this.now(),
    });
    this.save_wait({ job_id, step, step_job_id: building, target: null, since_epoch: this.now() });
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
    if (waiting.step === "build") return { first: `building on ${this.host_name(this.agent_for("build"))}`, then: "it is built" };
    return { first: "waiting for the system to reach the cache", then: "it is there" };
  }

  // Moves a waiting switch along: starts its step once it can, follows it, and starts the switch's own run once nothing is left.
  private async advance_wait(job: Job, waiting: SwitchWait): Promise<void> {
    if (this.store.job(job.id)?.state !== "running") return this.save_wait(null);
    if (waiting.step === "build") return this.advance_build(job, waiting);
    if (waiting.step === "push") return this.advance_push(job, waiting);
    // A switch from before every action built where direct_on says may still wait on a step no switch takes now.
    return this.end_wait(job, `X-Nix no longer waits on the cache this way (${waiting.step}); switch again`);
  }

  // Builds where direct_on says, once no other build runs there, then switches once the system the build pushed reaches the cache.
  private async advance_build(job: Job, waiting: SwitchWait): Promise<void> {
    if (waiting.step_job_id === null) {
      const host = this.host_name(this.agent_for("build"));
      const blocker = this.build_blocker(host);
      if (blocker !== null) return this.store.set_progress(job.id, `Waiting to build on ${host}: ${blocker}`);
      const launched = await this.launch_guarded("build", this.build_operation(), job.trigger, false);
      if (launched.job_id === null) return this.end_wait(job, `Could not start the build: ${launched.error}`);
      this.save_wait({ ...waiting, step_job_id: launched.job_id });
      const where = this.host_name(this.store.job(launched.job_id)!.agent);
      this.store.append_output(job.id, `Building on ${where} first, job #${launched.job_id}\n`);
      return this.store.set_progress(job.id, `Building on ${where}`);
    }
    const build = this.store.job(waiting.step_job_id);
    if (build === null) return this.end_wait(job, "The build is gone from the history");
    // A build taken over from an earlier switch is older than this switch's job, so only the switch follows it.
    if (build.state === "running" && this.running_job()?.id !== build.id) {
      await this.poll_job(build);
      // A build that ended has moved the switch on already.
      const polled = this.store.job(build.id)!;
      if (polled.state === "running") this.store.set_progress(job.id, `Building on ${this.host_name(polled.agent)}${polled.progress ? `: ${polled.progress}` : ""}`);
      return;
    }
    this.copy_step_output(job, waiting, build);
    const where = this.host_name(build.agent);
    if (build.state === "running") return this.store.set_progress(job.id, `Building on ${where}${build.progress ? `: ${build.progress}` : ""}`);
    if (build.state === "failed") return this.end_wait(job, `The build on ${where} failed: ${build.error}`);
    const built = this.built_by(build) ?? waiting.target;
    if (built === null) return this.end_wait(job, `The build on ${where} finished without naming the system it built`);
    if (this.same_host(build.agent, job.agent)) return this.start_switch(job, built);
    this.save_wait({ job_id: job.id, step: "push", step_job_id: null, target: built, since_epoch: this.now() });
    return this.advance_push(job, this.evaluation().switch_wait!);
  }

  // Waits for a system built on another host to reach the cache, as a store watcher there pushes it.
  private async advance_push(job: Job, waiting: SwitchWait): Promise<void> {
    const target = waiting.target!;
    const refusal = this.built_refusal(target);
    if (refusal !== null) return this.refuse_built(job, refusal);
    const checker = this.agents.pick([job.agent, ...this.build_agents()], false);
    const holds = await this.cache_holds(target, checker).catch(() => "absent" as const);
    if (holds === "held") {
      this.store.append_output(job.id, "The cache holds the system; switching\n");
      return this.start_switch(job, target);
    }
    const where = this.host_name(checker);
    const waited = this.now() - waiting.since_epoch >= push_wait_in_seconds;
    // A host answers from a miss it cached before the push until its narinfo-cache-negative-ttl runs out.
    if (holds === "unfetchable") {
      if (!waited) return this.store.set_progress(job.id, `${target} is in the cache, but ${where} cannot fetch all of it yet; it may still hold a miss from before the push`);
      return this.end_wait(job, `${target} reached the cache, but ${where} could not fetch all of it; check its substituters and narinfo-cache-negative-ttl, and switch again`);
    }
    if (!waited) return this.store.set_progress(job.id, `Waiting for ${target} to reach the cache`);
    return this.end_wait(job, `${target} was built but never reached the cache; push it there, as attic watch-store does, and switch again`);
  }

  // Starts the waiting switch's own run, fetching and activating the store path its build made.
  private async start_switch(job: Job, target: string): Promise<void> {
    const refusal = this.built_refusal(target);
    if (refusal !== null) return this.refuse_built(job, refusal);
    const token = watch_token(job.command) ?? randomBytes(8).toString("hex");
    let operation: Operation;
    try {
      operation = with_marker_token(switch_job_operation(this.effective_settings(), job.kind as SwitchMode, token, target));
    } catch (error) {
      return this.end_wait(job, `Could not prepare the ${job_noun(job.kind)}: ${(error as Error).message}`);
    }
    this.save_wait(null);
    this.store.set_command(job.id, JSON.stringify(operation));
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

  // Why a build cannot start on the host now, or null when nothing else builds there; a held Build has no run yet, so it builds nothing.
  private build_blocker(host: string): string | null {
    if (starting_builds.has(host)) return "another build is starting there";
    const other = this.store.running_jobs(system_build_kinds).find((candidate) => candidate.run_id !== null && this.host_name(candidate.agent) === host);
    return other === undefined ? null : `job #${other.id} of ${other.deployment_id} is building there`;
  }

  // ── Held builds ──────────────────────────────────────────────────────────

  // Keeps a Build as a job without a run while another system builds on its host, answering null when it can start now.
  private hold_build(trigger: string): { job_id: number; blocker: string } | null {
    const agent = this.agent_for("build");
    const host = this.host_name(agent);
    const blocker = this.build_blocker(host);
    if (blocker === null) return null;
    const job_id = this.store.create_job({
      deployment_id: this.id, kind: "build", command: JSON.stringify(this.build_operation()), agent, run_id: null, trigger, started_epoch: this.now(),
    });
    this.store.set_progress(job_id, `Waiting to build on ${host}: ${blocker}`);
    const evaluation = this.evaluation();
    evaluation.held_build = job_id;
    this.store.save_evaluation(this.id, evaluation);
    return { job_id, blocker };
  }

  // Starts a held Build's run once nothing else builds on its host, building what the deployment builds by then.
  private async advance_held_build(job: Job): Promise<void> {
    const host = this.host_name(job.agent);
    const blocker = this.build_blocker(host);
    if (blocker !== null) return this.store.set_progress(job.id, `Waiting to build on ${host}: ${blocker}`);
    const operation = with_marker_token(this.build_operation());
    const run_id = `${this.id}-build-${this.now()}-${randomBytes(3).toString("hex")}`;
    starting_builds.add(host);
    let waking: Promise<void> | null;
    try {
      ({ waking } = await start_run(this.agents, job.agent, run_id, operation));
    } catch (error) {
      this.release_held_build();
      this.store.append_output(job.id, `${(error as Error).message}\n`);
      this.store.finish_job(job.id, "failed", null, "The job could not be started", this.now());
      this.store.add_event(this.id, this.now(), "error", `Could not start the build: ${(error as Error).message}`);
      return;
    } finally {
      starting_builds.delete(host);
    }
    this.release_held_build();
    this.store.set_command(job.id, JSON.stringify(operation));
    this.store.set_run_id(job.id, run_id);
    this.store.set_progress(job.id, `Building on ${host}`);
    this.store.add_event(this.id, this.now(), "info", `${job.trigger === "schedule" ? "Scheduled build" : "Build"} started`);
    if (waking !== null) {
      track_wake(this.store, job.id, host, waking, this.now, (error) => this.store.add_event(this.id, this.now(), "error", `Could not start the build: ${error}`));
    }
  }

  // Ends a held Build before its run starts, answering null when the job is not one.
  stop_held_build(job_id: number, by: string): Promise<{ ok: boolean; message: string; job_id: number } | null> {
    return this.serial(async () => {
      if (this.evaluation().held_build !== job_id || this.store.job(job_id)?.state !== "running") return null;
      this.release_held_build();
      const reason = `${by} stopped it before it started`;
      this.store.append_output(job_id, `${reason}\n`);
      this.store.finish_job(job_id, "failed", null, reason, this.now());
      this.store.add_event(this.id, this.now(), "warning", `${by} stopped job #${job_id} (build) before it started`);
      return { ok: true, message: `Stopped job #${job_id}`, job_id };
    });
  }

  private release_held_build(): void {
    const evaluation = this.evaluation();
    delete evaluation.held_build;
    this.store.save_evaluation(this.id, evaluation);
  }

  // The build a switch still building first follows, while it runs.
  private waiting_build(): number | null {
    const waiting = this.evaluation().switch_wait;
    if (waiting?.step !== "build" || waiting.step_job_id === null) return null;
    return this.store.job(waiting.step_job_id)?.state === "running" ? waiting.step_job_id : null;
  }

  // Ends a switch still building first, so a new action runs in its place; its build carries on for that action to take over.
  private preempt_wait(action: ActionId, building: number | null): void {
    const waiting = this.evaluation().switch_wait;
    const job = waiting === undefined ? null : this.store.job(waiting.job_id);
    if (job === null || job.state !== "running") return;
    this.save_wait(null);
    const reason = `A ${job_noun(action)} took its place before it started${building === null ? "" : `, taking over its build #${building}`}`;
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
    this.note_switch_end(job.kind, reason);
  }

  // Keeps the revision a switch or test failed at, with why, or forgets the last failure once one succeeds.
  private note_switch_end(kind: JobKind, failure: string | null): void {
    if (kind !== "switch" && kind !== "test") return;
    const evaluation = this.evaluation();
    if (failure === null) delete evaluation.switch_failure;
    else evaluation.switch_failure = { revision: evaluation.flake_revision, reason: failure };
    this.store.save_evaluation(this.id, evaluation);
  }

  // Shows in the switch's job what its step's job printed since the last poll, ending its last line once the step is done.
  private copy_step_output(job: Job, waiting: SwitchWait, step: Job & { output: string }): void {
    // A step's output shorter than what was copied had its middle cut, so copying goes on from the cut line.
    const cut_at = step.output.indexOf(output_cut_line);
    const resumed = cut_at === -1 ? 0 : cut_at + output_cut_line.length;
    const copied = (waiting.copied ?? 0) > step.output.length ? resumed : waiting.copied ?? 0;
    // A running step's last line may not have ended yet, so only whole lines are shown until it is done.
    const until = step.state === "running" ? step.output.lastIndexOf("\n") + 1 : step.output.length;
    if (until <= copied) return;
    // The step's marker lines were read with its own token, so copied ones are quoted and never read as the switch's.
    const text = quote_markers(step.output.slice(copied, until));
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

  private operation_for(kind: JobAction): Operation {
    if (kind === "build") return this.build_operation();
    // Each switch has its own token, naming the folder its watchdog and X-Nix share on the host.
    return switch_job_operation(this.evaluated_settings(), kind, randomBytes(8).toString("hex"));
  }

  // The settings with a remote flake fixed at the commit last evaluated, so every build and switch reads the system the
  // evaluation named even when the branch moves after it.
  private evaluated_settings(): DeploymentSettings {
    const settings = this.effective_settings();
    const revision = this.evaluation().flake_revision;
    if (revision === null || !/^[0-9a-f]{40}$/.test(revision) || local_path(settings.flake) !== null) return settings;
    const flake = pinned_flake(settings.flake, revision);
    return flake === null ? settings : { ...settings, flake };
  }

  // ── Jobs ─────────────────────────────────────────────────────────────────

  // The hosts that may run Build, most preferred first.
  build_agents(): (string | null)[] {
    return this.settings.build_agents.length > 0 ? this.settings.build_agents : [this.settings.host];
  }

  // The host whose agent runs a job of this kind; the build may run apart from the switch.
  agent_for(kind: JobKind): string | null {
    if (kind === "eval") return this.settings.eval_agent ?? this.settings.host;
    if (kind === "build") return this.direct_agent();
    if (kind === "reboot" || kind === "diff") return this.settings.host;
    return this.settings.switch_agent ?? this.settings.host;
  }

  private async launch(
    kind: JobKind, operation: Operation, trigger: string, announce: boolean, wake = kind !== "eval",
  ): Promise<{ job_id: number | null; error: string; unreachable: boolean }> {
    const agent = this.agent_for(kind);
    const run_id = `${this.id}-${kind}-${this.now()}-${randomBytes(3).toString("hex")}`;
    // Each run gets a marker token of its own, which the job keeps in its command.
    operation = with_marker_token(operation);
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

  // Launches a job, holding a build's host from other builds until its job names the run.
  private async launch_guarded(
    kind: JobKind, operation: Operation, trigger: string, announce: boolean,
  ): Promise<{ job_id: number | null; error: string; unreachable: boolean }> {
    if (kind !== "build") return this.launch(kind, operation, trigger, announce);
    const host = this.host_name(this.agent_for("build"));
    starting_builds.add(host);
    return this.launch(kind, operation, trigger, announce).finally(() => starting_builds.delete(host));
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
    return follow(this.store, this.agents, job, this.now, timed_out, build_translation(this.store, job, this.now));
  }

  private async poll_job(job: Job): Promise<void> {
    // A switch waiting on what it depends on has no run of its own to follow yet.
    const waiting = this.evaluation().switch_wait;
    if (waiting?.job_id === job.id) return this.advance_wait(job, waiting);
    if (this.evaluation().held_build === job.id) return this.advance_held_build(job);
    const followed = await this.follow(job);
    if (followed.outcome === "unreachable") {
      this.store.add_event(this.id, this.now(), "warning", `Could not poll the running ${job.kind}: ${followed.error}`);
      return;
    }
    // The job's progress names what is building rather than the last line printed.
    await tend_build(this.store, this.agents, job);
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
      await record_builds(this.store, this.agents, finished, [{ target, store_path: this.built_by(finished), succeeded: finished.state === "succeeded" }], this.now());
    }
    const noun = capitalise(job_noun(job.kind));
    let event: { level: EventLevel; text: string } = finished.state === "succeeded"
      ? { level: "info", text: `${noun} finished` }
      : { level: "error", text: `${noun} failed: ${finished.error}` };
    if (is_switch_kind(job.kind)) {
      const judged = this.judge_switch(finished, noun);
      if (judged !== null) event = judged;
      finished = this.store.job(job.id)!;
      this.note_switch_end(job.kind, finished.state === "succeeded" ? null : finished.error ?? "The switch failed");
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
    const verdict = switch_verdict(finished.output, command_marker_token(finished.command));
    const fail = (error: string) => this.store.finish_job(finished.id, "failed", finished.exit_code, error, finished.finished_epoch ?? this.now());
    if (verdict.refused !== null) {
      fail(`Refused before anything changed: ${verdict.refused}`);
      return { level: "error", text: `${noun} refused: ${verdict.refused}` };
    }
    const outcome = verdict.outcome;
    // A system kept although some of its units failed is still a switch that worked, with a warning naming them.
    const kept_with_failures = (): { level: EventLevel; text: string } | null => {
      if (verdict.units_failed === null || finished.state !== "succeeded") return null;
      this.store.save_evaluation(this.id, { ...this.evaluation(), units_failed: { units: verdict.units_failed, running: null } });
      return { level: "warning", text: `${noun} kept, but some units failed to start: ${verdict.units_failed}` };
    };
    if (outcome === null) return kept_with_failures();
    if (outcome.kind === "rolled-back") {
      fail(`Rolled back to the previous system: ${outcome.reason}`);
      return { level: "error", text: `${noun} rolled back to the previous system: ${outcome.reason}` };
    }
    if (outcome.kind === "rollback-failed") {
      fail(`The rollback failed: ${outcome.reason}`);
      return { level: "error", text: `${noun} could not be rolled back: ${outcome.reason}` };
    }
    if (outcome.kind === "unchanged") {
      const reason = verdict.activated ? `The checks failed, but the system had not changed, so nothing was rolled back: ${outcome.reason}` : `Nothing changed: ${outcome.reason}`;
      fail(reason);
      return { level: "error", text: `${noun} failed: ${reason}` };
    }
    if (outcome.kind === "kept") return { level: "warning", text: `${noun} kept unconfirmed: ${outcome.reason}` };
    if (outcome.kind === "deferred") {
      this.store.save_evaluation(this.id, { ...this.evaluation(), deferred_switch: { reason: outcome.reason, running: this.reading()?.current ?? null } });
      return { level: "warning", text: `${noun} set for the next boot: ${outcome.reason}` };
    }
    if (outcome.kind === "unknown") {
      fail(outcome.reason || "The watchdog never reported an outcome");
      return { level: "error", text: `${noun} ended without a word from its watchdog: ${outcome.reason}` };
    }
    return kept_with_failures();
  }

  // Confirms a guarded switch awaiting confirmation once its HTTP checks pass, or tells its watchdog to roll back.
  private async tend_switch(job: Job): Promise<void> {
    const token = watch_token(job.command);
    if (!is_switch_kind(job.kind) || token === null || this.tended_switches.has(job.id)) return;
    const current = this.store.job(job.id)!;
    const verdict = switch_verdict(current.output, command_marker_token(current.command));
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
      this.store.append_output(job.id, `${one_line(reason)}; told the watchdog to roll back\n`);
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
  diff(force: boolean, trigger = "manual"): Promise<DiffOutcome> {
    return this.serial(() => this.compute_diff(force, trigger));
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
    const operation = with_marker_token(diff_operation(this.settings, from, to));
    const result = await this.agents.get(this.settings.host).run(operation, { timeout_in_seconds: diff_timeout_in_seconds });
    if (result.exit_code === -1) return { diff: null, message: `Could not compare the closures: ${clip(result.stderr || result.stdout, 200)}` };
    const job_id = this.store.create_job({ deployment_id: this.id, kind: "diff", command: JSON.stringify(operation), agent: this.settings.host, run_id: null, trigger, started_epoch: this.now() });
    this.store.append_output(job_id, [result.stdout, result.stderr].filter(Boolean).join("\n"));
    const diff = parse_diff(result.stdout, from, to, this.now(), job_id, marker_token_of(operation));
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
  roll_back(generation: number, reason: string, trigger = "manual"): Promise<ActionOutcome> {
    return this.serial(async () => {
      if (this.running_job() !== null) return { ok: false, message: "A job is already running for this deployment", job_id: null };
      const collecting = this.host?.collection_refusal() ?? null;
      if (collecting !== null) return { ok: false, message: collecting, job_id: null };
      const { generations, error } = await this.generations();
      if (error !== null) return { ok: false, message: error, job_id: null };
      const chosen = generations.find((candidate) => candidate.generation === generation);
      if (chosen === undefined) return { ok: false, message: `Generation ${generation} is not one of the host's system generations`, job_id: null };
      if (chosen.current && chosen.profile) return { ok: false, message: `Generation ${generation} is already running`, job_id: null };
      const operation = rollback_operation(this.settings, generation, reason);
      const launched = await this.launch("rollback", operation, trigger, false);
      if (launched.job_id === null) {
        const job_id = this.record_failed_launch("rollback", operation, trigger, launched.error);
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
