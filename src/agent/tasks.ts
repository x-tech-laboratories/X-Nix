// How an X-Nix agent carries out an operation: to its end within the agent, or as a long run in a runner process of
// its own, which reads the operation from the run's folder so it outlives the agent.

// ── Imports ──────────────────────────────────────────────────────────────────

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { LongRuns, type LongRunOptions, type LongRunUnit } from "@x-tech-laboratories/x-libs/agent/long_runs";
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

// ── Units ────────────────────────────────────────────────────────────────────

// Each run's unit is `x-nix-run-<run id>.service`, the name the sudo rules allow.
export const run_unit_prefix = "x-nix-run";

// What the module sets for the runs' units: the slice they share and properties copied from the agent's own unit.
export interface RunUnitSettings {
  slice?: string;
  properties?: Record<string, string>;
}

export class RunUnitConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunUnitConfigError";
  }
}

// The variables systemd sets for the agent's own unit, which a run's unit gets fresh.
const own_unit_variables = new Set([
  "CREDENTIALS_DIRECTORY", "INVOCATION_ID", "JOURNAL_STREAM", "LISTEN_FDNAMES", "LISTEN_FDS", "LISTEN_PID", "MAINPID", "MANAGERPID",
  "MEMORY_PRESSURE_WATCH", "MEMORY_PRESSURE_WRITE", "NOTIFY_SOCKET", "SYSTEMD_EXEC_PID", "WATCHDOG_PID", "WATCHDOG_USEC",
]);

export function parse_run_unit_settings(raw: unknown): RunUnitSettings {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new RunUnitConfigError("The run unit settings must be an object.");
  const { slice, properties } = raw as Record<string, unknown>;
  if (slice !== undefined && slice !== null && (typeof slice !== "string" || !/^[A-Za-z0-9_.@-]+\.slice$/.test(slice))) {
    throw new RunUnitConfigError(`The runs' slice must be a slice unit's name, not ${JSON.stringify(slice)}.`);
  }
  if (properties !== undefined && (typeof properties !== "object" || properties === null || Array.isArray(properties)
    || Object.values(properties).some((value) => typeof value !== "string"))) {
    throw new RunUnitConfigError("The runs' unit properties must map names to strings.");
  }
  return { slice: slice ?? undefined, properties: properties as Record<string, string> | undefined };
}

// Long runs as transient units started with sudo, each given the agent's environment.
export function run_unit(settings: RunUnitSettings, environment: Record<string, string | undefined>): LongRunUnit {
  return {
    prefix: run_unit_prefix,
    slice: settings.slice,
    properties: settings.properties,
    environment: Object.fromEntries(
      Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined && !own_unit_variables.has(entry[0])),
    ),
    start_command: ["sudo", "-n", "systemd-run"],
    stop_command: ["sudo", "-n", "systemctl", "stop"],
  };
}

// The long runs kept under a state directory, each performed by the runner.
export function operation_runs(state_directory: string, options: LongRunOptions = {}): LongRuns<Operation> {
  return new LongRuns(state_directory, operation_runner, options);
}
