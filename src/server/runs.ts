// Follows a job's long run on its agent: copies its new output into the job, and finishes the job once the run has ended.

// ── Imports ──────────────────────────────────────────────────────────────────

import { AgentError, type AgentPool } from "./agents/agent.ts";
import { kept_awake_job } from "./agents/wake.ts";
import type { Operation } from "../shared/operations.ts";
import type { Job, Store } from "./store.ts";

// ── Following ────────────────────────────────────────────────────────────────

export interface Followed {
  outcome: "running" | "ended" | "unreachable";
  error: string;
}

// Turns a piece of a run's output into what the job keeps; ended is set once with nothing more to come.
export type Translate = (job: Job, chunk: string, ended: boolean) => string;

// Copies the run's new output into the job and finishes the job once the run has ended; `describe` names a failing exit
// code its owner knows better, such as a timeout, and `translate` rewrites output such as nix's structured log.
export async function follow(
  store: Store, agents: AgentPool, job: Job, now: () => number, describe: (exit_code: number) => string | null = () => null, translate: Translate | null = null,
): Promise<Followed> {
  // A run still waiting on its host to wake has nothing to read yet.
  if (agents.is_starting(job.run_id)) return { outcome: "running", error: "" };
  const agent = agents.get(job.agent);
  let offset = job.output_offset;
  let poll;
  try {
    do {
      poll = await agent.poll(job.run_id!, offset);
      store.append_output(job.id, translate === null ? poll.new_output : translate(job, poll.new_output, false), poll.next_offset);
      offset = poll.next_offset;
    } while (offset < poll.size && poll.new_output !== "");
  } catch (error) {
    if (error instanceof AgentError && error.unreachable) return { outcome: "unreachable", error: error.message };
    // A run the agent no longer knows has ended without a word.
    poll = { alive: false, exit_code: null };
  }
  if (poll.alive) return { outcome: "running", error: "" };
  if (translate !== null) store.append_output(job.id, translate(job, "", true));

  let error: string | null = null;
  if (poll.exit_code === null) error = "The run ended without writing an exit code";
  else if (poll.exit_code !== 0) error = describe(poll.exit_code) ?? `Exited with status ${poll.exit_code}`;
  store.finish_job(job.id, error === null ? "succeeded" : "failed", poll.exit_code, error, now());
  await agent.forget(job.run_id!);
  return { outcome: "ended", error: error ?? "" };
}

// ── Starting ─────────────────────────────────────────────────────────────────

// Starts a job's long run, kept awake on a host that sleeps, at once or after a wake it answers with.
export async function start_run(
  agents: AgentPool, host: string | null, run_id: string, operation: Operation, stdin: string | null = null, wake = true,
): Promise<{ waking: Promise<void> | null }> {
  const running = agents.keeps_awake(host) ? kept_awake_job(operation) : operation;
  if (wake && agents.can_wake(host)) return { waking: agents.start_when_awake(host, run_id, running, stdin) };
  await agents.get(host).start(run_id, running, stdin);
  return { waking: null };
}

// Shows a job as waking its host until its run starts, and fails it with why when the run never does.
export function track_wake(
  store: Store, job_id: number, host: string, waking: Promise<void>, now: () => number, on_failure: (error: string) => void = () => {},
): void {
  store.set_progress(job_id, `Waking ${host}`);
  waking.catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    store.append_output(job_id, `${message}\n`);
    store.finish_job(job_id, "failed", null, "The job could not be started", now());
    on_failure(message);
  });
}
