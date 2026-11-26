import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import type { LongRuns } from "@x-tech-laboratories/x-libs/agent/long_runs";
import { LocalAgent } from "@x-tech-laboratories/x-libs/server/agents/local";
import { register_agent_route } from "@x-tech-laboratories/x-libs/server/agents/route";

import { start_agent, type RunningAgent } from "../src/agent/agent.ts";
import {
  ancestry_operation, fetch_operation, parse_ls_remote, parse_pull_settings, pull_switch_operation, Puller, PullConfigError, verify_operation, type PullSettings,
} from "../src/agent/pull.ts";
import { operation_runner, operation_runs } from "../src/agent/tasks.ts";
import { AgentPool } from "../src/server/agents/agent.ts";
import { create_hub } from "../src/server/agents/hub.ts";
import { record_pulls } from "../src/server/pull_reports.ts";
import type { PullReport, RunResult } from "../src/shared/agent_protocol.ts";
import type { Operation } from "../src/shared/operations.ts";
import { clock, make_deployment, result } from "./fake_agent.ts";

const first_revision = "1".repeat(40);
const second_revision = "2".repeat(40);

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// ── Settings ─────────────────────────────────────────────────────────────────

describe("pull settings", () => {
  it("fill in their defaults, with the host's own name as the configuration", () => {
    expect(parse_pull_settings({ remotes: ["https://git.example/config"], allowed_signers: "/etc/x-nix/allowed_signers" }, "odin")).toEqual({
      remotes: [{ url: "https://git.example/config", branch: "main" }], after: 900, interval: 300, configuration: "odin", rebuild_bin: "nixos-rebuild",
      rebuild_args: [], require_sudo: true, git_bin: "git", allowed_signers: "/etc/x-nix/allowed_signers", allow_unsigned: false, allow_rewind: false,
    });
  });

  it("need allowed signers unless unsigned commits are allowed outright", () => {
    expect(() => parse_pull_settings({ remotes: ["https://git.example/config"] }, "odin")).toThrow(/allowed_signers/);
    expect(() => parse_pull_settings({ remotes: ["https://git.example/config"], allowed_signers: "signers" }, "odin")).toThrow(/absolute path/);
    expect(() => parse_pull_settings({ remotes: ["https://git.example/config"], allow_unsigned: "yes" }, "odin")).toThrow(/true or false/);
    expect(parse_pull_settings({ remotes: ["https://git.example/config"], allow_unsigned: true }, "odin")).toMatchObject({ allowed_signers: null, allow_unsigned: true });
  });

  it("take allow_rewind only as true or false", () => {
    expect(parse_pull_settings({ remotes: ["https://git.example/config"], allow_unsigned: true, allow_rewind: true }, "odin")).toMatchObject({ allow_rewind: true });
    expect(() => parse_pull_settings({ remotes: ["https://git.example/config"], allow_unsigned: true, allow_rewind: "yes" }, "odin")).toThrow(/allow_rewind/);
  });

  it("refuse remotes that can be tampered with on the way", () => {
    for (const url of ["http://git.example/config", "git://git.example/config", "git+http://git.example/config"]) {
      expect(() => parse_pull_settings({ remotes: [url], allow_unsigned: true }, "odin")).toThrow(/https:\/\/, ssh:\/\/ or file:\/\//);
    }
  });

  it("fetch the revision with its history into the agent's own repository, and check its ancestry and signature there", () => {
    const settings = parse_pull_settings({ remotes: ["git+https://git.example/config"], allowed_signers: "/etc/signers" }, "odin");
    const repository = "/var/lib/x-nix-agent/pull.git";
    const git = ["git", "-C", repository];
    const fetch = [...git, "-c", "gc.auto=0", "-c", "maintenance.auto=false", "fetch", "--quiet", "--no-tags"];
    expect(fetch_operation(settings, settings.remotes[0], second_revision, repository, false).steps.map((step) => step.argv)).toEqual([
      ["git", "init", "--quiet", "--bare", repository],
      [...fetch, "--", "https://git.example/config", `+${second_revision}:refs/x-nix/pulled`],
    ]);
    expect(fetch_operation(settings, settings.remotes[0], second_revision, repository, true).steps[1].argv).toEqual([...fetch, "--unshallow", "--", "https://git.example/config", `+${second_revision}:refs/x-nix/pulled`]);
    expect(ancestry_operation(settings, repository, first_revision, second_revision).steps.map((step) => step.argv)).toEqual([
      [...git, "merge-base", "--is-ancestor", "--", first_revision, second_revision],
    ]);
    expect(verify_operation(settings, repository, second_revision, "/etc/signers").steps.map((step) => step.argv)).toEqual([
      [...git, "-c", "gpg.ssh.allowedSignersFile=/etc/signers", "verify-commit", "--", second_revision],
    ]);
  });

  it("refuse no remotes, a remote that is not a URL, or a branch that is not a name", () => {
    const unsigned = { allow_unsigned: true };
    expect(() => parse_pull_settings({ remotes: [], ...unsigned }, "odin")).toThrow(PullConfigError);
    expect(() => parse_pull_settings({ remotes: [{ url: "git@github.com:owner/config.git" }], ...unsigned }, "odin")).toThrow(/https:\/\//);
    expect(() => parse_pull_settings({ remotes: [{ url: "https://git.example/config", branch: "--evil" }], ...unsigned }, "odin")).toThrow(PullConfigError);
    expect(() => parse_pull_settings({ remotes: ["https://git.example/config"], after: "soon", ...unsigned }, "odin")).toThrow(PullConfigError);
  });

  it("switch to the branch fixed at the revision, and read the head ls-remote prints", () => {
    const settings = parse_pull_settings({ remotes: ["https://git.example/config"], rebuild_args: ["--option", "x y"], allow_unsigned: true }, "odin");
    expect(pull_switch_operation(settings, settings.remotes[0], first_revision)).toEqual({
      kind: "programs",
      steps: [{ argv: ["sudo", "-n", "nixos-rebuild", "switch", "--flake", `git+https://git.example/config?ref=refs%2Fheads%2Fmain&rev=${first_revision}#odin`, "--no-update-lock-file", "--option", "x y"] }],
    });
    const locked = parse_pull_settings({ remotes: ["https://git.example/config"], rebuild_args: ["--no-update-lock-file"], require_sudo: false, allow_unsigned: true }, "odin");
    expect(pull_switch_operation(locked, locked.remotes[0], first_revision)).toMatchObject({
      steps: [{ argv: ["nixos-rebuild", "switch", "--flake", `git+https://git.example/config?ref=refs%2Fheads%2Fmain&rev=${first_revision}#odin`, "--no-update-lock-file"] }],
    });
    expect(parse_ls_remote(`${first_revision}\trefs/heads/main\n`, "main")).toBe(first_revision);
    expect(parse_ls_remote(`${first_revision}\trefs/heads/mainline\n`, "main")).toBeNull();
  });
});

// ── Puller ───────────────────────────────────────────────────────────────────

describe("pull mode", () => {
  // A puller whose remotes answer what the test sets, whose Git answers each fetch and ancestry check as set, and whose switch only prints its arguments.
  function make_puller(after = "0s", values: Record<string, unknown> = {}) {
    const folder = mkdtempSync(join(tmpdir(), "x-nix-pull-"));
    const runs = operation_runs(folder, { tail_interval_in_milliseconds: 10 });
    const settings: PullSettings = parse_pull_settings({
      remotes: ["https://primary.example/config", { url: "https://mirror.example/config", branch: "main" }], after, rebuild_bin: "echo", require_sudo: false, allow_unsigned: true, ...values,
    }, "odin");
    const remote_answers = new Map<string, RunResult>();
    // The exit code of `merge-base --is-ancestor` for a deployed and a new revision, 0 unless set.
    const ancestry = new Map<string, number>();
    const git = { fetch: result(0) };
    const asked: string[] = [];
    const state = { connected: false, reports: 0, now: 1_000_000 };
    const lines: string[] = [];
    const puller = new Puller(settings, runs, folder, {
      connected: () => state.connected,
      report: () => state.reports++,
      log: (line) => lines.push(line),
      now: () => state.now,
      run: async (operation) => {
        const command = JSON.stringify(operation);
        asked.push(command);
        const argv = operation.kind === "programs" ? operation.steps.flatMap((step) => step.argv) : [];
        if (argv.includes("fetch")) return git.fetch;
        if (argv.includes("merge-base")) return result(ancestry.get(argv.slice(-2).join("..")) ?? 0);
        return [...remote_answers].find(([host]) => command.includes(host))?.[1] ?? result(128, "", "fatal: unable to access");
      },
    });
    const head = (host: string, revision: string) => remote_answers.set(host, result(0, `${revision}\trefs/heads/main\n`));
    const asked_for = (word: string) => asked.filter((command) => command.includes(`"${word}"`)).length;
    return { puller, runs, folder, head, asked, asked_for, ancestry, git, state, lines };
  }

  async function settle(runs: LongRuns<Operation>): Promise<void> {
    while (runs.list().some((run) => run.state === "running")) await sleep(20);
  }

  it("notes the first revision, switches to a later one that descends from it, and falls back to the next remote", async () => {
    const { puller, runs, head, asked, asked_for, lines } = make_puller();
    head("mirror.example", first_revision);

    await puller.tick();
    expect(runs.list()).toEqual([]);
    expect(puller.revision()).toBe(first_revision);
    expect(asked.map((command) => command.includes("primary.example"))).toEqual([true, false]);
    expect(asked_for("fetch")).toBe(0);

    head("primary.example", second_revision);
    await puller.tick();
    expect(runs.list()).toHaveLength(1);
    expect(puller.revision()).toBe(second_revision);
    expect(lines.at(-1)).toContain("unreachable");
    expect(asked.at(-1)).toContain(`"merge-base","--is-ancestor","--","${first_revision}","${second_revision}"`);

    await settle(runs);
    await puller.tick();
    const [report] = await puller.pending();
    expect(report).toMatchObject({ revision: second_revision, branch: "main", remote: "https://primary.example/config", exit_code: 0 });
    expect(report.output).toContain(`rev=${second_revision}#odin`);
  });

  it("refuses a revision that does not descend from the deployed one only once, and reports the refusal", async () => {
    const { puller, runs, head, asked_for, ancestry, lines, folder } = make_puller();
    head("primary.example", second_revision);
    await puller.tick();
    ancestry.set(`${second_revision}..${first_revision}`, 1);
    head("primary.example", first_revision);

    await puller.tick();
    await puller.tick();

    expect(runs.list()).toEqual([]);
    expect(puller.revision()).toBe(second_revision);
    expect(asked_for("fetch")).toBe(1);
    expect(lines.filter((line) => line.includes(`Not switching to ${first_revision}`))).toEqual([
      `Not switching to ${first_revision} of main from https://primary.example/config: it does not descend from the deployed revision ${second_revision}, so it is older or on other history`,
    ]);
    expect(JSON.parse(readFileSync(join(folder, "pull.json"), "utf8")).refused).toBe(first_revision);
    const [report] = await puller.pending();
    expect(report).toMatchObject({ revision: first_revision, exit_code: null, command: "", refused: expect.stringContaining("does not descend") });
    expect(report.output).toContain("does not descend");
    puller.acknowledge([report.run_id]);
    expect(await puller.pending()).toEqual([]);
  });

  it("refuses a revision whose history lacks the deployed one, and switches to it with allow_rewind", async () => {
    for (const allow_rewind of [false, true]) {
      const { puller, runs, head, ancestry, asked_for, lines } = make_puller("0s", { allow_rewind });
      head("primary.example", first_revision);
      await puller.tick();
      ancestry.set(`${first_revision}..${second_revision}`, 128);
      head("primary.example", second_revision);

      await puller.tick();

      expect(puller.revision()).toBe(allow_rewind ? second_revision : first_revision);
      expect(runs.list()).toHaveLength(allow_rewind ? 1 : 0);
      expect(asked_for("merge-base")).toBe(allow_rewind ? 0 : 1);
      if (!allow_rewind) expect(lines.at(-1)).toContain(`the deployed revision ${first_revision} is not in its history, which was rewritten`);
    }
  });

  it("tries again later when the revision cannot be fetched or compared", async () => {
    const { puller, runs, head, ancestry, asked_for, git, lines } = make_puller();
    head("primary.example", first_revision);
    await puller.tick();
    head("primary.example", second_revision);
    git.fetch = result(128, "", "fatal: the remote hung up");

    await puller.tick();
    expect(lines.at(-1)).toContain("Could not fetch");
    git.fetch = result(0);
    ancestry.set(`${first_revision}..${second_revision}`, 2);
    await puller.tick();
    expect(lines.at(-1)).toContain("Could not compare");
    ancestry.delete(`${first_revision}..${second_revision}`);
    await puller.tick();

    expect(asked_for("fetch")).toBe(3);
    expect(runs.list()).toHaveLength(1);
    expect(puller.revision()).toBe(second_revision);
  });

  it("keeps only the latest refusals for the server", async () => {
    const { puller, head, ancestry } = make_puller();
    head("primary.example", first_revision);
    await puller.tick();
    for (let index = 0; index < 25; index++) {
      const revision = index.toString(16).padStart(40, "a");
      ancestry.set(`${first_revision}..${revision}`, 1);
      head("primary.example", revision);
      await puller.tick();
    }
    const reports = await puller.pending();
    expect(reports).toHaveLength(20);
    expect(reports.at(-1)!.revision).toBe((24).toString(16).padStart(40, "a"));
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

describe("pull mode with signed commits", () => {
  // A local repository with one commit signed by the allowed key and one by nobody, and a puller that runs its operations for real.
  function make_signed_remote() {
    const folder = mkdtempSync(join(tmpdir(), "x-nix-signed-"));
    const key = join(folder, "signer");
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "signer", "-f", key]);
    const allowed_signers = join(folder, "allowed_signers");
    writeFileSync(allowed_signers, `signer@example ${readFileSync(`${key}.pub`, "utf8").trim()}\n`);
    const repository = join(folder, "config");
    const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
    execFileSync("git", ["init", "--quiet", "--initial-branch", "main", repository]);
    git("config", "user.name", "Signer");
    git("config", "user.email", "signer@example");
    git("config", "gpg.format", "ssh");
    git("config", "user.signingkey", key);
    const commit = (message: string, sign: boolean) => {
      writeFileSync(join(repository, "file"), message);
      git("add", "file");
      git("commit", "--quiet", sign ? "--gpg-sign" : "--no-gpg-sign", "-m", message);
      return git("rev-parse", "HEAD");
    };
    // Points the branch back at an older commit, as a force-push would.
    const reset = (revision: string) => git("reset", "--quiet", "--hard", revision);
    // Starts the branch afresh with no history in common, as a rewrite would.
    const rewrite = (message: string) => {
      git("checkout", "--quiet", "--orphan", "rewritten");
      const revision = commit(message, true);
      git("branch", "--quiet", "-M", "main");
      return revision;
    };
    return { folder, allowed_signers, url: `file://${repository}`, commit, reset, rewrite, git };
  }

  function make_puller(remote_url: string, allowed_signers: string, folder: string) {
    const runs = operation_runs(join(folder, "agent"), { tail_interval_in_milliseconds: 10 });
    const settings = parse_pull_settings({ remotes: [remote_url], after: "0s", rebuild_bin: "echo", require_sudo: false, allowed_signers }, "odin");
    const lines: string[] = [];
    const puller = new Puller(settings, runs, join(folder, "agent"), { connected: () => false, report: () => {}, log: (line) => lines.push(line) });
    return { puller, runs, lines };
  }

  it("switches to a commit an allowed key signed, and refuses one nobody signed only once", async () => {
    const remote = make_signed_remote();
    remote.commit("first", true);
    const { puller, runs, lines } = make_puller(remote.url, remote.allowed_signers, remote.folder);
    await puller.tick();

    const signed = remote.commit("signed", true);
    await puller.tick();
    expect(puller.revision()).toBe(signed);
    expect(runs.list()).toHaveLength(1);

    while (runs.list().some((run) => run.state === "running")) await sleep(20);
    const unsigned = remote.commit("unsigned", false);
    await puller.tick();
    await puller.tick();
    expect(puller.revision()).toBe(signed);
    expect(runs.list()).toHaveLength(1);
    expect(lines.filter((line) => line.includes(`Not switching to ${unsigned}`))).toHaveLength(1);
  }, 30_000);

  it("refuses an older signed commit and a rewritten branch, and switches to a later signed descendant", async () => {
    const remote = make_signed_remote();
    const first = remote.commit("first", true);
    const { puller, runs, lines } = make_puller(remote.url, remote.allowed_signers, remote.folder);
    await puller.tick();
    const second = remote.commit("second", true);
    await puller.tick();
    expect(puller.revision()).toBe(second);
    while (runs.list().some((run) => run.state === "running")) await sleep(20);

    remote.reset(first);
    await puller.tick();
    expect(puller.revision()).toBe(second);
    expect(lines.at(-1)).toContain(`Not switching to ${first} of main from ${remote.url}: it does not descend from the deployed revision ${second}`);

    remote.reset(second);
    const third = remote.commit("third", true);
    await puller.tick();
    expect(puller.revision()).toBe(third);
    while (runs.list().some((run) => run.state === "running")) await sleep(20);

    const rewritten = remote.rewrite("rewritten");
    await puller.tick();
    expect(puller.revision()).toBe(third);
    expect(lines.at(-1)).toContain(`Not switching to ${rewritten}`);
    expect(runs.list()).toHaveLength(2);
  }, 30_000);

  it("unshallows the repository an older agent fetched with --depth 1 before comparing", async () => {
    const remote = make_signed_remote();
    remote.commit("first", true);
    const { puller, runs } = make_puller(remote.url, remote.allowed_signers, remote.folder);
    await puller.tick();
    const second = remote.commit("second", true);
    const repository = join(remote.folder, "agent", "pull.git");
    execFileSync("git", ["init", "--quiet", "--bare", repository]);
    execFileSync("git", ["-C", repository, "fetch", "--quiet", "--no-tags", "--depth", "1", "--", remote.url, second]);
    const third = remote.commit("third", true);

    await puller.tick();

    expect(puller.revision()).toBe(third);
    expect(runs.list()).toHaveLength(1);
    expect(existsSync(join(repository, "shallow"))).toBe(false);
  }, 30_000);
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

  it("adds a refusal to the host's deployments as an event, with no job", () => {
    const harness = make_deployment({ host: "odin" });
    const refusal = { ...report, run_id: "pull-refused-1-abc", command: "", exit_code: null, refused: "it does not descend from the deployed revision" };

    expect(record_pulls(harness.store, [harness.deployment], "odin", [refusal], clock.now)).toEqual(["pull-refused-1-abc"]);

    expect(harness.store.jobs({ deployment_id: "host-deploy" })).toEqual([]);
    expect(harness.store.events("host-deploy")[0]).toMatchObject({
      level: "error", message: "While X-Nix was unreachable, the agent refused 222222222222 of main from https://git.example/config: it does not descend from the deployed revision",
    });
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
    const runs = operation_runs(state_directory);
    runs.start("pull-1-abc", { kind: "programs", steps: [{ argv: ["echo", "switched"] }] }, null);
    while (runs.get("pull-1-abc").state === "running") await sleep(20);
    writeFileSync(join(state_directory, "pull.json"), JSON.stringify({
      revision: second_revision,
      records: [{ run_id: "pull-1-abc", remote: "https://git.example/config", branch: "main", revision: second_revision, command: "echo switched", started_epoch: 1, finished_epoch: 2, exit_code: 0 }],
    }));

    const received: PullReport[] = [];
    const local = new LocalAgent(join(folder, "local"), { runner: operation_runner });
    const hub = create_hub(new AgentPool("heimdall", local), local, {
      on_pulls: (host, pulls) => {
        const reports = pulls as PullReport[];
        received.push(...reports.map((pull) => ({ ...pull, remote: `${host}:${pull.remote}` })));
        return reports.map((pull) => pull.run_id);
      },
    });
    hub.set_agent_keys(new Map([["odin", readFileSync(`${key_file}.pub`, "utf8").trim()]]));
    app = fastify();
    await register_agent_route(app, hub);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    const url = `ws://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}/api/agent`;

    agent = start_agent({
      url, key_file, state_directory, host: "odin", agent_version: "test", log: () => {},
      pull: parse_pull_settings({ remotes: ["https://git.example/config"], interval: "1h", allow_unsigned: true }, "odin"),
    });
    for (let tries = 0; tries < 100 && (received.length === 0 || JSON.parse(readFileSync(join(state_directory, "pull.json"), "utf8")).records.length > 0); tries++) await sleep(20);

    expect(received).toMatchObject([{ run_id: "pull-1-abc", remote: "odin:https://git.example/config", exit_code: 0, output: "$ echo switched\nswitched\n" }]);
    expect(JSON.parse(readFileSync(join(state_directory, "pull.json"), "utf8")).records).toEqual([]);
  });
});
