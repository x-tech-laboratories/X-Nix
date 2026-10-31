// The shapes the server and a host's agent share: one command's result and a long run's state.

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface RunResult {
  exit_code: number;
  stdout: string;
  stderr: string;
}

export type LongRunState = "running" | "exited" | "stopped" | "lost";

// A command the agent keeps going on its own, which outlives the connection and the agent.
export interface LongRun {
  run_id: string;
  pid: number;
  started_epoch: number;
  // Lost means it ended with no exit code written, as when the host rebooted under it.
  state: LongRunState;
  exit_code: number | null;
}

// What a long run has written since an offset, and whether it is still going.
export interface LongRunPoll {
  state: LongRunState;
  exit_code: number | null;
  alive: boolean;
  // The size of its whole output in bytes.
  size: number;
  new_output: string;
  // Where the next poll starts, which is short of `size` when a poll returns only part of the output.
  next_offset: number;
}

// ── Long run ids ─────────────────────────────────────────────────────────────

// A long run's id names its folder on the agent, so it is kept to safe characters.
export function is_run_id(value: string): boolean {
  return /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(value);
}
