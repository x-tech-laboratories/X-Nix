// Live build progress, as nix-output-monitor shows it: reads the JSON lines `nix build --log-format internal-json` prints,
// turns them back into readable log lines, and keeps count of the derivations building and built and the paths
// downloading and downloaded. The counts are kept with the job, so they survive a restart of the server. It also keeps
// what nix plans to build and fetch, with how each went, and which planned paths each planned derivation needs, read
// from the build's host, so the job can show the build as a tree.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { PlannedPath } from "../../shared/build_plan.ts";
import type { DerivationsOperation } from "../../shared/operations.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

// Nix's activity and result types, from its logging.hh.
const activity_types = { copy_path: 100, copy_paths: 103, builds: 104, build: 105, substitute: 108 } as const;
const result_types = { build_log_line: 101, set_phase: 104, progress: 105, set_expected: 106, post_build_log_line: 107 } as const;

// The most verbose message level shown: info, as nix prints without -v.
const shown_level = 3;

export interface Activity {
  type: number;
  name: string;
  // The derivation it builds or the path it fetches; absent from progress read before builds kept it.
  path?: string;
  phase: string | null;
}

export interface BuildProgress {
  // Builds and downloads that have ended, whether or not they succeeded.
  builds_done: number;
  builds_failed: number;
  builds_expected: number | null;
  downloads_done: number;
  downloads_expected: number | null;
  // What is going on now, by nix's activity id; only builds and downloads are kept.
  activities: Record<string, Activity>;
  // The ids of the activities whose progress counts the whole build's builds or downloads.
  totals: Record<string, "builds" | "downloads">;
  // What nix plans to build and fetch, by store path.
  planned: Record<string, PlannedPath>;
  // Which of nix's plan lists the messages are going through.
  listing: "build" | "fetch" | null;
  // The start of a line not yet ended by a newline.
  carry: string;
}

export function empty_progress(): BuildProgress {
  return { builds_done: 0, builds_failed: 0, builds_expected: null, downloads_done: 0, downloads_expected: null, activities: {}, totals: {}, planned: {}, listing: null, carry: "" };
}

interface NixLine {
  action?: string;
  id?: number;
  type?: number;
  level?: number;
  msg?: string;
  text?: string;
  fields?: unknown[];
}

// ── Reading ──────────────────────────────────────────────────────────────────

// Reads a piece of output into the progress, answering with the readable lines it stands for; ended flushes a last line.
export function read_build_log(progress: BuildProgress, chunk: string, ended: boolean, now: number = Math.floor(Date.now() / 1000)): string {
  const text = progress.carry + chunk;
  const lines = text.split("\n");
  progress.carry = ended ? "" : lines.pop()!;
  const readable: string[] = [];
  for (const line of lines) {
    if (line === "") continue;
    const shown = read_line(progress, line, now);
    if (shown !== null) readable.push(shown);
  }
  // Nothing runs once the build has ended, whatever nix last reported.
  if (ended) {
    progress.activities = {};
    for (const entry of Object.values(progress.planned)) {
      if (entry.state !== "building" && entry.state !== "fetching") continue;
      Object.assign(entry, { state: "stopped", phase: null, finished_epoch: now });
    }
  }
  return readable.length === 0 ? "" : `${readable.join("\n")}\n`;
}

function read_line(progress: BuildProgress, line: string, now: number): string | null {
  if (!line.startsWith("@nix ")) return line;
  let entry: NixLine;
  try {
    entry = JSON.parse(line.slice(5)) as NixLine;
  } catch {
    return line;
  }
  const fields = Array.isArray(entry.fields) ? entry.fields : [];
  const id = String(entry.id ?? "");
  switch (entry.action) {
    case "msg": {
      const message = strip_colours(entry.msg ?? "");
      read_plan(progress, message);
      if ((entry.level ?? 0) > shown_level) return null;
      // Only a builder that ran and failed counts: nix also says Cannot build for it, and for each derivation whose dependency failed.
      if (/builder for '.+?' failed/.test(message)) progress.builds_failed += 1;
      return message;
    }
    case "start": {
      const path = String(fields[0] ?? entry.text ?? "");
      if (entry.type === activity_types.build || entry.type === activity_types.substitute) {
        const building = entry.type === activity_types.build;
        progress.activities[id] = { type: entry.type, name: building ? derivation_name(path) : path_name(path), path, phase: null };
        const planned = plan(progress, path, building ? "build" : "fetch");
        if (planned !== null) Object.assign(planned, { state: building ? "building" : "fetching", started_epoch: now, finished_epoch: null });
      } else if (entry.type === activity_types.builds) progress.totals[id] = "builds";
      else if (entry.type === activity_types.copy_paths) progress.totals[id] = "downloads";
      return null;
    }
    case "stop": {
      const activity = progress.activities[id];
      if (activity === undefined) return null;
      if (activity.type === activity_types.build) progress.builds_done += 1;
      else progress.downloads_done += 1;
      delete progress.activities[id];
      const planned = progress.planned[activity.path ?? ""];
      if (planned !== undefined && (planned.state === "building" || planned.state === "fetching")) {
        Object.assign(planned, { state: planned.kind === "build" ? "built" : "fetched", phase: null, finished_epoch: now });
      }
      return null;
    }
    case "result":
      return read_result(progress, id, entry.type ?? 0, fields);
    default:
      return null;
  }
}

