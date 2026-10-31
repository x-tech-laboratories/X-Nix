// The scripts a cache runs on its building host, and how their reports become rows.
//
// One check script evaluates every tracked target from the flake, checks whether that store path is in the local store,
// and asks the cache which of the closure's own paths it lacks. Paths signed by an upstream cache are left out, since
// Attic never stores them. A target named in `drop_pushed` is kept only in the cache: once a check finds it fully pushed,
// its closure's path list is written beside its build root as `<link>.closure` and the root is removed, so garbage
// collection frees the store, and later checks judge it by that list. Build and Push run one target and end by checking
// it again, so its row shows the outcome as soon as they finish.

// ── Imports ──────────────────────────────────────────────────────────────────

import { worse, type CacheSettings, type Status } from "../config.ts";
import { shell_quote } from "./commands.ts";
import { local_path } from "./flake.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

// What a script reported about one target, by key.
export interface TargetFacts {
  target?: string;
  built?: string;
  local?: string;
  own?: string;
  error?: string;
  cache_error?: string;
  dropped?: string;
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
}

// Starts every line a script reports on, so a build's own output is never read as a report.
export const report_mark = "@@x-nix-cache";

// The name the flake's metadata is reported under, never a target's.
const flake_name = "@flake";

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

// The build root and closure list of a target kept only in the cache, else null.
function kept_root(settings: CacheSettings, name: string): [link: string, list: string] | null {
  const link = build_link(settings, name);
  return link === null || !settings.drop_pushed.includes(name) ? null : [link, `${link}.closure`];
}

function nix(settings: CacheSettings): string {
  return [settings.nix_bin, ...settings.nix_args.map(shell_quote)].join(" ");
}

// A remote ref is only seen freshly with --refresh.
function remote(settings: CacheSettings): boolean {
  return local_path(settings.flake) === null;
}

// ── Scripts ──────────────────────────────────────────────────────────────────

// `report` prints one fact about $name; `check` evaluates a target, then `inspect` reads the closure at $out, using $link
// and $list, the target's build root and closure list, both empty unless it is kept only in the cache.
function functions(settings: CacheSettings): string {
  const nix_command = nix(settings);
  // nix pads the path column with spaces and then a tab, so the widest path has only the tab before its signatures.
  const keys = settings.upstream_keys.map((key) => `${key}:`).join(" ");
  const skip_upstream = `BEGIN { n = split("${keys}", up, " ") } { for (i = 2; i <= NF; i++) for (k = 1; k <= n; k++) if (index($i, up[k]) == 1) next; print $1 }`;
  const own_paths = settings.upstream_keys.length > 0
    ? `${nix_command} path-info -r --sigs "$out" | awk ${shell_quote(skip_upstream)}`
    : `${nix_command} path-info -r "$out"`;
  return [
    `report() { printf "${report_mark}\\t%s\\t%s\\t%s\\n" "$name" "$1" "$(printf "%s" "$2" | tr "\\t\\n" "  ")"; }`,
    "check() {",
    "  name=$1 link=$3 list=$4",
    // nix's stderr reaches the run's output as it evaluates, and is kept for the error report.
    `  out=$( { { ${nix_command} eval --raw --no-write-lock-file $refresh "$2"; echo $? > "$t/rc"; } 2>&1 1>&3 3>&- | tee "$t/err" >&2; } 3>&1 )`,
    '  if [ "$(cat "$t/rc")" != 0 ]; then',
    '    report error "$(tail -c 400 "$t/err")"',
    "    return",
    "  fi",
    "  refresh=",
    '  report target "$out"',
    "  inspect",
    "}",
    "inspect() {",
    `  if ${nix_command} path-info "$out" >/dev/null 2>&1; then`,
    "    report built 1",
    `    ${own_paths} > "$t/own"`,
    // A target dropped from the store is judged by the closure list written when it was dropped.
    '  elif [ -n "$list" ] && [ "$(head -n 1 "$list" 2>/dev/null)" = "$out" ]; then',
    "    report built 1",
    "    report local 0",
    '    tail -n +2 "$list" > "$t/own"',
    "  else",
    "    report built 0",
    '    echo "$out" > "$t/own"',
    "  fi",
    '  report own "$(wc -l < "$t/own" | tr -d " ")"',
    `  json=$(${nix_command} path-info --stdin --json --store ${shell_quote(settings.cache_url)} < "$t/own" 2>"$t/err")`,
    '  if [ -z "$json" ]; then',
    '    report cache_error "$(tail -c 400 "$t/err")"',
    "    return",
    "  fi",
    `  printf "%s\\n" "$json" | grep -o '"/nix/store/[^"]*":null' | cut -d'"' -f2 > "$t/missing"`,
    '  while read -r path; do report missing "$path"; done < "$t/missing"',
    // Only a root still pointing at this closure is dropped, and its list is in place before the root goes.
    '  if [ ! -s "$t/missing" ] && [ -n "$link" ] && [ "$(readlink "$link")" = "$out" ]; then',
    '    { echo "$out"; cat "$t/own"; } > "$list.tmp" && mv "$list.tmp" "$list" && rm -f "$link" && report dropped 1',
    "  fi",
    "}",
  ].join("\n");
}

