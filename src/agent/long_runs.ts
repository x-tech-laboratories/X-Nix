// Long runs: commands that keep going on their own, in their own process group, so they outlive the connection that
// started them and the agent itself. Each writes its output and exit code into its own folder under the state
// directory, which is all a later agent needs to report on it, follow it, or stop it.
//
// A run's folder holds `run.json` (its pid and when the process began), `out` (stdout and stderr together), `exit`
// once it has ended, and `stopped` once it has been asked to stop. Its stdin, which carries a passphrase, is handed
// over through a pipe and never written down.

// ── Imports ──────────────────────────────────────────────────────────────────

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { constants } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { is_run_id, type LongRun, type LongRunPoll, type LongRunState } from "../shared/agent_protocol.ts";
import { type CommandStream, kill_grace_in_milliseconds, signal_group } from "./commands.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

// A poll returns at most this much output, and the next poll carries on from there.
export const poll_limit_in_bytes = 1024 * 1024;

// A followed run is read in pieces of this size.
const tail_chunk_in_bytes = 64 * 1024;

// The outer shell runs the command with its output in the run's folder, then writes the exit code in one rename.
const wrapper = 'sh -c "$2" > "$1/out" 2>&1; echo $? > "$1/exit.part"; mv -f "$1/exit.part" "$1/exit"';

export interface LongRunOptions {
  kill_grace_in_milliseconds?: number;
  // How often a followed run that has written nothing new is looked at again.
  tail_interval_in_milliseconds?: number;
}

interface RunRecord {
  run_id: string;
  pid: number;
  // When the process began, in clock ticks since boot, so a reused pid is not taken for the run.
  start_ticks: number | null;
  started_epoch: number;
}

export class LongRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LongRunError";
  }
}

// ── Long runs ────────────────────────────────────────────────────────────────

export class LongRuns {
  private readonly directory: string;
  private readonly grace: number;
  private readonly tail_interval: number;
  // The runs this agent started, whose exit it hears of directly.
  private readonly children = new Map<string, ChildProcess>();

  constructor(state_directory: string, options: LongRunOptions = {}) {
    this.directory = join(state_directory, "runs");
    this.grace = options.kill_grace_in_milliseconds ?? kill_grace_in_milliseconds;
    this.tail_interval = options.tail_interval_in_milliseconds ?? 250;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }

  // ── Starting ─────────────────────────────────────────────────────────────

  start(run_id: string, command: string, stdin: string | null): LongRun {
    const folder = this.folder(run_id);
    if (existsSync(folder)) throw new LongRunError(`A run named '${run_id}' already exists.`);
    mkdirSync(folder, { mode: 0o700 });
    writeFileSync(join(folder, "out"), "", { mode: 0o600 });

    const child = spawn("sh", ["-c", wrapper, "x-nix-run", folder, command], {
      detached: true,
      stdio: [stdin === null ? "ignore" : "pipe", "ignore", "ignore"],
    });
    if (child.pid === undefined) {
      rmSync(folder, { recursive: true, force: true });
      throw new LongRunError("Could not start sh.");
    }
    if (stdin !== null) {
      child.stdin!.on("error", () => {});
      child.stdin!.end(stdin);
    }
    // A wrapper killed before it could write its exit code is given the shell's code for that signal.
    child.on("exit", (code, signal) => {
      this.children.delete(run_id);
      const exit_file = join(folder, "exit");
      if (existsSync(folder) && !existsSync(exit_file)) {
        const exit_code = code ?? 128 + (signal === null ? 0 : constants.signals[signal]);
        writeFileSync(exit_file, `${exit_code}\n`);
      }
    });
    child.on("error", () => {});
    child.unref();
    this.children.set(run_id, child);

    const record: RunRecord = { run_id, pid: child.pid, start_ticks: start_ticks_of(child.pid), started_epoch: now_seconds() };
    write_atomically(join(folder, "run.json"), JSON.stringify(record));
    return this.describe(record);
  }

  // ── Reading ──────────────────────────────────────────────────────────────

  // Every run in the state directory, as found now, so a new agent knows the ones an earlier one started.
  list(): LongRun[] {
    const runs: LongRun[] = [];
    for (const name of readdirSync(this.directory)) {
      const record = this.record(name);
      if (record !== null) runs.push(this.describe(record));
    }
    return runs.sort((first, second) => first.started_epoch - second.started_epoch || first.run_id.localeCompare(second.run_id));
  }

  get(run_id: string): LongRun {
    return this.describe(this.require(run_id));
  }

  async poll(run_id: string, offset: number, limit = poll_limit_in_bytes): Promise<LongRunPoll> {
    const record = this.require(run_id);
    // The state is read before the output, so output read after an ending is known to be complete.
    const run = this.describe(record);
    const out = join(this.folder(run_id), "out");
    const size = statSync(out).size;
    const start = Math.max(0, Math.min(Math.trunc(offset), size));
    let bytes = await read_range(out, start, Math.min(limit, size - start));
    if (start + bytes.length < size) bytes = whole_text(bytes);
    return {
      state: run.state,
      exit_code: run.exit_code,
      alive: run.state === "running",
      size,
      new_output: bytes.toString("utf8"),
      next_offset: start + bytes.length,
    };
  }

