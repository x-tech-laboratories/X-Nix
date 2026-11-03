// The cache operations the agent performs, against a scripted program runner rather than a real nix.

import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { cache_build, cache_build_all, cache_check, cache_push, missing_paths } from "../src/agent/operations/cache.ts";
import type { Context, ProgramResult, RunProgram, StreamUse } from "../src/agent/programs.ts";
import { cache_settings, type CacheSettings } from "../src/server/config.ts";
import { build_all_operation, build_operation, check_operation, parse_report, push_operation } from "../src/server/nixos/attic.ts";
import type { CacheCheckOperation } from "../src/shared/operations.ts";

const alpha = "/nix/store/aaaa-nixos-system-Alpha";
const beta = "/nix/store/bbbb-nixos-system-Beta";
const dep = "/nix/store/dddd-dep";

// ── Harness ──────────────────────────────────────────────────────────────────

type Answer = Partial<ProgramResult> | undefined;

interface Ran {
  context: Context;
  // Every program run, in order.
  calls: string[][];
  output: () => string;
  errors: () => string;
}

const shows = (use: StreamUse) => use === "show" || use === "both";
const keeps = (use: StreamUse) => use === "keep" || use === "both";

// A context whose programs answer from a function of their arguments and stdin.
function scripted(answer: (argv: string[], stdin: string | null) => Answer): Ran {
  const out: string[] = [];
  const err: string[] = [];
  const calls: string[][] = [];
  const program: RunProgram = async (context, argv, options = {}) => {
    calls.push(argv);
    const result = { exit_code: 0, stdout: "", stderr: "", ...answer(argv, options.stdin ?? null) };
    const [stdout_use, stderr_use] = [options.stdout ?? "show", options.stderr ?? "show"];
    if (shows(stdout_use)) context.out.write(result.stdout);
    if (shows(stderr_use)) context.err.write(result.stderr);
    return { exit_code: result.exit_code, stdout: keeps(stdout_use) ? result.stdout : "", stderr: keeps(stderr_use) ? result.stderr : "" };
  };
  const context: Context = {
    out: { write: (chunk) => void out.push(String(chunk)) },
    err: { write: (chunk) => void err.push(String(chunk)) },
    signal: new AbortController().signal, own_groups: false, log: false, stdin: null, program,
  };
  return { context, calls, output: () => out.join(""), errors: () => err.join("") };
}

const has = (argv: string[], ...words: string[]) => words.every((word) => argv.includes(word));

function settings(values: Record<string, unknown> = {}): CacheSettings {
  return cache_settings({ id: "fleet", flake: "/f", configurations: ["Alpha"], installables: {}, cache_url: "https://cache.example/fleet", nix_bin: "nix", nix_args: [], upstream_keys: [], ...values });
}

function check_of(values: Record<string, unknown> = {}): CacheCheckOperation {
  return (check_operation(settings(values)) as { operation: CacheCheckOperation }).operation;
}

// ── Check ────────────────────────────────────────────────────────────────────

describe("check", () => {
  it("reports targets, failures and metadata, leaving out upstream paths and copying nix's errors", async () => {
    const ran = scripted((argv) => {
      if (has(argv, "eval") && argv.at(-1)!.endsWith("#Broken")) return { exit_code: 1, stderr: "error: no such attribute\n" };
      if (has(argv, "eval")) return { stdout: alpha };
      if (has(argv, "--stdin")) return { stdout: `{"${alpha}":{"ca":null},"${dep}":null}` };
      // nix pads the path column with spaces then a tab, so the widest path has only the tab.
      if (has(argv, "-r", "--sigs")) return { stdout: `${alpha}      \tultimate\n${dep}\tultimate\n/nix/store/eeee-glibc   \tcache.nixos.org-1:abc\n` };
      if (has(argv, "metadata")) return { stdout: '{"revision":"abc"}' };
      return undefined;
    });

    await cache_check(ran.context, check_of({ installables: { Broken: "Broken" }, upstream_keys: ["cache.nixos.org-1"] }));

    const report = parse_report(ran.output());
    expect(report.targets.get("Alpha")).toEqual({ target: alpha, built: "1", own: "2", missing: [dep] });
    expect(report.targets.get("Broken")?.error).toBe("error: no such attribute");
    expect(report.metadata).toBe('{"revision":"abc"}');
    expect(ran.errors()).toBe("error: no such attribute\n");
  });

  it("refreshes a remote flake only until one evaluation succeeds", async () => {
    const ran = scripted((argv) => (has(argv, "eval") ? (argv.at(-1)!.includes("Alpha") ? { exit_code: 1 } : { stdout: beta }) : { stdout: "{}" }));
    await cache_check(ran.context, check_of({ flake: "github:o/f", configurations: ["Alpha", "Beta", "Gamma"] }));
    const evaluations = ran.calls.filter((argv) => has(argv, "eval"));
    expect(evaluations.map((argv) => argv.includes("--refresh"))).toEqual([true, true, false]);
  });

  it("reads missing paths from either shape nix prints, and fails a check the cache did not answer", async () => {
    expect(missing_paths(`[{"path":"${alpha}","valid":true},{"path":"${dep}","valid":false}]`)).toEqual([dep]);
    expect(missing_paths(`{"${alpha}":{},"${dep}":null}`)).toEqual([dep]);
    expect(missing_paths("")).toBeNull();

    const ran = scripted((argv) => (has(argv, "eval") ? { stdout: alpha } : has(argv, "--stdin") ? { exit_code: 1, stderr: "unable to download" } : undefined));
    await cache_check(ran.context, check_of());
    expect(parse_report(ran.output()).targets.get("Alpha")?.cache_error).toBe("unable to download");
  });
});

