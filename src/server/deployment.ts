// One NixOS deployment: whether the running system is the one its flake evaluates to, and the jobs that bring it there.
//
// Every cycle reads the host's running system, booted system, generation and version with one cheap script. Every
// `eval_interval` it also evaluates the host's toplevel from the flake and reads `nix flake metadata`, as one long run
// that outlives a restart of the server; later cycles poll it and judge drift against the stored evaluation until it
// ends. A failed evaluation is retried after `retry_interval`. Update, build and switch run as long runs on the agent
// the settings name, one at a time, and every action lands in the job history with its output. With `auto_switch`, drift
// lasting `auto_switch_after` starts a switch once per target closure, and `update_at` and `build_at` start a daily job.

// ── Imports ──────────────────────────────────────────────────────────────────

import { randomBytes } from "node:crypto";

import { AgentError, type AgentPool, type RunResult } from "./agents/agent.ts";
import { worse, type DeploymentSettings, type Status, type TimeOfDay } from "./config.ts";
import { format_age, format_duration } from "./durations.ts";
import {
  build_command, can_update, eval_command, reboot_command, split_eval_output, switch_command, timed_out_exit_code, update_command,
} from "./nixos/commands.ts";
import { parse_metadata, short_revision } from "./nixos/flake.ts";
import { parse_probe, probe_script, reboot_required, type ProbeFields } from "./nixos/probe.ts";
import type { EventLevel, Job, JobKind, Store } from "./store.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export type ScheduledKind = "update" | "build";
export type ActionId = "update" | "build" | "switch" | "reboot";

export const action_ids: ActionId[] = ["update", "build", "switch", "reboot"];

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
}

const empty_evaluation: Evaluation = {
  evaluated_epoch: null, target: null, eval_error: null, eval_unreachable: false, metadata_error: null, flake_revision: null,
  flake_last_modified_epoch: null, oldest_input: null, inputs_last_modified_epoch: null, drift_target: null, drift_since_epoch: null,
  auto_switch_target: null, scheduled: {},
};

const level_of_status: Record<Status, EventLevel> = { online: "info", info: "info", unavailable: "warning", warning: "warning", failed: "error" };

// The jobs that hold the deployment's buttons; an evaluation runs beside them.
const main_job_kinds: JobKind[] = ["update", "build", "switch"];

