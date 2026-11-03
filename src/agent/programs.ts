// Runs one program with its arguments, never through a shell, for an operation: what it prints goes to the operation's
// output, is kept for the operation to read, or both. Both the agent and the server's built-in agent run programs here.

// ── Imports ──────────────────────────────────────────────────────────────────

import { spawn } from "node:child_process";
import { constants as fs_constants } from "node:fs";
import { access } from "node:fs/promises";
import { constants } from "node:os";

import { show_argv, type Argv, type Step } from "../shared/operations.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

// Where an operation's output goes.
export interface Sink {
  write(chunk: Buffer | string): void;
}

// Whether a program's stream is shown in the operation's output, kept for the operation, both, or thrown away.
export type StreamUse = "show" | "keep" | "both" | "drop";

export interface ProgramOptions {
  stdin?: string | null;
  stdout?: StreamUse;
  stderr?: StreamUse;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  // Prints the program as a `$` line before it runs, when the context keeps a log.
  echo?: boolean;
}

export interface ProgramResult {
  exit_code: number;
  stdout: string;
  stderr: string;
}

export type RunProgram = (context: Context, argv: Argv, options?: ProgramOptions) => Promise<ProgramResult>;

// What an operation runs within.
export interface Context {
  out: Sink;
  // Errors, which a long run writes into the same output.
  err: Sink;
  // Aborted once the operation is to stop.
  signal: AbortSignal;
  // Whether each program gets a process group of its own, so stopping it stops everything it started.
  own_groups: boolean;
  // Whether the output is a log a person reads, which shows each program as it starts, rather than an answer to parse.
  log: boolean;
  // What the operation was handed on stdin.
  stdin: string | null;
  program: RunProgram;
}

// Give a stopped program this long to exit before it is killed outright.
export const kill_grace_in_milliseconds = 5000;

// A run keeps at most this much stdout, since it travels whole in one message.
export const stdout_limit_in_bytes = 32 * 1024 * 1024;

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
export class BoundedBuffer {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  truncated = false;
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  write(chunk: Buffer | string): void {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    const room = this.limit - this.size;
    if (room <= 0) {
      this.truncated = bytes.length > 0 || this.truncated;
      return;
    }
    const kept = bytes.length > room ? bytes.subarray(0, room) : bytes;
    if (kept !== bytes) this.truncated = true;
    this.chunks.push(kept);
    this.size += kept.length;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

const shows = (use: StreamUse) => use === "show" || use === "both";
const keeps = (use: StreamUse) => use === "keep" || use === "both";

// ── Running ──────────────────────────────────────────────────────────────────

export const spawn_program: RunProgram = (context, argv, options = {}) => new Promise((resolve) => {
  const stdout_use = options.stdout ?? "show";
  const stderr_use = options.stderr ?? "show";
  if (options.echo && context.log) context.out.write(`$ ${show_argv(argv)}\n`);
  if (context.signal.aborted) {
    resolve({ exit_code: -1, stdout: "", stderr: "Stopped before it started" });
    return;
  }
  const child = spawn(argv[0], argv.slice(1), {
    detached: context.own_groups,
    stdio: [options.stdin == null ? "ignore" : "pipe", "pipe", "pipe"],
    env: options.env,
    cwd: options.cwd,
  });
  if (options.stdin != null) {
    child.stdin!.on("error", () => {});
    child.stdin!.end(options.stdin);
  }
  const stdout = new BoundedBuffer(stdout_limit_in_bytes);
  const stderr = new BoundedBuffer(stderr_limit_in_bytes);
  child.stdout!.on("data", (chunk: Buffer) => {
    if (shows(stdout_use)) context.out.write(chunk);
    if (keeps(stdout_use)) stdout.write(chunk);
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    if (shows(stderr_use)) context.err.write(chunk);
    if (keeps(stderr_use)) stderr.write(chunk);
  });

  let kill_timer: NodeJS.Timeout | undefined;
  const stop = () => {
    const signal = (name: NodeJS.Signals) => (context.own_groups ? signal_group(child.pid, name) : child.kill(name));
    signal("SIGTERM");
    kill_timer = setTimeout(() => signal("SIGKILL"), kill_grace_in_milliseconds);
  };
  context.signal.addEventListener("abort", stop, { once: true });

  let settled = false;
  const settle = (result: ProgramResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(kill_timer);
    context.signal.removeEventListener("abort", stop);
    resolve(result);
  };
  child.on("error", (error: NodeJS.ErrnoException) => {
    const message = error.code === "ENOENT" ? `${argv[0]} is not installed on this host` : `Could not start ${argv[0]}: ${error.message}`;
    if (shows(stderr_use)) context.err.write(`${message}\n`);
    settle({ exit_code: error.code === "ENOENT" ? 127 : -1, stdout: "", stderr: message });
  });
  child.on("close", (code, signal) => {
    const exit_code = code ?? 128 + (signal === null ? 0 : constants.signals[signal]);
    settle({ exit_code, stdout: stdout.text(), stderr: stderr.text() });
  });
});

// The program a step runs here: itself, or ssh carrying it to its host as one command line.
export function step_argv(step: Step): Argv {
  if (step.ssh === undefined) return step.argv;
  const options = (process.env.NIX_SSHOPTS ?? "").split(/\s+/).filter(Boolean);
  return [...(step.ssh.sudo ? ["sudo", "-n"] : []), "ssh", ...options, step.ssh.host, show_argv(step.argv)];
}

// Runs each step in turn, showing it as it goes, and answers the first failing status, or 0.
export async function run_steps(context: Context, steps: Step[]): Promise<number> {
  for (const step of steps) {
    const result = await context.program(context, step_argv(step), { echo: true, stdout: step.quiet ? "drop" : "show" });
    if (result.exit_code !== 0) return result.exit_code;
  }
  return 0;
}

// Runs a command a person wrote into the config, exactly as written.
export function person_command(command: string, sudo = false): Argv {
  return sudo ? ["sudo", "-n", "/bin/sh", "-c", command] : ["/bin/sh", "-c", command];
}

// Where a program is on the PATH, or null when it is not there.
export async function on_path(name: string): Promise<string | null> {
  const folders = name.includes("/") ? [""] : (process.env.PATH ?? "").split(":").filter(Boolean);
  for (const folder of folders) {
    const path = folder === "" ? name : `${folder}/${name}`;
    try {
      await access(path, fs_constants.X_OK);
      return path;
    } catch {
      // Not in this folder.
    }
  }
  return null;
}
