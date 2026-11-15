// A deployment's own operations: evaluating the host's toplevel, building it, asking whether the cache holds it,
// comparing two closures, and updating a flake's lock: a local checkout's in place, or a github: flake's with a commit
// pushed back, each only once the new lock evaluates.

// ── Imports ──────────────────────────────────────────────────────────────────

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  diff_mark, eval_mark, fresh_lookup, is_store_path, show_argv, toplevel, type BuildOperation, type CacheHoldsOperation, type ClosureDiffOperation,
  type EvaluateOperation, type GithubUpdateOperation, type LocalUpdateOperation, type UpdateCheck,
} from "../../shared/operations.ts";
import { on_path, type Context } from "../programs.ts";

// ── Evaluation ───────────────────────────────────────────────────────────────

// Evaluates the toplevel and reads the flake's metadata, showing nix's progress live, then prints each one's stdout and
// exit status after marker lines; it fails when either did.
export async function evaluate(context: Context, operation: EvaluateOperation): Promise<number> {
  const refresh = operation.refresh ? ["--refresh"] : [];
  const commands = {
    eval: [...operation.nix, "eval", "--raw", "--no-write-lock-file", ...refresh, toplevel(operation.flake, operation.attribute ?? hostname())],
    metadata: [...operation.nix, "flake", "metadata", "--json", "--no-write-lock-file", ...refresh, operation.flake],
  };
  const results = [];
  for (const [name, argv] of Object.entries(commands)) {
    context.out.write(`\n${eval_mark} ${name} stderr\n`);
    results.push({ name, ...(await context.program(context, argv, { stdout: "keep" })) });
  }
  for (const result of results) {
    context.out.write(`\n${eval_mark} ${result.name} stdout\n${result.stdout}\n${eval_mark} ${result.name} exit\n${result.exit_code}\n`);
  }
  return results.every((result) => result.exit_code === 0) ? 0 : 1;
}

// ── Build ────────────────────────────────────────────────────────────────────

// Realises the host's closure without activating it, printing its store path; a closure missing here but already in the
// cache is not downloaded just to be rooted, and any failure of that check falls through to the build.
export async function build(context: Context, operation: BuildOperation): Promise<number> {
  const refresh = operation.refresh ? ["--refresh"] : [];
  const target = toplevel(operation.flake, operation.attribute ?? hostname());
  if (operation.cache_url !== null) {
    const evaluated = await context.program(context, [...operation.nix, "eval", "--raw", "--no-write-lock-file", ...refresh, target], { stdout: "keep", stderr: "drop" });
    const out = evaluated.stdout.trim();
    if (evaluated.exit_code === 0 && is_store_path(out) && !(await has_path(context, operation.nix, out)) && (await has_path(context, operation.nix, out, operation.cache_url))) {
      context.out.write(`${out} is already in the cache; not building it\n`);
      return 0;
    }
  }
  if (operation.root_link !== null) mkdirSync(dirname(operation.root_link), { recursive: true });
  const link = operation.root_link === null ? ["--no-link"] : ["--out-link", operation.root_link];
  const argv = [...operation.nix, "build", ...link, "--print-out-paths", ...operation.args, ...refresh, target];
  return (await context.program(context, argv, { echo: true })).exit_code;
}

// Whether a store holds the path: this host's own, or the one named.
async function has_path(context: Context, nix: string[], path: string, store: string | null = null): Promise<boolean> {
  const argv = [...nix, "path-info", ...(store === null ? [] : [...fresh_lookup, "--store", store]), path];
  return (await context.program(context, argv, { stdout: "drop", stderr: "drop" })).exit_code === 0;
}

// ── Cache ────────────────────────────────────────────────────────────────────

