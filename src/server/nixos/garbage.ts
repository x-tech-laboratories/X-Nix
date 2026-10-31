// Garbage collection on a deployment's host: whether its Nix store is actually being reclaimed.
//
// One cheap script reads the store's filesystem and path count, every profile's generation links, the collection unit
// and timer, and the last collection's own summary line from the journal, so a collection that stopped running, failed,
// or was never scheduled reads as a failure rather than as a slowly filling disk. The last collection is kept between
// cycles, so a journal that has since rotated past it does not erase what was already seen, and a manual collection
// counts as the last one just as a timer run would.

// ── Imports ──────────────────────────────────────────────────────────────────

import { level_of_status, worse, type GcSettings, type Status } from "../config.ts";
import type { Message } from "../deployment.ts";
import { format_age, format_duration } from "../durations.ts";
import { shell_quote } from "./commands.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

// One collection, from the journal or from a job X-Nix ran.
export interface Collection {
  epoch: number;
  succeeded: boolean;
  deleted: number | null;
  freed_bytes: number | null;
  error: string | null;
}

export interface Profile {
  path: string;
  // The generation the profile points at.
  generation: number | null;
  count: number;
  oldest_epoch: number | null;
}

export interface GcFields {
  hostname: string | null;
  // `size used avail target` in bytes, as df prints it.
  df: string;
  paths: number | null;
  roots: number | null;
  svc_state: string;
  svc_result: string;
  svc_exit: string;
  timer_load: string;
  timer_state: string;
  timer_next: string;
  summary: string;
  outcome: string;
  error: string;
  profiles: Profile[];
}

// What the last cycle read of the host's store and made of it.
export interface StoreReading {
  status: Status;
  checked_epoch: number;
  messages: Message[];
  store: string;
  size_bytes: number | null;
  used_bytes: number | null;
  avail_bytes: number | null;
  used_percent: number | null;
  paths: number | null;
  roots: number | null;
  profiles: Profile[];
  generations: number | null;
  oldest_generation_epoch: number | null;
  collecting: boolean;
  timer_loaded: boolean;
  timer_active: boolean;
  next_epoch: number | null;
}

const summary_pattern = /(\d+)\s+store paths deleted,\s+([\d.]+)\s*(\w+)\s+freed/;

// systemd logs exactly one of these when a run ends, so the journal, not the unit's Result, which a daemon re-exec
// resets to success, decides the outcome.
const failed_mark = "Failed with result";
const finished_mark = "Finished ";

// How far from a run's outcome line its summary and error lines may be and still be that run's. They land within seconds
// of each other; this only rejects a stale line the journal kept from an earlier collection.
const run_window_in_seconds = 300;

// The units nix renders a collection's yield in, as bytes.
const size_units: Record<string, number> = {
  b: 1, byte: 1, bytes: 1,
  kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12,
  kib: 2 ** 10, mib: 2 ** 20, gib: 2 ** 30, tib: 2 ** 40, pib: 2 ** 50,
};

// ── Probe ────────────────────────────────────────────────────────────────────

