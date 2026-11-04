// The operations a cache runs on its building host (see agent/operations/cache.ts), and how their reports become rows.
//
// A check evaluates every tracked target from the flake, checks whether that store path is in the local store,
// and asks the cache which of the closure's own paths it lacks. Paths signed by an upstream cache are left out, since
// Attic never stores them. A target named in `drop_pushed` is kept only in the cache: once a check finds it fully pushed,
// its closure's path list is written beside its build root as `<link>.closure` and the root is removed, so garbage
// collection frees the store, and later checks judge it by that list. Build and Push run one target and end by checking
// it again, so its row shows the outcome as soon as they finish. Build all evaluates every target in one parallel pass of
// nix-eval-jobs, as nix-fast-build does, starts each target's build as soon as its own evaluation ends, pushes it once
// built, and ends by checking every target.

// ── Imports ──────────────────────────────────────────────────────────────────

import { worse, type CacheSettings, type Status } from "../config.ts";
import {
  flake_report_name, nix_string, report_mark, type CacheBuildAllOperation, type CacheBuildOperation, type CacheCheckOperation, type CachePushOperation,
  type CacheTarget, type CacheSettings as CacheSpec, type Operation,
} from "../../shared/operations.ts";
import { timed } from "./commands.ts";
import { local_path } from "./flake.ts";

export { report_mark } from "../../shared/operations.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

// What an operation reported about one target, by key.
export interface TargetFacts {
  target?: string;
  built?: string;
  local?: string;
  own?: string;
  error?: string;
  cache_error?: string;
  dropped?: string;
  // How Build all ended for the target: ok, failed, push_failed or eval_failed, and its build's seconds.
  build?: string;
  build_seconds?: string;
  missing: string[];
}

export interface Report {
  targets: Map<string, TargetFacts>;
  // `nix flake metadata --json`, as printed.
  metadata: string | null;
}

export interface TargetRow {
  name: string;
  target: string | null;
  // Null until checked.
  built: boolean | null;
  // False once the closure is kept only in the cache.
  local: boolean;
  own: number | null;
  missing_count: number;
  missing: string[];
  pushed_ok: boolean;
  // The Pushed column, such as "All 12" or "2 of 12 missing".
  pushed: string;
  status: Status;
  summary: string;
  // Why the target's evaluation failed, or null when it evaluated or was not checked.
  eval_error: string | null;
  // The host whose store the row was read from, the server's own when null; absent from older readings.
  host?: string | null;
}

// ── Targets ──────────────────────────────────────────────────────────────────

// Every tracked name and installable, configurations first.
export function targets(settings: CacheSettings): [name: string, installable: string][] {
  return [
    ...settings.configurations.map((name): [string, string] => [name, `${settings.flake}#nixosConfigurations."${name}".config.system.build.toplevel`]),
    ...Object.entries(settings.installables).map(([name, attribute]): [string, string] => [name, `${settings.flake}#${attribute}`]),
  ];
}

// The build root a target's build is linked at, when there is a build_root_dir.
export function build_link(settings: CacheSettings, name: string): string | null {
  if (settings.build_root_dir === null) return null;
  return `${settings.build_root_dir.replace(/\/+$/, "")}/${settings.build_links[name] ?? `${settings.id}-${name}`}`;
}

// One target as an operation names it: its installable, its attribute, and its build root and closure list.
function target_of(settings: CacheSettings, name: string): CacheTarget {
  const index = settings.configurations.indexOf(name);
  const attribute = index !== -1 ? `nixosConfigurations.${nix_string(name)}.config.system.build.toplevel` : settings.installables[name];
  const link = build_link(settings, name);
  // A target named in drop_pushed is kept only in the cache once pushed, judged by the closure list beside its root.
  const kept = link !== null && settings.drop_pushed.includes(name);
  return { name, installable: new Map(targets(settings)).get(name)!, attribute, link, list: kept ? `${link}.closure` : null };
}

function spec(settings: CacheSettings): CacheSpec {
  return {
    nix: [settings.nix_bin, ...settings.nix_args],
    flake: settings.flake,
    cache_url: settings.cache_url,
    upstream_keys: settings.upstream_keys,
    // A remote ref is only seen freshly with --refresh.
    refresh: local_path(settings.flake) === null,
    build_root_dir: settings.build_root_dir,
    build_args: settings.build_args,
    push_command: settings.push_command,
  };
}

// ── Operations ───────────────────────────────────────────────────────────────

