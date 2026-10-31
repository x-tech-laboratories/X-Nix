// What a switch would change, read on the host before it runs: the packages added, removed and changed between the
// running system and the built one with `nix store diff-closures`, both closures' sizes with `nix path-info -S`, and, when
// no package changed but the store paths still differ, the derivations' own difference with nix-diff. Also a closure's
// whole dependency graph with each path's own and closure size, for the closure browser.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { DeploymentSettings } from "../config.ts";
import { shell_quote } from "./commands.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

// Starts each line the diff script prints for the server, naming the section that follows.
export const diff_mark = "@@x-nix-diff";

export interface PackageChange {
  name: string;
  from: string[];
  to: string[];
  // How much the package's own paths grew, in bytes; negative when they shrank.
  size_delta_bytes: number | null;
}

export interface ClosureDiff {
  from: string;
  to: string;
  checked_epoch: number;
  // The job that holds the diff's whole output.
  job_id: number | null;
  // Whether the new closure is in the host's store, without which nothing could be compared.
  built: boolean;
  added: PackageChange[];
  removed: PackageChange[];
  changed: PackageChange[];
  // Packages whose version stayed but whose size changed.
  resized: PackageChange[];
  closure_before_bytes: number | null;
  closure_after_bytes: number | null;
  // nix-diff's account of the derivations, when no package changed but the paths differ.
  derivation_diff: string | null;
  // Why something could not be compared, such as nix-diff missing.
  note: string | null;
  error: string | null;
}

export interface ClosurePath {
  path: string;
  nar_size: number;
  closure_size: number;
  // The paths it refers to, as indexes into the list, itself left out.
  references: number[];
}

export interface ClosureTree {
  root: string;
  paths: ClosurePath[];
}

// A store path as nix prints it, which is safe to pass on.
const store_path_pattern = /^\/nix\/store\/[0-9a-z]{32}-[0-9A-Za-z+._?=-]+$/;

export function is_store_path(value: string): boolean {
  return store_path_pattern.test(value);
}

// ── Diff ─────────────────────────────────────────────────────────────────────

function nix(settings: DeploymentSettings): string {
  return [settings.nix_bin, ...settings.nix_args.map(shell_quote)].join(" ");
}

// Compares two system closures on the host; a missing new closure is reported rather than fetched.
export function diff_command(settings: DeploymentSettings, from: string, to: string): string {
  const [a, b] = [shell_quote(from), shell_quote(to)];
  return [
    `if ! ${nix(settings)} path-info ${b} >/dev/null 2>&1; then echo "${diff_mark} missing"; exit 0; fi`,
    `echo "${diff_mark} closures"`,
    `changes=$(${nix(settings)} store diff-closures ${a} ${b} 2>&1); rc=$?`,
    `printf '%s\\n' "$changes"`,
    `[ $rc -eq 0 ] || echo "${diff_mark} failed $rc"`,
    `echo "${diff_mark} sizes"`,
    `${nix(settings)} path-info -S --json ${a} ${b} 2>/dev/null`,
    `echo "${diff_mark} derivations"`,
    // nix-diff only has something to add when the packages are the same, and needs both derivations in the store.
    `if [ $rc -eq 0 ] && [ ${a} != ${b} ] && [ -z "$changes" ]; then`,
    `  if ! command -v nix-diff >/dev/null 2>&1; then echo "${diff_mark} note nix-diff is not installed on the host, so the derivations cannot be compared";`,
    `  else from_drv=$(nix-store -q --deriver ${a} 2>/dev/null); to_drv=$(nix-store -q --deriver ${b} 2>/dev/null)`,
    `    if [ -e "$from_drv" ] && [ -e "$to_drv" ]; then nix-diff --color never "$from_drv" "$to_drv" 2>&1 | head -c 200000;`,
    `    else echo "${diff_mark} note The derivations of both closures are not in the host's store, so they cannot be compared"; fi`,
    "  fi",
    "fi",
  ].join("\n");
}

export function parse_diff(output: string, from: string, to: string, checked_epoch: number, job_id: number | null): ClosureDiff {
  const diff: ClosureDiff = {
    from, to, checked_epoch, job_id, built: true, added: [], removed: [], changed: [], resized: [],
    closure_before_bytes: null, closure_after_bytes: null, derivation_diff: null, note: null, error: null,
  };
  const sections = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const raw of strip_colours(output).split("\n")) {
    if (raw.startsWith(`${diff_mark} `)) {
      const words = raw.slice(diff_mark.length + 1).trim();
      if (words === "missing") diff.built = false;
      else if (words.startsWith("note ")) diff.note = words.slice(5);
      else if (words.startsWith("failed ")) diff.error = `nix store diff-closures exited ${words.split(" ").pop()}`;
      else {
        current = [];
        sections.set(words, current);
      }
      continue;
    }
    current?.push(raw);
  }
  for (const line of sections.get("closures") ?? []) {
    const change = parse_change_line(line);
    if (change === null) continue;
    if (change.from.length === 0 && change.to.length > 0) diff.added.push(change);
    else if (change.to.length === 0 && change.from.length > 0) diff.removed.push(change);
    else if (change.from.join(", ") !== change.to.join(", ")) diff.changed.push(change);
    else diff.resized.push(change);
  }
  if (diff.error !== null) diff.error = `${diff.error}: ${(sections.get("closures") ?? []).join("\n").trim().slice(0, 400)}`;
  const sizes = closure_sizes((sections.get("sizes") ?? []).join("\n"));
  diff.closure_before_bytes = sizes.get(from) ?? null;
  diff.closure_after_bytes = sizes.get(to) ?? null;
  const derivations = (sections.get("derivations") ?? []).join("\n").trim();
  diff.derivation_diff = derivations === "" ? null : derivations;
  return diff;
}

