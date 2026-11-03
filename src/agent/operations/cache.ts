// A cache's operations on its building host. A check evaluates every tracked target, sees whether that store path is in
// the local store, and asks the cache which of the closure's own paths it lacks, leaving out paths signed by an upstream
// cache, which Attic never stores. A target with a closure list is kept only in the cache: once a check finds it fully
// pushed, its closure's paths are written to that list and its build root is removed, so garbage collection frees the
// store, and later checks judge it by the list. Build and Push run one target and end by checking it again. Build all
// evaluates every target in one parallel pass of nix-eval-jobs, builds each as soon as its own evaluation ends, pushes it
// once built, and ends by checking every target. Each fact is printed as one tab-separated line after a marker.

// ── Imports ──────────────────────────────────────────────────────────────────

import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";

import {
  flake_report_name, fresh_lookup, missing_tool_exit_code, report_mark, type CacheBuildAllOperation, type CacheBuildOperation, type CacheCheckOperation,
  type CachePushOperation, type CacheSettings, type CacheTarget,
} from "../../shared/operations.ts";
import { on_path, person_command, type Context } from "../programs.ts";

// ── Reporting ────────────────────────────────────────────────────────────────

function report(context: Context, name: string, key: string, value: string): void {
  context.out.write(`${report_mark}\t${name}\t${key}\t${value.replace(/[\t\n]/g, " ")}\n`);
}

// The end of a program's error output, as short as a row can show.
function tail(text: string, length = 400): string {
  return text.trim().slice(-length);
}

// ── Checking ─────────────────────────────────────────────────────────────────

// Evaluates a target, answering its store path, or null after reporting why it could not.
async function evaluate_target(context: Context, cache: CacheSettings, target: CacheTarget, refresh: boolean): Promise<string | null> {
  const argv = [...cache.nix, "eval", "--raw", "--no-write-lock-file", ...(refresh ? ["--refresh"] : []), target.installable];
  // nix's stderr reaches the run's output as it evaluates, and is kept for the error report.
  const result = await context.program(context, argv, { stdout: "keep", stderr: "both" });
  if (result.exit_code !== 0) {
    report(context, target.name, "error", tail(result.stderr));
    return null;
  }
  return result.stdout.trim();
}

// Reports what the cache holds of the closure at `out`, dropping the build root of a target kept only in the cache.
async function inspect(context: Context, cache: CacheSettings, target: CacheTarget, out: string): Promise<void> {
  const local = await context.program(context, [...cache.nix, "path-info", out], { stdout: "drop", stderr: "drop" });
  let own: string[];
  const listed = target.list === null ? [] : read_lines(target.list);
  if (local.exit_code === 0) {
    report(context, target.name, "built", "1");
    own = await own_paths(context, cache, out);
  } else if (listed[0] === out) {
    // A target dropped from the store is judged by the closure list written when it was dropped.
    report(context, target.name, "built", "1");
    report(context, target.name, "local", "0");
    own = listed.slice(1);
  } else {
    report(context, target.name, "built", "0");
    own = [out];
  }
  report(context, target.name, "own", String(own.length));

  const asked = await context.program(context, [...cache.nix, "path-info", "--stdin", "--json", ...fresh_lookup, "--store", cache.cache_url], {
    stdin: own.map((path) => `${path}\n`).join(""), stdout: "keep", stderr: "keep",
  });
  const missing = missing_paths(asked.stdout);
  if (missing === null) {
    report(context, target.name, "cache_error", tail(asked.stderr));
    return;
  }
  for (const path of missing) report(context, target.name, "missing", path);

  // Only a root still pointing at this closure is dropped, and its list is in place before the root goes.
  if (missing.length === 0 && target.link !== null && target.list !== null && link_of(target.link) === out) {
    writeFileSync(`${target.list}.tmp`, [out, ...own].map((path) => `${path}\n`).join(""));
    renameSync(`${target.list}.tmp`, target.list);
    rmSync(target.link, { force: true });
    report(context, target.name, "dropped", "1");
  }
}

