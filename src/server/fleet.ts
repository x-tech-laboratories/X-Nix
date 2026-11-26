// Fleet runs: one action on many deployments at once, picked by name glob or @tag, with a cap on how many run together.
//
// A run is kept whole in the store and advanced every few seconds, so it carries on after a restart of the server. Each
// deployment's part is an ordinary job, started with the fleet run named as its trigger and followed by the
// deployment's own cycle; the run only reads how each job ended. A staged run goes through its stages in order, each
// stage a selector such as "@canary": a staged switch waits for each host to read as in sync against a fresh evaluation
// before the next starts, and the first failure stops the rollout. Between stages the run can hold: the finished stage
// soaks, failing a host that turns failed or drifts, and the next waits for an admin's approval when the run needs one.

// ── Imports ──────────────────────────────────────────────────────────────────

import { format_duration, parse_duration } from "@x-tech-laboratories/x-libs/durations";

import type { DeploymentSettings, FleetSettings } from "./config.ts";
import type { Deployment } from "./deployment.ts";
import { switch_verdict } from "./nixos/switch.ts";
import type { Store } from "./store.ts";
import { command_marker_token } from "../shared/operations.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export type FleetActionId = "build" | "switch" | "reboot";

export const fleet_action_ids: FleetActionId[] = ["build", "switch", "reboot"];

// Verifying is a switched host waiting to read as in sync before a staged rollout moves on.
export type FleetHostState = "queued" | "running" | "verifying" | "succeeded" | "failed" | "skipped";

export type FleetRunState = "running" | "succeeded" | "failed" | "stopped";

export interface FleetHost {
  deployment_id: string;
  name: string;
  // The index of the stage the host belongs to; every host is in stage 0 of a run that is not staged.
  stage: number;
  state: FleetHostState;
  job_id: number | null;
  message: string | null;
  started_epoch: number | null;
  // When the switch ended, from which the host must read as in sync.
  verify_since_epoch: number | null;
  finished_epoch: number | null;
}

// A finished stage the run holds at before the next: soaking until a time, and waiting for approval when the run needs it.
export interface StageGate {
  stage: number;
  soak_until_epoch: number;
  approved: boolean;
  approved_by: string | null;
}

export interface FleetRun {
  id: number;
  action: FleetActionId;
  // What picked the hosts, as a selector or the list of ids.
  selector: string;
  staged: boolean;
  // The stage selectors in order, and a last stage for hosts no selector named when there are any.
  stages: string[];
  parallel: number;
  state: FleetRunState;
  current_stage: number;
  stop_requested: boolean;
  // The jobs a stop ended while they ran, whose hosts read as skipped rather than failed; absent before any was.
  stopped_jobs?: number[];
  // How long each finished stage soaks, and whether the next needs approval; absent from runs started before either was kept.
  soak?: number;
  approve?: boolean;
  // The finished stage the run holds at, or null while none does.
  gate?: StageGate | null;
  // Who started it; absent from runs started before it was kept.
  started_by?: string;
  started_epoch: number;
  finished_epoch: number | null;
  message: string | null;
  hosts: FleetHost[];
}

export interface FleetRequest {
  action?: unknown;
  selector?: unknown;
  ids?: unknown;
  staged?: unknown;
  stages?: unknown;
  parallel?: unknown;
  soak?: unknown;
  approve?: unknown;
}

export interface FleetOutcome {
  ok: boolean;
  message: string;
  run: FleetRun | null;
}

export interface FleetOptions {
  store: Store;
  settings: FleetSettings;
  // Asks the deployment's cycle to come soon, so a started job or a switch's evaluation is followed quickly.
  poke?: (deployment: Deployment) => void;
  // Stops a running job, for a stop that also ends the jobs already running; such a stop is refused without it.
  // A guarded switch past its activation answers with rolling_back set, as its watchdog was told to roll back instead.
  stop_job?: (job_id: number, by: string) => Promise<{ ok: boolean; message: string; rolling_back?: boolean }>;
  // The time in seconds, which tests set.
  now?: () => number;
}

const advance_interval_in_milliseconds = 5000;

