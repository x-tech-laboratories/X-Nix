// Performs an operation to its end within this process, keeping what it prints, for a request that waits on its answer.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { RunResult } from "../shared/agent_protocol.ts";
import type { Operation } from "../shared/operations.ts";
import { perform } from "./operations/index.ts";
import { BoundedBuffer, spawn_program, stderr_limit_in_bytes, stdout_limit_in_bytes, type RunProgram } from "./programs.ts";

// ── Running ──────────────────────────────────────────────────────────────────

export interface RunOptions {
  timeout_in_seconds: number;
  stdin?: string | null;
  // Runs each program; tests replace it.
  program?: RunProgram;
}

export async function run_operation(operation: Operation, options: RunOptions): Promise<RunResult> {
  const out = new BoundedBuffer(stdout_limit_in_bytes);
  const err = new BoundedBuffer(stderr_limit_in_bytes);
  const controller = new AbortController();
  let timed_out = false;
  const timer = setTimeout(() => {
    timed_out = true;
    controller.abort();
  }, options.timeout_in_seconds * 1000);
  const context = { out, err, signal: controller.signal, own_groups: true, log: false, stdin: options.stdin ?? null, program: options.program ?? spawn_program };
  let exit_code: number;
  try {
    exit_code = await perform(context, operation);
  } catch (error) {
    err.write((error as Error).message);
    exit_code = 1;
  } finally {
    clearTimeout(timer);
  }
  if (timed_out) return { exit_code: -1, stdout: out.text().trim(), stderr: `Timed out after ${options.timeout_in_seconds}s` };
  const note = out.truncated ? `Output cut at ${stdout_limit_in_bytes} bytes` : "";
  return { exit_code, stdout: out.text().trim(), stderr: [err.text().trim(), note].filter(Boolean).join("\n") };
}