// The closure's paths the cache must hold itself, leaving out those an upstream cache has signed.
async function own_paths(context: Context, cache: CacheSettings, out: string): Promise<string[]> {
  if (cache.upstream_keys.length === 0) {
    const listed = await context.program(context, [...cache.nix, "path-info", "-r", out], { stdout: "keep", stderr: "drop" });
    return lines(listed.stdout);
  }
  const listed = await context.program(context, [...cache.nix, "path-info", "-r", "--sigs", out], { stdout: "keep", stderr: "drop" });
  const upstream = cache.upstream_keys.map((key) => `${key}:`);
  // nix pads the path column with spaces and then a tab, so the widest path has only the tab before its signatures.
  return lines(listed.stdout)
    .map((line) => line.split(/\s+/))
    .filter(([, ...signatures]) => !signatures.some((signature) => upstream.some((key) => signature.startsWith(key))))
    .map(([path]) => path);
}

// The paths `nix path-info --json` says the store lacks, from either its old list or its newer object form.
export function missing_paths(json: string): string[] | null {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  if (Array.isArray(data)) {
    return data.filter((item) => item?.valid === false && typeof item.path === "string").map((item) => item.path as string);
  }
  if (typeof data !== "object" || data === null) return null;
  return Object.entries(data as Record<string, unknown>).filter(([, info]) => info === null).map(([path]) => path);
}

async function check_target(context: Context, cache: CacheSettings, target: CacheTarget, refresh: boolean): Promise<boolean> {
  const out = await evaluate_target(context, cache, target, refresh);
  if (out === null) return false;
  report(context, target.name, "target", out);
  await inspect(context, cache, target, out);
  return true;
}

// ── Check ────────────────────────────────────────────────────────────────────

export async function cache_check(context: Context, operation: CacheCheckOperation): Promise<number> {
  const { cache } = operation;
  // Only the first evaluation that succeeds refetches a remote flake, so every target is judged at the same revision.
  let refresh = cache.refresh;
  for (const target of operation.targets) {
    if (await check_target(context, cache, target, refresh)) refresh = false;
  }
  const metadata = await context.program(context, [...cache.nix, "flake", "metadata", "--json", "--no-write-lock-file", cache.flake], { stdout: "keep", stderr: "drop" });
  report(context, flake_report_name, "metadata", metadata.stdout.trim());
  return 0;
}

// ── Build ────────────────────────────────────────────────────────────────────

// Builds one target from the flake's latest revision, pushes what it built when there is a push_command, then checks it.
export async function cache_build(context: Context, operation: CacheBuildOperation): Promise<number> {
  const { cache, target } = operation;
  const link = target.link === null ? ["--no-link"] : ["--out-link", target.link];
  if (cache.build_root_dir !== null) mkdirSync(cache.build_root_dir, { recursive: true });
  const argv = [...cache.nix, "build", "--print-out-paths", ...link, ...cache.build_args, ...(cache.refresh ? ["--refresh"] : []), target.installable];
  const built = await context.program(context, argv, { echo: true, stdout: "keep" });
  let status = built.exit_code;
  const out = lines(built.stdout).pop() ?? "";
  // Pushed here rather than left to a store watcher, so the check that follows never races the upload.
  if (status === 0 && out !== "" && cache.push_command !== null) status = (await push(context, cache, out)).exit_code || status;
  if (out !== "") {
    report(context, target.name, "target", out);
    await inspect(context, cache, target, out);
  }
  return status;
}

// Pushes one target's store path, then checks it again; the push's status is the run's.
export async function cache_push(context: Context, operation: CachePushOperation): Promise<number> {
  const { cache, target, path } = operation;
  const pushed = await push(context, cache, path);
  report(context, target.name, "target", path);
  await inspect(context, cache, target, path);
  return pushed.exit_code;
}

function push(context: Context, cache: CacheSettings, path: string) {
  return context.program(context, person_command(`${cache.push_command} "$1"`).concat(["x-nix-push", path]), { echo: true });
}

// ── Build all ────────────────────────────────────────────────────────────────

interface Outcome {
  word: "ok" | "failed" | "push_failed";
  seconds: number;
  out: string;
}

// One line nix-eval-jobs prints for a target once its evaluation ends.
interface EvaluatedJob {
  attr?: string;
  error?: string;
  drvPath?: string;
  outputs?: Record<string, string>;
}