const active_states = new Set<FleetHostState>(["running", "verifying"]);

// ── Selectors ────────────────────────────────────────────────────────────────

// The longest selector a request may give, in characters.
export const max_selector_length = 1000;

// The most terms one selector may hold, and the most stage selectors a staged run may name.
export const max_selector_terms = 100;

// The terms of a selector, split on spaces and commas, such as "web-* @canary".
export function selector_terms(selector: string): string[] {
  return selector.split(/[\s,]+/).filter(Boolean);
}

// Why a selector from a request is refused, or null when it is within the limits.
export function selector_problem(selector: string): string | null {
  if (selector.length > max_selector_length) return `A selector may be at most ${max_selector_length} characters long`;
  if (selector_terms(selector).length > max_selector_terms) return `A selector may hold at most ${max_selector_terms} terms`;
  return null;
}

// Characters a wildcard does not stand for, the line terminators, as a regular expression's dot never matched them.
const line_terminators = new Set(["\n", "\r", "\u2028", "\u2029"]);

// Whether a glob matches the whole text, case-sensitively, `*` standing for any run of characters and `?` for one, in time bounded by the product of their lengths.
export function glob_matches(glob: string, text: string): boolean {
  let glob_index = 0;
  let text_index = 0;
  // The position just past the last `*` seen, and the text position it was last tried from.
  let star_index = -1;
  let star_text_index = 0;
  while (text_index < text.length) {
    const wanted = glob_index < glob.length ? glob[glob_index] : null;
    const character = text[text_index];
    const one_fits = wanted === "?" ? !line_terminators.has(character) : wanted !== "*" && wanted === character;
    if (one_fits) {
      glob_index++;
      text_index++;
    } else if (wanted === "*") {
      star_index = ++glob_index;
      star_text_index = text_index;
    } else if (star_index !== -1 && !line_terminators.has(text[star_text_index])) {
      glob_index = star_index;
      text_index = ++star_text_index;
    } else {
      return false;
    }
  }
  while (glob_index < glob.length && glob[glob_index] === "*") glob_index++;
  return glob_index === glob.length;
}

// Whether one term picks the deployment: @tag by its tags, anything else as a glob on its id or name.
export function term_matches(term: string, settings: Pick<DeploymentSettings, "id" | "name" | "tags">): boolean {
  if (term.startsWith("@")) return settings.tags.includes(term.slice(1));
  return glob_matches(term, settings.id) || glob_matches(term, settings.name);
}

export function selector_matches(selector: string, settings: Pick<DeploymentSettings, "id" | "name" | "tags">): boolean {
  return selector_terms(selector).some((term) => term_matches(term, settings));
}

// ── Fleet ────────────────────────────────────────────────────────────────────

export class Fleet {
  readonly settings: FleetSettings;
  private readonly deployments: Map<string, Deployment>;
  private readonly store: Store;
  private readonly poke: (deployment: Deployment) => void;
  private readonly stop_job: FleetOptions["stop_job"];
  private readonly now: () => number;
  private timer: NodeJS.Timeout | undefined;
  // Advances run one at a time.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(deployments: Map<string, Deployment>, options: FleetOptions) {
    this.deployments = deployments;
    this.store = options.store;
    this.settings = options.settings;
    this.poke = options.poke ?? (() => {});
    this.stop_job = options.stop_job;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  // The deployments a selector picks, in the config's order.
  select(selector: string): Deployment[] {
    return [...this.deployments.values()].filter((deployment) => selector_matches(selector, deployment.settings));
  }

  // Why a selector from a request is refused, or null when it may be used.
  selector_problem(selector: string): string | null {
    return selector_problem(selector);
  }

  // Every tag any deployment has, sorted.
  tags(): string[] {
    return [...new Set([...this.deployments.values()].flatMap((deployment) => deployment.settings.tags))].sort();
  }

  runs(limit = 20): FleetRun[] {
    return this.store.fleet_runs<FleetRun>({ limit });
  }

  run(id: number): FleetRun | null {
    return this.store.fleet_run<FleetRun>(id);
  }

  // ── Starting ─────────────────────────────────────────────────────────────

