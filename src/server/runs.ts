// Follows a job's long run on its agent: copies its new output into the job, and finishes the job once the run has ended.

// ── Imports ──────────────────────────────────────────────────────────────────

import { follow_run, type Followed, type RunSink } from "@x-tech-laboratories/x-libs/server/runs";

import { StoppedBeforeStart, type AgentPool, type LongRun } from "./agents/agent.ts";
import { kept_awake_job } from "./agents/wake.ts";
import { rollback_signal_operation, switch_verdict, watch_token } from "./nixos/switch.ts";
import { innermost, operation_of, type Operation } from "../shared/operations.ts";
import type { Job, Store } from "./store.ts";

// ── Following ────────────────────────────────────────────────────────────────

export type { Followed };

// Turns a piece of a run's output into what the job keeps; ended is set once with nothing more to come.
export type Translate = (job: Job, chunk: string, ended: boolean) => string;

// Copies the run's new output into the job and finishes the job once the run has ended; `describe` names a failing exit
// code its owner knows better, such as a timeout, and `translate` rewrites output such as nix's structured log. A run
// someone stopped fails as stopped by them, whatever its exit code.
export async function follow(
  store: Store, agents: AgentPool, job: Job, now: () => number, describe: (exit_code: number) => string | null = () => null, translate: Translate | null = null,
): Promise<Followed> {
  // A run still waiting on its host to wake has nothing to read yet.
  if (agents.is_starting(job.run_id)) return { outcome: "running", error: "" };
  const sink: RunSink = {
    append_output: (text, next_offset) => store.append_output(job.id, text, next_offset ?? null),
    finish: (state, exit_code, error) => {
      const by = agents.stopped_by(job.run_id!, true);
      if (by === null) store.finish_job(job.id, state, exit_code, error, now());
      else store.finish_job(job.id, "failed", exit_code, `Stopped by ${by}`, now());
    },
  };
  return follow_run(agents.get(job.agent), job.run_id!, job.output_offset, sink, {
    describe, translate: translate === null ? undefined : (chunk, ended) => translate(job, chunk, ended),
  });
}

// ── Stopping ─────────────────────────────────────────────────────────────────

export interface StopOutcome {
  ok: boolean;
  message: string;
  job_id: number | null;
  // Set when the job was a guarded switch past its activation, whose watchdog was told to roll back rather than the run stopped.
  rolling_back?: boolean;
}

// How long the agent has to deliver a rollback signal.
const signal_timeout_in_seconds = 60;

// A stopped guarded switch whose watchdog was told to roll back, and when it is stopped outright should it still run.
interface RollingBack {
  store: Store;
  agents: AgentPool;
  job_id: number;
  by: string;
  deadline_epoch: number;
}

// The stopped guarded switches still rolling back, by run id, as run ids are unique across stores.
const rolling_back = new Map<string, RollingBack>();

