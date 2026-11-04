import { describe, expect, it } from "vitest";

import { AgentError, AgentPool } from "../src/server/agents/agent.ts";
import { Cache } from "../src/server/cache.ts";
import { parse_metrics, probe_cache_server, type Fetcher } from "../src/server/cache_server.ts";
import { ConfigError, cache_settings, parse_config, type CacheSettings } from "../src/server/config.ts";
import { build_all_expression, build_all_operation, build_operation, check_operation, parse_report, push_operation, report_mark } from "../src/server/nixos/attic.ts";
import type { CacheCheckOperation } from "../src/shared/operations.ts";
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

// A report line, as the operations print them.
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
  agents: AgentPool;
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
  const agents = new AgentPool("host", agent);
  const cache = new Cache(settings(values), { store, agents, now: () => clock.now, fetch: fake_fetch(answers) });
  return { cache, agent, agents, store, answers };
}

// Launches a check and ends it with this output.
async function check(harness: Harness, output: string, exit_code: number | null = 0): Promise<void> {
  await harness.cache.cycle();
  harness.agent.end(harness.agent.last_run("cache_check")!, output, exit_code);
  await harness.cache.cycle();
}

function rows(harness: Harness) {
  return Object.fromEntries(harness.cache.reading()!.rows.map((row) => [row.name, row]));
}

// ── Operations ───────────────────────────────────────────────────────────────

describe("check operation", () => {
  it("checks every target against the cache, refreshing a remote flake, under the timeout", () => {
    const timed = check_operation(settings());
    expect(timed).toMatchObject({ kind: "timed", seconds: 1800 });
    const check = (timed as { operation: CacheCheckOperation }).operation;
    expect(check.kind).toBe("cache_check");
    expect(check.cache).toMatchObject({ cache_url: "https://cache.example/fleet", refresh: true, flake: "github:owner/fleet" });
    expect(check.targets.map((target) => [target.name, target.installable])).toEqual([
      ["Alpha", 'github:owner/fleet#nixosConfigurations."Alpha".config.system.build.toplevel'],
      ["Beta", 'github:owner/fleet#nixosConfigurations."Beta".config.system.build.toplevel'],
      ["kernel", "github:owner/fleet#packages.aarch64-linux.kernel"],
    ]);
    const local = (check_operation(settings({ flake: "/etc/nixos" })) as { operation: CacheCheckOperation }).operation;
    expect(local.cache.refresh).toBe(false);
  });

  it("passes the upstream keys whose paths are left out", () => {
    const check = (check_operation(settings({ upstream_keys: ["cache.nixos.org-1", "other-1"] })) as { operation: CacheCheckOperation }).operation;
    expect(check.cache.upstream_keys).toEqual(["cache.nixos.org-1", "other-1"]);
  });

  it("passes a root and list only for targets named in drop_pushed", () => {
    const check = (check_operation(settings({ build_root_dir: "/roots", drop_pushed: ["Alpha"], build_links: { Alpha: "alpha-deploy" } })) as { operation: CacheCheckOperation }).operation;
    expect(check.targets[0]).toMatchObject({ name: "Alpha", link: "/roots/alpha-deploy", list: "/roots/alpha-deploy.closure" });
    expect(check.targets[1]).toMatchObject({ name: "Beta", link: "/roots/fleet-Beta", list: null });
  });
});

describe("build and push operations", () => {
  it("build from the latest flake, rooted under its link", () => {
    const build = build_operation(settings(), "Alpha");
    expect(build).toMatchObject({ kind: "cache_build", target: { installable: 'github:owner/fleet#nixosConfigurations."Alpha".config.system.build.toplevel', link: null } });
    expect(build.cache).toMatchObject({ build_args: ["--keep-going", "--print-build-logs"], refresh: true });
    const rooted = settings({ build_root_dir: "/roots/", build_links: { Alpha: "alpha-deploy" } });
    expect(build_operation(rooted, "Alpha").target.link).toBe("/roots/alpha-deploy");
    expect(build_operation(rooted, "Beta").target.link).toBe("/roots/fleet-Beta");
  });

  it("push the row's store path with push_command", () => {
    expect(push_operation(settings({ push_command: "attic push fleet" }), "Alpha", alpha)).toMatchObject({
      kind: "cache_push", path: alpha, cache: { push_command: "attic push fleet" }, target: { name: "Alpha" },
    });
  });
});

// ── Build all ────────────────────────────────────────────────────────────────