  // Checks the request, keeps the new run and starts its first hosts.
  async start(request: FleetRequest, started_by = "manual"): Promise<FleetOutcome> {
    const refuse = (message: string): FleetOutcome => ({ ok: false, message, run: null });
    const action = request.action as FleetActionId;
    if (!fleet_action_ids.includes(action)) return refuse(`No fleet action named '${String(request.action)}'`);
    let picked: Deployment[];
    let selector: string;
    if (Array.isArray(request.ids)) {
      const unknown = request.ids.find((id) => typeof id !== "string" || !this.deployments.has(id));
      if (unknown !== undefined) return refuse(`No deployment named '${String(unknown)}'`);
      const ids = new Set(request.ids as string[]);
      picked = [...this.deployments.values()].filter((deployment) => ids.has(deployment.id));
      selector = picked.map((deployment) => deployment.id).join(" ");
    } else if (typeof request.selector === "string" && request.selector.trim() !== "") {
      selector = request.selector.trim();
      const problem = selector_problem(selector);
      if (problem !== null) return refuse(problem);
      picked = this.select(selector);
    } else {
      return refuse("Pick deployments with a selector such as \"web-* @canary\", or a list of ids");
    }
    if (picked.length === 0) return refuse(`No deployment matches ${selector}`);
    const parallel = request.parallel === undefined || request.parallel === null ? this.settings.parallel : Number(request.parallel);
    if (!Number.isInteger(parallel) || parallel < 1) return refuse("`parallel` must be a whole number of at least 1");
    const staged = request.staged === true;
    let stages: string[] = [];
    if (staged) {
      if (request.stages !== undefined && request.stages !== null && (!Array.isArray(request.stages) || !request.stages.every((stage) => typeof stage === "string"))) {
        return refuse("`stages` must be a list of selectors");
      }
      if (Array.isArray(request.stages) && request.stages.length > max_selector_terms) return refuse(`A run may name at most ${max_selector_terms} stages`);
      const stage_problem = ((request.stages as string[] | undefined) ?? []).map(selector_problem).find((problem) => problem !== null);
      if (stage_problem !== undefined) return refuse(stage_problem);
      stages = ((request.stages as string[] | undefined) ?? this.settings.stages).map((stage) => stage.trim()).filter(Boolean);
    }
    const soak = soak_of(request.soak, this.settings.soak);
    if (soak === null) return refuse("`soak` must be a duration such as \"15m\", or a number of seconds");
    if (request.approve !== undefined && request.approve !== null && typeof request.approve !== "boolean") return refuse("`approve` must be true or false");
    const approve = (request.approve as boolean | null | undefined) ?? this.settings.approve_stages;

    const now = this.now();
    const hosts = picked.map((deployment, index): FleetHost => ({
      deployment_id: deployment.id, name: deployment.settings.name, stage: staged ? stage_of(deployment, stages, index) : 0, state: "queued",
      job_id: null, message: null, started_epoch: null, verify_since_epoch: null, finished_epoch: null,
    }));
    // With no stage selectors, every host is its own stage, one after another.
    if (staged && stages.length === 0) stages = picked.map((deployment) => deployment.id);
    else if (staged && hosts.some((host) => host.stage === stages.length)) stages = [...stages, "the rest"];
    const run: Omit<FleetRun, "id"> = {
      action, selector, staged, stages, parallel, state: "running", current_stage: Math.min(...hosts.map((host) => host.stage)), stop_requested: false,
      soak: staged ? soak : 0, approve: staged && approve, gate: null, started_by, started_epoch: now, finished_epoch: null, message: null, hosts,
    };
    const id = this.store.create_fleet_run("running", run);
    for (const deployment of picked) this.store.add_event(deployment.id, now, "info", `Fleet run #${id} queued by ${started_by}: ${action}`);
    await this.advance();
    return { ok: true, message: `Fleet run #${id} started on ${picked.length} deployment${picked.length === 1 ? "" : "s"}`, run: this.run(id) };
  }