  // Follows a run's output from an offset as it is written, ending once the run has ended and all of it is read.
  tail(run_id: string, offset: number): CommandStream {
    this.require(run_id);
    const out = join(this.folder(run_id), "out");
    let position = Math.max(0, Math.trunc(offset));
    let following = true;
    let reading = false;
    let wait_timer: NodeJS.Timeout | undefined;
    let wake: (() => void) | undefined;
    let settle!: (result: { exit_code: number; stderr: string }) => void;
    const done = new Promise<{ exit_code: number; stderr: string }>((resolve) => (settle = resolve));

    const pause = () => new Promise<void>((resolve) => {
      wake = resolve;
      wait_timer = setTimeout(resolve, this.tail_interval);
    });

    const pump = async () => {
      if (reading || !following) return;
      reading = true;
      try {
        while (following) {
          const run = this.describe(this.require(run_id));
          const chunk = await read_range(out, position, tail_chunk_in_bytes);
          if (!following) return;
          if (chunk.length > 0) {
            position += chunk.length;
            if (!stdout.push(chunk)) return;
            continue;
          }
          if (run.state !== "running") {
            following = false;
            stdout.push(null);
            settle({ exit_code: run.exit_code ?? -1, stderr: run.state === "exited" ? "" : `The run was ${run.state}.` });
            return;
          }
          await pause();
        }
      } catch (error) {
        following = false;
        stdout.destroy();
        settle({ exit_code: -1, stderr: `Could not follow the run: ${(error as Error).message}` });
      } finally {
        reading = false;
      }
    };

    const stdout = new Readable({
      read: () => void pump(),
      destroy: (error, callback) => {
        if (following) settle({ exit_code: -1, stderr: "Stopped following the run." });
        following = false;
        clearTimeout(wait_timer);
        wake?.();
        callback(error);
      },
    });

    return { stdout, done, stop: () => stdout.destroy() };
  }

  // ── Stopping ─────────────────────────────────────────────────────────────

  // Asks the run's process group to stop, kills it after the grace period, and settles once it has ended.
  async stop(run_id: string): Promise<LongRun> {
    const record = this.require(run_id);
    if (this.describe(record).state !== "running") return this.describe(record);
    writeFileSync(join(this.folder(run_id), "stopped"), "");
    signal_group(record.pid, "SIGTERM");
    const deadline = Date.now() + this.grace;
    while (this.is_alive(record)) {
      if (Date.now() >= deadline) {
        signal_group(record.pid, "SIGKILL");
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    while (this.is_alive(record)) await new Promise((resolve) => setTimeout(resolve, 50));
    return this.describe(record);
  }

  // Removes an ended run's folder.
  forget(run_id: string): void {
    const record = this.require(run_id);
    if (this.describe(record).state === "running") throw new LongRunError(`The run '${run_id}' is still running.`);
    rmSync(this.folder(run_id), { recursive: true, force: true });
  }

  // Forgets runs that ended longer ago than the age given.
  prune(max_age_in_seconds: number): void {
    const cutoff = Date.now() - max_age_in_seconds * 1000;
    for (const run of this.list()) {
      if (run.state === "running") continue;
      const exit_file = join(this.folder(run.run_id), "exit");
      const ended = existsSync(exit_file) ? statSync(exit_file).mtimeMs : run.started_epoch * 1000;
      if (ended < cutoff) this.forget(run.run_id);
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private folder(run_id: string): string {
    if (!is_run_id(run_id)) throw new LongRunError(`'${run_id}' is not a valid run id.`);
    return join(this.directory, run_id);
  }

  private record(run_id: string): RunRecord | null {
    if (!is_run_id(run_id)) return null;
    try {
      return JSON.parse(readFileSync(join(this.folder(run_id), "run.json"), "utf8")) as RunRecord;
    } catch {
      return null;
    }
  }

  private require(run_id: string): RunRecord {
    const record = this.record(run_id);
    if (record === null) throw new LongRunError(`No run named '${run_id}'.`);
    return record;
  }

  private is_alive(record: RunRecord): boolean {
    const child = this.children.get(record.run_id);
    if (child !== undefined) return child.exitCode === null && child.signalCode === null;
    try {
      process.kill(record.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
    }
    return record.start_ticks === null || start_ticks_of(record.pid) === record.start_ticks;
  }

  private describe(record: RunRecord): LongRun {
    const folder = this.folder(record.run_id);
    const stopped = existsSync(join(folder, "stopped"));
    const exit_code = read_exit_code(join(folder, "exit"));
    let state: LongRunState;
    if (exit_code !== null) state = stopped ? "stopped" : "exited";
    else if (this.is_alive(record)) state = "running";
    else state = stopped ? "stopped" : "lost";
    return { run_id: record.run_id, pid: record.pid, started_epoch: record.started_epoch, state, exit_code };
  }
}

// ── Files ────────────────────────────────────────────────────────────────────

function read_exit_code(path: string): number | null {
  try {
    const text = readFileSync(path, "utf8").trim();
    return /^-?\d+$/.test(text) ? Number(text) : null;
  } catch {
    return null;
  }
}

async function read_range(path: string, offset: number, length: number): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

// Cuts a piece of output back to its last whole line, or failing that its last whole character.
function whole_text(bytes: Buffer): Buffer {
  const last_newline = bytes.lastIndexOf(0x0a);
  if (last_newline !== -1) return bytes.subarray(0, last_newline + 1);
  let start = bytes.length - 1;
  while (start > 0 && start > bytes.length - 4 && (bytes[start] & 0xc0) === 0x80) start--;
  const lead = bytes[start];
  const needed = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return bytes.length - start < needed ? bytes.subarray(0, start) : bytes;
}

function write_atomically(path: string, text: string): void {
  writeFileSync(`${path}.part`, text, { mode: 0o600 });
  renameSync(`${path}.part`, path);
}

// When the process began, from /proc; null where /proc is missing.
function start_ticks_of(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The fields after the command name, which may itself hold spaces and parentheses; start time is field 22.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ticks = Number(fields[19]);
    return Number.isFinite(ticks) ? ticks : null;
  } catch {
    return null;
  }
}

function now_seconds(): number {
  return Math.floor(Date.now() / 1000);
}