const probe_timeout_in_seconds = 60;
const reboot_timeout_in_seconds = 60;

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

  constructor(settings: DeploymentSettings, options: DeploymentOptions) {
    this.settings = settings;
    this.store = options.store;
    this.agents = options.agents;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
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

  // Why an action cannot run now, or null when it can.
  action_refusal(action: ActionId): string | null {
    if (action === "update" && !can_update(this.settings)) {
      return `Cannot update ${this.settings.flake}: only a local checkout, or a github: flake with a push_ssh_key, has a lock file X-Nix can write`;
    }
    if (this.running_job() !== null) return "A job is already running for this deployment";
    return null;
  }

  // ── Cycle ────────────────────────────────────────────────────────────────

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
    const [probe, folded] = await Promise.all([this.agents.get(this.settings.host).run(probe_script(), probe_timeout_in_seconds), evaluating]);

    if (probe.exit_code !== 0 && probe.stdout.trim() === "") {
      return this.save_unavailable(`Could not read the deployed system: ${clip(probe.stderr || probe.stdout, 200)}`, folded);
    }
    const fields = parse_probe(probe.stdout);
    if (fields.current === null) return this.save_unavailable("/run/current-system is unreadable; is this a NixOS host?", folded);
    this.assemble(fields, folded ?? this.evaluation(), folded !== null);
  }

  private save_unavailable(text: string, folded: Evaluation | null): void {
    if (folded !== null) this.store.save_evaluation(this.id, folded);
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
        messages.push({ level: level_of_status[this.settings.drift_status], text: `System is out of date: ${this.settings.flake} evaluates to ${target}, running ${fields.current}` });
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
    });
  }

  // Saves the reading, noting a change of status as an event.
  private save_reading(reading: Reading): void {
    const previous = this.reading();
    this.store.save_reading(this.id, reading);
    if (previous?.status === reading.status) return;
    const level = level_of_status[reading.status];
    const reason = reading.messages.find((message) => message.level === level && level !== "info");
    this.store.add_event(this.id, reading.checked_epoch, level, reason ? `Now ${reading.status}: ${reason.text}` : `Now ${reading.status}`);
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
    const launched = await this.launch("eval", eval_command(this.settings, this.attribute()), "schedule", false);
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
    const launched = await this.launch("switch", switch_command(this.settings), "automatic", false);
    // A host that never answered started nothing, so a later cycle may try again.
    if (launched.unreachable) {
      this.store.add_event(this.id, this.now(), "warning", `Could not start the automatic switch: ${launched.error}`);
      return;
    }
    const evaluation = this.evaluation();
    evaluation.auto_switch_target = target;
    this.store.save_evaluation(this.id, evaluation);
    if (launched.job_id === null) this.record_failed_launch("switch", switch_command(this.settings), "automatic", launched.error);
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

  act(action: ActionId): Promise<ActionOutcome> {
    return this.serial(async () => {
      const refusal = this.action_refusal(action);
      if (refusal !== null) return { ok: false, message: refusal, job_id: null };
      if (action === "reboot") return this.reboot();
      const command = this.command_for(action);
      const launched = await this.launch(action, command, "manual", true);
      if (launched.job_id === null) {
        const job_id = this.record_failed_launch(action, command, "manual", launched.error);
        return { ok: false, message: `Could not start the ${action}: ${launched.error}`, job_id };
      }
      return { ok: true, message: `${capitalise(action)} started`, job_id: launched.job_id };
    });
  }

  // The reboot is for the probed host itself, and runs as a command rather than a job that would die with it.
  private async reboot(): Promise<ActionOutcome> {
    const command = reboot_command(this.settings);
    const result = await this.agents.get(this.settings.host).run(command, reboot_timeout_in_seconds);
    const job_id = this.store.create_job({
      deployment_id: this.id, kind: "reboot", command, agent: this.settings.host, run_id: null, trigger: "manual", started_epoch: this.now(),
    });
    this.store.append_output(job_id, [result.stdout, result.stderr].filter(Boolean).join("\n"));
    const ok = result.exit_code === 0;
    this.store.finish_job(job_id, ok ? "succeeded" : "failed", result.exit_code, ok ? null : `Exited with status ${result.exit_code}`, this.now());
    this.store.add_event(this.id, this.now(), ok ? "info" : "error", ok ? "Reboot requested" : `Could not reboot: ${clip(result.stderr || result.stdout, 200)}`);
    return { ok, message: ok ? "Reboot requested" : `Could not reboot: ${clip(result.stderr || result.stdout, 200)}`, job_id };
  }

  private command_for(kind: "update" | "build" | "switch"): string {
    if (kind === "update") return update_command(this.settings);
    if (kind === "build") return build_command(this.settings, this.attribute());
    return switch_command(this.settings);
  }

  // ── Jobs ─────────────────────────────────────────────────────────────────

  // The host whose agent runs a job of this kind; the build may run apart from the switch and update.
  agent_for(kind: JobKind): string | null {
    if (kind === "eval") return this.settings.eval_agent ?? this.settings.host;
    if (kind === "build") return this.settings.build_agent ?? this.settings.host;
    if (kind === "reboot") return this.settings.host;
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
    if (announce) this.store.add_event(this.id, this.now(), "info", `${capitalise(kind)} started`);
    return { job_id, error: "", unreachable: false };
  }

  // Keeps a job that could not start in the history, with why.
  private record_failed_launch(kind: JobKind, command: string, trigger: string, error: string): number {
    const job_id = this.store.create_job({ deployment_id: this.id, kind, command, agent: this.agent_for(kind), run_id: null, trigger, started_epoch: this.now() });
    this.store.append_output(job_id, `${error}\n`);
    this.store.finish_job(job_id, "failed", null, "The job could not be started", this.now());
    this.store.add_event(this.id, this.now(), "error", `Could not start the ${kind}: ${error}`);
    return job_id;
  }

  // Copies a long run's new output into its job and finishes the job once the run has ended.
  private async follow(job: Job): Promise<{ outcome: "running" | "ended" | "unreachable"; error: string }> {
    const agent = this.agents.get(job.agent);
    let offset = job.output_offset;
    let poll;
    try {
      do {
        poll = await agent.poll(job.run_id!, offset);
        this.store.append_output(job.id, poll.new_output, poll.next_offset);
        offset = poll.next_offset;
      } while (offset < poll.size && poll.new_output !== "");
    } catch (error) {
      if (error instanceof AgentError && error.unreachable) return { outcome: "unreachable", error: error.message };
      // A run the agent no longer knows has ended without a word.
      poll = { alive: false, exit_code: null };
    }
    if (poll.alive) return { outcome: "running", error: "" };

    let error: string | null = null;
    if (poll.exit_code === null) error = "The run ended without writing an exit code";
    else if (poll.exit_code === timed_out_exit_code && job.kind === "eval") error = `Timed out after ${format_duration(this.settings.eval_timeout)}`;
    else if (poll.exit_code !== 0) error = `Exited with status ${poll.exit_code}`;
    this.store.finish_job(job.id, error === null ? "succeeded" : "failed", poll.exit_code, error, this.now());
    await agent.forget(job.run_id!);
    return { outcome: "ended", error: error ?? "" };
  }

  private async poll_job(job: Job): Promise<void> {
    const followed = await this.follow(job);
    if (followed.outcome === "unreachable") {
      this.store.add_event(this.id, this.now(), "warning", `Could not poll the running ${job.kind}: ${followed.error}`);
      return;
    }
    if (followed.outcome === "running") return;
    // Whatever the job changed, the next cycle evaluates afresh.
    this.force_eval = true;
    const finished = this.store.job(job.id)!;
    if (finished.state === "succeeded") this.store.add_event(this.id, this.now(), "info", `${capitalise(job.kind)} finished`);
    else this.store.add_event(this.id, this.now(), "error", `${capitalise(job.kind)} failed: ${finished.error}`);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function blank_reading(): Reading {
  return {
    status: "unavailable", checked_epoch: 0, messages: [], hostname: null, current: null, booted: null, version: null, generation: null,
    switched_epoch: null, up_to_date: null, reboot_required: null, flake_reachable: null,
  };
}

function clip(text: string, length: number): string {
  return text.trim().slice(0, length);
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