  // Skips every host not yet started; the run ends once those already running have, or, with jobs, stops their jobs too.
  stop(id: number, options: { jobs?: boolean; by?: string } = {}): Promise<FleetOutcome> {
    return this.serial(async () => {
      const run = this.run(id);
      if (run === null) return { ok: false, message: `No fleet run #${id}`, run: null };
      if (run.state !== "running") return { ok: false, message: `Fleet run #${id} has already ended`, run };
      if (options.jobs === true && this.stop_job === undefined) return { ok: false, message: "This server cannot stop jobs", run };
      run.stop_requested = true;
      const notes = options.jobs === true ? await this.stop_running_jobs(run, options.by ?? "manual") : { failures: [], rolling_back: [] };
      await this.advance_run(run);
      const message = options.jobs === true ? `Fleet run #${id} is stopping, with its running jobs` : `Fleet run #${id} is stopping`;
      return { ok: notes.failures.length === 0, message: [message, ...notes.rolling_back, ...notes.failures].join("; "), run: this.run(id) };
    });
  }

  // Stops the job of every host still running, all at once, and answers with why any could not be stopped and which
  // guarded switches roll back instead; a Build still held for its host ends there, before it has a run.
  private async stop_running_jobs(run: FleetRun, by: string): Promise<{ failures: string[]; rolling_back: string[] }> {
    const running = run.hosts.filter((host) => host.state === "running" && host.job_id !== null);
    const stop = async (host: FleetHost) => {
      const held = await this.deployments.get(host.deployment_id)?.stop_held_build(host.job_id!, by);
      return held ?? this.stop_job!(host.job_id!, by);
    };
    const outcomes = await Promise.all(running.map(async (host) => ({ host, outcome: await stop(host) })));
    const failures: string[] = [];
    const rolling_back: string[] = [];
    for (const { host, outcome } of outcomes) {
      if (!outcome.ok) {
        failures.push(`${host.name}: ${outcome.message}`);
        continue;
      }
      if ("rolling_back" in outcome && outcome.rolling_back === true) rolling_back.push(`${host.name}: ${outcome.message}`);
      run.stopped_jobs = [...(run.stopped_jobs ?? []), host.job_id!];
      const deployment = this.deployments.get(host.deployment_id);
      if (deployment !== undefined) this.poke(deployment);
    }
    return { failures, rolling_back };
  }

  // Lets a run held for approval start its next stage, once any soak still running has passed.
  approve(id: number, approved_by = "manual"): Promise<FleetOutcome> {
    return this.serial(async () => {
      const run = this.run(id);
      if (run === null) return { ok: false, message: `No fleet run #${id}`, run: null };
      const gate = run.gate ?? null;
      if (run.state !== "running" || gate === null || gate.approved) return { ok: false, message: `Fleet run #${id} is not waiting for approval`, run };
      run.gate = { ...gate, approved: true, approved_by };
      for (const host of run.hosts) if (host.stage === gate.stage) this.store.add_event(host.deployment_id, this.now(), "info", `Fleet run #${id}: ${approved_by} approved the next stage`);
      await this.advance_run(run);
      return { ok: true, message: `Fleet run #${id} may start its next stage`, run: this.run(id) };
    });
  }

  // ── Advancing ────────────────────────────────────────────────────────────

  start_timer(): void {
    this.timer = setInterval(() => void this.advance(), advance_interval_in_milliseconds);
    this.timer.unref();
  }

  stop_timer(): void {
    clearInterval(this.timer);
  }

  // Moves every running fleet run along: notes the jobs that ended, then starts the next hosts.
  advance(): Promise<void> {
    return this.serial(async () => {
      for (const run of this.store.fleet_runs<FleetRun>({ state: "running", limit: 1000 })) await this.advance_run(run);
    });
  }