// ── Kept only in the cache ───────────────────────────────────────────────────

describe("kept only in the cache", () => {
  async function check_alpha(local: boolean, missing = "", link_to: string | null = alpha, list: string | null = null) {
    const folder = mkdtempSync(join(tmpdir(), "x-nix-cache-"));
    const link = join(folder, "alpha");
    if (link_to !== null) symlinkSync(link_to, link);
    if (list !== null) writeFileSync(`${link}.closure`, list);
    const ran = scripted((argv) => {
      if (has(argv, "eval")) return { stdout: alpha };
      if (has(argv, "--stdin")) return { stdout: `{"${alpha}":{}${missing ? `,"${missing}":null` : ""}}` };
      if (has(argv, "-r")) return { stdout: `${alpha}\n${dep}\n` };
      if (has(argv, "path-info")) return { exit_code: local ? 0 : 1 };
      return undefined;
    });
    await cache_check(ran.context, check_of({ build_root_dir: folder, build_links: { Alpha: "alpha" }, drop_pushed: ["Alpha"] }));
    return { facts: parse_report(ran.output()).targets.get("Alpha")!, link, list_file: `${link}.closure` };
  }

  it("drops a fully pushed root once its closure list is written", async () => {
    const { facts, link, list_file } = await check_alpha(true);
    expect(facts.dropped).toBe("1");
    expect(lstatSync(link, { throwIfNoEntry: false })).toBeUndefined();
    expect(readFileSync(list_file, "utf8")).toBe(`${alpha}\n${alpha}\n${dep}\n`);
  });

  it("keeps a root with missing paths, or one for another closure", async () => {
    const missing = await check_alpha(true, dep);
    expect(missing.facts.dropped).toBeUndefined();
    expect(lstatSync(missing.link).isSymbolicLink()).toBe(true);
    expect(existsSync(missing.list_file)).toBe(false);

    const other = await check_alpha(true, "", beta);
    expect(other.facts.dropped).toBeUndefined();
    expect(lstatSync(other.link).isSymbolicLink()).toBe(true);
  });

  it("judges a dropped target by its list, and an older list counts for nothing", async () => {
    const dropped = await check_alpha(false, dep, null, `${alpha}\n${alpha}\n${dep}\n`);
    expect(dropped.facts).toEqual({ target: alpha, built: "1", local: "0", own: "2", missing: [dep] });

    const older = await check_alpha(false, "", null, `${beta}\n${beta}\n`);
    expect(older.facts.built).toBe("0");
    expect(older.facts.local).toBeUndefined();
  });
});

// ── Build and push ───────────────────────────────────────────────────────────

describe("build and push", () => {
  const quiet = (build: Answer, push: Answer = undefined) => scripted((argv) => {
    if (argv[0] === "/bin/sh") return push;
    if (has(argv, "build")) return build;
    if (has(argv, "--stdin")) return { stdout: "{}" };
    if (has(argv, "-r")) return { stdout: alpha };
    return undefined;
  });

  it("report the built target, keeping a failed build's status", async () => {
    const ran = quiet({ exit_code: 1, stdout: `${alpha}\n` });
    expect(await cache_build(ran.context, build_operation(settings({ build_args: [] }), "Alpha"))).toBe(1);
    expect(parse_report(ran.output()).targets.get("Alpha")).toEqual({ target: alpha, built: "1", own: "1", missing: [] });
  });

  it("push what a build made before reporting, and fail the build when the push fails", async () => {
    const ran = quiet({ stdout: `${alpha}\n` }, { exit_code: 1 });
    expect(await cache_build(ran.context, build_operation(settings({ push_command: "attic push fleet" }), "Alpha"))).toBe(1);
    expect(ran.calls).toContainEqual(["/bin/sh", "-c", 'attic push fleet "$1"', "x-nix-push", alpha]);
    expect(parse_report(ran.output()).targets.get("Alpha")?.target).toBe(alpha);
  });

  it("push nothing when the build failed", async () => {
    const ran = quiet({ exit_code: 1 });
    expect(await cache_build(ran.context, build_operation(settings({ push_command: "attic push fleet" }), "Alpha"))).toBe(1);
    expect(ran.calls.some((argv) => argv[0] === "/bin/sh")).toBe(false);
  });

  it("push the row's store path, the push's status being the run's", async () => {
    const ran = quiet(undefined, { exit_code: 2 });
    expect(await cache_push(ran.context, push_operation(settings({ push_command: "attic push fleet" }), "Alpha", alpha))).toBe(2);
    expect(ran.calls[0]).toEqual(["/bin/sh", "-c", 'attic push fleet "$1"', "x-nix-push", alpha]);
    expect(parse_report(ran.output()).targets.get("Alpha")?.target).toBe(alpha);
  });
});

