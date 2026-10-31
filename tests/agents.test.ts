import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { start_agent, type RunningAgent } from "../src/agent/agent.ts";
import { AgentPool, type Agent } from "../src/server/agents/agent.ts";
import { AgentHub, close_codes } from "../src/server/agents/hub.ts";
import { LocalAgent } from "../src/server/agents/local.ts";
import { register_agent_route } from "../src/server/agents/route.ts";
import { ConfigError, parse_config } from "../src/server/config.ts";
import { key_fingerprint, parse_private_key, parse_public_key, sign_challenge, verify_challenge } from "../src/shared/agent_keys.ts";
import { encode_message, key_host_header, protocol_version } from "../src/shared/agent_protocol.ts";

const agent_main = join(import.meta.dirname, "../src/agent/main.ts");

// A key pair made with ssh-keygen in the test's own folder, so no key is ever kept in the repository.
function make_key(directory: string, name: string, extra: string[] = ["-N", ""]): { private_file: string; public_line: string } {
  const private_file = join(directory, name);
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", ...extra, "-C", `x-nix-agent-${name}`, "-f", private_file], { stdio: "ignore" });
  return { private_file, public_line: readFileSync(`${private_file}.pub`, "utf8").trim() };
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// ── Keys ─────────────────────────────────────────────────────────────────────

describe("agent keys", () => {
  const folder = mkdtempSync(join(tmpdir(), "x-nix-keys-"));

  it("read a key ssh-keygen made and sign a challenge its public line verifies, for that host and nonce only", () => {
    const { private_file, public_line } = make_key(folder, "odin");
    const signature = sign_challenge(parse_private_key(readFileSync(private_file, "utf8")), "odin", "nonce-1");
    const public_key = parse_public_key(public_line);
    expect(verify_challenge(public_key, "odin", "nonce-1", signature)).toBe(true);
    expect(verify_challenge(public_key, "odin", "nonce-2", signature)).toBe(false);
    expect(verify_challenge(public_key, "thor", "nonce-1", signature)).toBe(false);
    expect(verify_challenge(parse_public_key(make_key(folder, "other").public_line), "odin", "nonce-1", signature)).toBe(false);
  });

  it("give the fingerprint ssh-keygen prints", () => {
    const { private_file, public_line } = make_key(folder, "fingerprint");
    expect(key_fingerprint(public_line)).toBe(execFileSync("ssh-keygen", ["-l", "-f", `${private_file}.pub`], { encoding: "utf8" }).split(" ")[1]);
  });

  it("refuse an encrypted private key and a public line that is not ed25519", () => {
    const { private_file, public_line } = make_key(folder, "encrypted", ["-N", "a test passphrase"]);
    expect(() => parse_private_key(readFileSync(private_file, "utf8"))).toThrow(/encrypted with a passphrase/);
    expect(() => parse_public_key(`ssh-rsa ${public_line.split(" ")[1]}`)).toThrow(/must be an ssh-ed25519 key/);
  });

  it("are declared in the config by host, and checked there", () => {
    const { public_line } = make_key(folder, "config");
    expect(parse_config({ agents: { odin: public_line } }).agents.get("odin")).toBe(public_line);
    expect(() => parse_config({ agents: { odin: "ssh-ed25519 not*base64" } })).toThrow(ConfigError);
    expect(() => parse_config({ agents: ["odin"] })).toThrow(ConfigError);
  });
});

// ── Hub ──────────────────────────────────────────────────────────────────────

describe("agent hub", () => {
  let app: FastifyInstance;
  let hub: AgentHub;
  let pool: AgentPool;
  let url: string;
  let folder: string;
  let state_directory: string;
  let key: { private_file: string; public_line: string };
  let agent: RunningAgent | null;
  let processes: ChildProcess[];

  const connected = (host = "odin") => new Promise<void>((resolve) => {
    if (hub.is_connected(host)) resolve();
    hub.on("connect", (status) => status.host === host && resolve());
  });

  function start_test_agent(private_file = key.private_file, host = "odin"): RunningAgent {
    agent = start_agent({
      url, key_file: private_file, state_directory, host, agent_version: "test",
      backoff_initial_in_milliseconds: 50, backoff_longest_in_milliseconds: 200, log: () => {},
    });
    return agent;
  }

  beforeEach(async () => {
    folder = mkdtempSync(join(tmpdir(), "x-nix-hub-"));
    state_directory = join(folder, "agent");
    key = make_key(folder, "odin");
    agent = null;
    processes = [];
    pool = new AgentPool("heimdall", new LocalAgent(join(folder, "local")));
    hub = new AgentHub(pool);
    hub.set_agent_keys(new Map([["odin", key.public_line]]));
    app = fastify();
    await register_agent_route(app, hub);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    url = `ws://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}/api/agent`;
  });

  afterEach(async () => {
    await agent?.stop();
    for (const child of processes) child.kill("SIGKILL");
    await app.close();
  });

  it("joins a connected agent to the pool, which runs commands and long runs through it", async () => {
    expect((await pool.get("odin").run("echo hi", 5)).exit_code).toBe(-1);
    start_test_agent();
    await connected();

    const remote: Agent = pool.get("odin");
    expect((await remote.run("echo signed in", 5)).stdout).toBe("signed in");
    await remote.start("odin-test-1", "echo started; exit 3");
    let poll = await remote.poll("odin-test-1", 0);
    while (poll.alive) {
      await sleep(25);
      poll = await remote.poll("odin-test-1", 0);
    }
    expect([poll.exit_code, poll.new_output]).toEqual([3, "started\n"]);
    expect(hub.statuses()).toEqual([{ host: "odin", status: expect.objectContaining({ host: "odin", agent_version: "test" }) }]);
  });

  it("answers a poll of an unknown run as the agent's failure, not the host being out of reach", async () => {
    start_test_agent();
    await connected();
    await expect(pool.get("odin").poll("nope", 0)).rejects.toMatchObject({ unreachable: false });
  });

  it("leaves the pool when the agent hangs up, and keeps a long run going for it to report on its return", async () => {
    start_test_agent();
    await connected();
    await pool.get("odin").start("odin-sleep", "sleep 1; echo done");
    const gone = new Promise((resolve) => hub.once("disconnect", resolve));
    await agent!.stop();
    await gone;
    await expect(pool.get("odin").poll("odin-sleep", 0)).rejects.toMatchObject({ unreachable: true });

    start_test_agent();
    await connected();
    await sleep(1200);
    expect((await pool.get("odin").poll("odin-sleep", 0)).new_output).toBe("done\n");
  });

  it("starts the agent process from its environment", async () => {
    const child = spawn(process.execPath, [agent_main], {
      env: { ...process.env, X_NIX_AGENT_URL: url, X_NIX_AGENT_KEY_FILE: key.private_file, X_NIX_AGENT_HOST: "odin", X_NIX_AGENT_STATE_DIR: state_directory },
      stdio: "ignore",
    });
    processes.push(child);
    await connected();
    expect(hub.is_connected("odin")).toBe(true);
  });

  it("refuses an agent holding another key, or a host with none declared, or the server's own", async () => {
    let connections = 0;
    hub.on("connect", () => connections++);
    start_test_agent(make_key(folder, "other").private_file);
    await sleep(400);
    expect(connections).toBe(0);

    expect(hub.admit({ [key_host_header]: "thor" })).toEqual({ error: "Host 'thor' has no declared agent key." });
    expect(hub.admit({ [key_host_header]: "heimdall" })).toMatchObject({ error: expect.stringContaining("server's own host") });
    expect(hub.admit({})).toMatchObject({ error: expect.stringContaining(key_host_header) });
  });

  it("closes a socket whose hello carries a wrong signature, or none, or another protocol", async () => {
    for (const [hello, code] of [[{ signature: "AAAA" }, close_codes.bad_key], [{}, close_codes.bad_key], [{ protocol: 99 }, close_codes.protocol]] as const) {
      const socket = new WebSocket(url, { headers: { [key_host_header]: "odin" } } as unknown as string[]);
      const challenge = JSON.parse(String((await new Promise<MessageEvent>((resolve) => socket.addEventListener("message", resolve, { once: true }))).data));
      expect(challenge).toMatchObject({ type: "challenge", nonce: expect.any(String) });
      const ended = new Promise<CloseEvent>((resolve) => socket.addEventListener("close", resolve, { once: true }));
      socket.send(encode_message({ type: "hello", protocol: protocol_version, host: "odin", agent_version: "test", runs: [], ...hello }));
      expect((await ended).code).toBe(code);
    }
    expect(hub.is_connected("odin")).toBe(false);
  });

  it("hangs up on an agent whose host's key changed", async () => {
    start_test_agent();
    await connected();
    const gone = new Promise((resolve) => hub.once("disconnect", resolve));
    hub.set_agent_keys(new Map([["odin", make_key(folder, "replacement").public_line]]));
    await gone;
    await sleep(300);
    expect(hub.is_connected("odin")).toBe(false);
  });
});