  private serial<Answer>(work: () => Promise<Answer>): Promise<Answer> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  private async advance_run(run: FleetRun): Promise<void> {
    const now = this.now();
    for (const host of run.hosts) {
      if (host.state === "running") this.follow_host(run, host, now);
      if (host.state === "verifying") this.verify_host(host, now);
    }
    if (run.gate) this.watch_soak(run, run.gate, now);
    const halted = run.stop_requested || (run.staged && run.hosts.some((host) => host.state === "failed"));
    if (halted) {
      const reason = run.stop_requested ? "Stopped before it started" : "Skipped: an earlier stage failed";
      for (const host of run.hosts) if (host.state === "queued") this.finish_host(host, "skipped", reason, now);
    }
    if (run.staged) run.current_stage = this.next_stage(run, now);

    let active = run.hosts.filter((host) => active_states.has(host.state)).length;
    for (const host of run.hosts) {
      if (active >= run.parallel || (run.staged && run.hosts.some((candidate) => candidate.state === "failed"))) break;
      if (host.state !== "queued" || host.stage !== run.current_stage) continue;
      await this.start_host(run, host);
      if (active_states.has(host.state)) active++;
    }

    if (!run.hosts.some((host) => host.state === "queued" || active_states.has(host.state))) this.finish_run(run, now);
    this.store.save_fleet_run(run.id, run.state, run);
  }

  // The stage to work on: the current one until none of its hosts is left to finish and its gate opens, then the next that has hosts.
  private next_stage(run: FleetRun, now: number): number {
    const unfinished = (stage: number) => run.hosts.some((host) => host.stage === stage && (host.state === "queued" || active_states.has(host.state)));
    if (unfinished(run.current_stage)) return run.current_stage;
    const later = run.hosts.filter((host) => host.stage > run.current_stage && host.state === "queued").map((host) => host.stage);
    if (later.length === 0 || !this.gate_open(run, now)) return run.current_stage;
    return Math.min(...later);
  }

  // Whether the finished current stage lets the next start: once it has soaked, and been approved when the run needs it.
  private gate_open(run: FleetRun, now: number): boolean {
    const soak = run.soak ?? 0;
    const approve = run.approve ?? false;
    if (soak === 0 && !approve) return true;
    if (run.gate?.stage !== run.current_stage) {
      run.gate = { stage: run.current_stage, soak_until_epoch: now + soak, approved: !approve, approved_by: null };
    }
    const gate = run.gate;
    const next = run.current_stage + 2;
    if (now < gate.soak_until_epoch) {
      run.message = `Stage ${run.current_stage + 1} is soaking for ${format_duration(gate.soak_until_epoch - now)} before stage ${next}`;
      return false;
    }
    if (!gate.approved) {
      run.message = `Stage ${next} waits for approval`;
      return false;
    }
    run.gate = null;
    run.message = null;
    return true;
  }

  // Fails a host of the held stage whose status turns failed, or a switched host that drifts from the flake again.
  private watch_soak(run: FleetRun, gate: StageGate, now: number): void {
    for (const host of run.hosts) {
      if (host.stage !== gate.stage || host.state !== "succeeded") continue;
      const reading = this.deployments.get(host.deployment_id)?.reading() ?? null;
      if (reading === null || reading.checked_epoch < (host.finished_epoch ?? now)) continue;
      if (reading.status === "failed") {
        const reason = reading.messages.find((message) => message.level === "error")?.text;
        this.finish_host(host, "failed", reason ? `Failed while its stage soaked: ${reason}` : "Failed while its stage soaked", now);
      } else if (run.action === "switch" && reading.up_to_date === false) {
        this.finish_host(host, "failed", "Drifted from the flake while its stage soaked", now);
      }
    }
  }

  private async start_host(run: FleetRun, host: FleetHost): Promise<void> {
    const now = this.now();
    const deployment = this.deployments.get(host.deployment_id);
    if (deployment === undefined) return this.finish_host(host, "failed", "No longer in the config", now);
    host.started_epoch = now;
    const outcome = await deployment.act(run.action, `fleet #${run.id}`);
    host.job_id = outcome.job_id;
    if (!outcome.ok) return this.finish_host(host, "failed", outcome.message, this.now());
    // A reboot is a command that has already ended, not a job to follow.
    if (run.action === "reboot") return this.finish_host(host, "succeeded", outcome.message, this.now());
    host.state = "running";
    host.message = outcome.message;
    this.poke(deployment);
  }