describe("build all", () => {
  it("evaluates every target in one expression keyed by position", () => {
    expect(build_all_expression(settings({ flake: 'github:o/f"x' }))).toBe(
      'let flake = builtins.getFlake "github:o/f\\"x"; in { t0 = flake.nixosConfigurations."Alpha".config.system.build.toplevel; '
      + 't1 = flake.nixosConfigurations."Beta".config.system.build.toplevel; t2 = flake.packages.aarch64-linux.kernel; }');
  });

  it("names nix-eval-jobs and every target in the order of the expression", () => {
    const operation = build_all_operation(settings({ eval_jobs_bin: "/bin/nix-eval-jobs" }));
    expect(operation).toMatchObject({ kind: "cache_build_all", eval_jobs: "/bin/nix-eval-jobs", eval_workers: 4 });
    expect(operation.targets.map((target) => target.name)).toEqual(["Alpha", "Beta", "kernel"]);
    expect(operation.expression).toBe(build_all_expression(settings()));
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
    expect(harness.store.builds({ owner_id: "fleet" }).map((build) => [build.target, build.succeeded, build.store_path])).toEqual([["Beta", false, null], ["Alpha", true, alpha]]);

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
    expect(rows(harness).Beta.built).toBe(true);
  });

  it("run on the most preferred of their hosts that is connected", async () => {
    const harness = make_cache({ host: ["odin", "host"] });
    await harness.cache.cycle();
    expect(harness.store.jobs({ include_evaluations: true })[0].agent).toBe("host");

    harness.agents.add("odin", new FakeAgent());
    expect(harness.cache.host()).toBe("odin");
  });

  it("count a target another host built and pushed as kept only in the cache", async () => {
    const harness = make_cache({ configurations: ["Alpha"], installables: {} });
    await check(harness, line("Alpha", "target", alpha) + line("Alpha", "built", 0) + line("Alpha", "own", 1));
    expect(harness.cache.reading()?.status).toBe("online");
    expect(rows(harness).Alpha).toMatchObject({ built: true, local: false, pushed: "Yes", summary: "Pushed, kept only in the cache" });
  });

  it("take their pending status from pending_status", async () => {
    const harness = make_cache({ configurations: ["Alpha"], installables: {}, pending_status: "failed" });
    await check(harness, line("Alpha", "target", alpha) + line("Alpha", "built", 0) + line("Alpha", "own", 1) + line("Alpha", "missing", alpha));
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
    harness.agent.write(harness.agent.last_run("cache_check")!, line("Alpha", "target", alpha));
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
    const alpha_lines = alpha_built ? built("Alpha", alpha, 1, [alpha]) : line("Alpha", "target", alpha) + line("Alpha", "built", 0) + line("Alpha", "own", 1) + line("Alpha", "missing", alpha);
    await check(harness, alpha_lines + built("Beta", beta, 3) + metadata);
    return harness;
  }

  it("build a target as a job", async () => {
    const harness = await checked();
    const outcome = await harness.cache.act("build", "Alpha");
    expect(outcome).toMatchObject({ ok: true, message: "Build of Alpha started" });
    expect(harness.cache.running_job()?.kind).toBe("build-target");
    expect(harness.store.jobs()[0].command).toContain("cache_build");
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
    harness.agent.end(harness.agent.last_run("cache_build")!, "error: build failed\n", 1);
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

  it("takes one host or a list of them, most preferred first", () => {
    expect(settings().hosts).toEqual([]);
    expect(settings({ host: "odin" }).hosts).toEqual(["odin"]);
    expect(settings({ host: ["odin", "heimdall"] }).hosts).toEqual(["odin", "heimdall"]);
    expect(() => settings({ host: ["odin", 3] })).toThrow("must be a host name or a list of host names");
  });

  it("shares one id space with deployments", () => {
    expect(() => parse_config({ deployments: [{ id: "fleet" }], caches: [base] })).toThrow("Two flakes, deployments or caches");
  });
});

// ── Daily Build all ──────────────────────────────────────────────────────────

describe("the daily Build all", () => {
  it("never starts as soon as it is set, then runs in place of the check once its slot has passed", async () => {
    const harness = make_cache({ build_at: "04:00" });
    await harness.cache.cycle();
    expect(harness.cache.running_job()?.kind).toBe("check");
    harness.agent.end(harness.agent.last_run('"kind":"cache_check"')!, "", 0);
    await harness.cache.cycle();

    const handled = harness.store.evaluation<{ scheduled_build: number }>(harness.cache.id)!.scheduled_build;
    harness.store.save_evaluation(harness.cache.id, { scheduled_build: handled - 86400 });
    await harness.cache.cycle();

    expect(harness.cache.running_job()).toMatchObject({ kind: "build-all", trigger: "schedule" });
    expect(harness.cache.build_due()).toBeNull();
  });
});
