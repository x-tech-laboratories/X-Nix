// Follows a job's long run on its agent: copies its new output into the job, and finishes the job once the run has ended.

// ── Imports ──────────────────────────────────────────────────────────────────

import { AgentError, type AgentPool } from "./agents/agent.ts";
import type { Job, Store } from "./store.ts";

// ── Following ────────────────────────────────────────────────────────────────

export interface Followed {
  outcome: "running" | "ended" | "unreachable";
  error: string;
}

// Copies the run's new output into the job and finishes the job once the run has ended; `describe` names a failing exit
// code its owner knows better, such as a timeout.
export async function follow(store: Store, agents: AgentPool, job: Job, now: () => number, describe: (exit_code: number) => string | null = () => null): Promise<Followed> {
  const agent = agents.get(job.agent);
  let offset = job.output_offset;
  let poll;
  try {
    do {
      poll = await agent.poll(job.run_id!, offset);
      store.append_output(job.id, poll.new_output, poll.next_offset);
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
  else if (poll.exit_code !== 0) error = describe(poll.exit_code) ?? `Exited with status ${poll.exit_code}`;
  store.finish_job(job.id, error === null ? "succeeded" : "failed", poll.exit_code, error, now());
  await agent.forget(job.run_id!);
  return { outcome: "ended", error: error ?? "" };
}