function read_result(progress: BuildProgress, id: string, type: number, fields: unknown[]): string | null {
  const activity = progress.activities[id];
  if (type === result_types.build_log_line || type === result_types.post_build_log_line) {
    const text = strip_colours(String(fields[0] ?? ""));
    return activity === undefined ? text : `${activity.name}> ${text}`;
  }
  if (type === result_types.set_phase && activity !== undefined) {
    activity.phase = String(fields[0] ?? "") || null;
    const planned = progress.planned[activity.path ?? ""];
    if (planned !== undefined) planned.phase = activity.phase;
    return null;
  }
  // Nix reports the whole build's expected counts on its builds and copy-paths activities.
  if (type === result_types.progress && typeof fields[1] === "number") {
    if (progress.totals[id] === "builds") progress.builds_expected = fields[1];
    else if (progress.totals[id] === "downloads") progress.downloads_expected = fields[1];
    return null;
  }
  if (type === result_types.set_expected && typeof fields[1] === "number") {
    if (fields[0] === activity_types.build) progress.builds_expected = fields[1];
    else if (fields[0] === activity_types.copy_path) progress.downloads_expected = fields[1];
  }
  return null;
}

// ── Plan ─────────────────────────────────────────────────────────────────────

// Reads nix's lists of what it will build and fetch, each a heading followed by one store path per line, and its
// failures, which name the derivation that failed or whose dependency did.
function read_plan(progress: BuildProgress, message: string): void {
  for (const line of message.split("\n")) {
    const words = line.trim();
    const listed = /^\s+(\/nix\/store\/\S+)$/.exec(line);
    if (/^(these \d+ derivations|this derivation) will be built:$/.test(words)) progress.listing = "build";
    else if (/^(these \d+ paths|this path) will be fetched\b/.test(words)) progress.listing = "fetch";
    else if (listed !== null && progress.listing !== null) plan(progress, listed[1], progress.listing);
    else progress.listing = null;
  }
  const failed = /(?:builder for|Cannot build|dependencies of derivation) '(\/nix\/store\/[^']+\.drv)'/.exec(message);
  const entry = failed === null ? undefined : progress.planned[failed[1]];
  if (entry === undefined) return;
  const by_dependency = /dependencies of derivation|Reason: \d+ dependenc(y|ies) failed/.test(message);
  Object.assign(entry, { state: by_dependency ? "dependency-failed" : "failed", phase: null });
}

// The planned path, added when nix had not listed it; null for what is not a store path.
function plan(progress: BuildProgress, path: string, kind: "build" | "fetch"): PlannedPath | null {
  if (!path.startsWith("/nix/store/")) return null;
  progress.planned[path] ??= {
    kind, name: kind === "build" ? derivation_name(path) : path_name(path), state: "waiting", phase: null, started_epoch: null, finished_epoch: null,
    needs: kind === "build" ? null : [],
  };
  return progress.planned[path];
}

// Reads from the build's host which planned paths each planned derivation not yet read needs; null when none is left.
export function needs_operation(progress: BuildProgress): DerivationsOperation | null {
  const unread = Object.keys(progress.planned).filter((path) => progress.planned[path].needs === null);
  return unread.length === 0 ? null : { kind: "derivations", derivations: unread, planned: Object.keys(progress.planned) };
}

// Keeps what the host answered; a derivation it could not read needs nothing, so it is not asked for again.
export function read_needs(progress: BuildProgress, asked: DerivationsOperation, answer: Record<string, string[]> | null): void {
  for (const path of asked.derivations) {
    const entry = progress.planned[path];
    const needs = answer?.[path];
    if (entry !== undefined) entry.needs = Array.isArray(needs) ? needs.filter((need) => typeof need === "string") : [];
  }
}

// ── Summaries ────────────────────────────────────────────────────────────────

// One line for the job's progress, such as `Built 3 of 12, building 2; downloaded 40 of 140, downloading 4`.
export function summarise(progress: BuildProgress): string {
  const running = Object.values(progress.activities);
  const building = running.filter((activity) => activity.type === activity_types.build).length;
  const downloading = running.length - building;
  const built = Math.max(0, progress.builds_done - progress.builds_failed);
  const of = (expected: number | null) => (expected === null ? "" : ` of ${expected}`);
  const parts = [
    `Built ${built}${of(progress.builds_expected)}${building > 0 ? `, building ${building}` : ""}${progress.builds_failed > 0 ? `, ${progress.builds_failed} failed` : ""}`,
    `downloaded ${progress.downloads_done}${of(progress.downloads_expected)}${downloading > 0 ? `, downloading ${downloading}` : ""}`,
  ];
  return parts.join("; ");
}

export function is_build_activity(activity: Activity): boolean {
  return activity.type === activity_types.build;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// A derivation's name without its hash and .drv, such as `hello-2.12`.
function derivation_name(path: string): string {
  return path_name(path).replace(/\.drv$/, "");
}

function path_name(path: string): string {
  const base = path.split("/").pop() ?? path;
  return /^[0-9a-z]{32}-/.test(base) ? base.slice(33) : base;
}

// The escape sequences nix colours its output with, built from the escape character so no control character is written.
const colour_pattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function strip_colours(text: string): string {
  return text.replaceAll(colour_pattern, "");
}