// ── Build all ────────────────────────────────────────────────────────────────

describe("build all", () => {
  // A nix-eval-jobs that notes its arguments and prints these lines.
  function fake_eval_jobs(lines: string[]): { program: string; folder: string } {
    const folder = mkdtempSync(join(tmpdir(), "x-nix-eval-jobs-"));
    const program = join(folder, "nix-eval-jobs");
    writeFileSync(program, `#!/bin/sh\nprintf '%s\\n' "$*" > '${join(folder, "eval-args")}'\ncat <<'END'\n${lines.join("\n")}\nEND\n`);
    chmodSync(program, 0o755);
    return { program, folder };
  }

  const builds_and_inspects = (push: Answer = undefined) => scripted((argv) => {
    if (argv[0] === "/bin/sh") return push;
    if (has(argv, "build")) return argv.some((word) => word.includes("bad")) ? { exit_code: 1, stderr: "error: builder failed\n" } : undefined;
    if (has(argv, "--stdin")) return { stdout: "{}" };
    if (has(argv, "-r")) return { stdout: alpha };
    if (has(argv, "path-info")) return { exit_code: argv.includes(alpha) ? 0 : 1 };
    return undefined;
  });

  it("builds each evaluated target, reports how each ended and checks it", async () => {
    const { program, folder } = fake_eval_jobs([
      `{"attr":"t0","attrPath":["t0"],"drvPath":"/nix/store/aaaa-alpha.drv","name":"alpha","outputs":{"out":"${alpha}"},"system":"x86_64-linux"}`,
      `{"attr":"t1","attrPath":["t1"],"drvPath":"/nix/store/bbbb-bad.drv","name":"beta","outputs":{"out":"${beta}"},"system":"x86_64-linux"}`,
      `{"attr":"t2","attrPath":["t2"],"error":"error: attribute 'x' missing\\n at flake.nix:3"}`,
    ]);
    const ran = builds_and_inspects();
    const operation = build_all_operation(settings({ build_args: [], configurations: ["Alpha", "Beta"], installables: { Broken: "x" }, eval_jobs_bin: program }));

    expect(await cache_build_all(ran.context, operation)).toBe(1);

    const report = parse_report(ran.output());
    expect(report.targets.get("Alpha")).toMatchObject({ build: "ok", target: alpha, built: "1" });
    expect(report.targets.get("Beta")).toMatchObject({ build: "failed", target: beta, built: "0" });
    expect(report.targets.get("Broken")).toMatchObject({ build: "eval_failed", error: "error: attribute 'x' missing  at flake.nix:3" });
    expect(report.targets.get("Alpha")?.build_seconds).toMatch(/^\d+$/);
    expect(ran.output()).toContain(`Alpha: evaluated, building ${alpha}`);
    expect(ran.calls).toContainEqual(["nix", "build", "--no-link", "/nix/store/aaaa-alpha.drv^*"]);
    expect(readFileSync(join(folder, "eval-args"), "utf8")).toContain("--impure --workers 4 --gc-roots-dir");
  });

  it("pushes each target it built, and fails a target whose push fails", async () => {
    const { program } = fake_eval_jobs([`{"attr":"t0","drvPath":"/nix/store/aaaa-alpha.drv","outputs":{"out":"${alpha}"}}`]);
    const ran = builds_and_inspects({ exit_code: 1 });
    await cache_build_all(ran.context, build_all_operation(settings({ build_args: [], push_command: "false", eval_jobs_bin: program })));
    expect(parse_report(ran.output()).targets.get("Alpha")?.build).toBe("push_failed");
  });

  it("says plainly when nix-eval-jobs is missing", async () => {
    const ran = builds_and_inspects();
    expect(await cache_build_all(ran.context, build_all_operation(settings({ eval_jobs_bin: "/nonexistent/nix-eval-jobs" })))).toBe(127);
    expect(ran.errors()).toContain("/nonexistent/nix-eval-jobs is not installed on this host");
  });
});
