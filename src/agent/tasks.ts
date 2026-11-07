// How an X-Nix agent carries out an operation: to its end within the agent, or as a long run in a runner process of
// its own, which reads the operation from the run's folder so it outlives the agent.

// ── Imports ──────────────────────────────────────────────────────────────────

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { LongRuns, type LongRunOptions } from "@x-tech-laboratories/x-libs/agent/long_runs";
import type { TaskRunner } from "@x-tech-laboratories/x-libs/agent/tasks";

import type { Operation } from "../shared/operations.ts";
import { run_operation } from "./run.ts";

// ── Runner ───────────────────────────────────────────────────────────────────

const runner_program = fileURLToPath(new URL("./runner.ts", import.meta.url));

// What the agent leaves in the run's folder for the runner.
export interface RunPlan {
  operation: Operation;
  // Whether the operation's stdin arrives on the runner's.
  stdin: boolean;
}

export const plan_file = "operation.json";

export const operation_runner: TaskRunner<Operation> = {
  run: (operation, options) => run_operation(operation, options),
  launch: (operation, folder, has_stdin) => {
    const plan: RunPlan = { operation, stdin: has_stdin };
    writeFileSync(join(folder, plan_file), JSON.stringify(plan), { mode: 0o600 });
    return { program: process.execPath, args: [runner_program, folder] };
  },
};

// The long runs kept under a state directory, each performed by the runner.
export function operation_runs(state_directory: string, options: LongRunOptions = {}): LongRuns<Operation> {
  return new LongRuns(state_directory, operation_runner, options);
}