export async function cache_build_all(context: Context, operation: CacheBuildAllOperation): Promise<number> {
  const { cache, targets } = operation;
  if ((await on_path(operation.eval_jobs)) === null) {
    context.err.write(`${operation.eval_jobs} is not installed on this host; Build all needs it on the PATH of services.x-nix or services.x-nix-agent\n`);
    return missing_tool_exit_code;
  }
  const scratch = mkdtempSync(join(tmpdir(), "x-nix-build-all-"));
  try {
    const keyed = new Map(targets.map((target, index) => [`t${index}`, target]));
    const errors = new Map<string, string>();
    const outcomes = new Map<string, Promise<Outcome>>();

    const build_one = async (target: CacheTarget, drv: string, out: string): Promise<Outcome> => {
      const started = Date.now();
      const link = target.link === null ? ["--no-link"] : ["--out-link", target.link];
      if (cache.build_root_dir !== null) mkdirSync(cache.build_root_dir, { recursive: true });
      const built = await context.program(context, [...cache.nix, "build", ...link, ...cache.build_args, `${drv}^*`]);
      let word: Outcome["word"] = built.exit_code === 0 ? "ok" : "failed";
      if (word === "ok" && cache.push_command !== null && (await push(context, cache, out)).exit_code !== 0) word = "push_failed";
      context.out.write(`${target.name}: ${word}\n`);
      return { word, seconds: Math.round((Date.now() - started) / 1000), out };
    };

    // A remote flake is fetched afresh, as every other job does with --refresh.
    const fresh = cache.refresh ? ["--option", "tarball-ttl", "0"] : [];
    const argv = [operation.eval_jobs, "--impure", "--workers", String(operation.eval_workers), "--gc-roots-dir", join(scratch, "roots"), ...fresh, "--expr", operation.expression];
    mkdirSync(join(scratch, "roots"));
    // nix-eval-jobs prints one JSON line per target as its evaluation ends, and that target's build starts at once.
    const evaluation = await evaluate_jobs(context, argv, (job) => {
      const target = job.attr === undefined ? undefined : keyed.get(job.attr);
      if (target === undefined || job.attr === undefined) return;
      if (job.error !== undefined) {
        errors.set(job.attr, tail(job.error.replace(/\n/g, " ")));
        context.out.write(`${target.name}: evaluation failed\n`);
        return;
      }
      const out = job.outputs?.out ?? "";
      context.out.write(`${target.name}: evaluated, building ${out}\n`);
      outcomes.set(job.attr, build_one(target, job.drvPath ?? "", out));
    });

    let status = evaluation.exit_code === 0 ? 0 : 1;
    // Each target is reported in turn once every build has ended.
    for (const [key, target] of keyed) {
      const error = errors.get(key);
      const outcome = await outcomes.get(key);
      if (outcome === undefined) {
        report(context, target.name, "error", error ?? `nix-eval-jobs never evaluated it: ${tail(evaluation.stderr, 300)}`);
        report(context, target.name, "build", "eval_failed");
        status = 1;
        continue;
      }
      report(context, target.name, "build", outcome.word);
      report(context, target.name, "build_seconds", String(outcome.seconds));
      if (outcome.word !== "ok") status = 1;
      report(context, target.name, "target", outcome.out);
      await inspect(context, cache, target, outcome.out);
    }
    return status;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Runs nix-eval-jobs, handing each JSON line to `each` as it is printed, with its stderr shown and its end kept.
function evaluate_jobs(context: Context, argv: string[], each: (job: EvaluatedJob) => void): Promise<{ exit_code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { detached: context.own_groups, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      context.err.write(chunk);
      stderr = (stderr + chunk.toString("utf8")).slice(-4096);
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        each(JSON.parse(line) as EvaluatedJob);
      } catch {
        // A line that is not a job is not one of ours.
      }
    });
    const stop = () => child.kill("SIGTERM");
    context.signal.addEventListener("abort", stop, { once: true });
    child.on("error", (error) => resolve({ exit_code: 127, stderr: error.message }));
    child.on("close", (code) => {
      context.signal.removeEventListener("abort", stop);
      resolve({ exit_code: code ?? 1, stderr });
    });
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function lines(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

function read_lines(path: string): string[] {
  try {
    return lines(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
}

function link_of(path: string): string | null {
  try {
    return readlinkSync(path);
  } catch {
    return null;
  }
}