// Stops a running job's long run on its agent, waiting for its processes to end, and the job's owner finishes it on its
// next cycle; a guarded switch past its activation, whose watchdog lives in the run, has its watchdog told to roll back
// instead, and is stopped outright only when that signal fails or no outcome comes within the watchdog's window.
export async function stop_job(store: Store, agents: AgentPool, job_id: number, by: string, now: () => number): Promise<StopOutcome> {
  const job = store.job(job_id);
  if (job === null) return { ok: false, message: "No such job", job_id: null };
  const refuse = (message: string): StopOutcome => ({ ok: false, message, job_id });
  if (job.state !== "running") return refuse(`Job #${job_id} has already ended`);
  if (job.run_id === null) return refuse(`Job #${job_id} has no run to stop`);
  if (agents.call_off(job.run_id, by)) {
    store.add_event(job.deployment_id, now(), "warning", `${by} stopped job #${job_id} (${job.kind}) before its host woke`);
    return { ok: true, message: `Stopped job #${job_id} before it started`, job_id };
  }
  const pending = rolling_back.get(job.run_id);
  if (pending !== undefined && now() < pending.deadline_epoch) {
    return refuse(`Job #${job_id} is rolling back, as ${pending.by} asked; it is stopped outright if no outcome has come by ${new Date(pending.deadline_epoch * 1000).toISOString()}`);
  }
  const window = pending === undefined ? guarded_window(job.command, job.output) : null;
  if (window !== null) {
    const signalled = await signal_rollback(agents, job.agent, watch_token(job.command)!, `Stopped by ${by} after the activation`);
    if (signalled === null) {
      const deadline_epoch = now() + window;
      rolling_back.set(job.run_id, { store, agents, job_id, by, deadline_epoch });
      setTimeout(() => void stop_overdue_rollbacks(() => Math.max(now(), deadline_epoch)), window * 1000).unref();
      store.append_output(job_id, `${by} stopped the switch after it activated; told its watchdog to roll back, and the job ends with its outcome\n`);
      store.add_event(job.deployment_id, now(), "warning", `${by} stopped job #${job_id} (${job.kind}) after it activated; its watchdog rolls the host back`);
      return {
        ok: true, job_id, rolling_back: true,
        message: `Job #${job_id} had activated under its watchdog, so the watchdog was told to roll back; the job ends with its outcome, or is stopped outright after ${window} seconds`,
      };
    }
    store.append_output(job_id, `Could not tell the watchdog to roll back (${signalled}), so the run is stopped outright\n`);
  }
  return hard_stop(store, agents, job, by, now, window === null ? "" : "; its watchdog could not be told to roll back, so nothing will roll the host back");
}

// Stops outright every stopped guarded switch still running past its watchdog's window, forgetting those that ended.
export async function stop_overdue_rollbacks(now: () => number): Promise<void> {
  for (const [run_id, pending] of rolling_back) {
    const job = pending.store.job(pending.job_id);
    if (job === null || job.state !== "running") {
      rolling_back.delete(run_id);
      continue;
    }
    if (now() < pending.deadline_epoch) continue;
    rolling_back.delete(run_id);
    pending.store.append_output(job.id, "No outcome came from the watchdog in its window, so the run is stopped outright\n");
    await hard_stop(pending.store, pending.agents, job, pending.by, now, "; its watchdog gave no outcome in its window");
  }
}

// How long a guarded switch that has activated without an outcome may take to end once its watchdog is told to roll
// back, in seconds, or null for any other job.
function guarded_window(command: string, output: string): number | null {
  if (watch_token(command) === null) return null;
  const operation = operation_of(command);
  const inner = operation === null ? null : innermost(operation);
  if (inner?.kind !== "switch" || !inner.watch) return null;
  const verdict = switch_verdict(output);
  if (!verdict.activated || verdict.outcome !== null) return null;
  // The run waits this long for the watchdog's outcome after the activation, which bounds the rollback too.
  return inner.watch.activation_timeout + inner.watch.confirm_window + 120;
}

// Tells a guarded switch's watchdog to roll back, answering null once it has, or why it could not.
async function signal_rollback(agents: AgentPool, host: string | null, token: string, reason: string): Promise<string | null> {
  try {
    const result = await agents.get(host).run(rollback_signal_operation(token, reason), { timeout_in_seconds: signal_timeout_in_seconds });
    return result.exit_code === 0 ? null : (result.stderr || result.stdout).trim().slice(0, 200) || `status ${result.exit_code}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// Stops the run itself, ending every process in its unit, the watchdog of a guarded switch among them.
async function hard_stop(store: Store, agents: AgentPool, job: Job, by: string, now: () => number, note: string): Promise<StopOutcome> {
  const job_id = job.id;
  const refuse = (message: string): StopOutcome => ({ ok: false, message, job_id });
  let run: LongRun;
  try {
    run = await agents.stop(job.agent, job.run_id!, by);
  } catch (error) {
    return refuse(`Could not stop job #${job_id}: ${error instanceof Error ? error.message : String(error)}`);
  }
  // A run that ended on its own before the stop reached it keeps its own outcome.
  if (run.state !== "stopped") {
    agents.stopped_by(job.run_id!, true);
    return refuse(`Job #${job_id} had already ended before it could be stopped`);
  }
  store.add_event(job.deployment_id, now(), "warning", `${by} stopped job #${job_id} (${job.kind})${note}`);
  return { ok: true, message: `Stopped job #${job_id}${note}`, job_id };
}

