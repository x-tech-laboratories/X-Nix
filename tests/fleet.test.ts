import { describe, expect, it } from "vitest";

import { ConfigError, deployment_settings, fleet_settings, parse_config } from "../src/server/config.ts";
import { Fleet, glob_matches, max_selector_length, max_selector_terms, selector_matches, selector_problem, term_matches, type FleetRun } from "../src/server/fleet.ts";
import { pinned_flake } from "../src/server/nixos/flake.ts";
import { stop_job } from "../src/server/runs.ts";
import { Store } from "../src/server/store.ts";
import { clock, collect, current_closure, cycle, FakeAgent, make_deployment, metadata, result, rewind_drift, rewind_evaluation, type Harness } from "./fake_agent.ts";

const commit = "0123456789abcdef0123456789abcdef01234567";

// Deployments sharing one store and agent, each with its own settings.
function make_fleet(entries: Record<string, unknown>[], settings: Record<string, unknown> = {}): { fleet: Fleet; harnesses: Map<string, Harness>; store: Store; agent: FakeAgent } {
  const store = new Store(":memory:");
  const agent = new FakeAgent();
  // The fleet orders the deployments' automatic switches, as the server wires it.
  let fleet: Fleet | null = null;
  const harnesses = new Map(entries.map((entry) => {
    const harness = make_deployment(entry, { store, agent, auto_switch_hold: (deployment, revision) => fleet!.auto_switch_hold(deployment, revision) });
    return [harness.deployment.id, harness];
  }));
  const deployments = new Map([...harnesses].map(([id, harness]) => [id, harness.deployment]));
  fleet = new Fleet(deployments, { store, settings: fleet_settings(settings), now: () => clock.now });
  return { fleet, harnesses, store, agent };
}

// The newest long run a deployment started for a kind of job.
function run_of(agent: FakeAgent, id: string, kind = "switch") {
  return agent.long_runs.filter((run) => run.run_id.startsWith(`${id}-${kind}-`)).pop();
}

// Ends a deployment's running job and lets its cycle notice.
async function end_job(harness: Harness, agent: FakeAgent, exit_code: number, kind = "switch"): Promise<void> {
  agent.end(run_of(agent, harness.deployment.id, kind)!, "done\n", exit_code);
  await harness.deployment.cycle();
}

function states(run: FleetRun | null): Record<string, string> {
  return Object.fromEntries((run?.hosts ?? []).map((host) => [host.deployment_id, host.state]));
}

// ── Settings ─────────────────────────────────────────────────────────────────

describe("fleet settings", () => {
  it("default to four at once, no stages and a 30 minute sync timeout", () => {
    expect(parse_config({}).fleet).toEqual({ parallel: 4, stages: [], sync_timeout: 1800, soak: 0, approve_stages: false, auto_switch_staged: false });
    expect(parse_config({ fleet: { parallel: 2, stages: ["@canary", "web-*"], sync_timeout: "10m", soak: "15m", approve_stages: true } }).fleet)
      .toEqual({ parallel: 2, stages: ["@canary", "web-*"], sync_timeout: 600, soak: 900, approve_stages: true, auto_switch_staged: true });
    expect(parse_config({ fleet: { stages: ["@canary"], auto_switch_staged: false } }).fleet.auto_switch_staged).toBe(false);
    expect(() => parse_config({ fleet: { parallel: 0 } })).toThrow(ConfigError);
    expect(() => parse_config({ fleet: [] })).toThrow(ConfigError);
  });

  it("read each deployment's tags and pin, refusing a bad tag or a pin its flake cannot take", () => {
    const settings = deployment_settings({ id: "web", flake: "github:owner/config", tags: ["web", "canary"], pin: "v1.2" });
    expect([settings.tags, settings.pin]).toEqual([["web", "canary"], "v1.2"]);
    expect(deployment_settings({ id: "plain" })).toMatchObject({ tags: [], pin: null });
    expect(() => deployment_settings({ id: "web", tags: ["has space"] })).toThrow(ConfigError);
    expect(() => deployment_settings({ id: "web", flake: "path:/etc/nixos", pin: "v1" })).toThrow(/git or forge flake/);
    expect(() => deployment_settings({ id: "web", flake: "github:owner/config", pin: "--upload-pack=evil" })).toThrow(ConfigError);
  });
});

