// One NixOS deployment: whether the running system is the one its flake evaluates to, and the jobs that bring it there.
//
// Every cycle reads the host's running system, booted system, generation and version with one cheap script. Every
// `eval_interval` it also evaluates the host's toplevel from the flake and reads `nix flake metadata`, as one long run
// that outlives a restart of the server; later cycles poll it and judge drift against the stored evaluation until it
// ends. A failed evaluation is retried after `retry_interval`. Update, build and switch run as long runs on the agent
// the settings name, one at a time, and every action lands in the job history with its output. With `auto_switch`, drift
// lasting `auto_switch_after` starts a switch once per target closure, and `update_at` and `build_at` start a daily job.
// Unless `gc` is false, every cycle also reads the host's Nix store and its garbage collection, judged apart from the
// deployment's own status, and Collect Garbage runs the same collection the timer does. Unless `boot` is false, every
// cycle also reads the boot loader's entries, and the next boot can be set to any of them once. A pin, from the settings
// or set on the page, fixes evaluation, build and switch at one commit or tag instead of the branch head.
//
// A switch runs in one of nixos-rebuild's modes, and with pre_switch_checks, health checks or magic_rollback it runs
// guarded (see nixos/switch.ts): while it waits for confirmation, each poll runs the HTTP checks and confirms, and once
// it ends its marker lines say whether it was refused or rolled back and why. Rollback activates any earlier generation
// of the system profile. Before a switch the page asks for the package diff between the running and the built closure,
// which runs as a job and is kept with the evaluation, and the closure browser reads any generation's dependency graph.
// A Build with build_progress reads nix's structured log into counts of what is building and downloading.

// ── Imports ──────────────────────────────────────────────────────────────────

import { randomBytes } from "node:crypto";

import { AgentError, type AgentPool, type RunResult } from "./agents/agent.ts";
import { built_store_path, record_builds } from "./builds.ts";
import { level_of_status, worse, type DeploymentSettings, type GcSettings, type Status, type TimeOfDay } from "./config.ts";
import { format_age, format_duration } from "./durations.ts";
import { empty_progress, read_build_log, summarise, type BuildProgress } from "./nixos/build_log.ts";
import { closure_command, diff_command, is_store_path, parse_closure, parse_diff, type ClosureDiff, type ClosureTree } from "./nixos/closure.ts";
import {
  build_command, can_update, eval_command, reboot_command, split_eval_output, switch_from_cache_command, switch_modes,
  timed_out_exit_code, update_command, type SwitchMode,
} from "./nixos/commands.ts";
import {
  confirm_command, generations_script, parse_generations, rollback_command, rollback_signal_command, switch_job_command, switch_verdict, watch_token,
  type Generation,
} from "./nixos/switch.ts";
import { boot_script, next_boot_command, parse_boot, type Boot } from "./nixos/boot.ts";
import { is_pin, parse_metadata, pinned_flake, short_revision } from "./nixos/flake.ts";
import {
  assess_store, collect_command, finished_collection, fold_collection, gc_probe_script, observed_collection, parse_gc_probe, unread_store,
  type Collection, type StoreReading,
} from "./nixos/garbage.ts";
import { parse_probe, probe_script, reboot_required, type ProbeFields } from "./nixos/probe.ts";
import { follow, type Followed, type Translate } from "./runs.ts";
import type { EventLevel, Job, JobKind, Store } from "./store.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export type ScheduledKind = "update" | "build";
export type ActionId = "update" | "build" | "switch" | "reboot" | "collect" | "boot" | "test" | "dry-activate";

export const action_ids: ActionId[] = ["update", "build", "switch", "reboot", "collect", "boot", "test", "dry-activate"];

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
  // The last garbage collection seen, kept after the journal has rotated past it.
  last_collection: Collection | null;
  // The pin set on the page, null to follow the branch head, or absent to use the settings' pin.
  pin_override?: string | null;
  // The last package diff between a running closure and a built one.
  last_diff: ClosureDiff | null;
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
  // The host's Nix store, with its own status; null when it is not watched.
  store: StoreReading | null;
  // The host's boot entries; null when they are not read, or could not be.
  boot: Boot | null;
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
  // Called once a switch has succeeded, such as to upload the host's secrets again.
  after_switch?: (deployment: Deployment) => void;
}