// ── A host's runs ────────────────────────────────────────────────────────────

// A long run on a host's agent, with the job that follows it, or null for a run no job knows, such as one left behind.
export interface AgentRunView extends LongRun {
  job: Pick<Job, "id" | "deployment_id" | "kind" | "state"> | null;
}

// Every long run a host's agent holds, newest first; reaching the agent does not wake its host.
export async function agent_runs(store: Store, agents: AgentPool, host: string): Promise<AgentRunView[]> {
  const runs = await agents.get(host).runs();
  return runs.sort((a, b) => b.started_epoch - a.started_epoch).map((run) => {
    const job = store.job_by_run(run.run_id);
    return { ...run, job: job === null ? null : { id: job.id, deployment_id: job.deployment_id, kind: job.kind, state: job.state } };
  });
}

// Stops one run on a host: as stop_job when a running job follows it, else at once on the agent.
export async function stop_agent_run(store: Store, agents: AgentPool, host: string, run_id: string, by: string, now: () => number): Promise<StopOutcome> {
  const job = store.job_by_run(run_id);
  if (job !== null && job.state === "running") return stop_job(store, agents, job.id, by, now);
  try {
    const run = await agents.get(host).stop(run_id);
    if (run.state !== "stopped") return { ok: false, message: `The run ${run_id} had already ended`, job_id: null };
  } catch (error) {
    return { ok: false, message: `Could not stop the run ${run_id}: ${error instanceof Error ? error.message : String(error)}`, job_id: null };
  }
  return { ok: true, message: `Stopped the run ${run_id}`, job_id: null };
}

// Removes an ended run's folder from a host; one a running job still follows is left for the job to finish.
export async function forget_agent_run(store: Store, agents: AgentPool, host: string, run_id: string): Promise<StopOutcome> {
  const job = store.job_by_run(run_id);
  if (job !== null && job.state === "running") return { ok: false, message: `Job #${job.id} still follows the run ${run_id}`, job_id: job.id };
  try {
    await agents.get(host).forget(run_id);
  } catch (error) {
    return { ok: false, message: `Could not remove the run ${run_id}: ${error instanceof Error ? error.message : String(error)}`, job_id: null };
  }
  return { ok: true, message: `Removed the run ${run_id}`, job_id: null };
}

// ── Starting ─────────────────────────────────────────────────────────────────

// Starts a job's long run, kept awake on a host that sleeps, at once or after a wake it answers with.
export async function start_run(
  agents: AgentPool, host: string | null, run_id: string, operation: Operation, stdin: string | null = null, wake = true,
): Promise<{ waking: Promise<void> | null }> {
  const waking = wake && agents.can_wake(host);
  // Only a host this job wakes turns its screen back off, never one someone may be using.
  const running = agents.keeps_awake(host) ? kept_awake_job(operation, waking ? agents.screen_off(host) : null) : operation;
  if (waking) return { waking: agents.start_when_awake(host, run_id, running, stdin) };
  await agents.get(host).start(run_id, running, { stdin });
  return { waking: null };
}

// Shows a job as waking its host until its run starts, and fails it with why when the run never does; a job stopped
// while it waited fails as stopped, and stop_job has already noted that in the history.
export function track_wake(
  store: Store, job_id: number, host: string, waking: Promise<void>, now: () => number, on_failure: (error: string) => void = () => {},
): void {
  store.set_progress(job_id, `Waking ${host}`);
  waking.catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    store.append_output(job_id, `${message}\n`);
    if (error instanceof StoppedBeforeStart) {
      store.finish_job(job_id, "failed", null, `Stopped by ${error.by}`, now());
      return;
    }
    store.finish_job(job_id, "failed", null, "The job could not be started", now());
    on_failure(message);
  });
}
