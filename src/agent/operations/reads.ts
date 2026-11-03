// The cheap reads of a host, each printing its facts as one JSON value: the running system, the Nix store and its
// garbage collection, the system profile's generations, and a build's products.

// ── Imports ──────────────────────────────────────────────────────────────────

import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, statfsSync } from "node:fs";
import { open } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, resolve } from "node:path";

import { boot_parts, generation_of, type BuildProduct, type GcFields, type Generation, type ProbeFields, type Profile } from "../../shared/facts.ts";
import type { LocateOperation, PieceOperation, ProductsOperation, StoreProbeOperation } from "../../shared/operations.ts";
import type { Context } from "../programs.ts";

// ── Files ────────────────────────────────────────────────────────────────────

const system_profile = "/nix/var/nix/profiles/system";
const profiles_folder = "/nix/var/nix/profiles";

// Where a link finally leads, or null when it leads nowhere.
export function real(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

// What a link points at, as written.
export function link_target(path: string): string | null {
  try {
    return readlinkSync(path);
  } catch {
    return null;
  }
}

// When a link itself was made or last changed, in seconds.
export function link_epoch(path: string): number | null {
  try {
    return Math.floor(lstatSync(path).mtimeMs / 1000);
  } catch {
    return null;
  }
}

function read_text(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function is_link(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function entries(folder: string): string[] {
  try {
    return readdirSync(folder);
  } catch {
    return [];
  }
}

function print(context: Context, value: unknown): number {
  context.out.write(JSON.stringify(value));
  return 0;
}

// ── Probe ────────────────────────────────────────────────────────────────────

export async function probe(context: Context): Promise<number> {
  const profile_link = link_target(system_profile);
  const fields: ProbeFields = {
    hostname: hostname(),
    current: real("/run/current-system"),
    booted: real("/run/booted-system"),
    switched_epoch: link_epoch("/run/current-system"),
    profile_created_epoch: profile_link === null ? null : link_epoch(resolve(profiles_folder, profile_link)),
    generation: generation_of(profile_link ?? ""),
    version: read_text("/run/current-system/nixos-version") ?? (await version_from_tool(context)),
    booted_parts: boot_parts.map((part) => real(`/run/booted-system/${part}`) ?? ""),
    current_parts: boot_parts.map((part) => real(`/run/current-system/${part}`) ?? ""),
  };
  return print(context, fields);
}

async function version_from_tool(context: Context): Promise<string | null> {
  const result = await context.program(context, ["nixos-version", "--json"], { stdout: "keep", stderr: "drop" });
  try {
    const data = JSON.parse(result.stdout) as { nixosVersion?: unknown };
    return typeof data.nixosVersion === "string" ? data.nixosVersion : null;
  } catch {
    return null;
  }
}

// ── Store ────────────────────────────────────────────────────────────────────

export async function store_probe(context: Context, operation: StoreProbeOperation): Promise<number> {
  const service = await systemd_properties(context, operation.unit, ["ActiveState", "Result", "InactiveEnterTimestamp"]);
  const timer = await systemd_properties(context, operation.timer, ["LoadState", "ActiveState", "NextElapseUSecRealtime"]);
  const journal = (pattern: string) => last_journal_line(context, operation.unit, pattern);
  const fields: GcFields = {
    hostname: hostname(),
    ...filesystem(operation.store),
    paths: count_entries(operation.store),
    roots: count_entries("/nix/var/nix/gcroots/auto"),
    svc_state: service.get("ActiveState") ?? "",
    svc_result: service.get("Result") ?? "",
    svc_exit: service.get("InactiveEnterTimestamp") ?? "",
    timer_load: timer.get("LoadState") ?? "",
    timer_state: timer.get("ActiveState") ?? "",
    timer_next: timer.get("NextElapseUSecRealtime") ?? "",
    summary: await journal("store paths deleted"),
    outcome: await journal("Finished |Failed with result"),
    error: await journal("error:"),
    profiles: profiles(),
  };
  return print(context, fields);
}

function filesystem(path: string): Pick<GcFields, "size_bytes" | "used_bytes" | "avail_bytes"> {
  try {
    const stats = statfsSync(path);
    return { size_bytes: stats.blocks * stats.bsize, used_bytes: (stats.blocks - stats.bfree) * stats.bsize, avail_bytes: stats.bavail * stats.bsize };
  } catch {
    return { size_bytes: null, used_bytes: null, avail_bytes: null };
  }
}

// How many entries a folder holds, leaving out hidden ones as ls does; null when it cannot be read.
function count_entries(folder: string): number | null {
  try {
    return readdirSync(folder).filter((name) => !name.startsWith(".")).length;
  } catch {
    return null;
  }
}

async function systemd_properties(context: Context, unit: string, names: string[]): Promise<Map<string, string>> {
  const argv = ["systemctl", "show", unit, "--timestamp=unix", ...names.flatMap((name) => ["-p", name])];
  const result = await context.program(context, argv, { stdout: "keep", stderr: "drop" });
  const values = new Map<string, string>();
  for (const line of result.stdout.split("\n")) {
    const separator = line.indexOf("=");
    if (separator !== -1) values.set(line.slice(0, separator), line.slice(separator + 1).trim());
  }
  return values;
}

async function last_journal_line(context: Context, unit: string, pattern: string): Promise<string> {
  const argv = ["journalctl", "-u", unit, "-o", "short-unix", "--no-pager", "-n", "1", "-g", pattern];
  const result = await context.program(context, argv, { stdout: "keep", stderr: "drop" });
  return result.stdout.trim().split("\n").pop() ?? "";
}

// Every profile and its generation links; a profile links to its own generation link, which rules out ones like
// /nix/var/nix/profiles/default that point at another profile and would be counted twice.
function profiles(): Profile[] {
  const folders = [profiles_folder, ...entries(`${profiles_folder}/per-user`).map((user) => `${profiles_folder}/per-user/${user}`)];
  const found: Profile[] = [];
  for (const folder of folders) {
    const names = entries(folder);
    for (const name of names) {
      const path = `${folder}/${name}`;
      if (!is_link(path)) continue;
      const target = link_target(path) ?? "";
      const own_link = (candidate: string) => candidate.startsWith(`${name}-`) && candidate.endsWith("-link");
      if (!own_link(target)) continue;
      const stamps = names.filter(own_link).filter((link) => is_link(`${folder}/${link}`)).map((link) => link_epoch(`${folder}/${link}`));
      const known = stamps.filter((stamp): stamp is number => stamp !== null);
      const generation = target.slice(name.length + 1, -"-link".length);
      found.push({
        path,
        generation: /^\d+$/.test(generation) ? Number(generation) : null,
        count: stamps.length,
        oldest_epoch: known.length > 0 ? Math.min(...known) : null,
      });
    }
  }
  return found;
}

// ── Generations ──────────────────────────────────────────────────────────────

export async function generations(context: Context): Promise<number> {
  const current = real("/run/current-system");
  const booted = real("/run/booted-system");
  const profile = link_target(system_profile);
  const found: Generation[] = [];
  for (const name of entries(profiles_folder)) {
    const number = generation_of(name);
    const path = number === null ? null : real(`${profiles_folder}/${name}`);
    if (number === null || path === null) continue;
    found.push({
      generation: number,
      created_epoch: link_epoch(`${profiles_folder}/${name}`),
      path,
      version: read_text(`${profiles_folder}/${name}/nixos-version`),
      current: path === current,
      booted: path === booted,
      profile: name === profile,
    });
  }
  return print(context, found.sort((first, second) => second.generation - first.generation));
}

// ── Products ─────────────────────────────────────────────────────────────────

// A path's size when it is a regular file inside the store path, else null.
function size_inside(store_path: string, path: string): number | null {
  const resolved = real(path);
  if (resolved === null || !resolved.startsWith(`${store_path}/`)) return null;
  const stats = statSync(resolved);
  return stats.isFile() ? stats.size : null;
}

export async function products(context: Context, operation: ProductsOperation): Promise<number> {
  const list = read_text(`${operation.store_path}/nix-support/hydra-build-products`) ?? "";
  const found: BuildProduct[] = [];
  for (const line of list.split("\n")) {
    const [type, subtype, quoted] = line.trim().split(/\s+/);
    if (quoted === undefined) continue;
    const path = quoted.replace(/^"/, "").replace(/"$/, "");
    found.push({ type, subtype, path, name: basename(path), size_bytes: size_inside(operation.store_path, path) });
  }
  return print(context, found);
}

export async function locate(context: Context, operation: LocateOperation): Promise<number> {
  const resolved = real(operation.path);
  if (resolved === null) return fail(context, "It is no longer in the store", 2);
  if (!resolved.startsWith(`${operation.store_path}/`)) return fail(context, "It is not inside the build's store path", 3);
  const stats = statSync(resolved);
  if (!stats.isFile()) return fail(context, "It is not a regular file", 4);
  return print(context, { path: resolved, size: stats.size });
}

// Reads a piece of a file the server located, as base64 so it travels as text.
export async function piece(context: Context, operation: PieceOperation): Promise<number> {
  const handle = await open(operation.path, "r");
  try {
    const buffer = Buffer.alloc(operation.length);
    const { bytesRead } = await handle.read(buffer, 0, operation.length, operation.offset);
    context.out.write(buffer.subarray(0, bytesRead).toString("base64"));
    return 0;
  } finally {
    await handle.close();
  }
}

function fail(context: Context, message: string, exit_code: number): number {
  context.err.write(message);
  return exit_code;
}