// The check of every target, then the flake's metadata, stopped once it runs past `timeout`.
export function check_operation(settings: CacheSettings): Operation {
  const check: CacheCheckOperation = { kind: "cache_check", cache: spec(settings), targets: targets(settings).map(([name]) => target_of(settings, name)) };
  return timed(settings.timeout, check);
}

// Builds one target from the flake's latest revision, pushes what it built when there is a push_command, then checks it.
export function build_operation(settings: CacheSettings, name: string): CacheBuildOperation {
  return { kind: "cache_build", cache: spec(settings), target: target_of(settings, name) };
}

// Pushes one target's store path, then checks it again; the push's status is the run's.
export function push_operation(settings: CacheSettings, name: string, path: string): CachePushOperation {
  return { kind: "cache_push", cache: spec(settings), target: target_of(settings, name), path };
}

// One attribute set of every target's derivation, keyed t0, t1 and so on in the order of the targets.
export function build_all_expression(settings: CacheSettings): string {
  const entries = targets(settings).map(([name], index) => `t${index} = flake.${target_of(settings, name).attribute};`).join(" ");
  return `let flake = builtins.getFlake ${nix_string(settings.flake)}; in { ${entries} }`;
}

// Evaluates and builds every target, then checks each, failing when any target did not build.
export function build_all_operation(settings: CacheSettings): CacheBuildAllOperation {
  return {
    kind: "cache_build_all", cache: spec(settings), targets: targets(settings).map(([name]) => target_of(settings, name)),
    eval_jobs: settings.eval_jobs_bin, eval_workers: settings.eval_workers, expression: build_all_expression(settings),
  };
}

// ── Reports ──────────────────────────────────────────────────────────────────

export function parse_report(output: string): Report {
  const report: Report = { targets: new Map(), metadata: null };
  for (const line of output.split("\n")) {
    const parts = line.split("\t");
    if (parts[0] !== report_mark || parts.length < 4) continue;
    const [, name, key] = parts;
    const value = parts.slice(3).join("\t");
    if (name === flake_report_name) {
      report.metadata = value;
      continue;
    }
    if (!report.targets.has(name)) report.targets.set(name, { missing: [] });
    const facts = report.targets.get(name)!;
    if (key === "missing") facts.missing.push(value);
    else (facts as unknown as Record<string, string>)[key] = value;
  }
  return report;
}

// One target's row, with its status and a one-line summary.
export function target_row(settings: CacheSettings, name: string, facts: TargetFacts | undefined, host?: string | null): TargetRow {
  const row: TargetRow = {
    name, target: null, built: null, local: true, own: null, missing_count: 0, missing: [], pushed_ok: false, pushed: "—",
    status: "unavailable", summary: "Not checked", eval_error: null, host,
  };
  if (facts === undefined) return row;
  if (facts.error !== undefined) return { ...row, status: "failed", summary: `Evaluation failed: ${facts.error.trim()}`, eval_error: facts.error.trim() };

  const missing = facts.missing;
  // A target another of the cache's hosts built and pushed is absent from this store, but the cache holds its root.
  const built_elsewhere = facts.built === "0" && missing.length === 0 && facts.cache_error === undefined;
  const built = facts.built === "1" || built_elsewhere;
  const own = /^\d+$/.test(facts.own ?? "") ? Number(facts.own) : 0;
  Object.assign(row, {
    target: facts.target ?? null, built, local: facts.local !== "0" && !built_elsewhere, own,
    missing_count: missing.length, missing: missing.slice(0, settings.missing_limit),
  });
  if (facts.cache_error !== undefined) return { ...row, pushed: "Unknown", summary: `Could not query the cache: ${facts.cache_error.trim()}` };

  // An unbuilt target was checked by its root path alone, so its count says nothing about the closure.
  if (!built) row.pushed = "No";
  else if (built_elsewhere) row.pushed = "Yes";
  else row.pushed = missing.length > 0 ? `${missing.length} of ${own} missing` : `All ${own}`;
  row.pushed_ok = built && missing.length === 0;
  if (row.pushed_ok) {
    row.status = "online";
    row.summary = row.local && facts.dropped === undefined ? "Built and pushed" : "Pushed, kept only in the cache";
    if (facts.dropped !== undefined) row.local = false;
  } else {
    row.status = settings.pending_status;
    row.summary = built ? `${missing.length} of ${own} paths are not in the cache` : "Not built from the latest flake";
  }
  return row;
}

// The worst status of the rows.
export function rows_status(rows: TargetRow[]): Status {
  return rows.reduce<Status>((status, row) => worse(status, row.status), "online");
}
