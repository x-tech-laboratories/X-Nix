// Fleet runs: one action on many deployments at once, picked by name glob or @tag, with a cap on how many run together.
//
// A run is kept whole in the store and advanced every few seconds, so it carries on after a restart of the server. Each
// deployment's part is an ordinary job, started with the fleet run named as its trigger and followed by the
// deployment's own cycle; the run only reads how each job ended. A staged run goes through its stages in order, each
// stage a selector such as "@canary": a staged switch waits for each host to read as in sync against a fresh evaluation
// before the next starts, and the first failure stops the rollout.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { DeploymentSettings, FleetSettings } from "./config.ts";
import type { Deployment } from "./deployment.ts";
import { format_duration } from "./durations.ts";
import type { Store } from "./store.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export type FleetActionId = "update" | "build" | "switch" | "reboot";

export const fleet_action_ids: FleetActionId[] = ["update", "build", "switch", "reboot"];

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
  // The time in seconds, which tests set.
  now?: () => number;
}

const advance_interval_in_milliseconds = 5000;

const active_states = new Set<FleetHostState>(["running", "verifying"]);

// ── Selectors ────────────────────────────────────────────────────────────────

// The terms of a selector, split on spaces and commas, such as "web-* @canary".
export function selector_terms(selector: string): string[] {
  return selector.split(/[\s,]+/).filter(Boolean);
}

// Whether one term picks the deployment: @tag by its tags, anything else as a glob on its id or name.
export function term_matches(term: string, settings: Pick<DeploymentSettings, "id" | "name" | "tags">): boolean {
  if (term.startsWith("@")) return settings.tags.includes(term.slice(1));
  const pattern = new RegExp(`^${term.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")}$`);
  return pattern.test(settings.id) || pattern.test(settings.name);
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
  private readonly now: () => number;
  private timer: NodeJS.Timeout | undefined;
  // Advances run one at a time.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(deployments: Map<string, Deployment>, options: FleetOptions) {
    this.deployments = deployments;
    this.store = options.store;
    this.settings = options.settings;
    this.poke = options.poke ?? (() => {});
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  // The deployments a selector picks, in the config's order.
  select(selector: string): Deployment[] {
    return [...this.deployments.values()].filter((deployment) => selector_matches(selector, deployment.settings));
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
  async start(request: FleetRequest): Promise<FleetOutcome> {
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
      stages = ((request.stages as string[] | undefined) ?? this.settings.stages).map((stage) => stage.trim()).filter(Boolean);
    }

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
      started_epoch: now, finished_epoch: null, message: null, hosts,
    };
    const id = this.store.create_fleet_run("running", run);
    for (const deployment of picked) this.store.add_event(deployment.id, now, "info", `Fleet run #${id} queued: ${action}`);
    await this.advance();
    return { ok: true, message: `Fleet run #${id} started on ${picked.length} deployment${picked.length === 1 ? "" : "s"}`, run: this.run(id) };
  }

  // Skips every host not yet started; the run ends once those already running have.
  stop(id: number): Promise<FleetOutcome> {
    return this.serial(async () => {
      const run = this.run(id);
      if (run === null) return { ok: false, message: `No fleet run #${id}`, run: null };
      if (run.state !== "running") return { ok: false, message: `Fleet run #${id} has already ended`, run };
      run.stop_requested = true;
      await this.advance_run(run);
      return { ok: true, message: `Fleet run #${id} is stopping`, run: this.run(id) };
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
    const halted = run.stop_requested || (run.staged && run.hosts.some((host) => host.state === "failed"));
    if (halted) {
      const reason = run.stop_requested ? "Stopped before it started" : "Skipped: an earlier stage failed";
      for (const host of run.hosts) if (host.state === "queued") this.finish_host(host, "skipped", reason, now);
    }
    if (run.staged) run.current_stage = this.next_stage(run);

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

  // The stage to work on: the current one until none of its hosts is left to finish, then the next that has hosts.
  private next_stage(run: FleetRun): number {
    const unfinished = (stage: number) => run.hosts.some((host) => host.stage === stage && (host.state === "queued" || active_states.has(host.state)));
    if (unfinished(run.current_stage)) return run.current_stage;
    const later = run.hosts.filter((host) => host.stage > run.current_stage && host.state === "queued").map((host) => host.stage);
    return later.length === 0 ? run.current_stage : Math.min(...later);
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
    if (job.state === "failed") return this.finish_host(host, "failed", job.error ?? "The job failed", now);
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

// The index of the first stage whose selector picks the deployment, or one past the last for a host no stage names.
function stage_of(deployment: Deployment, stages: string[], index: number): number {
  if (stages.length === 0) return index;
  const found = stages.findIndex((stage) => selector_matches(stage, deployment.settings));
  return found === -1 ? stages.length : found;
}
