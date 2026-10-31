import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AgentError, AgentPool } from "../src/server/agents/agent.ts";
import { Cache } from "../src/server/cache.ts";
import { parse_metrics, probe_cache_server, type Fetcher } from "../src/server/cache_server.ts";
import { ConfigError, cache_settings, parse_config, type CacheSettings } from "../src/server/config.ts";
import { build_all_expression, build_all_script, build_script, check_command, check_script, parse_report, push_script, report_mark } from "../src/server/nixos/attic.ts";
import { Store } from "../src/server/store.ts";
import { clock, FakeAgent } from "./fake_agent.ts";

const alpha = "/nix/store/aaaa-nixos-system-Alpha";
const beta = "/nix/store/bbbb-nixos-system-Beta";
const kernel = "/nix/store/kkkk-linux";

const base = {
  id: "fleet",
  flake: "github:owner/fleet",
  configurations: ["Alpha", "Beta"],
  installables: { kernel: "packages.aarch64-linux.kernel" },
  cache_url: "https://cache.example/fleet",
};

function settings(values: Record<string, unknown> = {}): CacheSettings {
  return cache_settings({ ...base, ...values });
}

// A report line, as the scripts print them.
function line(name: string, key: string, value: string | number): string {
  return `${report_mark}\t${name}\t${key}\t${value}\n`;
}

function built(name: string, path: string, own: number, missing: string[] = []): string {
  return line(name, "target", path) + line(name, "built", 1) + line(name, "own", own) + missing.map((item) => line(name, "missing", item)).join("");
}

const metadata = line("@flake", "metadata", JSON.stringify({ lastModified: 1, locked: { rev: "0123456789abcdef0123456789abcdef01234567", lastModified: 1 } }));

// ── Harness ──────────────────────────────────────────────────────────────────

interface Harness {
  cache: Cache;
  agent: FakeAgent;
  store: Store;
  // What each URL the cache server is asked for answers, by URL; a missing one cannot be reached.
  answers: Map<string, [status: number, body: string]>;
}

// A cache server answering from a table of URLs.
function fake_fetch(answers: Map<string, [number, string]>): Fetcher {
  return async (url) => {
    const answer = answers.get(url);
    if (answer === undefined) throw new Error("connect ECONNREFUSED");
    return { ok: answer[0] >= 200 && answer[0] < 300, status: answer[0], text: async () => answer[1] };
  };
}

const cache_info = "StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 41\n";

function make_cache(values: Record<string, unknown> = {}): Harness {
  const store = new Store(":memory:");
  const agent = new FakeAgent();
  const answers = new Map<string, [number, string]>([["https://cache.example/fleet/nix-cache-info", [200, cache_info]]]);
  const cache = new Cache(settings(values), { store, agents: new AgentPool("host", agent), now: () => clock.now, fetch: fake_fetch(answers) });
  return { cache, agent, store, answers };
}

// Launches a check and ends it with this output.
async function check(harness: Harness, output: string, exit_code: number | null = 0): Promise<void> {
  await harness.cache.cycle();
  harness.agent.end(harness.agent.last_run("--store")!, output, exit_code);
  await harness.cache.cycle();
}

function rows(harness: Harness) {
  return Object.fromEntries(harness.cache.reading()!.rows.map((row) => [row.name, row]));
}

// ── Scripts against a fake nix ───────────────────────────────────────────────

// Writes a nix that answers by a shell case over its arguments, and settings that use it.
function fake_nix(cases: string, values: Record<string, unknown> = {}): { settings: CacheSettings; folder: string } {
  const folder = mkdtempSync(join(tmpdir(), "x-nix-attic-"));
  const nix = join(folder, "nix");
  writeFileSync(nix, `#!/bin/sh\ncase "$*" in\n${cases}\nesac\n`);
  chmodSync(nix, 0o755);
  return { folder, settings: settings({ flake: "/f", configurations: ["Alpha"], installables: {}, nix_bin: nix, nix_args: [], ...values }) };
}