const preamble = ['t=$(mktemp -d)', `trap 'rm -rf "$t"' EXIT`];

// The check of every target, then the flake's metadata, killed once it runs past `timeout`.
export function check_command(settings: CacheSettings): string {
  return `timeout ${settings.timeout} sh -c ${shell_quote(check_script(settings))}`;
}

export function check_script(settings: CacheSettings): string {
  const lines = [
    ...preamble,
    // Only the first evaluation refetches a remote flake, so every target is judged at the same revision.
    `refresh=${remote(settings) ? "--refresh" : ""}`,
    functions(settings),
  ];
  for (const [name, installable] of targets(settings)) {
    lines.push(["check", name, installable, ...(kept_root(settings, name) ?? [])].map(shell_quote).join(" "));
  }
  lines.push(`name=${shell_quote(flake_name)}; report metadata "$(${nix(settings)} flake metadata --json --no-write-lock-file ${shell_quote(settings.flake)} 2>/dev/null)"`);
  return lines.join("\n");
}

// Builds one target from the flake's latest revision, pushes what it built when there is a push_command, then checks it.
export function build_command(settings: CacheSettings, name: string): string {
  return `sh -c ${shell_quote(build_script(settings, name))}`;
}

export function build_script(settings: CacheSettings, name: string): string {
  const installable = new Map(targets(settings)).get(name)!;
  const args = [...settings.build_args, ...(remote(settings) ? ["--refresh"] : [])].map(shell_quote).join(" ");
  const link = build_link(settings, name);
  // One fixed link per target, so each build replaces the root the last one held.
  const build = link === null
    ? `${nix(settings)} build --print-out-paths --no-link ${args} ${shell_quote(installable)}`
    : `mkdir -p ${shell_quote(settings.build_root_dir!)} && ${nix(settings)} build --print-out-paths --out-link ${shell_quote(link)} ${args} ${shell_quote(installable)}`;
  const lines = [...preamble, functions(settings), target_line(settings, name), `out=$(${build})`, "rc=$?", 'out=$(printf "%s\\n" "$out" | tail -n 1)'];
  // Pushed here rather than left to a store watcher, so the check that follows never races the upload.
  if (settings.push_command !== null) lines.push(`if [ "$rc" = 0 ] && [ -n "$out" ]; then ${settings.push_command} "$out" || rc=$?; fi`);
  lines.push('if [ -n "$out" ]; then report target "$out"; inspect; fi', "exit $rc");
  return lines.join("\n");
}

// Pushes one target's store path, then checks it again; the push's status is the run's.
export function push_command(settings: CacheSettings, name: string, path: string): string {
  return `sh -c ${shell_quote(push_script(settings, name, path))}`;
}

export function push_script(settings: CacheSettings, name: string, path: string): string {
  const lines = [
    ...preamble, functions(settings), target_line(settings, name), `out=${shell_quote(path)}`,
    `${settings.push_command} "$out"`, "rc=$?", 'report target "$out"', "inspect", "exit $rc",
  ];
  return lines.join("\n");
}

function target_line(settings: CacheSettings, name: string): string {
  const [link, list] = kept_root(settings, name) ?? ["", ""];
  return `name=${shell_quote(name)} link=${shell_quote(link)} list=${shell_quote(list)}`;
}

// ── Reports ──────────────────────────────────────────────────────────────────

export function parse_report(output: string): Report {
  const report: Report = { targets: new Map(), metadata: null };
  for (const line of output.split("\n")) {
    const parts = line.split("\t");
    if (parts[0] !== report_mark || parts.length < 4) continue;
    const [, name, key] = parts;
    const value = parts.slice(3).join("\t");
    if (name === flake_name) {
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
export function target_row(settings: CacheSettings, name: string, facts: TargetFacts | undefined): TargetRow {
  const row: TargetRow = {
    name, target: null, built: null, local: true, own: null, missing_count: 0, missing: [], pushed_ok: false, pushed: "—",
    status: "unavailable", summary: "Not checked",
  };
  if (facts === undefined) return row;
  if (facts.error !== undefined) return { ...row, status: "failed", summary: `Evaluation failed: ${facts.error.trim()}` };

  const built = facts.built === "1";
  const own = /^\d+$/.test(facts.own ?? "") ? Number(facts.own) : 0;
  const missing = facts.missing;
  Object.assign(row, {
    target: facts.target ?? null, built, local: facts.local !== "0", own,
    missing_count: missing.length, missing: missing.slice(0, settings.missing_limit),
  });
  if (facts.cache_error !== undefined) return { ...row, pushed: "Unknown", summary: `Could not query the cache: ${facts.cache_error.trim()}` };

  // An unbuilt target was checked by its root path alone, so its count says nothing about the closure.
  if (!built) row.pushed = missing.length > 0 ? "No" : "Root only";
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
