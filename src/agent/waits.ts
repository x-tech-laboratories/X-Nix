// What a stalled run is doing, read from /proc: the programs it still runs, the file locks they wait for, and the
// processes holding those locks. Everything here is readable by any user, so it works for root's programs too.

// ── Imports ──────────────────────────────────────────────────────────────────

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { format_duration } from "@x-tech-laboratories/x-libs/durations";

import { stall_mark } from "../shared/operations.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

export const nix_database_lock = "/nix/var/nix/db/big-lock";
export const switch_lock = "/run/nixos/switch-to-configuration.lock";

// The locks a stalled switch most often waits for, by what a person calls them.
const lock_names: Record<string, string> = {
  [nix_database_lock]: "the Nix store database",
  [switch_lock]: "the switch lock, held by another switch",
};

// Clock ticks per second in /proc's start times, which Linux fixes at 100 for user space.
const ticks_per_second = 100;

// How many holders a note names before counting the rest.
const holders_named = 6;

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface ProcessInfo {
  pid: number;
  ppid: number;
  name: string;
  age_in_seconds: number;
}

export interface LockEntry {
  pid: number;
  // Whether the process waits for the lock, rather than holding it.
  waiting: boolean;
  mode: "READ" | "WRITE";
  // The locked file as /proc/locks names it: device and inode.
  file: string;
}

// ── Reading /proc ────────────────────────────────────────────────────────────

export function read_processes(proc = "/proc"): Map<number, ProcessInfo> {
  const uptime = Number(read_text(join(proc, "uptime")).split(" ")[0]) || 0;
  const processes = new Map<number, ProcessInfo>();
  for (const entry of list(proc)) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = read_text(join(proc, entry, "stat"));
    const open = stat.indexOf("(");
    const close = stat.lastIndexOf(")");
    if (open === -1 || close === -1) continue;
    // The fields after the name start at the state, the third field; the start time is the 22nd.
    const fields = stat.slice(close + 2).split(" ");
    const started = Number(fields[19]) / ticks_per_second;
    processes.set(Number(entry), { pid: Number(entry), ppid: Number(fields[1]), name: stat.slice(open + 1, close), age_in_seconds: Math.max(0, uptime - started) });
  }
  return processes;
}

export function read_locks(proc = "/proc"): LockEntry[] {
  const entries: LockEntry[] = [];
  for (const line of read_text(join(proc, "locks")).split("\n")) {
    const words = line.trim().split(/\s+/);
    const waiting = words[1] === "->";
    // A line is its number, the lock's kind and class, its mode, then the process and the file; a waiter's has "->" first.
    const [, , , mode, pid, file] = waiting ? words.slice(1) : words;
    if (pid === undefined || file === undefined || (mode !== "READ" && mode !== "WRITE")) continue;
    entries.push({ pid: Number(pid), waiting, mode, file });
  }
  return entries;
}

// How /proc/locks names a file: its device's major and minor numbers in hex, then its inode.
export function lock_file_id(path: string): string | null {
  try {
    const { dev, ino } = statSync(path, { bigint: true });
    const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn);
    const minor = (dev & 0xffn) | ((dev >> 12n) & ~0xffn);
    return `${major.toString(16).padStart(2, "0")}:${minor.toString(16).padStart(2, "0")}:${ino}`;
  } catch {
    return null;
  }
}

// ── Questions ────────────────────────────────────────────────────────────────

// Every process started under the root, at any depth.
export function descendants(processes: Map<number, ProcessInfo>, root: number): ProcessInfo[] {
  const children = new Map<number, ProcessInfo[]>();
  for (const info of processes.values()) children.set(info.ppid, [...(children.get(info.ppid) ?? []), info]);
  const found: ProcessInfo[] = [];
  const next = [...(children.get(root) ?? [])];
  while (next.length > 0) {
    const info = next.shift()!;
    found.push(info);
    next.push(...(children.get(info.pid) ?? []));
  }
  return found;
}

// The processes holding a lock on the file, other than those given.
export function lock_holders(path: string, except: Set<number> = new Set(), proc = "/proc", file_id = lock_file_id(path)): ProcessInfo[] {
  if (file_id === null) return [];
  const processes = read_processes(proc);
  const pids = new Set(read_locks(proc).filter((entry) => !entry.waiting && entry.file === file_id && !except.has(entry.pid)).map((entry) => entry.pid));
  return [...pids].map((pid) => processes.get(pid)).filter((info): info is ProcessInfo => info !== undefined);
}

// Names a process the way a note shows it.
export function show_process(info: ProcessInfo): string {
  return `${info.name} (pid ${info.pid}, running for ${format_duration(info.age_in_seconds, { largest_unit: "days" })})`;
}

export function show_holders(holders: ProcessInfo[]): string {
  const named = holders.slice(0, holders_named).map(show_process).join(", ");
  return holders.length > holders_named ? `${named} and ${holders.length - holders_named} more` : named;
}

// ── Notes ────────────────────────────────────────────────────────────────────

export interface StallOptions {
  proc?: string;
  // The files to name by what they are, as their /proc/locks ids; read from the real paths when absent.
  lock_files?: Record<string, string>;
}

// The lines a run prints once it has been quiet for the given time: what it still runs, and what any of it waits for.
export function describe_stall(root: number, quiet_in_seconds: number, options: StallOptions = {}): string[] {
  const proc = options.proc ?? "/proc";
  const files = options.lock_files ?? known_lock_files();
  const processes = read_processes(proc);
  const under = descendants(processes, root);
  const own = new Set(under.map((info) => info.pid));

  const parents = new Set(under.map((info) => info.ppid));
  const chains = under.filter((info) => !parents.has(info.pid)).slice(0, 3).map((leaf) => chain_to(processes, root, leaf));
  const lines = [`No output for ${format_duration(quiet_in_seconds)}; still running ${chains.length > 0 ? chains.join("; ") : "nothing under the run"}`];

  const locks = read_locks(proc);
  for (const wait of locks.filter((entry) => entry.waiting && own.has(entry.pid))) {
    const waiter = processes.get(wait.pid)!;
    const path = Object.entries(files).find(([, id]) => id === wait.file)?.[0] ?? null;
    const holders = [...new Set(locks.filter((entry) => !entry.waiting && entry.file === wait.file && entry.pid !== wait.pid).map((entry) => entry.pid))]
      .map((pid) => processes.get(pid))
      .filter((info): info is ProcessInfo => info !== undefined);
    const what = path === null ? `a lock on file ${wait.file}` : `${lock_names[path]} (${path})`;
    lines.push(`${waiter.name} (pid ${waiter.pid}) waits for ${what}, held by ${holders.length > 0 ? show_holders(holders) : "nothing it can see"}`);
    if (path === nix_database_lock) {
      lines.push(
        "A newer Nix needs the store database to itself to upgrade it; long-lived Nix clients, such as a language server, keep it from getting it. " +
          "close_nix_lock_holders stops them on its own.",
      );
    }
  }
  return lines.map((line) => `${stall_mark} ${line}`);
}

export function known_lock_files(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const path of Object.keys(lock_names)) {
    const id = lock_file_id(path);
    if (id !== null) files[path] = id;
  }
  return files;
}

// The programs from the root down to the leaf, as "a › b › c (pid N)".
function chain_to(processes: Map<number, ProcessInfo>, root: number, leaf: ProcessInfo): string {
  const names: string[] = [];
  for (let info: ProcessInfo | undefined = leaf; info !== undefined && info.pid !== root; info = processes.get(info.ppid)) names.unshift(info.name);
  return `${names.join(" › ")} (pid ${leaf.pid})`;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function read_text(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function list(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}
