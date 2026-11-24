// Follows a job's long run on its agent: copies its new output into the job, and finishes the job once the run has ended.

// ── Imports ──────────────────────────────────────────────────────────────────

import { follow_run, type Followed, type RunSink } from "@x-tech-laboratories/x-libs/server/runs";

import { StoppedBeforeStart, type AgentPool, type LongRun } from "./agents/agent.ts";
import { kept_awake_job } from "./agents/wake.ts";
import type { Operation } from "../shared/operations.ts";
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
}

// Stops a running job's long run on its agent, waiting for its processes to end; the job's owner finishes it on its
// next cycle, so whatever the owner does after a job, such as reading a switch's verdict, still happens.
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
  let run: LongRun;
  try {
    run = await agents.stop(job.agent, job.run_id, by);
  } catch (error) {
    return refuse(`Could not stop job #${job_id}: ${error instanceof Error ? error.message : String(error)}`);
  }
  // A run that ended on its own before the stop reached it keeps its own outcome.
  if (run.state !== "stopped") {
    agents.stopped_by(job.run_id, true);
    return refuse(`Job #${job_id} had already ended before it could be stopped`);
  }
  store.add_event(job.deployment_id, now(), "warning", `${by} stopped job #${job_id} (${job.kind})`);
  return { ok: true, message: `Stopped job #${job_id}`, job_id };
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