  private follow_host(run: FleetRun, host: FleetHost, now: number): void {
    const job = host.job_id === null ? null : this.store.job(host.job_id);
    if (job === null) return this.finish_host(host, "failed", "Its job is gone from the history", now);
    if (job.state === "running") {
      host.message = job.progress;
      return;
    }
    if (job.state === "failed" && run.stopped_jobs?.includes(job.id)) return this.finish_host(host, "skipped", job.error ?? "Stopped", now);
    if (job.state === "failed") return this.finish_host(host, "failed", job.error ?? "The job failed", now);
    const outcome = run.action === "switch" ? switch_verdict(job.output, command_marker_token(job.command)).outcome : null;
    if (outcome?.kind === "deferred") return this.finish_host(host, "succeeded", `Set for the next boot: ${outcome.reason}`, now);
    if (!(run.staged && run.action === "switch")) return this.finish_host(host, "succeeded", "Finished", now);
    host.state = "verifying";
    host.verify_since_epoch = job.finished_epoch ?? now;
    host.message = "Switched; waiting for a fresh evaluation to read as in sync";
    const deployment = this.deployments.get(host.deployment_id);
    if (deployment !== undefined) {
      deployment.request_evaluation();
      this.poke(deployment);
    }
  }

  // A switched host passes once an evaluation since the switch reads as in sync, and fails on drift or after sync_timeout.
  private verify_host(host: FleetHost, now: number): void {
    const deployment = this.deployments.get(host.deployment_id);
    if (deployment === undefined) return this.finish_host(host, "failed", "No longer in the config", now);
    const since = host.verify_since_epoch ?? now;
    const evaluation = deployment.evaluation();
    const reading = deployment.reading();
    // An evaluation folded in the same second as the switch ended may have been judged against the old closure.
    const fresh = evaluation.evaluated_epoch !== null && evaluation.evaluated_epoch > since && deployment.running_evaluation() === null
      && reading !== null && reading.checked_epoch >= evaluation.evaluated_epoch;
    if (fresh && evaluation.eval_error !== null) return this.finish_host(host, "failed", `The evaluation after the switch failed: ${evaluation.eval_error}`, now);
    if (fresh && reading.up_to_date === true) return this.finish_host(host, "succeeded", "Switched and in sync", now);
    if (fresh && reading.up_to_date === false) return this.finish_host(host, "failed", "Still drifting from the flake after the switch", now);
    if (now - since > this.settings.sync_timeout) {
      return this.finish_host(host, "failed", `Did not read as in sync within ${format_duration(this.settings.sync_timeout)} of the switch`, now);
    }
  }

  private finish_host(host: FleetHost, state: "succeeded" | "failed" | "skipped", message: string, now: number): void {
    host.state = state;
    host.message = message;
    host.finished_epoch = now;
  }

  private finish_run(run: FleetRun, now: number): void {
    const count = (state: FleetHostState) => run.hosts.filter((host) => host.state === state).length;
    const failed = count("failed");
    run.state = failed > 0 ? "failed" : run.stop_requested && count("skipped") > 0 ? "stopped" : "succeeded";
    run.finished_epoch = now;
    run.message = [`${count("succeeded")} succeeded`, failed > 0 && `${failed} failed`, count("skipped") > 0 && `${count("skipped")} skipped`].filter(Boolean).join(", ");
    for (const host of run.hosts) {
      if (host.state === "skipped") continue;
      const level = host.state === "failed" ? "error" : "info";
      this.store.add_event(host.deployment_id, now, level, `Fleet run #${run.id} ${run.action}: ${host.message ?? host.state}`);
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// A run's soak in seconds: a duration such as "15m", a number of seconds, the settings' when absent, or null when malformed.
function soak_of(value: unknown, fallback: number): number | null {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
  if (typeof value !== "string") return null;
  try {
    return parse_duration(value, "soak");
  } catch {
    return null;
  }
}

// The index of the first stage whose selector picks the deployment, or one past the last for a host no stage names.
function stage_of(deployment: Deployment, stages: string[], index: number): number {
  if (stages.length === 0) return index;
  const found = stages.findIndex((stage) => selector_matches(stage, deployment.settings));
  return found === -1 ? stages.length : found;
}
