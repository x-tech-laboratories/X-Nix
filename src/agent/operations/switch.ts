// A switch: its pre-switch checks, the fetch of a closure from the cache, its watchdog, the activation, post_switch and
// its health checks, printing marker lines that tell the server how it went; and the files X-Nix writes to confirm a
// switch or to have it rolled back. A guarded switch ends once its watchdog gives an outcome, even while the activation
// hangs, and with close_nix_lock_holders it stops what keeps the activation from the Nix store database.

// ── Imports ──────────────────────────────────────────────────────────────────

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  stall_mark, switch_mark, watch_folder, watch_folder_prefix, watch_folders_parent, type ConfirmSwitchOperation, type SignalRollbackOperation,
  type SwitchOperation, type SwitchWatch,
} from "../../shared/operations.ts";
import { person_command, run_steps, type Context } from "../programs.ts";
import { descendants, lock_file_id, lock_holders, nix_database_lock, read_locks, read_processes, show_holders, type ProcessInfo } from "../waits.ts";
import { system_profile, watch_files, write_whole } from "../watchdog.ts";
import { link_target, real } from "./reads.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

const watchdog_program = fileURLToPath(new URL("../watchdog.ts", import.meta.url));

// A switch's folder whose run died this long ago is cleared by the next switch.
const stale_folder_in_milliseconds = 86_400_000;

// How often the switch looks for its watchdog's outcome.
const outcome_interval_in_milliseconds = 2000;

// How long a switch's program waits for the Nix store database before close_nix_lock_holders acts, and how long those
// it stopped get to let go before they are killed.
const nix_lock_patience_in_milliseconds = 60_000;
const nix_lock_grace_in_milliseconds = 10_000;

// ── Switch ───────────────────────────────────────────────────────────────────

export async function switch_system(context: Context, operation: SwitchOperation, now: () => number = () => Date.now()): Promise<number> {
  const mark = (words: string) => context.out.write(`${switch_mark} ${words}\n`);
  const say = (line: string) => context.out.write(`${line}\n`);

  if (operation.pre_switch_checks.length > 0) {
    mark("phase pre-switch-checks");
    for (const [index, check] of operation.pre_switch_checks.entries()) {
      say(`$ ${check}`);
      const result = await context.program(context, person_command(check));
      if (result.exit_code !== 0) {
        mark(`refused Pre-switch check ${index + 1} (${clip_line(check)}) failed with status ${result.exit_code}`);
        return 3;
      }
    }
    say("Every pre-switch check passed");
  }

  // Fetched before the watchdog starts, so a slow download never uses up the time the activation has.
  const fetch_steps = operation.fetch_steps ?? [];
  if (fetch_steps.length > 0) {
    mark("phase fetch");
    const fetched = await run_steps(context, fetch_steps);
    if (fetched !== 0) {
      mark(`outcome unchanged The fetch from the cache failed with status ${fetched}`);
      return fetched;
    }
  }

  const watch = operation.watch;
  const folder = watch === null ? null : watch_folder(watch.token);
  if (watch !== null && folder !== null) {
    mark("phase watch");
    try {
      start_watchdog(watch, folder);
    } catch (error) {
      mark(`refused Could not start the rollback watchdog on the host: ${(error as Error).message}`);
      return 3;
    }
    say(`The watchdog in ${folder} rolls this switch back unless it is confirmed`);
  }

  mark(`phase ${operation.mode}`);
  const ended = await activation_or_outcome(context, operation, folder, now);
  if ("outcome" in ended) {
    context.out.write(read_log(folder!));
    rmSync(folder!, { recursive: true, force: true });
    say(`${operation.activation_name} is still running, but its watchdog has given its outcome, so this switch ends here`);
    mark(`outcome ${ended.outcome}`);
    return 1;
  }
  const { status } = ended;
  // post_switch runs whatever the activation returned, and its own status never changes the switch's.
  if (operation.post_switch !== null) await context.program(context, operation.post_switch, { echo: true });
  if (watch === null || folder === null) return status;

  let failure = "";
  if (status !== 0) {
    failure = `${operation.activation_name} failed with status ${status}`;
    signal_rollback_in(folder, failure);
  } else {
    touch(join(folder, watch_files.activated));
    mark("activated");
    if (watch.health_commands.length > 0) failure = await health_checks(context, watch, folder, now);
    if (failure === "") mark("awaiting-confirmation");
  }

  // The run waits for the watchdog's outcome a little longer than the watchdog itself can take.
  const deadline = now() + (watch.activation_timeout + watch.confirm_window + 120) * 1000;
  let outcome = read_outcome(folder);
  while (outcome === "" && now() < deadline) {
    await sleep(outcome_interval_in_milliseconds);
    outcome = read_outcome(folder);
  }
  context.out.write(read_log(folder));
  // A watchdog that never reported may still be running, so its folder is left for the next switch's sweep.
  if (outcome !== "") rmSync(folder, { recursive: true, force: true });
  mark(`outcome ${outcome || "unknown The watchdog never reported an outcome"}`);
  if (/^(confirmed|kept|unchanged)\b/.test(outcome)) return status;
  return status !== 0 ? status : 1;
}

// Waits for the activation, or for the watchdog's outcome should it come first, as when the activation hangs and the
// watchdog has already tried to roll it back; meanwhile clears the Nix store database's lock when the switch asks.
async function activation_or_outcome(
  context: Context, operation: SwitchOperation, folder: string | null, now: () => number,
): Promise<{ status: number } | { outcome: string }> {
  const activation = run_steps(context, operation.steps).then((status) => ({ status }));
  const clearing = operation.close_nix_lock_holders ? nix_lock_clearing(context, operation.close_nix_lock_holders.sudo, now) : null;
  for (;;) {
    const ended = await Promise.race([activation, sleep(outcome_interval_in_milliseconds).then(() => null)]);
    if (ended !== null) return ended;
    const outcome = folder === null ? "" : read_outcome(folder);
    if (outcome !== "") return { outcome };
    await clearing?.();
  }
}