// One line of `nix store diff-closures`, such as `firefox: 120.0 → 121.0, +1204.3 KiB`, or null for anything else.
export function parse_change_line(line: string): PackageChange | null {
  const match = /^(\S[^:]*): (.+)$/.exec(line.trim());
  if (match === null) return null;
  let rest = match[2].trim();
  let size_delta_bytes: number | null = null;
  const size = /(?:^|,\s*)([+-]\d+(?:\.\d+)?)\s*([KMGT]?i?B)$/.exec(rest);
  if (size !== null) {
    size_delta_bytes = Math.round(Number(size[1]) * unit_bytes(size[2]));
    rest = rest.slice(0, size.index).trim();
  }
  const arrow = rest.indexOf("→");
  if (arrow === -1) {
    if (size_delta_bytes === null) return null;
    return { name: match[1], from: [], to: [], size_delta_bytes };
  }
  const versions = (text: string) => (text.trim() === "∅" ? [] : text.split(",").map((version) => (version.trim() === "ε" ? "" : version.trim())));
  return { name: match[1], from: versions(rest.slice(0, arrow)), to: versions(rest.slice(arrow + 1)), size_delta_bytes };
}

function unit_bytes(unit: string): number {
  const powers: Record<string, number> = { B: 0, KiB: 1, KB: 1, MiB: 2, MB: 2, GiB: 3, GB: 3, TiB: 4, TB: 4 };
  return 1024 ** (powers[unit] ?? 0);
}

// The closure size of each path `nix path-info -S --json` names, from either the old list or the newer object form.
function closure_sizes(json: string): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const entry of path_info_entries(json)) {
    if (typeof entry.info.closureSize === "number") sizes.set(entry.path, entry.info.closureSize);
  }
  return sizes;
}

// ── Closure graph ────────────────────────────────────────────────────────────

// Prints every path of the closure with its own size, its closure size and its references.
export function closure_command(settings: DeploymentSettings, path: string): string {
  return `${nix(settings)} path-info --recursive --size --closure-size --json ${shell_quote(path)}`;
}

export function parse_closure(json: string, root: string): ClosureTree {
  const entries = path_info_entries(json);
  const index = new Map<string, number>();
  // The root comes first, and the rest from the largest closure down.
  entries.sort((first, second) => (first.path === root ? -1 : second.path === root ? 1 : (number(second.info.closureSize) - number(first.info.closureSize))));
  entries.forEach((entry, position) => index.set(entry.path, position));
  const paths = entries.map((entry): ClosurePath => ({
    path: entry.path,
    nar_size: number(entry.info.narSize),
    closure_size: number(entry.info.closureSize),
    references: (Array.isArray(entry.info.references) ? entry.info.references : [])
      .map((reference) => index.get(full_path(String(reference))))
      .filter((position): position is number => position !== undefined && entries[position].path !== entry.path),
  }));
  return { root: entries[0]?.path ?? root, paths };
}

interface PathInfoEntry {
  path: string;
  info: { narSize?: unknown; closureSize?: unknown; references?: unknown };
}

// Nix printed path-info as a list of objects with a path, and since 2.19 as an object keyed by path.
function path_info_entries(json: string): PathInfoEntry[] {
  let data: unknown;
  try {
    data = JSON.parse(json.trim() || "null");
  } catch {
    return [];
  }
  if (Array.isArray(data)) {
    return data.filter((item) => typeof item?.path === "string").map((item) => ({ path: full_path(item.path), info: item }));
  }
  if (typeof data !== "object" || data === null) return [];
  return Object.entries(data as Record<string, unknown>)
    .filter(([, info]) => typeof info === "object" && info !== null)
    .map(([path, info]) => ({ path: full_path(path), info: info as PathInfoEntry["info"] }));
}

// Newer Nix names references by their base name alone.
function full_path(path: string): string {
  return path.startsWith("/") ? path : `/nix/store/${path}`;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// The escape sequences nix colours its output with, built from the escape character so no control character is written.
const colour_pattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function strip_colours(text: string): string {
  return text.replaceAll(colour_pattern, "");
}