// What a request for the package diff answers: the diff, or why there is none.
export interface DiffOutcome {
  diff: ClosureDiff | null;
  message: string | null;
}

const empty_evaluation: Evaluation = {
  evaluated_epoch: null, target: null, eval_error: null, eval_unreachable: false, metadata_error: null, flake_revision: null,
  flake_last_modified_epoch: null, oldest_input: null, inputs_last_modified_epoch: null, drift_target: null, drift_since_epoch: null,
  auto_switch_target: null, scheduled: {}, last_collection: null, last_diff: null,
};

// The jobs that hold the deployment's buttons; an evaluation runs beside them.
const main_job_kinds: JobKind[] = ["update", "build", "switch", "boot", "test", "dry-activate", "rollback", "collect"];

const probe_timeout_in_seconds = 60;
const reboot_timeout_in_seconds = 60;
const diff_timeout_in_seconds = 300;
const closure_timeout_in_seconds = 120;
// How long confirming a switch or telling its watchdog to roll back may take.
const signal_timeout_in_seconds = 60;
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
  private readonly after_switch: ((deployment: Deployment) => void) | null;
  // Set when a job ends or the running closure changes, so the next cycle evaluates at once.
  private force_eval = false;
  // The target an automatic switch is due for on the next cycle.
  private auto_switch_due: string | null = null;
  // Cycles and actions run one at a time.
  private queue: Promise<unknown> = Promise.resolve();
  private readonly http_check: (url: string) => Promise<string | null>;
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
    this.after_switch = options.after_switch ?? null;
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

  running_evaluation(): Job | null {
    return this.store.running_job(this.id, ["eval"]);
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
    if (action === "update" && !can_update(this.settings)) {
      return `Cannot update ${this.settings.flake}: only a local checkout, or a github: flake with a push_ssh_key, has a lock file X-Nix can write`;
    }
    if (action === "collect" && this.settings.gc === null) return "The store is not watched for this deployment; its gc is off";
    if (action === "switch" && this.settings.switch_from_cache && this.cached_target() === null) {
      return "Switching from the cache needs the store path of a successful evaluation; evaluate first";
    }
    if (this.running_job() !== null) return "A job is already running for this deployment";
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
  }

  // Whether the deployment waits on a fresh evaluation before its drift can be trusted.
  sync_pending(): boolean {
    return this.running_evaluation() !== null || this.due_for_evaluation();
  }

  // Runs one cycle; asked for by a person, it evaluates unless an evaluation is already running.
  cycle(options: { force_eval?: boolean } = {}): Promise<void> {
    return this.serial(async () => {
      if (options.force_eval && this.running_evaluation() === null) this.force_eval = true;
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
    const evaluation_job = this.running_evaluation();
    let evaluating: Promise<Evaluation | null> = Promise.resolve(null);
    if (evaluation_job !== null) evaluating = this.poll_evaluation(evaluation_job);
    // An evaluation on another host needs the target's attribute name, which the first probe supplies.
    else if (this.due_for_evaluation() && !(this.settings.eval_agent !== null && this.attribute() === null)) evaluating = this.launch_evaluation();
    const agent = this.agents.get(this.settings.host);
    const gc = this.settings.gc;
    const [probe, gc_probe, boot_probe, folded] = await Promise.all([
      agent.run(probe_script(), probe_timeout_in_seconds),
      gc === null ? null : agent.run(gc_probe_script(gc), probe_timeout_in_seconds),
      this.settings.boot ? agent.run(boot_script(this.settings.require_sudo), probe_timeout_in_seconds) : null,
      evaluating,
    ]);
    const evaluation = folded ?? this.evaluation();
    const store = gc === null ? null : this.read_store(gc, gc_probe!, evaluation);
    // A boot read that reached nothing keeps the entries last seen.
    const boot = boot_probe === null ? null : boot_probe.stdout.trim() === "" ? this.reading()?.boot ?? null : parse_boot(boot_probe.stdout);

    if (probe.exit_code !== 0 && probe.stdout.trim() === "") {
      return this.save_unavailable(`Could not read the deployed system: ${clip(probe.stderr || probe.stdout, 200)}`, evaluation, store, boot);
    }
    const fields = parse_probe(probe.stdout);
    if (fields.current === null) return this.save_unavailable("/run/current-system is unreadable; is this a NixOS host?", evaluation, store, boot);
    this.assemble(fields, evaluation, folded !== null, store, boot);
  }

  private save_unavailable(text: string, evaluation: Evaluation, store: StoreReading | null, boot: Boot | null): void {
    this.store.save_evaluation(this.id, evaluation);
    const previous = this.reading();
    this.save_reading({
      ...(previous ?? blank_reading()),
      status: "unavailable",
      checked_epoch: this.now(),
      messages: [{ level: "warning", text }],
      store,
      boot,
    });
  }

  // Reads the store from its probe, folding the last collection it shows into the evaluation.
  private read_store(gc: GcSettings, result: RunResult, evaluation: Evaluation): StoreReading {
    const unavailable = (text: string): StoreReading => ({
      ...(this.reading()?.store ?? unread_store(gc)),
      status: "unavailable",
      checked_epoch: this.now(),
      messages: [{ level: "warning", text }],
    });
    if (result.exit_code !== 0 && result.stdout.trim() === "") return unavailable(`Could not read the Nix store: ${clip(result.stderr || result.stdout, 200)}`);
    const fields = parse_gc_probe(result.stdout);
    if (fields.df === "") return unavailable(`${gc.store} is unreadable; is Nix installed on this host?`);
    evaluation.last_collection = fold_collection(evaluation.last_collection, observed_collection(fields));
    return assess_store(gc, fields, evaluation.last_collection, this.now());
  }

  // Turns the probe's facts and the evaluation into this cycle's reading and worst-of status.
  private assemble(fields: ProbeFields, evaluation: Evaluation, evaluated: boolean, store: StoreReading | null, boot: Boot | null): void {
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
      const age = now - evaluation.inputs_last_modified_epoch;
      const stale = this.settings.max_input_age !== null && age > this.settings.max_input_age;
      if (stale) raise("warning");
      messages.push({
        level: stale ? "warning" : "info",
        text: `Oldest locked input ${evaluation.oldest_input ?? "?"} is ${format_age(age)}${stale ? `, over the ${format_duration(this.settings.max_input_age!)} limit` : ""}`,
      });
    }

    // A schedule seen for the first time starts at its next slot, never at once.
    for (const [kind, at] of this.schedule()) evaluation.scheduled[kind] ??= latest_slot(at, now);
    if (this.settings.update_at !== null && !can_update(this.settings)) {
      raise("warning");
      messages.push({ level: "warning", text: `Scheduled update never runs: ${this.settings.flake} has no lock file X-Nix can write` });
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
      store,
      boot,
    });
  }

  // Saves the reading, noting a change of the deployment's or the store's status as an event.
  private save_reading(reading: Reading): void {
    const previous = this.reading();
    this.store.save_reading(this.id, reading);
    this.note_change(previous?.status ?? null, reading.status, reading.messages, reading.checked_epoch, "Now");
    if (reading.store !== null) this.note_change(previous?.store?.status ?? null, reading.store.status, reading.store.messages, reading.store.checked_epoch, "Store now");
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
    if (this.force_eval) return true;
    const evaluation = this.evaluation();
    if (evaluation.evaluated_epoch === null) return true;
    // A failed evaluation waits only retry_interval, so a fix is seen soon.
    const failed = evaluation.eval_error !== null || evaluation.metadata_error !== null;
    return this.now() - evaluation.evaluated_epoch >= (failed ? this.settings.retry_interval : this.settings.eval_interval);
  }

  // Starts the evaluation, answering with a failed evaluation if it could not start.
  private async launch_evaluation(): Promise<Evaluation | null> {
    this.force_eval = false;
    const launched = await this.launch("eval", eval_command(this.effective_settings(), this.attribute()), "schedule", false);
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
    const command = this.command_for("switch");
    const launched = await this.launch("switch", command, "automatic", false);
    // A host that never answered started nothing, so a later cycle may try again.
    if (launched.unreachable) {
      this.store.add_event(this.id, this.now(), "warning", `Could not start the automatic switch: ${launched.error}`);
      return;
    }
    const evaluation = this.evaluation();
    evaluation.auto_switch_target = target;
    this.store.save_evaluation(this.id, evaluation);
    if (launched.job_id === null) this.record_failed_launch("switch", command, "automatic", launched.error);
    else this.store.add_event(this.id, this.now(), "info", "Automatic switch started");
  }

  // ── Daily jobs ───────────────────────────────────────────────────────────

  private schedule(): [ScheduledKind, TimeOfDay][] {
    const entries: [ScheduledKind, TimeOfDay | null][] = [["update", this.settings.update_at], ["build", this.settings.build_at]];
    return entries.filter((entry): entry is [ScheduledKind, TimeOfDay] => entry[1] !== null);
  }

  // The first daily job whose latest slot is newer than the one last handled, update before build.
  scheduled_due(): { kind: ScheduledKind; slot: number } | null {
    const handled = this.evaluation().scheduled;
    const now = this.now();
    for (const [kind, at] of this.schedule()) {
      if (kind === "update" && !can_update(this.settings)) continue;
      const slot = latest_slot(at, now);
      const last = handled[kind];
      if (last !== undefined && slot > last) return { kind, slot };
    }
    return null;
  }

  private async launch_scheduled(kind: ScheduledKind, slot: number): Promise<void> {
    const command = this.command_for(kind);
    const launched = await this.launch(kind, command, "schedule", false);
    // A host that never answered started nothing, so a later cycle may try again.
    if (launched.unreachable) {
      this.store.add_event(this.id, this.now(), "warning", `Could not start the scheduled ${kind}: ${launched.error}`);
      return;
    }
    const evaluation = this.evaluation();
    evaluation.scheduled = { ...evaluation.scheduled, [kind]: slot };
    this.store.save_evaluation(this.id, evaluation);
    if (launched.job_id === null) this.record_failed_launch(kind, command, "schedule", launched.error);
    else this.store.add_event(this.id, this.now(), "info", `Scheduled ${kind} started`);
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  // Runs an action, naming in the job what started it, such as a person or a fleet run.
  act(action: ActionId, trigger = "manual"): Promise<ActionOutcome> {
    return this.serial(async () => {
      const refusal = this.action_refusal(action);
      if (refusal !== null) return { ok: false, message: refusal, job_id: null };
      if (action === "reboot") return this.reboot(trigger);
      const command = this.command_for(action);
      const launched = await this.launch(action, command, trigger, true);
      if (launched.job_id === null) {
        const job_id = this.record_failed_launch(action, command, trigger, launched.error);
        return { ok: false, message: `Could not start the ${job_noun(action)}: ${launched.error}`, job_id };
      }
      return { ok: true, message: `${capitalise(job_noun(action))} started`, job_id: launched.job_id };
    });
  }

  // The reboot is for the probed host itself, and runs as a command rather than a job that would die with it.
  private async reboot(trigger: string): Promise<ActionOutcome> {
    const command = reboot_command(this.settings);
    const result = await this.agents.get(this.settings.host).run(command, reboot_timeout_in_seconds);
    const job_id = this.store.create_job({
      deployment_id: this.id, kind: "reboot", command, agent: this.settings.host, run_id: null, trigger, started_epoch: this.now(),
    });
    this.store.append_output(job_id, [result.stdout, result.stderr].filter(Boolean).join("\n"));
    const ok = result.exit_code === 0;
    this.store.finish_job(job_id, ok ? "succeeded" : "failed", result.exit_code, ok ? null : `Exited with status ${result.exit_code}`, this.now());
    this.store.add_event(this.id, this.now(), ok ? "info" : "error", ok ? "Reboot requested" : `Could not reboot: ${clip(result.stderr || result.stdout, 200)}`);
    return { ok, message: ok ? "Reboot requested" : `Could not reboot: ${clip(result.stderr || result.stdout, 200)}`, job_id };
  }

  // Why the next boot cannot be set to this entry now, or null when it can.
  next_boot_refusal(entry: string): string | null {
    if (!this.settings.boot) return "Boot entries are not read for this deployment; its boot is off";
    const boot = this.reading()?.boot ?? null;
    if (boot === null || boot.loader === "none") return "No boot loader X-Nix can set has been read on this host";
    if (!boot.entries.some((candidate) => candidate.id === entry)) return `'${entry}' is not one of the host's boot entries`;
    if (this.running_job() !== null) return "A job is already running for this deployment";
    return null;
  }

  // Sets the entry the host boots into once, then reboots when asked; a command rather than a job, as a reboot ends it.
  set_next_boot(entry: string, reboot: boolean): Promise<ActionOutcome> {
    return this.serial(async () => {
      const refusal = this.next_boot_refusal(entry);
      if (refusal !== null) return { ok: false, message: refusal, job_id: null };
      const reading = this.reading()!;
      const boot = reading.boot!;
      const title = boot.entries.find((candidate) => candidate.id === entry)!.title;
      const command = next_boot_command(boot, entry, reboot, this.settings.require_sudo);
      const result = await this.agents.get(this.settings.host).run(command, reboot_timeout_in_seconds);
      const job_id = this.store.create_job({
        deployment_id: this.id, kind: "next-boot", command, agent: this.settings.host, run_id: null, trigger: "manual", started_epoch: this.now(),
      });
      this.store.append_output(job_id, [result.stdout, result.stderr].filter(Boolean).join("\n"));
      const ok = result.exit_code === 0;
      this.store.finish_job(job_id, ok ? "succeeded" : "failed", result.exit_code, ok ? null : `Exited with status ${result.exit_code}`, this.now());
      const message = ok
        ? `Next boot set to ${title}${reboot ? "; rebooting" : ""}`
        : `Could not set the next boot to ${title}: ${clip(result.stderr || result.stdout, 200)}`;
      this.store.add_event(this.id, this.now(), ok ? "info" : "error", message);
      if (ok) {
        // Shown at once, rather than after the next cycle reads it back.
        this.store.save_reading(this.id, { ...reading, boot: { ...boot, next: entry, entries: boot.entries.map((candidate) => ({ ...candidate, next: candidate.id === entry })) } });
      }
      return { ok, message, job_id };
    });
  }

  private command_for(kind: JobAction): string {
    if (kind === "update") return update_command(this.settings);
    if (kind === "collect") return collect_command(this.settings.gc!, this.settings.require_sudo);
    if (kind === "build") return build_command(this.effective_settings(), this.attribute());
    const target = this.cached_target();
    if (kind === "switch" && this.settings.switch_from_cache && target !== null) return switch_from_cache_command(this.effective_settings(), target);
    // Each switch has its own token, naming the folder its watchdog and X-Nix share on the host.
    return switch_job_command(this.effective_settings(), kind, randomBytes(8).toString("hex"));
  }

  // The store path a switch from the cache activates: the last evaluation's, unless that evaluation failed.
  cached_target(): string | null {
    const evaluation = this.evaluation();
    return evaluation.eval_error === null && evaluation.target !== null && is_store_path(evaluation.target) ? evaluation.target : null;
  }

  // ── Jobs ─────────────────────────────────────────────────────────────────

  // The host whose agent runs a job of this kind; the build may run apart from the switch and update.
  agent_for(kind: JobKind): string | null {
    if (kind === "eval") return this.settings.eval_agent ?? this.settings.host;
    if (kind === "build") return this.settings.build_agent ?? this.settings.host;
    if (kind === "reboot" || kind === "collect" || kind === "diff") return this.settings.host;
    return this.settings.switch_agent ?? this.settings.host;
  }

  private async launch(kind: JobKind, command: string, trigger: string, announce: boolean): Promise<{ job_id: number | null; error: string; unreachable: boolean }> {
    const agent = this.agent_for(kind);
    const run_id = `${this.id}-${kind}-${this.now()}-${randomBytes(3).toString("hex")}`;
    try {
      await this.agents.get(agent).start(run_id, command);
    } catch (error) {
      const unreachable = error instanceof AgentError && error.unreachable;
      return { job_id: null, error: (error as Error).message, unreachable };
    }
    const job_id = this.store.create_job({ deployment_id: this.id, kind, command, agent, run_id, trigger, started_epoch: this.now() });
    if (announce) this.store.add_event(this.id, this.now(), "info", `${capitalise(job_noun(kind))} started`);
    return { job_id, error: "", unreachable: false };
  }

  // Keeps a job that could not start in the history, with why.
  private record_failed_launch(kind: JobKind, command: string, trigger: string, error: string): number {
    const job_id = this.store.create_job({ deployment_id: this.id, kind, command, agent: this.agent_for(kind), run_id: null, trigger, started_epoch: this.now() });
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
    const followed = await this.follow(job);
    if (followed.outcome === "unreachable") {
      this.store.add_event(this.id, this.now(), "warning", `Could not poll the running ${job.kind}: ${followed.error}`);
      return;
    }
    // The job's progress names what is building rather than the last line printed.
    if (this.translation(job) !== null) this.store.set_progress(job.id, summarise(this.live_progress(job.id)));
    if (followed.outcome === "running") return this.tend_switch(job);
    this.tended_switches.delete(job.id);
    this.http_checks_started.delete(job.id);
    let finished = this.store.job(job.id)!;
    if (job.kind === "collect") {
      // A manual collection is the last collection, just as a timer run would be.
      const evaluation = this.evaluation();
      evaluation.last_collection = finished_collection(finished.output, finished.state === "succeeded", finished.error, this.now());
      this.store.save_evaluation(this.id, evaluation);
    } else {
      // Whatever the job changed, the next cycle evaluates afresh.
      this.force_eval = true;
    }
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
    if (job.kind === "build" && finished.state === "succeeded" && this.agent_for("build") === this.settings.host) await this.compute_diff(false, "schedule");
    // Whatever account a key belongs to may have just appeared, so an activation that stood lets the secrets follow.
    if (finished.state === "succeeded" && (job.kind === "switch" || job.kind === "test" || job.kind === "rollback")) this.after_switch?.(this);
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
      const signalled = await agent.run(rollback_signal_command(this.settings, token, reason), signal_timeout_in_seconds);
      if (signalled.exit_code !== 0) return;
      this.tended_switches.add(job.id);
      this.store.append_output(job.id, `${reason}; told the watchdog to roll back\n`);
      return;
    }
    const confirmed = await agent.run(confirm_command(this.settings, token), signal_timeout_in_seconds);
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
    const command = diff_command(this.settings, from, to);
    const result = await this.agents.get(this.settings.host).run(command, diff_timeout_in_seconds);
    if (result.exit_code === -1) return { diff: null, message: `Could not compare the closures: ${clip(result.stderr || result.stdout, 200)}` };
    const job_id = this.store.create_job({ deployment_id: this.id, kind: "diff", command, agent: this.settings.host, run_id: null, trigger, started_epoch: this.now() });
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
    const result = await this.agents.get(this.settings.host).run(generations_script(), probe_timeout_in_seconds);
    const generations = parse_generations(result.stdout);
    if (generations.length === 0) return { generations, error: `Could not read the system profile's generations: ${clip(result.stderr || result.stdout, 200) || "none found"}` };
    return { generations, error: null };
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
      const command = rollback_command(this.settings, generation, reason);
      const launched = await this.launch("rollback", command, "manual", false);
      if (launched.job_id === null) {
        const job_id = this.record_failed_launch("rollback", command, "manual", launched.error);
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
    const result = await this.agents.get(this.settings.host).run(closure_command(this.settings, path), closure_timeout_in_seconds);
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
    switched_epoch: null, up_to_date: null, reboot_required: null, flake_reachable: null, store: null, boot: null,
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
