import { describe, expect, it } from "vitest";

import { AgentPool } from "../src/server/agents/agent.ts";
import { flake_settings } from "../src/server/config.ts";
import { Flake } from "../src/server/flake.ts";
import { Store } from "../src/server/store.ts";
import { clock, FakeAgent, metadata, result, shown_command } from "./fake_agent.ts";

// ── Setup ────────────────────────────────────────────────────────────────────

function make_flake(values: Record<string, unknown> = {}) {
  const store = new Store(":memory:");
  const agent = new FakeAgent();
  agent.answers.push(["flake metadata", metadata({ inputs: { nixpkgs: clock.now - 86400, home: clock.now - 3 * 86400 } })]);
  const updated: string[] = [];
  const flake = new Flake(flake_settings({ id: "config", url: "/etc/nixos", ...values }), {
    store, agents: new AgentPool("host", agent), now: () => clock.now, on_updated: (changed) => updated.push(changed.id),
  });
  return { flake, agent, store, updated };
}

// Moves the handled update slot some days back, as if its slots since had passed unrun.
function rewind_update(flake: Flake, store: Store, days = 1): void {
  const state = flake.state();
  store.save_evaluation(flake.id, { ...state, scheduled_update: state.scheduled_update! - days * 86400 });
}

// ── Reading ──────────────────────────────────────────────────────────────────

describe("a flake", () => {
  it("reads its revision and each locked input", async () => {
    const { flake } = make_flake();

    await flake.cycle();

    const reading = flake.reading()!;
    expect(reading.status).toBe("online");
    expect(reading.revision).toBe("f".repeat(40));
    expect(reading.inputs.map((input) => [input.name, input.last_modified_epoch])).toEqual([["nixpkgs", clock.now - 86400], ["home", clock.now - 3 * 86400]]);
    expect(reading.oldest_input).toBe("home");
  });

  it("warns about stale inputs only when max_input_age is set", async () => {
    const limited = make_flake({ max_input_age: "2d" });
    await limited.flake.cycle();
    expect(limited.flake.reading()?.status).toBe("warning");

    const unlimited = make_flake();
    await unlimited.flake.cycle();
    expect(unlimited.flake.reading()?.status).toBe("online");
  });

  it("keeps what it last read when a read fails", async () => {
    const { flake, agent } = make_flake();
    await flake.cycle();
    agent.answers.unshift(["flake metadata", result(1, "", "error: unable to download")]);

    await flake.cycle();

    expect(flake.reading()).toMatchObject({ status: "unavailable", revision: "f".repeat(40), metadata_error: "error: unable to download" });
  });
});

// ── Update ───────────────────────────────────────────────────────────────────

describe("the update", () => {
  it("writes a local checkout's lock, then has everything naming the flake evaluate", async () => {
    const { flake, agent, updated } = make_flake();

    const outcome = await flake.update();
    expect(outcome.ok).toBe(true);
    expect(shown_command(flake.running_job()?.command ?? "")).toContain("sudo -n nix --extra-experimental-features 'nix-command flakes' flake update --flake /etc/nixos");
    agent.end(agent.last_run("flake update")!, "• Updated input 'nixpkgs'\n", 0);
    await flake.cycle();

    expect(flake.running_job()).toBeNull();
    expect(flake.state().last_update).toMatchObject({ succeeded: true, summary: "• Updated input 'nixpkgs'" });
    expect(updated).toEqual(["config"]);
  });

  it("pushes a github: flake back with its key, and refuses one without", async () => {
    const keyed = make_flake({ url: "github:owner/config", push_ssh_key: "/var/lib/x-nix/deploy_key" });
    expect((await keyed.flake.update()).ok).toBe(true);
    expect(JSON.parse(keyed.flake.running_job()!.command)).toMatchObject({ kind: "github_update", ssh_url: "git@github.com:owner/config.git" });

    const keyless = make_flake({ url: "github:owner/config" });
    const refused = await keyless.flake.update();
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain("push_ssh_key");
  });

  it("warns once it has failed, and tells nothing to evaluate", async () => {
    const { flake, agent, updated } = make_flake();
    await flake.update();
    agent.end(agent.last_run("flake update")!, "error: cannot write lock\n", 1);

    await flake.cycle();

    expect(flake.reading()?.status).toBe("warning");
    expect(flake.reading()?.messages.some((message) => message.text.startsWith("The last update failed"))).toBe(true);
    expect(updated).toEqual([]);
  });
});

// ── Daily update ─────────────────────────────────────────────────────────────

describe("the daily update", () => {
  it("never starts as soon as it is set, and starts once its slot has passed", async () => {
    const { flake, store } = make_flake({ update_at: "02:00" });
    await flake.cycle();
    expect(flake.running_job()).toBeNull();

    rewind_update(flake, store);
    await flake.cycle();

    expect(flake.running_job()).toMatchObject({ kind: "update", trigger: "schedule" });
    expect(flake.update_due()).toBeNull();
  });

  it("never runs on a flake X-Nix cannot write, and says so", async () => {
    const { flake } = make_flake({ url: "github:owner/config", update_at: "02:00" });

    await flake.cycle();

    expect(flake.update_due()).toBeNull();
    expect(flake.reading()?.status).toBe("warning");
    expect(flake.reading()?.messages.some((message) => message.text.includes("Scheduled update never runs"))).toBe(true);
  });
});
