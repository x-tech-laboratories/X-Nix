// What X-Nix's server and agents agree on over the agent's WebSocket, on top of X-Libs' agent protocol: each run or
// long run carries an operation (see operations.ts), which the agent performs itself rather than a command line.
//
// After its hello, an agent that deployed from Git on its own sends `pulls`, and the server answers with
// `pulls_received` naming those it kept.

// ── Imports ──────────────────────────────────────────────────────────────────

import { key_host_header as header_for, type AgentApp } from "@x-tech-laboratories/x-libs/agent/protocol";

import { is_operation, type Operation } from "./operations.ts";

export type { LongRun, LongRunPoll, LongRunState, RunResult } from "@x-tech-laboratories/x-libs/agent/protocol";

// ── App ──────────────────────────────────────────────────────────────────────

export const x_nix_app: AgentApp<Operation> = {
  name: "x-nix",
  protocol_version: 2,
  task_field: "operation",
  is_task: is_operation,
};

// The upgrade header an agent names its host in.
export const key_host_header = header_for(x_nix_app.name);

// ── Pull reports ─────────────────────────────────────────────────────────────

// A switch the agent ran on its own from Git while the server was unreachable, reported once the server is back.
export interface PullReport {
  run_id: string;
  // The Git remote and branch the revision came from.
  remote: string;
  branch: string;
  revision: string;
  // The operation it ran, as JSON.
  command: string;
  started_epoch: number;
  finished_epoch: number | null;
  // Null when the run ended without writing one.
  exit_code: number | null;
  // The end of what the switch printed.
  output: string;
}
