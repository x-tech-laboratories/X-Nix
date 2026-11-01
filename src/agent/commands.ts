// Runs one shell command on this machine, either to its end with its output kept or with its stdout handed back as it
// comes. Both the agent and the server's built-in agent run commands through here.

// ── Imports ──────────────────────────────────────────────────────────────────

import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

import type { RunResult } from "../shared/agent_protocol.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface RunOptions {
  timeout_in_seconds: number;
  stdin?: string | null;
}

export interface StreamOptions {
  stdin?: string | null;
}

// A running command whose stdout is read as it comes, rather than kept until it ends.
export interface CommandStream {
  stdout: Readable;
  // Settles once the command has ended and its stdout has been read to the end.
  done: Promise<{ exit_code: number; stderr: string }>;
  // Stops the command and everything it started.
  stop: () => void;
}

// Give a stopped command this long to exit before it is killed outright.
export const kill_grace_in_milliseconds = 5000;

// A run keeps at most this much stdout, since it travels whole in one message.
export const run_stdout_limit_in_bytes = 32 * 1024 * 1024;

// Stderr is only ever an error message, so this much is plenty.
export const stderr_limit_in_bytes = 64 * 1024;

// ── Helpers ──────────────────────────────────────────────────────────────────

// Sends the signal to a process group, which may have ended already.
export function signal_group(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // The process group is already gone.
  }
}

// Collects chunks up to a size, noting whether any were dropped.
class BoundedBuffer {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  truncated = false;
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  add(chunk: Buffer): void {
    const room = this.limit - this.size;
    if (room <= 0) {
      this.truncated = true;
      return;
    }
    const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
    if (kept !== chunk) this.truncated = true;
    this.chunks.push(kept);
    this.size += kept.length;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8").trim();
  }
}

// Its own process group, so stopping it stops the command's children too.
function spawn_shell(command: string, stdin: string | null | undefined) {
  const child = spawn("sh", ["-c", command], { detached: true, stdio: [stdin == null ? "ignore" : "pipe", "pipe", "pipe"] });
  if (stdin != null) {
    child.stdin!.on("error", () => {});
    child.stdin!.end(stdin);
  }
  return child;
}

// ── Running ──────────────────────────────────────────────────────────────────

export function run_command(command: string, options: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn_shell(command, options.stdin);
    const stdout = new BoundedBuffer(run_stdout_limit_in_bytes);
    const stderr = new BoundedBuffer(stderr_limit_in_bytes);
    let timed_out = false;
    let kill_timer: NodeJS.Timeout | undefined;

    const timeout_timer = setTimeout(() => {
      timed_out = true;
      signal_group(child.pid, "SIGTERM");
      kill_timer = setTimeout(() => signal_group(child.pid, "SIGKILL"), kill_grace_in_milliseconds);
    }, options.timeout_in_seconds * 1000);

    child.stdout!.on("data", (chunk: Buffer) => stdout.add(chunk));
    child.stderr!.on("data", (chunk: Buffer) => stderr.add(chunk));

    child.on("error", (error) => {
      clearTimeout(timeout_timer);
      clearTimeout(kill_timer);
      resolve({ exit_code: -1, stdout: "", stderr: `Could not start sh: ${error.message}` });
    });

    child.on("close", (exit_code) => {
      clearTimeout(timeout_timer);
      clearTimeout(kill_timer);
      if (timed_out) {
        resolve({ exit_code: -1, stdout: stdout.text(), stderr: `Timed out after ${options.timeout_in_seconds}s` });
        return;
      }
      const note = stdout.truncated ? `Output cut at ${run_stdout_limit_in_bytes} bytes` : "";
      resolve({ exit_code: exit_code ?? -1, stdout: stdout.text(), stderr: [stderr.text(), note].filter(Boolean).join("\n") });
    });
  });
}

// ── Streaming ────────────────────────────────────────────────────────────────

// Runs the command with no timeout and hands back its stdout as it comes, for output too big to hold.
export function stream_command(command: string, options: StreamOptions = {}): CommandStream {
  const child = spawn_shell(command, options.stdin);
  const stderr = new BoundedBuffer(stderr_limit_in_bytes);
  let ended = false;
  let kill_timer: NodeJS.Timeout | undefined;

  child.stderr!.on("data", (chunk: Buffer) => stderr.add(chunk));

  const done = new Promise<{ exit_code: number; stderr: string }>((resolve) => {
    child.on("error", (error) => {
      ended = true;
      resolve({ exit_code: -1, stderr: `Could not start sh: ${error.message}` });
    });
    child.on("close", (exit_code) => {
      ended = true;
      clearTimeout(kill_timer);
      resolve({ exit_code: exit_code ?? -1, stderr: stderr.text() });
    });
  });

  const stop = () => {
    if (ended) return;
    signal_group(child.pid, "SIGTERM");
    // Output nobody reads any more is thrown away, so a full pipe cannot keep the command from ending.
    child.stdout!.unpipe();
    child.stdout!.destroy();
    kill_timer ??= setTimeout(() => signal_group(child.pid, "SIGKILL"), kill_grace_in_milliseconds);
  };

  return { stdout: child.stdout!, done, stop };
}
