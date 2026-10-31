import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { start_agent, type RunningAgent } from "../src/agent/agent.ts";
import { LongRuns } from "../src/agent/long_runs.ts";
import { parse_ls_remote, parse_pull_settings, pull_switch_command, Puller, PullConfigError, type PullSettings } from "../src/agent/pull.ts";
import { AgentPool } from "../src/server/agents/agent.ts";
import { AgentHub } from "../src/server/agents/hub.ts";
import { LocalAgent } from "../src/server/agents/local.ts";
import { register_agent_route } from "../src/server/agents/route.ts";
import { record_pulls } from "../src/server/pull_reports.ts";
import type { PullReport, RunResult } from "../src/shared/agent_protocol.ts";
import { clock, make_deployment, result } from "./fake_agent.ts";

const first_revision = "1".repeat(40);
const second_revision = "2".repeat(40);

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// ── Settings ─────────────────────────────────────────────────────────────────

describe("pull settings", () => {
  it("fill in their defaults, with the host's own name as the configuration", () => {
    expect(parse_pull_settings({ remotes: ["https://git.example/config"] }, "odin")).toEqual({
      remotes: [{ url: "https://git.example/config", branch: "main" }], after: 900, interval: 300, configuration: "odin", rebuild_bin: "nixos-rebuild",
      rebuild_args: [], require_sudo: true, git_bin: "git",
    });
  });

  it("refuse no remotes, a remote that is not a URL, or a branch that is not a name", () => {
    expect(() => parse_pull_settings({ remotes: [] }, "odin")).toThrow(PullConfigError);
    expect(() => parse_pull_settings({ remotes: [{ url: "git@github.com:owner/config.git" }] }, "odin")).toThrow(/https:\/\//);
    expect(() => parse_pull_settings({ remotes: [{ url: "https://git.example/config", branch: "--evil" }] }, "odin")).toThrow(PullConfigError);
    expect(() => parse_pull_settings({ remotes: ["https://git.example/config"], after: "soon" }, "odin")).toThrow(PullConfigError);
  });

  it("switch to the branch fixed at the revision, and read the head ls-remote prints", () => {
    const settings = parse_pull_settings({ remotes: ["https://git.example/config"], rebuild_args: ["--option", "x y"] }, "odin");
    expect(pull_switch_command(settings, settings.remotes[0], first_revision)).toBe(
      `sudo -n nixos-rebuild switch --flake 'git+https://git.example/config?ref=refs%2Fheads%2Fmain&rev=${first_revision}#odin' --option 'x y'`,
    );
    expect(parse_ls_remote(`${first_revision}\trefs/heads/main\n`, "main")).toBe(first_revision);
    expect(parse_ls_remote(`${first_revision}\trefs/heads/mainline\n`, "main")).toBeNull();
  });
});

// ── Puller ───────────────────────────────────────────────────────────────────

describe("pull mode", () => {
  // A puller whose remotes answer what the test sets, and whose switch only prints its arguments.
  function make_puller(after = "0s") {
    const folder = mkdtempSync(join(tmpdir(), "x-nix-pull-"));
    const runs = new LongRuns(folder, { tail_interval_in_milliseconds: 10 });
    const settings: PullSettings = parse_pull_settings({
      remotes: ["https://primary.example/config", { url: "https://mirror.example/config", branch: "main" }], after, rebuild_bin: "echo", require_sudo: false,
    }, "odin");
    const remote_answers = new Map<string, RunResult>();
    const asked: string[] = [];
    const state = { connected: false, reports: 0, now: 1_000_000 };
    const lines: string[] = [];
    const puller = new Puller(settings, runs, folder, {
      connected: () => state.connected,
      report: () => state.reports++,
      log: (line) => lines.push(line),
      now: () => state.now,
      run: async (command) => {
        asked.push(command);
        return [...remote_answers].find(([host]) => command.includes(host))?.[1] ?? result(128, "", "fatal: unable to access");
      },
    });
    const head = (host: string, revision: string) => remote_answers.set(host, result(0, `${revision}\trefs/heads/main\n`));
    return { puller, runs, folder, head, asked, state, lines };
  }

  async function settle(runs: LongRuns): Promise<void> {
    while (runs.list().some((run) => run.state === "running")) await sleep(20);
  }

  it("notes the first revision, switches to a later one, and falls back to the next remote", async () => {
    const { puller, runs, head, asked, lines } = make_puller();
    head("mirror.example", first_revision);

    await puller.tick();
    expect(runs.list()).toEqual([]);
    expect(puller.revision()).toBe(first_revision);
    expect(asked.map((command) => command.includes("primary.example"))).toEqual([true, false]);

    head("primary.example", second_revision);
    await puller.tick();
    expect(runs.list()).toHaveLength(1);
    expect(puller.revision()).toBe(second_revision);
    expect(lines.at(-1)).toContain("unreachable");

    await settle(runs);
    await puller.tick();
    const [report] = await puller.pending();
    expect(report).toMatchObject({ revision: second_revision, branch: "main", remote: "https://primary.example/config", exit_code: 0 });
    expect(report.output).toContain(`rev=${second_revision}#odin`);
  });

  it("waits while the server is connected or only briefly gone", async () => {
    const { puller, runs, head, state } = make_puller("15m");
    head("primary.example", first_revision);
    await puller.tick();
    expect(puller.revision()).toBeNull();

    state.connected = true;
    state.now += 3600_000;
    await puller.tick();
    state.connected = false;
    await puller.tick();
    expect(puller.revision()).toBeNull();

    state.now += 900_000;
    await puller.tick();
    expect(puller.revision()).toBe(first_revision);
    expect(runs.list()).toEqual([]);
  });

  it("forgets a switch once the server has received its report", async () => {
    const { puller, runs, head, folder } = make_puller();
    head("primary.example", first_revision);
    await puller.tick();
    head("primary.example", second_revision);
    await puller.tick();
    await settle(runs);
    await puller.tick();
    const [report] = await puller.pending();

    puller.acknowledge([report.run_id]);

    expect(await puller.pending()).toEqual([]);
    expect(runs.list()).toEqual([]);
    expect(JSON.parse(readFileSync(join(folder, "pull.json"), "utf8")).revision).toBe(second_revision);
  });
});

// ── Reports ──────────────────────────────────────────────────────────────────

describe("a pull report", () => {
  const report: PullReport = {
    run_id: "pull-1-abc", remote: "https://git.example/config", branch: "main", revision: second_revision, command: "nixos-rebuild switch",
    started_epoch: clock.now - 600, finished_epoch: clock.now - 300, exit_code: 0, output: "activating the configuration...\n",
  };

  it("joins the job history of the host's deployments once, and asks for a fresh evaluation", () => {
    const harness = make_deployment({ host: "odin" });
    const elsewhere = make_deployment({ id: "elsewhere", host: "thor" }, { store: harness.store });

    const kept = record_pulls(harness.store, [harness.deployment, elsewhere.deployment], "odin", [report, { nonsense: true }], clock.now);
    record_pulls(harness.store, [harness.deployment], "odin", [report], clock.now);

    expect(kept).toEqual(["pull-1-abc"]);
    const jobs = harness.store.jobs({ deployment_id: "host-deploy" });
    expect(jobs.map((job) => [job.kind, job.trigger, job.state, job.agent])).toEqual([["switch", "agent pull", "succeeded", "odin"]]);
    expect(harness.store.job(jobs[0].id)!.output).toContain("activating");
    expect(harness.store.jobs({ deployment_id: "elsewhere" })).toEqual([]);
    expect(harness.store.events("host-deploy")[0].message).toContain("While X-Nix was unreachable, the agent switched to 222222222222 of main");
    expect(harness.deployment.due_for_evaluation()).toBe(true);
  });

  it("records a failed switch as failed", () => {
    const harness = make_deployment({ host: "odin" });
    record_pulls(harness.store, [harness.deployment], "odin", [{ ...report, exit_code: 1 }], clock.now);
    expect(harness.store.jobs({ deployment_id: "host-deploy" })[0]).toMatchObject({ state: "failed", error: "Exited with status 1" });
  });
});

// ── Over the agent's socket ──────────────────────────────────────────────────

describe("a reconnecting agent", () => {
  let app: FastifyInstance | null = null;
  let agent: RunningAgent | null = null;

  afterEach(async () => {
    await agent?.stop();
    await app?.close();
    agent = null;
    app = null;
  });

  it("reports the switches it ran on its own, and drops each the server kept", async () => {
    const folder = mkdtempSync(join(tmpdir(), "x-nix-pull-agent-"));
    const key_file = join(folder, "odin");
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "x-nix-agent-odin", "-f", key_file], { stdio: "ignore" });
    const state_directory = join(folder, "agent");
    // A switch an earlier run of the agent finished while the server was away.
    const runs = new LongRuns(state_directory);
    runs.start("pull-1-abc", "echo switched", null);
    while (runs.get("pull-1-abc").state === "running") await sleep(20);
    writeFileSync(join(state_directory, "pull.json"), JSON.stringify({
      revision: second_revision,
      records: [{ run_id: "pull-1-abc", remote: "https://git.example/config", branch: "main", revision: second_revision, command: "echo switched", started_epoch: 1, finished_epoch: 2, exit_code: 0 }],
    }));

    const hub = new AgentHub(new AgentPool("heimdall", new LocalAgent(join(folder, "local"))));
    hub.set_agent_keys(new Map([["odin", readFileSync(`${key_file}.pub`, "utf8").trim()]]));
    const received: PullReport[] = [];
    hub.on_pulls = (host, pulls) => {
      received.push(...pulls.map((pull) => ({ ...pull, remote: `${host}:${pull.remote}` })));
      return pulls.map((pull) => pull.run_id);
    };
    app = fastify();
    await register_agent_route(app, hub);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    const url = `ws://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}/api/agent`;

    agent = start_agent({
      url, key_file, state_directory, host: "odin", agent_version: "test", log: () => {},
      pull: parse_pull_settings({ remotes: ["https://git.example/config"], interval: "1h" }, "odin"),
    });
    for (let tries = 0; tries < 100 && (received.length === 0 || JSON.parse(readFileSync(join(state_directory, "pull.json"), "utf8")).records.length > 0); tries++) await sleep(20);

    expect(received).toMatchObject([{ run_id: "pull-1-abc", remote: "odin:https://git.example/config", exit_code: 0, output: "switched\n" }]);
    expect(JSON.parse(readFileSync(join(state_directory, "pull.json"), "utf8")).records).toEqual([]);
  });
});