function run(command: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync("sh", ["-c", command], { encoding: "utf8" });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

describe("check script", () => {
  it("checks every target against the cache, refreshing a remote flake once", () => {
    const text = check_script(settings());
    expect(text).toContain(`check Alpha 'github:owner/fleet#nixosConfigurations."Alpha".config.system.build.toplevel'`);
    expect(text).toContain("check kernel 'github:owner/fleet#packages.aarch64-linux.kernel'");
    expect(text).toContain("--store https://cache.example/fleet");
    expect(text).toContain("refresh=--refresh");
    expect(check_command(settings())).toMatch(/^timeout 1800 sh -c /);
    expect(check_script(settings({ flake: "/etc/nixos" }))).toContain("refresh=\n");
  });

  it("leaves out paths an upstream cache signed", () => {
    expect(check_script(settings({ upstream_keys: ["cache.nixos.org-1", "other-1"] }))).toContain('split("cache.nixos.org-1: other-1:", up, " ")');
  });

  it("reports targets, failures and metadata, copying nix's errors to the output", () => {
    const { settings: fake } = fake_nix([
      "  *eval*Broken*) echo 'error: no such attribute' >&2; exit 1 ;;",
      `  *eval*) printf %s ${alpha} ;;`,
      `  *'path-info --stdin'*) cat >/dev/null; echo '{"${alpha}":{"ca":null},"/nix/store/dddd-dep":null}' ;;`,
      // nix pads the path column with spaces then a tab, so the widest path has only the tab.
      `  *'path-info -r --sigs'*) printf '${alpha}      \\tultimate\\n/nix/store/dddd-dep\\tultimate\\n/nix/store/eeee-glibc   \\tcache.nixos.org-1:abc\\n' ;;`,
      "  *path-info*) exit 0 ;;",
      `  *metadata*) echo '{"revision":"abc"}' ;;`,
    ].join("\n"), { installables: { Broken: "Broken" } });

    const result = run(check_script(fake));

    const report = parse_report(result.stdout);
    expect(report.targets.get("Alpha")).toEqual({ target: alpha, built: "1", own: "2", missing: ["/nix/store/dddd-dep"] });
    expect(report.targets.get("Broken")?.error).toBe("error: no such attribute");
    expect(report.metadata).toBe('{"revision":"abc"}');
    expect(result.stderr).toBe("error: no such attribute\n");
  });
});

describe("kept only in the cache", () => {
  const cases = (local: boolean, missing = "") => [
    `  *eval*) printf %s ${alpha} ;;`,
    `  *'path-info --stdin'*) cat >/dev/null; echo '{"${alpha}":{}${missing ? `,"${missing}":null` : ""}}' ;;`,
    `  *'path-info -r'*) printf '${alpha}\\n/nix/store/dddd-dep\\n' ;;`,
    `  *path-info*) exit ${local ? 0 : 1} ;;`,
  ].join("\n");

  function check_alpha(local: boolean, missing = "", link_to: string | null = alpha, list: string | null = null) {
    const { settings: fake, folder } = fake_nix(cases(local, missing), { upstream_keys: [], build_root_dir: "/unused", drop_pushed: ["Alpha"] });
    const link = join(folder, "alpha");
    if (link_to !== null) symlinkSync(link_to, link);
    if (list !== null) writeFileSync(`${link}.closure`, list);
    const rooted = { ...fake, build_root_dir: folder, build_links: { Alpha: "alpha" } };
    const facts = parse_report(run(check_script(rooted)).stdout).targets.get("Alpha")!;
    return { facts, link, list_file: `${link}.closure` };
  }

  it("drops a fully pushed root once its closure list is written", () => {
    const { facts, link, list_file } = check_alpha(true);
    expect(facts.dropped).toBe("1");
    expect(existsSync(link) || lstatSync(link, { throwIfNoEntry: false }) !== undefined).toBe(false);
    expect(readFileSync(list_file, "utf8")).toBe(`${alpha}\n${alpha}\n/nix/store/dddd-dep\n`);
  });

  it("keeps a root with missing paths, or one for another closure", () => {
    const missing = check_alpha(true, "/nix/store/dddd-dep");
    expect(missing.facts.dropped).toBeUndefined();
    expect(lstatSync(missing.link).isSymbolicLink()).toBe(true);
    expect(existsSync(missing.list_file)).toBe(false);

    const other = check_alpha(true, "", beta);
    expect(other.facts.dropped).toBeUndefined();
    expect(lstatSync(other.link).isSymbolicLink()).toBe(true);
  });

  it("judges a dropped target by its list, and an older list counts for nothing", () => {
    const dropped = check_alpha(false, "/nix/store/dddd-dep", null, `${alpha}\n${alpha}\n/nix/store/dddd-dep\n`);
    expect(dropped.facts).toEqual({ target: alpha, built: "1", local: "0", own: "2", missing: ["/nix/store/dddd-dep"] });

    const older = check_alpha(false, "", null, `${beta}\n${beta}\n`);
    expect(older.facts.built).toBe("0");
    expect(older.facts.local).toBeUndefined();
  });

  it("passes a root and list only for targets named in drop_pushed", () => {
    const text = check_script(settings({ build_root_dir: "/roots", drop_pushed: ["Alpha"], build_links: { Alpha: "alpha-deploy" } }));
    expect(text).toContain(`check Alpha 'github:owner/fleet#nixosConfigurations."Alpha".config.system.build.toplevel' /roots/alpha-deploy /roots/alpha-deploy.closure`);
    expect(text).toContain(`check Beta 'github:owner/fleet#nixosConfigurations."Beta".config.system.build.toplevel'\n`);
  });
});

describe("build and push scripts", () => {
  const quiet_nix = `  *'path-info --stdin'*) cat >/dev/null; echo '{}' ;;\n  *'path-info -r'*) echo ${alpha} ;;\n  *path-info*) exit 0 ;;`;

  it("build from the latest flake, rooted under its link", () => {
    expect(build_script(settings(), "Alpha")).toContain(
      `build --print-out-paths --no-link --keep-going --print-build-logs --refresh 'github:owner/fleet#nixosConfigurations."Alpha".config.system.build.toplevel'`);
    const rooted = settings({ build_root_dir: "/roots/", build_links: { Alpha: "alpha-deploy" } });
    expect(build_script(rooted, "Alpha")).toContain("--out-link /roots/alpha-deploy ");
    expect(build_script(rooted, "Beta")).toContain("--out-link /roots/fleet-Beta ");
  });

  it("report the built target, keeping a failed build's status", () => {
    const { settings: fake } = fake_nix(quiet_nix, { upstream_keys: [], build_args: [] });
    const command = build_script(fake, "Alpha").replace(/^out=\$\(.*\)$/m, `out=$(echo building >&2; echo ${alpha}; exit 1)`);
    const result = run(command);
    expect(result.status).toBe(1);
    expect(parse_report(result.stdout).targets.get("Alpha")).toEqual({ target: alpha, built: "1", own: "1", missing: [] });
  });

  it("push what a build made before reporting, and fail the build when the push fails", () => {
    const { settings: fake } = fake_nix(quiet_nix, { upstream_keys: [], push_command: `sh -c 'printf "pushed %s\\n" "$1" >&2; exit 1' push` });
    const command = build_script(fake, "Alpha").replace(/^out=\$\(.*\)$/m, `out=$(echo ${alpha})`);
    const result = run(command);
    expect(result.stderr).toBe(`pushed ${alpha}\n`);
    expect(result.status).toBe(1);
    expect(parse_report(result.stdout).targets.get("Alpha")?.target).toBe(alpha);
  });

  it("push nothing when the build failed", () => {
    const { settings: fake } = fake_nix(quiet_nix, { push_command: "echo pushed >&2" });
    const command = build_script(fake, "Alpha").replace(/^out=\$\(.*\)$/m, "out=$(exit 1)");
    const result = run(command);
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("pushed");
  });

  it("push the row's store path with push_command", () => {
    expect(push_script(settings({ push_command: "attic push fleet" }), "Alpha", alpha)).toContain(`out=${alpha}\nattic push fleet "$out"`);
  });

  it("are plain sh, as the agent runs them", () => {
    for (const script of [check_script(settings({ build_root_dir: "/r", drop_pushed: ["Alpha"] })), build_script(settings({ push_command: "attic push c" }), "Alpha"), push_script(settings({ push_command: "attic push c" }), "Alpha", alpha)]) {
      expect(() => execFileSync("sh", ["-n", "-c", script])).not.toThrow();
    }
  });
});

// ── Build all ────────────────────────────────────────────────────────────────

describe("build all", () => {
  // A nix-eval-jobs that prints one line per target, the second one failing to evaluate.
  function fake_eval_jobs(folder: string, lines: string[]): string {
    const program = join(folder, "nix-eval-jobs");
    writeFileSync(program, `#!/bin/sh\nprintf '%s\\n' "$*" > ${shell_quote_for_test(join(folder, "eval-args"))}\ncat <<'END'\n${lines.join("\n")}\nEND\n`);
    chmodSync(program, 0o755);
    return program;
  }

  function shell_quote_for_test(text: string): string {
    return `'${text.replaceAll("'", `'"'"'`)}'`;
  }

  const builds_and_inspects = [
    `  *'build --no-link'*bad*) echo 'error: builder failed' >&2; exit 1 ;;`,
    `  *'build --no-link'*) echo "building $*" >&2; exit 0 ;;`,
    `  *'path-info --stdin'*) cat >/dev/null; echo '{}' ;;`,
    `  *'path-info -r'*) echo ${alpha} ;;`,
    `  *path-info*${alpha}*) exit 0 ;;`,
    "  *path-info*) exit 1 ;;",
  ].join("\n");

  it("evaluates every target in one expression keyed by position", () => {
    expect(build_all_expression(settings({ flake: 'github:o/f"x' }))).toBe(
      'let flake = builtins.getFlake "github:o/f\\"x"; in { t0 = flake.nixosConfigurations."Alpha".config.system.build.toplevel; '
      + 't1 = flake.nixosConfigurations."Beta".config.system.build.toplevel; t2 = flake.packages.aarch64-linux.kernel; }');
  });

  it("builds each evaluated target, reports how each ended and checks it", () => {
    const { settings: fake, folder } = fake_nix(builds_and_inspects, { upstream_keys: [], build_args: [], configurations: ["Alpha", "Beta"], installables: { Broken: "x" } });
    const eval_jobs_bin = fake_eval_jobs(folder, [
      `{"attr":"t0","attrPath":["t0"],"drvPath":"/nix/store/aaaa-alpha.drv","name":"alpha","outputs":{"out":"${alpha}"},"system":"x86_64-linux"}`,
      `{"attr":"t1","attrPath":["t1"],"drvPath":"/nix/store/bbbb-bad.drv","name":"beta","outputs":{"out":"${beta}"},"system":"x86_64-linux"}`,
      `{"attr":"t2","attrPath":["t2"],"error":"error: attribute 'x' missing\\n at flake.nix:3"}`,
    ]);

    const result = run(build_all_script({ ...fake, eval_jobs_bin }));

    expect(result.status).toBe(1);
    const report = parse_report(result.stdout);
    expect(report.targets.get("Alpha")).toMatchObject({ build: "ok", target: alpha, built: "1" });
    expect(report.targets.get("Beta")).toMatchObject({ build: "failed", target: beta, built: "0" });
    expect(report.targets.get("Broken")).toMatchObject({ build: "eval_failed", error: "error: attribute 'x' missing  at flake.nix:3" });
    expect(report.targets.get("Alpha")?.build_seconds).toMatch(/^\d+$/);
    expect(result.stdout).toContain(`Alpha: evaluated, building ${alpha}`);
    expect(result.stderr).toContain("building build --no-link /nix/store/aaaa-alpha.drv^*");
    expect(readFileSync(join(folder, "eval-args"), "utf8")).toContain("--impure --workers 4 --gc-roots-dir");
  });

  it("pushes each target it built, and fails a target whose push fails", () => {
    const { settings: fake, folder } = fake_nix(builds_and_inspects, { upstream_keys: [], build_args: [], configurations: ["Alpha"], installables: {}, push_command: "false" });
    const eval_jobs_bin = fake_eval_jobs(folder, [`{"attr":"t0","drvPath":"/nix/store/aaaa-alpha.drv","outputs":{"out":"${alpha}"}}`]);

    expect(parse_report(run(build_all_script({ ...fake, eval_jobs_bin })).stdout).targets.get("Alpha")?.build).toBe("push_failed");
  });

  it("says plainly when nix-eval-jobs is missing", () => {
    const result = run(build_all_script(settings({ eval_jobs_bin: "/nonexistent/nix-eval-jobs" })));
    expect(result.status).toBe(127);
    expect(result.stderr).toContain("/nonexistent/nix-eval-jobs is not installed on this host");
  });

  it("is plain sh, as the agent runs it", () => {
    expect(() => execFileSync("sh", ["-n", "-c", build_all_script(settings({ build_root_dir: "/r", push_command: "attic push c" }))])).not.toThrow();
  });

  it("runs as one job and keeps each target's outcome", async () => {
    const harness = make_cache();
    await check(harness, built("Alpha", alpha, 1, [alpha]) + built("Beta", beta, 3) + metadata);

    expect(await harness.cache.build_all()).toMatchObject({ ok: true, message: "Build all started" });
    expect(harness.cache.build_all_refusal()).toContain("already running");
    harness.agent.end(harness.agent.last_run("nix-eval-jobs")!, `Alpha: ok\n${line("Alpha", "build", "ok")}${line("Alpha", "build_seconds", 42)}${built("Alpha", alpha, 1)}`
      + line("Beta", "error", "error: boom") + line("Beta", "build", "eval_failed"), 1);
    await harness.cache.cycle();

    const reading = harness.cache.reading()!;
    expect(reading.build_all?.results).toEqual([
      { name: "Alpha", result: "ok", seconds: 42 },
      { name: "Beta", result: "eval_failed", seconds: null },
      { name: "kernel", result: "not_reported", seconds: null },
    ]);
    expect(rows(harness).Alpha.pushed).toBe("All 1");
    expect(rows(harness).Beta.status).toBe("failed");
    expect(harness.store.events("fleet").map((event) => event.message)).toContain("Build all failed: 1 of 3 targets built; Exited with status 1");

    // A later check keeps the last Build all.
    await check(harness, built("Alpha", alpha, 1) + built("Beta", beta, 3) + metadata);
    expect(harness.cache.reading()?.build_all?.job_id).toBe(reading.build_all?.job_id);
  });
});

// ── Rows ─────────────────────────────────────────────────────────────────────

describe("rows", () => {
  it("are online when built and pushed, with the revision", async () => {
    const harness = make_cache();
    await check(harness, built("Alpha", alpha, 12) + built("Beta", beta, 3) + built("kernel", kernel, 1) + metadata);
    const reading = harness.cache.reading()!;
    expect(reading.status).toBe("online");
    expect(reading.revision).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(rows(harness).Alpha).toMatchObject({ pushed: "All 12", target: alpha, pushed_ok: true, summary: "Built and pushed" });
    expect(reading.messages[0].text).toBe("3 of 3 targets built, 3 fully pushed");
  });

  it("are pending with missing paths, capped at missing_limit", async () => {
    const harness = make_cache({ missing_limit: 1 });
    await check(harness, built("Alpha", alpha, 12, ["/nix/store/dddd-dep", "/nix/store/ffff-dep"]) + built("Beta", beta, 3) + built("kernel", kernel, 1));
    expect(harness.cache.reading()?.status).toBe("warning");
    expect(rows(harness).Alpha).toMatchObject({ pushed: "2 of 12 missing", summary: "2 of 12 paths are not in the cache", missing_count: 2, missing: ["/nix/store/dddd-dep"] });
  });

  it("are pending when not built, with the root's own state", async () => {
    const harness = make_cache();
    await check(harness, line("Alpha", "target", alpha) + line("Alpha", "built", 0) + line("Alpha", "own", 1) + line("Alpha", "missing", alpha)
      + line("Beta", "target", beta) + line("Beta", "built", 0) + line("Beta", "own", 1));
    expect(harness.cache.reading()?.status).toBe("warning");
    expect(rows(harness).Alpha).toMatchObject({ built: false, pushed: "No", summary: "Not built from the latest flake" });
    expect(rows(harness).Beta.pushed).toBe("Root only");
  });

  it("take their pending status from pending_status", async () => {
    const harness = make_cache({ configurations: ["Alpha"], installables: {}, pending_status: "failed" });
    await check(harness, line("Alpha", "target", alpha) + line("Alpha", "built", 0) + line("Alpha", "own", 1));
    expect(harness.cache.reading()?.status).toBe("failed");
  });

  it("fail on a failed evaluation and leave unchecked targets unavailable", async () => {
    const harness = make_cache();
    await check(harness, line("Alpha", "error", "error: attribute missing"));
    expect(harness.cache.reading()?.status).toBe("failed");
    expect(rows(harness).Alpha.summary).toBe("Evaluation failed: error: attribute missing");
    expect(rows(harness).Beta.status).toBe("unavailable");
  });

  it("are unavailable when the cache does not answer", async () => {
    const harness = make_cache();
    await check(harness, built("Alpha", alpha, 5) + line("Alpha", "cache_error", "unable to download"));
    expect(rows(harness).Alpha).toMatchObject({ status: "unavailable", pushed: "Unknown" });
  });

  it("say when a pushed target is kept only in the cache, and refuse to push it", async () => {
    const harness = make_cache({ push_command: "attic push fleet" });
    await check(harness, line("Alpha", "target", alpha) + line("Alpha", "built", 1) + line("Alpha", "local", 0) + line("Alpha", "own", 2));
    expect(rows(harness).Alpha).toMatchObject({ status: "online", summary: "Pushed, kept only in the cache", local: false });
    expect(harness.cache.action_refusal("push", "Alpha")).toContain("kept only in the cache");
  });

  it("ignore output that is not a report line", () => {
    expect(parse_report(`Alpha\ttarget\t${alpha}\nbuilding '/nix/store/x.drv'...\n`).targets.size).toBe(0);
  });
});

// ── Checks ───────────────────────────────────────────────────────────────────

describe("checks", () => {
  it("run as a long run on the host, left out of the job history", async () => {
    const harness = make_cache();
    await harness.cache.cycle();
    const job = harness.cache.running_job()!;
    expect([job.kind, job.trigger, job.agent]).toEqual(["check", "schedule", null]);
    expect(harness.store.jobs()).toHaveLength(0);
    expect(harness.store.jobs({ include_evaluations: true })).toHaveLength(1);
  });

  it("keep the previous reading while they run, showing progress", async () => {
    const harness = make_cache();
    await check(harness, built("Alpha", alpha, 1));
    const before = harness.cache.reading();
    await harness.cache.cycle();
    harness.agent.write(harness.agent.last_run("--store")!, line("Alpha", "target", alpha));
    await harness.cache.cycle();
    expect(harness.cache.reading()).toEqual(before);
    expect(harness.cache.running_job()?.progress).toBe("1 of 3 targets evaluated");
  });

  it("are unavailable when they report nothing, or could not start", async () => {
    const silent = make_cache();
    await check(silent, "", 1);
    expect(silent.cache.reading()?.status).toBe("unavailable");

    const offline = make_cache();
    offline.agent.start_error = new AgentError("No agent named 'builder' is connected", true);
    await offline.cache.cycle();
    expect(offline.cache.reading()?.messages[0].text).toContain("Could not start the check");
    expect(offline.cache.running_job()).toBeNull();
  });

  it("name a timeout and keep what was reported", async () => {
    const harness = make_cache();
    await check(harness, built("Alpha", alpha, 1), 124);
    expect(harness.store.jobs({ include_evaluations: true })[0]).toMatchObject({ state: "failed", error: "Timed out after 30 minutes" });
    expect(harness.cache.reading()?.messages.at(-1)?.text).toBe("The check ended badly: Timed out after 30 minutes");
  });

  it("keep running when the host does not answer a poll", async () => {
    const harness = make_cache();
    await harness.cache.cycle();
    harness.agent.poll_error = new AgentError("No agent named 'host' is connected", true);
    await harness.cache.cycle();
    expect(harness.cache.running_job()).not.toBeNull();
  });
});

// ── Actions ──────────────────────────────────────────────────────────────────

describe("actions", () => {
  async function checked(values: Record<string, unknown> = {}, alpha_built = true): Promise<Harness> {
    const harness = make_cache(values);
    const alpha_lines = alpha_built ? built("Alpha", alpha, 1, [alpha]) : line("Alpha", "target", alpha) + line("Alpha", "built", 0) + line("Alpha", "own", 1);
    await check(harness, alpha_lines + built("Beta", beta, 3) + metadata);
    return harness;
  }

  it("build a target as a job", async () => {
    const harness = await checked();
    const outcome = await harness.cache.act("build", "Alpha");
    expect(outcome).toMatchObject({ ok: true, message: "Build of Alpha started" });
    expect(harness.cache.running_job()?.kind).toBe("build-target");
    expect(harness.store.jobs()[0].command).toContain("--print-out-paths");
  });

  it("refuse an untracked target, a second job, and a push with nothing to push", async () => {
    const harness = await checked();
    expect((await harness.cache.act("build", "Gamma")).message).toContain("not a tracked target");
    expect((await harness.cache.act("push", "Alpha")).message).toContain("No push_command");

    const unbuilt = await checked({ push_command: "attic push fleet" }, false);
    expect((await unbuilt.cache.act("push", "Alpha")).message).toContain("not built");

    await harness.cache.act("build", "Alpha");
    expect((await harness.cache.act("build", "Beta")).message).toContain("already running");
  });

  it("push the row's store path", async () => {
    const harness = await checked({ push_command: "attic push fleet" });
    expect((await harness.cache.act("push", "Alpha")).ok).toBe(true);
    expect(harness.cache.running_job()?.command).toContain("attic push fleet");
    expect(harness.cache.running_job()?.command).toContain(alpha);
  });

  it("update only their own row once they finish", async () => {
    const harness = await checked({ push_command: "attic push fleet" });
    await harness.cache.act("push", "Alpha");
    harness.agent.end(harness.agent.last_run("attic push")!, `pushing...\n${built("Alpha", alpha, 1)}`, 0);
    await harness.cache.cycle();
    expect(rows(harness).Alpha.pushed).toBe("All 1");
    expect(rows(harness).Beta.pushed).toBe("All 3");
    expect(harness.cache.reading()?.revision).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(harness.store.events("fleet").map((event) => event.message)).toContain("Push of Alpha finished");
    expect(harness.store.jobs()[0].progress).toBe("pushing...");
  });

  it("keep the reading when a failed build reported nothing", async () => {
    const harness = await checked();
    const before = harness.cache.reading();
    await harness.cache.act("build", "Alpha");
    harness.agent.end(harness.agent.last_run("--print-out-paths")!, "error: build failed\n", 1);
    await harness.cache.cycle();
    expect(harness.cache.reading()).toEqual(before);
    expect(harness.store.events("fleet")[0].message).toBe("Build failed: Exited with status 1");
  });
});

// ── Cache server ─────────────────────────────────────────────────────────────

describe("cache server", () => {
  const endpoints = { health_url: "https://cache.example/health", metrics_url: "https://cache.example/metrics", size_metric: "attic_storage_bytes" };
  const metrics_text = [
    "# HELP attic_storage_bytes Bytes stored.",
    "# TYPE attic_storage_bytes gauge",
    'attic_storage_bytes{backend="local"} 1024',
    'attic_storage_bytes{backend="s3"} 2048',
    "http_requests_total 17",
    "garbage line",
  ].join("\n");

  it("reads nix-cache-info beside an http cache by default, and nothing for another store", () => {
    expect(settings().info_url).toBe("https://cache.example/fleet/nix-cache-info");
    expect(settings({ cache_url: "https://cache.example/fleet/" }).info_url).toBe("https://cache.example/fleet/nix-cache-info");
    expect(settings({ cache_url: "ssh://builder" }).info_url).toBeNull();
    expect(settings({ info_url: false }).info_url).toBeNull();
  });

  it("parses Prometheus samples, skipping comments and unreadable lines", () => {
    expect(parse_metrics(metrics_text)).toEqual([
      { name: 'attic_storage_bytes{backend="local"}', value: 1024 },
      { name: 'attic_storage_bytes{backend="s3"}', value: 2048 },
      { name: "http_requests_total", value: 17 },
    ]);
  });

  it("is online with its info, health and size", async () => {
    const harness = make_cache(endpoints);
    harness.answers.set("https://cache.example/health", [200, "OK"]);
    harness.answers.set("https://cache.example/metrics", [200, metrics_text]);

    await harness.cache.cycle();

    const server = harness.cache.server_reading()!;
    expect(server).toMatchObject({ status: "online", healthy: true, size_bytes: 3072, info: { StoreDir: "/nix/store", Priority: "41" } });
    expect(server.metrics.map((sample) => sample.name)).toEqual(['attic_storage_bytes{backend="local"}', 'attic_storage_bytes{backend="s3"}']);
  });

  it("raises server_status when unhealthy or unreachable, and notes the change", async () => {
    const harness = make_cache({ ...endpoints, server_status: "failed" });
    harness.answers.set("https://cache.example/health", [200, "OK"]);
    harness.answers.set("https://cache.example/metrics", [200, metrics_text]);
    await harness.cache.cycle();
    harness.answers.set("https://cache.example/health", [503, "database down"]);

    await harness.cache.cycle();

    expect(harness.cache.server_reading()).toMatchObject({ status: "failed", healthy: false });
    expect(harness.store.events("fleet")[0].message).toBe("Cache server now failed: Not healthy: https://cache.example/health answered 503: database down");
  });

  it("is unavailable when nix-cache-info cannot be read, and is left alone with no endpoints", async () => {
    const unreachable = await probe_cache_server(settings({ cache_url: "https://elsewhere.example" }), fake_fetch(new Map()), clock.now);
    expect(unreachable?.messages[0].text).toContain("Could not reach https://elsewhere.example/nix-cache-info");
    expect(unreachable?.status).toBe("warning");
    expect(await probe_cache_server(settings({ info_url: false }), fake_fetch(new Map()), clock.now)).toBeNull();
  });
});

// ── Config ───────────────────────────────────────────────────────────────────

describe("config", () => {
  it("needs a cache_url and something to track", () => {
    expect(() => cache_settings({ id: "c", configurations: ["A"] })).toThrow(ConfigError);
    expect(() => cache_settings({ id: "c", cache_url: "https://c" })).toThrow(ConfigError);
  });

  it("shares one id space with deployments", () => {
    expect(() => parse_config({ deployments: [{ id: "fleet" }], caches: [base] })).toThrow("Two deployments or caches");
  });
});