// Succeeds only when the cache holds the store path and the host can fetch every path of its closure. Caches such as
// Attic leave out what an upstream cache serves, so the closure is checked against the host's own substituters. The dry
// run succeeds even for a path nothing can fetch, so its output is read instead.
export async function cache_holds(context: Context, operation: CacheHoldsOperation): Promise<number> {
  if (!is_store_path(operation.store_path)) {
    context.err.write(`'${operation.store_path}' is not a store path`);
    return 2;
  }
  const held = await context.program(context, [...operation.nix, "path-info", ...fresh_lookup, "--store", operation.cache_url, operation.store_path], { stdout: "drop" });
  if (held.exit_code !== 0) return held.exit_code;
  const plan = await context.program(context, [...operation.nix, "build", "--dry-run", "--no-link", operation.store_path], { stdout: "keep", stderr: "keep" });
  if (plan.exit_code !== 0) return plan.exit_code;
  const text = `${plan.stdout}\n${plan.stderr}`;
  return text.includes("know how to build") || text.includes("will be built") ? 1 : 0;
}

// ── Closure diff ─────────────────────────────────────────────────────────────

// Compares two system closures, printing each part after a marker line; a missing new closure is reported, not fetched.
export async function closure_diff(context: Context, operation: ClosureDiffOperation): Promise<number> {
  const { nix, from, to } = operation;
  const mark = (words: string) => context.out.write(`${diff_mark} ${words}\n`);
  if (!(await has_path(context, nix, to))) {
    mark("missing");
    return 0;
  }
  mark("closures");
  const changes = await context.program(context, [...nix, "store", "diff-closures", from, to], { stdout: "keep", stderr: "keep" });
  const text = `${changes.stdout}${changes.stderr}`;
  context.out.write(text.endsWith("\n") || text === "" ? text : `${text}\n`);
  if (changes.exit_code !== 0) mark(`failed ${changes.exit_code}`);
  mark("sizes");
  await context.program(context, [...nix, "path-info", "-S", "--json", from, to], { stderr: "drop" });
  context.out.write("\n");
  mark("derivations");
  // nix-diff only has something to add when the packages are the same, and needs both derivations in the store.
  if (changes.exit_code !== 0 || from === to || text.trim() !== "") return 0;
  if ((await on_path("nix-diff")) === null) {
    mark("note nix-diff is not installed on the host, so the derivations cannot be compared");
    return 0;
  }
  const deriver = async (path: string) => (await context.program(context, ["nix-store", "-q", "--deriver", path], { stdout: "keep", stderr: "drop" })).stdout.trim();
  const [from_drv, to_drv] = [await deriver(from), await deriver(to)];
  if (!from_drv || !to_drv || !existsSync(from_drv) || !existsSync(to_drv)) {
    mark("note The derivations of both closures are not in the host's store, so they cannot be compared");
    return 0;
  }
  const derivations = await context.program(context, ["nix-diff", "--color", "never", from_drv, to_drv], { stdout: "keep", stderr: "keep" });
  context.out.write(`${derivations.stdout}${derivations.stderr}`.slice(0, 200_000));
  return 0;
}

// ── Update ───────────────────────────────────────────────────────────────────

