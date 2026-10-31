import { describe, expect, it } from "vitest";

import { ConfigError, deployment_settings, fleet_settings, parse_config } from "../src/server/config.ts";
import { Fleet, selector_matches, type FleetRun } from "../src/server/fleet.ts";
import { pinned_flake } from "../src/server/nixos/flake.ts";
import { Store } from "../src/server/store.ts";
import { clock, collect, current_closure, FakeAgent, make_deployment, result, type Harness } from "./fake_agent.ts";

const commit = "0123456789abcdef0123456789abcdef01234567";

// Deployments sharing one store and agent, each with its own settings.
function make_fleet(entries: Record<string, unknown>[], settings: Record<string, unknown> = {}): { fleet: Fleet; harnesses: Map<string, Harness>; store: Store; agent: FakeAgent } {
  const store = new Store(":memory:");
  const agent = new FakeAgent();
  const harnesses = new Map(entries.map((entry) => {
    const harness = make_deployment(entry, { store, agent });
    return [harness.deployment.id, harness];
  }));
  const deployments = new Map([...harnesses].map(([id, harness]) => [id, harness.deployment]));
  const fleet = new Fleet(deployments, { store, settings: fleet_settings(settings), now: () => clock.now });
  return { fleet, harnesses, store, agent };
}

// The newest long run a deployment started for a kind of job.
function run_of(agent: FakeAgent, id: string, kind = "switch") {
  return agent.runs.filter((run) => run.run_id.startsWith(`${id}-${kind}-`)).pop();
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
    expect(parse_config({}).fleet).toEqual({ parallel: 4, stages: [], sync_timeout: 1800 });
    expect(parse_config({ fleet: { parallel: 2, stages: ["@canary", "web-*"], sync_timeout: "10m" } }).fleet).toEqual({ parallel: 2, stages: ["@canary", "web-*"], sync_timeout: 600 });
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
    expect(harness.agent.last_run("build")!.command).toContain('"github:owner/config#nixosConfigurations');

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
    const { fleet, harnesses, agent } = make_fleet([{ id: "web-1" }, { id: "web-2" }, { id: "web-3" }, { id: "db-1" }]);

    const outcome = await fleet.start({ action: "build", selector: "web-*", parallel: 2 });

    expect(outcome.ok).toBe(true);
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
