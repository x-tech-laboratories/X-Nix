import { describe, expect, it } from "vitest";

import { AgentPool } from "../src/server/agents/agent.ts";
import { flake_settings } from "../src/server/config.ts";
import { Flake } from "../src/server/flake.ts";
import { Store } from "../src/server/store.ts";
import type { RunResult } from "../src/server/agents/agent.ts";
import { clock, FakeAgent, metadata, result, shown_command } from "./fake_agent.ts";

// ── Setup ────────────────────────────────────────────────────────────────────

// nixpkgs follows a channel branch on GitHub and home a Git remote's default branch.
const originals = {
  nixpkgs: { type: "github", owner: "NixOS", repo: "nixpkgs", ref: "nixos-26.05" },
  home: { type: "git", url: "https://git.example.org/me/home.git" },
};

function make_flake(values: Record<string, unknown> = {}) {
  const store = new Store(":memory:");
  const agent = new FakeAgent();
  agent.answers.push(["flake metadata", metadata({ inputs: { nixpkgs: clock.now - 86400, home: clock.now - 3 * 86400 }, originals })]);
  const updated: string[] = [];
  let passed = 0;
  const flake = new Flake(flake_settings({ id: "config", url: "/etc/nixos", ...values }), {
    store, agents: new AgentPool("host", agent), now: () => clock.now + passed, on_updated: (changed) => updated.push(changed.id),
  });
  // Moves this flake's clock on.
  const pass = (seconds: number) => void (passed += seconds);
  return { flake, agent, store, updated, pass };
}

// What the remote heads read answers when nixpkgs's branch is at the commit and home is where its lock has it.
function heads(nixpkgs: string): RunResult {
  return result(0, JSON.stringify([
    { exit_code: 0, heads: { "refs/heads/nixos-26.05": nixpkgs }, error: "" },
    { exit_code: 0, heads: { HEAD: "0".repeat(40) }, error: "" },
  ]));
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

  it("reads its metadata again only once its interval has passed", async () => {
    const { flake, agent, pass } = make_flake();
    const reads = () => agent.commands.filter((command) => command.includes("flake metadata")).length;
    await flake.cycle();
    await flake.cycle();
    expect(reads()).toBe(1);

    pass(3600);
    await flake.cycle();
    await flake.cycle({ force_eval: true });

    expect(reads()).toBe(3);
  });

  it("keeps what it last read when a read fails", async () => {
    const { flake, agent, pass } = make_flake();
    await flake.cycle();
    agent.answers.unshift(["flake metadata", result(1, "", "error: unable to download")]);
    pass(3600);

    await flake.cycle();

    expect(flake.reading()).toMatchObject({ status: "unavailable", revision: "f".repeat(40), metadata_error: "error: unable to download" });
  });

  it("has everything naming it evaluate once a read finds it changed", async () => {
    const { flake, agent, updated, pass } = make_flake();
    await flake.cycle();
    pass(3600);
    await flake.cycle();
    expect(updated).toEqual([]);

    agent.answers.unshift(["flake metadata", metadata({ revision: "a".repeat(40) })]);
    pass(3600);
    await flake.cycle();

    expect(updated).toEqual(["config"]);
  });
});

// ── Update ───────────────────────────────────────────────────────────────────

describe("the update", () => {
  it("writes a local checkout's lock, then has everything naming the flake evaluate", async () => {
    const { flake, agent, updated } = make_flake();

    const outcome = await flake.update();
    expect(outcome.ok).toBe(true);
    expect(shown_command(flake.running_job()?.command ?? "")).toContain("sudo -n nix --extra-experimental-features 'nix-command flakes' flake update --refresh --flake /etc/nixos");
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

// ── Input check ──────────────────────────────────────────────────────────────

describe("the input check", () => {
  it("asks each input's remote with git ls-remote, every minute by default", async () => {
    const { flake, agent } = make_flake();
    agent.answers.unshift(["remote_heads", heads("0".repeat(40))]);

    await flake.cycle();

    expect(flake.idle_interval()).toBe(60);
    expect(agent.operations.find((operation) => operation.kind === "remote_heads")).toEqual({
      kind: "remote_heads",
      remotes: [
        { url: "https://github.com/NixOS/nixpkgs", refs: ["refs/heads/nixos-26.05", "refs/tags/nixos-26.05", "refs/tags/nixos-26.05^{}"] },
        { url: "https://git.example.org/me/home.git", refs: ["HEAD"] },
      ],
    });
    expect(flake.running_job()).toBeNull();
  });

  it("updates once an input moves upstream, and only once for that commit", async () => {
    const { flake, agent, store } = make_flake();
    agent.answers.unshift(["remote_heads", heads("a".repeat(40))]);

    await flake.cycle();

    expect(flake.running_job()).toMatchObject({ kind: "update", trigger: "input nixpkgs" });
    expect(store.events("config").some((event) => event.message === "nixpkgs moved upstream; updating")).toBe(true);
    agent.end(agent.last_run("flake update")!, "error: cannot write lock\n", 1);
    await flake.cycle();
    await flake.cycle();
    expect(agent.runs).toHaveLength(1);

    agent.answers.unshift(["remote_heads", heads("b".repeat(40))]);
    await flake.cycle();
    expect(agent.runs).toHaveLength(2);
  });

  it("watches only watch_inputs, and nothing with input_check_interval null", async () => {
    const watched = make_flake({ watch_inputs: ["home"] });
    watched.agent.answers.unshift(["remote_heads", heads("a".repeat(40))]);
    await watched.flake.cycle();
    expect(watched.flake.watched_inputs().map((input) => input.name)).toEqual(["home"]);
    expect(watched.flake.running_job()).toBeNull();

    const off = make_flake({ input_check_interval: null });
    await off.flake.cycle();
    expect(off.flake.idle_interval()).toBe(3600);
    expect(off.agent.operations.some((operation) => operation.kind === "remote_heads")).toBe(false);
  });

  it("logs a failing check once", async () => {
    const { flake, agent, store } = make_flake();
    const failing = [{ exit_code: 128, heads: {}, error: "fatal: unable to access" }, { exit_code: 0, heads: {}, error: "" }];
    agent.answers.unshift(["remote_heads", result(0, JSON.stringify(failing))]);

    await flake.cycle();
    await flake.cycle();

    expect(store.events("config").filter((event) => event.message.startsWith("Could not check the inputs"))).toHaveLength(1);
    expect(flake.state().input_check_error).toBe("nixpkgs: fatal: unable to access");
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