// Stops what holds the Nix store database open once one of the switch's own programs has waited a minute for it, as a
// newer Nix does to upgrade it: TERM first, then KILL for any still holding it.
function nix_lock_clearing(context: Context, sudo: boolean, now: () => number): () => Promise<void> {
  const raise = sudo ? ["sudo", "-n"] : [];
  let waiting_since: number | null = null;
  return async () => {
    const database = lock_file_id(nix_database_lock);
    if (database === null) return;
    const processes = read_processes();
    const own = new Set(descendants(processes, process.pid).map((info) => info.pid));
    const waits = read_locks().some((entry) => entry.waiting && entry.file === database && own.has(entry.pid));
    if (!waits) {
      waiting_since = null;
      return;
    }
    waiting_since ??= now();
    if (now() - waiting_since < nix_lock_patience_in_milliseconds) return;
    waiting_since = null;

    // The daemon itself only hands out connections, so it is left running; its workers each hold one client's.
    const daemon = (info: ProcessInfo) => info.name === "nix-daemon" && processes.get(info.ppid)?.name !== "nix-daemon";
    const holders = lock_holders(nix_database_lock, own).filter((info) => !daemon(info));
    if (holders.length === 0) return;
    context.out.write(`${stall_mark} close_nix_lock_holders: stopping what holds the Nix store database open: ${show_holders(holders)}\n`);
    await context.program(context, [...raise, "kill", "-TERM", ...holders.map((info) => String(info.pid))], { echo: true });
    await sleep(nix_lock_grace_in_milliseconds);
    const left = lock_holders(nix_database_lock, own).filter((info) => holders.some((holder) => holder.pid === info.pid));
    if (left.length > 0) await context.program(context, [...raise, "kill", "-KILL", ...left.map((info) => String(info.pid))], { echo: true });
  };
}

// Runs the health commands every health_period until they all pass, answering the last failure once health_timeout passes.
async function health_checks(context: Context, watch: SwitchWatch, folder: string, now: () => number): Promise<string> {
  context.out.write(`${switch_mark} phase health-checks\n`);
  const started = now();
  for (;;) {
    let failure = "";
    for (const [index, check] of watch.health_commands.entries()) {
      const result = await context.program(context, person_command(check), { stdout: "keep", stderr: "keep" });
      if (result.exit_code === 0) continue;
      const tail = `${result.stdout}\n${result.stderr}`.trim().split("\n").slice(-3).join(" ").slice(0, 300);
      failure = `Health check ${index + 1} (${clip_line(check)}) failed with status ${result.exit_code}: ${tail}`;
      break;
    }
    if (failure === "") {
      context.out.write("Every health check passed\n");
      return "";
    }
    if (now() - started >= watch.health_timeout * 1000) {
      context.out.write(`${failure}\n`);
      signal_rollback_in(folder, failure);
      return failure;
    }
    context.out.write(`Waiting for the health checks: ${failure}\n`);
    await sleep(watch.health_period * 1000);
  }
}

// Clears the folders of switches whose run died long ago, makes this switch's folder, notes the previous system, and
// starts the watchdog in a session of its own.
function start_watchdog(watch: SwitchWatch, folder: string): void {
  const parent = watch_folders_parent();
  for (const name of readdirSync(parent)) {
    if (!name.startsWith(watch_folder_prefix)) continue;
    try {
      if (Date.now() - statSync(join(parent, name)).mtimeMs > stale_folder_in_milliseconds) rmSync(join(parent, name), { recursive: true, force: true });
    } catch {
      // Another switch's folder, gone already or not ours to clear.
    }
  }
  mkdirSync(folder, { mode: 0o700 });
  writeFileSync(join(folder, watch_files.previous_system), `${real("/run/current-system") ?? ""}\n`);
  writeFileSync(join(folder, watch_files.previous_profile), `${link_target(system_profile) ?? ""}\n`);
  writeFileSync(join(folder, watch_files.settings), JSON.stringify(watch));
  const log = openSync(join(folder, watch_files.log), "a");
  try {
    spawn(process.execPath, [watchdog_program, folder], { detached: true, stdio: ["ignore", log, log] }).unref();
  } finally {
    closeSync(log);
  }
}

// ── Signals ──────────────────────────────────────────────────────────────────

export async function confirm_switch(context: Context, operation: ConfirmSwitchOperation): Promise<number> {
  const folder = watch_folder(operation.token);
  if (!existsSync(folder)) {
    context.err.write(`${folder} is gone`);
    return 1;
  }
  touch(join(folder, watch_files.confirmed));
  return 0;
}

export async function signal_rollback(context: Context, operation: SignalRollbackOperation): Promise<number> {
  const folder = watch_folder(operation.token);
  if (!existsSync(folder)) {
    context.err.write(`${folder} is gone`);
    return 1;
  }
  signal_rollback_in(folder, operation.reason);
  return 0;
}

function signal_rollback_in(folder: string, reason: string): void {
  write_whole(join(folder, watch_files.rollback), `${reason}\n`);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function touch(path: string): void {
  writeFileSync(path, "");
}

function read_outcome(folder: string): string {
  return read_file(join(folder, watch_files.outcome)).trim();
}

function read_log(folder: string): string {
  return read_file(join(folder, watch_files.log));
}

function read_file(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function clip_line(text: string): string {
  const line = text.split("\n")[0].trim();
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}