export function gc_probe_script(gc: GcSettings): string {
  const [unit, timer, store] = [gc.unit, gc.timer, gc.store].map(shell_quote);
  return [
    'echo "hostname=$(uname -n)"',
    `echo "df=$(df -B1 --output=size,used,avail,target ${store} 2>/dev/null | tail -1)"`,
    `echo "paths=$(ls -U ${store} 2>/dev/null | wc -l)"`,
    'echo "roots=$(ls -U /nix/var/nix/gcroots/auto 2>/dev/null | wc -l)"',
    `echo "svc_state=$(systemctl show ${unit} -p ActiveState --value 2>/dev/null)"`,
    `echo "svc_result=$(systemctl show ${unit} -p Result --value 2>/dev/null)"`,
    `echo "svc_exit=$(systemctl show ${unit} --timestamp=unix -p InactiveEnterTimestamp --value 2>/dev/null)"`,
    `echo "timer_load=$(systemctl show ${timer} -p LoadState --value 2>/dev/null)"`,
    `echo "timer_state=$(systemctl show ${timer} -p ActiveState --value 2>/dev/null)"`,
    `echo "timer_next=$(systemctl show ${timer} --timestamp=unix -p NextElapseUSecRealtime --value 2>/dev/null)"`,
    `echo "summary=$(journalctl -u ${unit} -o short-unix --no-pager -n 1 -g 'store paths deleted' 2>/dev/null | tail -1)"`,
    `echo "outcome=$(journalctl -u ${unit} -o short-unix --no-pager -n 1 -g 'Finished |Failed with result' 2>/dev/null | tail -1)"`,
    `echo "error=$(journalctl -u ${unit} -o short-unix --no-pager -n 1 -g 'error:' 2>/dev/null | tail -1)"`,
    // A profile is a link to its own generation link, which rules out /nix/var/nix/profiles/default: it points at another
    // profile and would be counted twice.
    "for prof in /nix/var/nix/profiles/* /nix/var/nix/profiles/per-user/*/*; do",
    '  [ -L "$prof" ] || continue',
    '  target=$(readlink "$prof"); base=${prof##*/}',
    '  case "$target" in "$base"-*-link) ;; *) continue ;; esac',
    "  count=0; oldest=",
    '  for link in "$prof"-*-link; do',
    '    [ -L "$link" ] || continue',
    "    count=$((count + 1))",
    '    stamp=$(stat -c %Y "$link" 2>/dev/null)',
    '    if [ -n "$stamp" ] && { [ -z "$oldest" ] || [ "$stamp" -lt "$oldest" ]; }; then oldest=$stamp; fi',
    "  done",
    '  generation=${target#"$base"-}',
    '  echo "profile=$prof|${generation%-link}|$count|$oldest"',
    "done",
  ].join("\n");
}

export function parse_gc_probe(stdout: string): GcFields {
  const values = new Map<string, string>();
  const profiles: Profile[] = [];
  for (const line of stdout.split("\n")) {
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1).trim();
    if (key !== "profile") values.set(key, value);
    else {
      const profile = profile_of(value);
      if (profile !== null) profiles.push(profile);
    }
  }
  const text = (key: string) => values.get(key) ?? "";
  return {
    hostname: text("hostname") || null,
    df: text("df"),
    paths: whole(text("paths")),
    roots: whole(text("roots")),
    svc_state: text("svc_state"),
    svc_result: text("svc_result"),
    svc_exit: text("svc_exit"),
    timer_load: text("timer_load"),
    timer_state: text("timer_state"),
    timer_next: text("timer_next"),
    summary: text("summary"),
    outcome: text("outcome"),
    error: text("error"),
    profiles,
  };
}

// One `path|generation|count|oldest` probe line.
function profile_of(raw: string): Profile | null {
  const parts = raw.split("|");
  if (parts.length !== 4 || parts[0] === "") return null;
  return { path: parts[0], generation: whole(parts[1]), count: whole(parts[2]) ?? 0, oldest_epoch: whole(parts[3]) };
}

// ── Last collection ──────────────────────────────────────────────────────────

// This cycle's reading of the last collection, or null when nothing on the host records that one ever ran.
export function observed_collection(fields: GcFields): Collection | null {
  const outcome_epoch = log_epoch(fields.outcome);
  const summary = summary_pattern.exec(fields.summary);
  const summary_epoch = summary ? log_epoch(fields.summary) : null;
  // The unit's own stop bounds the run when the journal has rotated past every line of it.
  const epochs = [outcome_epoch, summary_epoch, systemd_epoch(fields.svc_exit)].filter((epoch): epoch is number => epoch !== null);
  if (epochs.length === 0) return null;
  const epoch = Math.max(...epochs);

  // A Result of success proves nothing: systemd resets it on a daemon re-exec, which a NixOS switch does, so only the
  // journal may call a run failed.
  let succeeded: boolean;
  if (fields.outcome.includes(failed_mark)) succeeded = false;
  else if (fields.outcome.includes(finished_mark)) succeeded = true;
  else succeeded = fields.svc_result === "" || fields.svc_result === "success";

  const run: Collection = { epoch, succeeded, deleted: null, freed_bytes: null, error: null };
  if (summary && same_run(summary_epoch, epoch)) {
    run.deleted = Number(summary[1]);
    run.freed_bytes = bytes_from(summary[2], summary[3]);
  }
  if (!succeeded && same_run(log_epoch(fields.error), epoch)) run.error = log_message(fields.error);
  return run;
}

