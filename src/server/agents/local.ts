// The agent built into the server for its own machine, performing operations and long runs itself.

// ── Imports ──────────────────────────────────────────────────────────────────

import { LongRunError, LongRuns, type LongRunOptions } from "../../agent/long_runs.ts";
import { run_operation } from "../../agent/run.ts";
import type { Operation } from "../../shared/operations.ts";
import { AgentError, type Agent, type LongRun, type LongRunPoll, type RunResult } from "./agent.ts";

// ── Local agent ──────────────────────────────────────────────────────────────

export class LocalAgent implements Agent {
  readonly long_runs: LongRuns;

  // Long runs keep their output under the state directory, so they outlive a restart of the server.
  constructor(state_directory: string, options: LongRunOptions = {}) {
    this.long_runs = new LongRuns(state_directory, options);
  }

  run(operation: Operation, timeout_in_seconds: number): Promise<RunResult> {
    return run_operation(operation, { timeout_in_seconds });
  }

  async start(run_id: string, operation: Operation, stdin: string | null = null): Promise<LongRun> {
    return as_agent_error(() => this.long_runs.start(run_id, operation, stdin));
  }

  async poll(run_id: string, offset: number): Promise<LongRunPoll> {
    return as_agent_error(() => this.long_runs.poll(run_id, offset));
  }

  async forget(run_id: string): Promise<void> {
    try {
      this.long_runs.forget(run_id);
    } catch {
      // A run already gone, or still running, is left as it is.
    }
  }
}

async function as_agent_error<Answer>(work: () => Answer | Promise<Answer>): Promise<Answer> {
  try {
    return await work();
  } catch (error) {
    throw error instanceof LongRunError ? new AgentError(error.message) : error;
  }
}