// ── Selectors ────────────────────────────────────────────────────────────────

describe("a selector", () => {
  const web = { id: "web-1", name: "Web one", tags: ["web", "canary"] };

  it("picks by glob on the id or name, or by @tag, any term sufficing", () => {
    expect(selector_matches("web-*", web)).toBe(true);
    expect(selector_matches("Web?one", web)).toBe(true);
    expect(selector_matches("@canary", web)).toBe(true);
    expect(selector_matches("db-* @db", web)).toBe(false);
    expect(selector_matches("db-*, @web", web)).toBe(true);
    expect(selector_matches("web", web)).toBe(false);
  });

  // The regular expression selectors were matched with before the glob matcher, kept to compare against.
  const regular_expression_matches = (term: string, text: string) =>
    new RegExp(`^${term.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")}$`).test(text);

  it("matches every glob exactly as the regular expression it replaced did", () => {
    const globs = ["*", "**", "?", "web-*", "*-1", "w*b*1", "web?1", "Web?one", "WEB-*", "web-1", "web-1*", "*web-1*", "?eb-?", "w?*1", "*?", "a*b*c",
      "web.1", "web+1", "(web)", "[web]", "w|b", "^web", "web$", "\\w", "{1}", "*.*", "web-**1", "*1*1*", "", "é*", "*\u{1F600}"];
    const texts = ["web-1", "web.1", "web+1", "Web one", "web", "", "w", "abc", "aXbXc", "web-11", "(web)", "[web]", "w|b", "^web", "web$", "\\w", "{1}",
      "multi\nline", "carriage\rline", "é-1", "x\u{1F600}", "web-1\n"];
    for (const glob of globs) {
      for (const text of texts) expect([glob, text, glob_matches(glob, text)]).toEqual([glob, text, regular_expression_matches(glob, text)]);
    }
  });

  it("answers at once for a term with many wildcards, and refuses a selector over the limits", () => {
    const started = performance.now();
    for (let round = 0; round < 1000; round++) term_matches(`${"*".repeat(500)}Z`, { id: "a".repeat(200), name: "b".repeat(200), tags: [] });
    expect(glob_matches(`${"*".repeat(500)}Z`, `${"a".repeat(5000)}`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(selector_problem("web-* @canary")).toBeNull();
    expect(selector_problem("*".repeat(max_selector_length + 1))).toContain(`${max_selector_length} characters`);
    expect(selector_problem(Array.from({ length: max_selector_terms + 1 }, (_, index) => `web-${index}`).join(" "))).toContain(`${max_selector_terms} terms`);
  });

  it("over the limits is refused by a fleet run, its stages and the select route's check", async () => {
    const { fleet } = make_fleet([{ id: "web-1", host: "web-1" }]);
    expect(fleet.selector_problem("x".repeat(max_selector_length + 1))).not.toBeNull();
    expect(await fleet.start({ action: "build", selector: "x".repeat(max_selector_length + 1) })).toMatchObject({ ok: false, message: expect.stringContaining("characters") });
    expect(await fleet.start({ action: "build", selector: "web-*", staged: true, stages: ["y".repeat(max_selector_length + 1)] })).toMatchObject({ ok: false });
    expect(await fleet.start({ action: "build", selector: "web-*", staged: true, stages: Array.from({ length: max_selector_terms + 1 }, () => "@canary") }))
      .toMatchObject({ ok: false, message: expect.stringContaining("stages") });
  });
});

// ── Pins ─────────────────────────────────────────────────────────────────────

describe("a pinned flake", () => {
  it("names the commit or tag in the reference each flake type takes", () => {
    expect(pinned_flake("github:owner/config", commit)).toBe(`github:owner/config?rev=${commit}`);
    expect(pinned_flake("github:owner/config/main?dir=hosts", "v1.2")).toBe("github:owner/config?dir=hosts&ref=v1.2");
    expect(pinned_flake("git+https://git.example/config?ref=main", commit)).toBe(`git+https://git.example/config?rev=${commit}&allRefs=1`);
    expect(pinned_flake("git+https://git.example/config", "v2")).toBe("git+https://git.example/config?ref=refs%2Ftags%2Fv2");
    expect(pinned_flake("/etc/nixos", commit)).toBe(`git+file:///etc/nixos?rev=${commit}&allRefs=1`);
    expect(pinned_flake("path:/etc/nixos", commit)).toBeNull();
    expect(pinned_flake("https://example.org/config.tar.gz", commit)).toBeNull();
  });

  it("is what evaluation, build and switch use, until the page follows the head again or resets to the settings' pin", async () => {
    const harness = make_deployment({ flake: "github:owner/config", configuration: "host", pin: "v1" });
    expect(harness.deployment.pin()).toBe("v1");

    expect((await harness.deployment.set_pin(commit)).ok).toBe(true);
    await harness.deployment.act("switch");
    expect(harness.agent.last_run("nixos-rebuild")!.command).toContain(`github:owner/config?rev=${commit}#host`);
    expect(harness.deployment.pin_overridden()).toBe(true);
    harness.agent.end(harness.agent.last_run("nixos-rebuild")!, "", 0);
    await harness.deployment.cycle();

    await harness.deployment.set_pin(null);
    expect(harness.deployment.pin()).toBeNull();
    await harness.deployment.act("build");
    expect(harness.agent.last_run('"kind":"build"')!.operation).toMatchObject({ flake: "github:owner/config", attribute: "host" });

    await harness.deployment.set_pin(null, true);
    expect([harness.deployment.pin(), harness.deployment.pin_overridden()]).toEqual(["v1", false]);
    expect((await harness.deployment.set_pin("not a pin")).ok).toBe(false);
  });

  it("is refused for a flake that cannot be pinned", async () => {
    const harness = make_deployment({ flake: "path:/etc/nixos" });
    expect(await harness.deployment.set_pin(commit)).toMatchObject({ ok: false, message: expect.stringContaining("git or forge flake") });
  });
});

// ── Fleet runs ───────────────────────────────────────────────────────────────

describe("a fleet run", () => {
  it("acts on what the selector picks, no more at once than parallel allows", async () => {
    // Each builds on a machine of its own, since builds on one machine wait for each other.
    const ids = ["web-1", "web-2", "web-3", "db-1"];
    const { fleet, harnesses, agent } = make_fleet(ids.map((id) => ({ id, build_agent: [`${id}-builder`] })));
    for (const id of ids) harnesses.get(id)!.agents.add(`${id}-builder`, agent);

    const outcome = await fleet.start({ action: "build", selector: "web-*", parallel: 2 }, "admin");

    expect(outcome.ok).toBe(true);
    expect(outcome.run!.started_by).toBe("admin");
    expect(states(outcome.run)).toEqual({ "web-1": "running", "web-2": "running", "web-3": "queued" });
    expect(harnesses.get("web-1")!.store.jobs({ deployment_id: "web-1" })[0].trigger).toBe(`fleet #${outcome.run!.id}`);
    await end_job(harnesses.get("web-1")!, agent, 0, "build");
    await fleet.advance();
    expect(states(fleet.run(outcome.run!.id))).toEqual({ "web-1": "succeeded", "web-2": "running", "web-3": "running" });

    await end_job(harnesses.get("web-2")!, agent, 1, "build");
    await end_job(harnesses.get("web-3")!, agent, 0, "build");
    await fleet.advance();
    const run = fleet.run(outcome.run!.id)!;
    expect([run.state, run.message]).toEqual(["failed", "2 succeeded, 1 failed"]);
    expect(run.hosts.find((host) => host.deployment_id === "web-2")!.message).toBe("Exited with status 1");
  });

  it("refuses an unknown action, an empty selection or an unknown id", async () => {
    const { fleet } = make_fleet([{ id: "web-1" }]);
    expect((await fleet.start({ action: "explode", selector: "*" })).ok).toBe(false);
    expect((await fleet.start({ action: "build", selector: "db-*" })).message).toContain("No deployment matches");
    expect((await fleet.start({ action: "build", ids: ["nowhere"] })).message).toContain("nowhere");
    expect((await fleet.start({ action: "build" })).ok).toBe(false);
  });

  it("marks a host whose action is refused as failed, and finishes a reboot at once", async () => {
    const { fleet, harnesses } = make_fleet([{ id: "web-1" }, { id: "web-2" }]);
    await harnesses.get("web-1")!.deployment.act("build");

    const outcome = await fleet.start({ action: "reboot", ids: ["web-1", "web-2"] });

    expect(states(outcome.run)).toEqual({ "web-1": "failed", "web-2": "succeeded" });
    expect(outcome.run!.hosts[0].message).toContain("already running");
    expect(outcome.run!.state).toBe("failed");
  });

  it("carries on after a restart from what the store kept", async () => {
    const { fleet, harnesses, store, agent } = make_fleet([{ id: "web-1" }, { id: "web-2" }], { parallel: 1 });
    const { run } = await fleet.start({ action: "build", selector: "*" });

    const restarted = new Fleet(new Map([...harnesses].map(([id, harness]) => [id, harness.deployment])), { store, settings: fleet_settings({ parallel: 1 }), now: () => clock.now });
    await end_job(harnesses.get("web-1")!, agent, 0, "build");
    await restarted.advance();

    expect(states(restarted.run(run!.id))).toEqual({ "web-1": "succeeded", "web-2": "running" });
  });

  it("skips the hosts not yet started once stopped", async () => {
    const { fleet, harnesses, agent } = make_fleet([{ id: "web-1" }, { id: "web-2" }], { parallel: 1 });
    const { run } = await fleet.start({ action: "build", selector: "*" });

    await fleet.stop(run!.id);
    expect(states(fleet.run(run!.id))).toEqual({ "web-1": "running", "web-2": "skipped" });
    await end_job(harnesses.get("web-1")!, agent, 0, "build");
    await fleet.advance();
    expect(fleet.run(run!.id)!.state).toBe("stopped");
  });

  it("stops the jobs still running when asked, reading their hosts as skipped", async () => {
    const { harnesses, store, agent } = make_fleet([{ id: "web-1" }, { id: "web-2" }, { id: "web-3" }]);
    const deployments = new Map([...harnesses].map(([id, harness]) => [id, harness.deployment]));
    const agents = harnesses.get("web-1")!.agents;
    const fleet = new Fleet(deployments, {
      store, settings: fleet_settings({ parallel: 2 }), now: () => clock.now, stop_job: (job_id, by) => stop_job(store, agents, job_id, by, () => clock.now),
    });
    const { run } = await fleet.start({ action: "build", selector: "*" });

    const outcome = await fleet.stop(run!.id, { jobs: true, by: "admin" });
    for (const harness of harnesses.values()) await harness.deployment.cycle();
    await fleet.advance();

    expect(outcome).toMatchObject({ ok: true, message: `Fleet run #${run!.id} is stopping, with its running jobs` });
    expect(run_of(agent, "web-1", "build")!.stopped).toBe(true);
    expect(run_of(agent, "web-3", "build")).toBeUndefined();
    const stopped = fleet.run(run!.id)!;
    expect(states(stopped)).toEqual({ "web-1": "skipped", "web-2": "skipped", "web-3": "skipped" });
    expect(stopped.hosts[0]!.message).toBe("Stopped by admin");
    expect(stopped.hosts[1]!.message).toBe("admin stopped it before it started");
    expect(stopped.state).toBe("stopped");
  });

  it("has a guarded switch that activated roll back rather than stop, saying so", async () => {
    const { harnesses, store, agent } = make_fleet([{ id: "web-1", magic_rollback: true }]);
    const deployments = new Map([...harnesses].map(([id, harness]) => [id, harness.deployment]));
    const agents = harnesses.get("web-1")!.agents;
    const fleet = new Fleet(deployments, { store, settings: fleet_settings({}), now: () => clock.now, stop_job: (job_id, by) => stop_job(store, agents, job_id, by, () => clock.now) });
    const { run } = await fleet.start({ action: "switch", selector: "*" });
    agent.write(run_of(agent, "web-1")!, "@@x-nix-switch activated\n");
    await harnesses.get("web-1")!.deployment.cycle();

    const outcome = await fleet.stop(run!.id, { jobs: true, by: "admin" });

    expect(outcome.ok).toBe(true);
    expect(outcome.message).toContain("web-1: Job #");
    expect(outcome.message).toContain("watchdog was told to roll back");
    expect(run_of(agent, "web-1")!.stopped).toBe(false);
    expect(agent.operations.some((operation) => operation.kind === "signal_rollback")).toBe(true);
  });

  it("refuses to stop jobs without a way to stop them", async () => {
    const { fleet } = make_fleet([{ id: "web-1" }]);
    const { run } = await fleet.start({ action: "build", selector: "*" });

    expect(await fleet.stop(run!.id, { jobs: true })).toMatchObject({ ok: false, message: "This server cannot stop jobs" });
    expect(fleet.run(run!.id)!.stop_requested).toBe(false);
  });
});

// ── Staged rollouts ──────────────────────────────────────────────────────────

describe("a staged rollout", () => {
  const matching = result(0, `${current_closure}\n`);

  // Ends the host's switch, then lets a later evaluation find it in sync or still drifting.
  async function switch_and_evaluate(harness: Harness, agent: FakeAgent, in_sync: boolean): Promise<void> {
    await end_job(harness, agent, 0);
    clock.now += 10;
    await collect(harness, in_sync ? { evaluation: matching } : {});
  }

  it("switches stage by stage, moving on once each host reads as in sync", async () => {
    const start = clock.now;
    const { fleet, harnesses, agent } = make_fleet([{ id: "web-1", tags: ["web"] }, { id: "canary", tags: ["canary"] }, { id: "db-1" }]);

    const { run } = await fleet.start({ action: "switch", selector: "*", staged: true, stages: ["@canary", "@web"] });
    expect(run!.stages).toEqual(["@canary", "@web", "the rest"]);
    expect(states(run)).toEqual({ "web-1": "queued", canary: "running", "db-1": "queued" });

    await end_job(harnesses.get("canary")!, agent, 0);
    await fleet.advance();
    expect(states(fleet.run(run!.id)).canary).toBe("verifying");

    clock.now += 10;
    await collect(harnesses.get("canary")!, { evaluation: matching });
    await fleet.advance();
    expect(states(fleet.run(run!.id))).toEqual({ "web-1": "running", canary: "succeeded", "db-1": "queued" });

    await switch_and_evaluate(harnesses.get("web-1")!, agent, true);
    await fleet.advance();
    await fleet.advance();
    await switch_and_evaluate(harnesses.get("db-1")!, agent, true);
    await fleet.advance();
    await fleet.advance();
    expect(fleet.run(run!.id)!.state).toBe("succeeded");
    clock.now = start;
  });

  it("stops at the first host still drifting after its switch", async () => {
    const start = clock.now;
    const { fleet, harnesses, agent } = make_fleet([{ id: "canary", tags: ["canary"] }, { id: "web-1" }]);
    const { run } = await fleet.start({ action: "switch", selector: "*", staged: true, stages: ["@canary"] });

    await end_job(harnesses.get("canary")!, agent, 0);
    await fleet.advance();
    clock.now += 10;
    await collect(harnesses.get("canary")!);
    await fleet.advance();

    const ended = fleet.run(run!.id)!;
    expect(states(ended)).toEqual({ canary: "failed", "web-1": "skipped" });
    expect(ended.hosts[0].message).toContain("Still drifting");
    expect(ended.state).toBe("failed");
    expect(run_of(agent, "web-1")).toBeUndefined();
    clock.now = start;
  });

  it("holds the next stage while the last soaks, then until an admin approves it", async () => {
    const start = clock.now;
    const { fleet, harnesses, agent } = make_fleet([{ id: "canary", tags: ["canary"] }, { id: "web-1" }], { soak: "10m", approve_stages: true });
    const { run } = await fleet.start({ action: "switch", selector: "*", staged: true, stages: ["@canary"] });
    expect((await fleet.approve(run!.id)).ok).toBe(false);

    await switch_and_evaluate(harnesses.get("canary")!, agent, true);
    await fleet.advance();
    await fleet.advance();
    expect(states(fleet.run(run!.id))).toEqual({ canary: "succeeded", "web-1": "queued" });
    expect(fleet.run(run!.id)!.message).toContain("soaking for 10 minutes");

    clock.now += 601;
    await fleet.advance();
    expect(states(fleet.run(run!.id))["web-1"]).toBe("queued");
    expect(fleet.run(run!.id)!.message).toBe("Stage 2 waits for approval");

    const approved = await fleet.approve(run!.id, "admin");
    expect(approved.ok).toBe(true);
    expect(states(approved.run)["web-1"]).toBe("running");
    clock.now = start;
  });

  it("stops when a host of the soaking stage drifts again", async () => {
    const start = clock.now;
    const { fleet, harnesses, agent } = make_fleet([{ id: "canary", tags: ["canary"] }, { id: "web-1" }], { soak: "10m" });
    const { run } = await fleet.start({ action: "switch", selector: "*", staged: true, stages: ["@canary"] });
    await switch_and_evaluate(harnesses.get("canary")!, agent, true);
    await fleet.advance();
    await fleet.advance();

    clock.now += 60;
    await collect(harnesses.get("canary")!);
    await fleet.advance();

    const ended = fleet.run(run!.id)!;
    expect(states(ended)).toEqual({ canary: "failed", "web-1": "skipped" });
    expect(ended.hosts[0].message).toContain("Drifted from the flake while its stage soaked");
    expect(run_of(agent, "web-1")).toBeUndefined();
    clock.now = start;
  });

  it("goes one host at a time with no stage selectors, and fails a host that never reads as in sync", async () => {
    const start = clock.now;
    const { fleet, harnesses, agent } = make_fleet([{ id: "first" }, { id: "second" }], { sync_timeout: "1m" });
    const { run } = await fleet.start({ action: "switch", selector: "*", staged: true });
    expect(states(run)).toEqual({ first: "running", second: "queued" });

    await end_job(harnesses.get("first")!, agent, 0);
    await fleet.advance();
    clock.now += 120;
    await fleet.advance();

    expect(fleet.run(run!.id)!.hosts[0].message).toContain("within 1 minute");
    expect(states(fleet.run(run!.id))).toEqual({ first: "failed", second: "skipped" });
    clock.now = start;
  });
});

// ── Staged automatic switches ────────────────────────────────────────────────

describe("staged automatic switches", () => {
  const flake = "github:owner/config";
  const automatic = { flake, auto_switch: true, auto_switch_after: "30m" };
  const other_commit = "89abcdef0123456789abcdef0123456789abcdef";
  // The flake at a commit, changed after the running generation, so switching moves the host forward.
  const at = (revision = commit) => metadata({ revision, last_modified_epoch: clock.now - 3600 });
  const matching = result(0, `${current_closure}\n`);
  const entries = [{ id: "canary", tags: ["canary"], ...automatic }, { id: "server", tags: ["servers"], ...automatic }, { id: "loose", ...automatic }];

  // Has the deployment drift to the flake at a revision for longer than auto_switch_after.
  async function drift(harness: Harness, revision = commit): Promise<void> {
    await collect(harness, { metadata: at(revision) });
    rewind_drift(harness, 1801);
    await cycle(harness);
  }

  // Has the deployment read as in sync at a revision, as after a switch.
  async function in_sync(harness: Harness, revision = commit): Promise<void> {
    await collect(harness, { evaluation: matching, metadata: at(revision) });
  }

  function texts(harness: Harness): string[] {
    return harness.deployment.reading()?.messages.map((message) => message.text) ?? [];
  }

  it("has a later stage wait for the earlier one to switch to the same revision, noting it once", async () => {
    const { harnesses } = make_fleet(entries, { stages: ["@canary", "@servers"] });
    const server = harnesses.get("server")!;

    await drift(server);
    await collect(server);

    expect(server.deployment.running_job()).toBeNull();
    expect(texts(server)).toContain("Not switching automatically: waiting for canary of stage 1 (@canary) to switch to 0123456789ab");
    expect(server.store.events("server").filter((event) => event.message.startsWith("Not switching automatically"))).toHaveLength(1);
  });

  it("switches a later stage once the earlier one runs the revision in sync and has soaked", async () => {
    const { harnesses } = make_fleet(entries, { stages: ["@canary", "@servers"], soak: "15m" });
    const canary = harnesses.get("canary")!;
    const server = harnesses.get("server")!;
    await in_sync(canary);
    await drift(server);

    await collect(server);
    expect(texts(server)).toContain("Not switching automatically: waiting for canary of stage 1 (@canary) to soak at 0123456789ab for 15 minutes more");

    const evaluation = canary.deployment.evaluation();
    canary.store.save_evaluation("canary", { ...evaluation, in_sync: { revision: commit, since_epoch: clock.now - 901 } });
    await collect(server);
    await cycle(server);
    expect(server.deployment.running_job()?.trigger).toBe("automatic");
  });

  it("holds a later stage while the earlier one failed to switch to the revision, until a new revision comes", async () => {
    const { harnesses, agent } = make_fleet(entries, { stages: ["@canary", "@servers"] });
    const canary = harnesses.get("canary")!;
    const server = harnesses.get("server")!;
    await drift(canary);
    await cycle(canary);
    expect(canary.deployment.running_job()?.trigger).toBe("automatic");
    agent.end(run_of(agent, "canary")!, "error: activation failed\n", 1);
    await cycle(canary);
    expect(canary.deployment.evaluation().switch_failure?.revision).toBe(commit);

    await drift(server);
    await collect(server);
    expect(server.deployment.running_job()).toBeNull();
    const held = server.deployment.reading()!.messages.find((message) => message.text.startsWith("Not switching automatically"))!;
    expect(held.level).toBe("warning");
    expect(held.text).toContain("canary of stage 1 (@canary) failed to switch to 0123456789ab");

    rewind_evaluation(server, 7200);
    await drift(server, other_commit);
    expect(texts(server)).toContain("Not switching automatically: waiting for canary of stage 1 (@canary) to switch to 89abcdef0123");
  });

  it("holds a later stage behind an earlier switch that rolled back", async () => {
    const { harnesses, agent } = make_fleet(entries, { stages: ["@canary", "@servers"] });
    const canary = harnesses.get("canary")!;
    const server = harnesses.get("server")!;
    await drift(canary);
    await cycle(canary);
    agent.end(run_of(agent, "canary")!, "@@x-nix-switch outcome rolled-back Health check 1 (curl) failed with status 7\n", 1);
    await cycle(canary);

    await drift(server);
    await collect(server);

    expect(texts(server).find((text) => text.startsWith("Not switching automatically"))).toContain("failed to switch to 0123456789ab: Rolled back to the previous system");
  });

  it("forgets an earlier stage's failure once a switch there succeeds", async () => {
    const { harnesses, agent } = make_fleet(entries, { stages: ["@canary", "@servers"] });
    const canary = harnesses.get("canary")!;
    await drift(canary);
    await cycle(canary);
    agent.end(run_of(agent, "canary")!, "", 1);
    await cycle(canary);

    await canary.deployment.act("switch");
    agent.end(run_of(agent, "canary")!, "done\n", 0);
    await cycle(canary);

    expect(canary.deployment.evaluation().switch_failure).toBeUndefined();
  });

  it("leaves a deployment no stage names, the first stage, and a fleet with auto_switch_staged off to switch as before", async () => {
    for (const [settings, id] of [[{ stages: ["@canary", "@servers"] }, "loose"], [{ stages: ["@canary", "@servers"] }, "canary"], [{ stages: ["@canary", "@servers"], auto_switch_staged: false }, "server"]] as const) {
      const { harnesses } = make_fleet(entries, settings);
      const harness = harnesses.get(id)!;

      await drift(harness);
      await cycle(harness);

      expect(harness.deployment.running_job()?.trigger).toBe("automatic");
    }
  });

  it("waits only on earlier deployments that switch the same flake by themselves", async () => {
    const { harnesses } = make_fleet([
      { id: "canary", tags: ["canary"], flake }, { id: "pinned", tags: ["canary"], ...automatic, pin: commit }, { id: "elsewhere", tags: ["canary"], ...automatic, flake: "github:owner/other" },
      { id: "server", tags: ["servers"], ...automatic },
    ], { stages: ["@canary", "@servers"] });
    const server = harnesses.get("server")!;

    await drift(server);
    await cycle(server);

    expect(server.deployment.running_job()?.trigger).toBe("automatic");
  });
});