// Folds what this cycle saw into the stored collection, keeping the older record whenever the journal no longer has it.
export function fold_collection(stored: Collection | null, seen: Collection | null): Collection | null {
  if (seen === null) return stored;
  if (stored === null) return seen;
  if (same_run(seen.epoch, stored.epoch)) {
    // The same run seen again; a later cycle may have picked up lines the first one missed.
    return {
      ...stored,
      epoch: seen.epoch,
      succeeded: seen.succeeded,
      deleted: seen.deleted ?? stored.deleted,
      freed_bytes: seen.freed_bytes ?? stored.freed_bytes,
      error: seen.error ?? stored.error,
    };
  }
  // A manual collection outlives the unit's last run in the journal, so the newer record wins.
  return seen.epoch > stored.epoch ? seen : stored;
}

// A finished collection job as the same record the journal gives.
export function finished_collection(output: string, succeeded: boolean, error: string | null, epoch: number): Collection {
  const lines = output.split("\n").reverse();
  const summary = lines.map((line) => summary_pattern.exec(line)).find((match) => match !== null) ?? null;
  return {
    epoch, succeeded, error,
    deleted: summary ? Number(summary[1]) : null,
    freed_bytes: summary ? bytes_from(summary[2], summary[3]) : null,
  };
}

// ── Command ──────────────────────────────────────────────────────────────────

// The same collection the timer runs.
export function collect_command(gc: GcSettings, require_sudo: boolean): string {
  return [require_sudo ? "sudo -n" : "", gc.gc_bin, ...gc.gc_args.map(shell_quote)].filter(Boolean).join(" ");
}

// ── Judging ──────────────────────────────────────────────────────────────────