// Clones the flake's repository, updates its lock and pushes a commit back once the check passes, as the agent's user rather than root.
export async function github_update(context: Context, operation: GithubUpdateOperation): Promise<number> {
  const folder = mkdtempSync(join(tmpdir(), "x-nix-update-"));
  const repository = join(folder, "repo");
  // Host keys come from the system known_hosts, so an unpinned github.com fails rather than being trusted.
  const ssh = ["ssh", "-i", operation.ssh_key, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes"];
  const env = { ...process.env, GIT_SSH_COMMAND: show_argv(ssh) };
  const git = (args: string[], options: { stdout?: "show" | "keep" } = {}) => context.program(context, ["git", ...args], { echo: true, env, ...options });
  try {
    const branch = operation.branch === null ? [] : ["--branch", operation.branch];
    const cloned = await git(["clone", "--quiet", "--depth", "1", ...branch, operation.ssh_url, repository]);
    if (cloned.exit_code !== 0) return cloned.exit_code;
    const updated = await context.program(context, [...operation.nix, "flake", "update", "--refresh", "--flake", repository], { echo: true, stdout: "both", stderr: "both" });
    if (updated.exit_code !== 0) return 1;
    const unchanged = await context.program(context, ["git", "-C", repository, "diff", "--quiet", "--", "flake.lock"]);
    if (unchanged.exit_code === 0) {
      context.out.write("Every input is already current\n");
      return 0;
    }
    if (operation.check != null && !(await check_lock(context, operation.nix, repository, [], operation.check))) {
      context.out.write("The new lock was not pushed\n");
      return 1;
    }
    const message = [operation.message, "", ...updated_inputs(updated)].join("\n");
    const identity = ["-c", `user.name=${operation.author_name}`, "-c", `user.email=${operation.author_email}`];
    const committed = await git(["-C", repository, ...identity, "commit", "--quiet", "-m", message, "--", "flake.lock"]);
    if (committed.exit_code !== 0) return committed.exit_code;
    const pushed = await git(["-C", repository, "push", "origin", "HEAD"]);
    if (pushed.exit_code !== 0) return pushed.exit_code;
    await git(["-C", repository, "log", "--oneline", "-1"]);
    return 0;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

// Updates the checkout's lock into a spare file, checks it, and only then copies it over the checkout's own.
export async function local_update(context: Context, operation: LocalUpdateOperation): Promise<number> {
  const folder = mkdtempSync(join(tmpdir(), "x-nix-update-"));
  const new_lock = join(folder, "flake.lock");
  const lock = join(operation.path, "flake.lock");
  const sudo = operation.sudo ? ["sudo", "-n", ...(operation.keep_nix_config ? ["--preserve-env=NIX_CONFIG"] : [])] : [];
  try {
    const update = [...sudo, ...operation.nix, "flake", "update", "--flake", operation.path, "--refresh", "--output-lock-file", new_lock];
    const updated = await context.program(context, update, { echo: true, stdout: "both", stderr: "both" });
    if (updated.exit_code !== 0) return 1;
    const written = read_text(new_lock);
    if (written === null) {
      context.out.write(`nix wrote no lock to ${new_lock}\n`);
      return 1;
    }
    if (written === read_text(lock)) {
      context.out.write("Every input is already current\n");
      return 0;
    }
    if (!(await check_lock(context, operation.nix, operation.path, ["--reference-lock-file", new_lock], operation.check))) {
      context.out.write("The lock was left as it was\n");
      return 1;
    }
    const copied = await context.program(context, [...(operation.sudo ? ["sudo", "-n"] : []), "cp", "-T", new_lock, lock], { echo: true });
    if (copied.exit_code !== 0) return copied.exit_code;
    context.out.write(`Wrote ${lock}\n`);
    return 0;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

// Evaluates or builds each attribute against the new lock, going on past a failure so the log names every one that broke.
async function check_lock(context: Context, nix: string[], flake: string, lock_args: string[], check: UpdateCheck): Promise<boolean> {
  const failed: string[] = [];
  for (const attribute of check.attributes) {
    context.out.write(`${check.build ? "Building" : "Evaluating"} ${attribute} with the new lock\n`);
    const argv = check.build
      ? [...nix, "build", "--no-link", "--no-write-lock-file", ...lock_args, `${flake}#${attribute}`]
      : [...nix, "eval", "--raw", "--no-write-lock-file", ...lock_args, `${flake}#${attribute}.drvPath`];
    const result = await context.program(context, argv, { echo: true, stdout: check.build ? "show" : "drop" });
    if (result.exit_code !== 0) failed.push(attribute);
  }
  if (failed.length > 0) context.out.write(`The new lock breaks ${failed.join(", ")}\n`);
  return failed.length === 0;
}

// The inputs nix said it moved, one line each.
function updated_inputs(updated: { stdout: string; stderr: string }): string[] {
  return [...`${updated.stdout}\n${updated.stderr}`.matchAll(/Updated input '([^']*)'/g)].map((match) => `- ${match[1]}`);
}

function read_text(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