// Turns the probe's facts and the last collection into this cycle's store reading and its worst-of status.
export function assess_store(gc: GcSettings, fields: GcFields, last: Collection | null, now: number): StoreReading {
  const messages: Message[] = [];
  let status: Status = "online";
  const raise = (next: Status, text: string, level = level_of_status[next]) => {
    status = worse(status, next);
    messages.push({ level, text });
  };
  const note = (text: string) => messages.push({ level: "info", text });

  const [size, used, avail] = fields.df.split(/\s+/).slice(0, 3).map(whole);
  let used_percent: number | null = null;
  if (size != null && used != null && avail != null) {
    used_percent = size > 0 ? (used / size) * 100 : 0;
    const level = level_for(used_percent, gc.warning, gc.threshold);
    const text = `${gc.store} is ${used_percent.toFixed(1)}% full (${format_bytes(used)} of ${format_bytes(size)}, ${format_bytes(avail)} free)`;
    if (level === "online") note(text);
    else raise(level, text, "warning");
  }
  if (fields.paths !== null) note(`${fields.paths.toLocaleString("en")} store paths, ${(fields.roots ?? 0).toLocaleString("en")} indirect GC roots`);

  const generations = fields.profiles.length > 0 ? fields.profiles.reduce((sum, profile) => sum + profile.count, 0) : null;
  const stamps = fields.profiles.map((profile) => profile.oldest_epoch).filter((epoch): epoch is number => epoch !== null);
  const oldest = stamps.length > 0 ? Math.min(...stamps) : null;
  if (oldest !== null) {
    const age = now - oldest;
    const text = `${generations} generations across ${fields.profiles.length} profiles, oldest kept ${format_age(age)}`;
    if (gc.max_generation_age !== null && age > gc.max_generation_age) raise("warning", `${text}, over the ${format_duration(gc.max_generation_age)} limit`);
    else note(text);
  }
  const crowded = gc.max_generations === null ? [] : fields.profiles.filter((profile) => profile.count > gc.max_generations!);
  if (crowded.length > 0) {
    raise("warning", `Over the ${gc.max_generations}-generation limit: ${crowded.map((profile) => `${profile.path} (${profile.count})`).join(", ")}`);
  }

  const collecting = ["active", "activating", "reloading"].includes(fields.svc_state);
  if (collecting) note(`${gc.unit} is collecting now`);
  if (last !== null && !last.succeeded) raise("failed", `The last collection failed${last.error ? `: ${last.error}` : ""}`);
  if (last === null) {
    raise("unavailable", `Could not tell when ${gc.unit} last ran: no record in its journal and no timestamp on the unit`);
  } else {
    const age = now - last.epoch;
    const freed = last.freed_bytes === null ? "" : `, freeing ${format_bytes(last.freed_bytes)} across ${(last.deleted ?? 0).toLocaleString("en")} paths`;
    const text = `Last collected ${format_age(age)}${freed}`;
    if (age > gc.max_age && !collecting) raise(gc.stale_status, `${text}, over the ${format_duration(gc.max_age)} limit`);
    else note(text);
  }

  const timer_active = fields.timer_state === "active";
  const timer_loaded = fields.timer_load === "loaded";
  if (!timer_active) raise(gc.timer_status, `${gc.timer} is ${timer_loaded ? "inactive" : "not installed"}; nothing collects on a schedule here`);
  const next_epoch = systemd_epoch(fields.timer_next);
  if (next_epoch !== null) note(`Next collection in ${format_duration(Math.max(next_epoch - now, 0))}`);

  return {
    status, checked_epoch: now, messages, store: gc.store,
    size_bytes: size ?? null, used_bytes: used ?? null, avail_bytes: avail ?? null, used_percent,
    paths: fields.paths, roots: fields.roots, profiles: fields.profiles, generations, oldest_generation_epoch: oldest,
    collecting, timer_loaded, timer_active, next_epoch,
  };
}

// A store not read yet, for the first cycle that cannot read it.
export function unread_store(gc: GcSettings): StoreReading {
  return {
    status: "unavailable", checked_epoch: 0, messages: [], store: gc.store, size_bytes: null, used_bytes: null, avail_bytes: null,
    used_percent: null, paths: null, roots: null, profiles: [], generations: null, oldest_generation_epoch: null, collecting: false,
    timer_loaded: false, timer_active: false, next_epoch: null,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function level_for(value: number, warning: number | null, threshold: number | null): Status {
  if (threshold !== null && value >= threshold) return "failed";
  if (warning !== null && value >= warning) return "warning";
  return "online";
}

// Sizes in binary units, such as "44.4 GiB".
export function format_bytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${Math.round(value)} B` : `${value.toFixed(1)} ${units[unit]}`;
}

// Nix's rendered "44.4 GiB" yield as bytes.
export function bytes_from(amount: string, unit: string): number | null {
  const factor = size_units[unit.toLowerCase()];
  const value = Number(amount);
  return factor === undefined || !Number.isFinite(value) ? null : value * factor;
}

function whole(text: string | undefined): number | null {
  return text !== undefined && /^\d+$/.test(text) ? Number(text) : null;
}

// A systemd `--timestamp=unix` value such as "@1788757200".
function systemd_epoch(value: string): number | null {
  return whole(value.replace(/^@/, "").split(".")[0]);
}

// The epoch at the front of a `journalctl -o short-unix` line.
function log_epoch(line: string): number | null {
  const stamp = Number(line.split(" ", 1)[0]);
  return line !== "" && Number.isFinite(stamp) ? Math.floor(stamp) : null;
}

// A journal line without its timestamp, host and unit.
function log_message(line: string): string {
  const separator = line.indexOf(": ");
  return (separator === -1 ? line : line.slice(separator + 2)).trim().slice(0, 200);
}

function same_run(epoch: number | null, run_epoch: number): boolean {
  return epoch !== null && Math.abs(run_epoch - epoch) <= run_window_in_seconds;
}
