import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fingerprint_of, generate_agent_key, parse_private_key } from "@x-tech-laboratories/x-libs/agent/keys";

import { read_server_keys_file, start_agent, type RunningAgent } from "../src/agent/agent.ts";
import { AgentPool } from "../src/server/agents/agent.ts";
import { create_hub, read_server_key, server_key_view, ServerKeyError, type Hub } from "../src/server/agents/hub.ts";
import { build_app, type HostView, type ProvisioningView } from "../src/server/app.ts";
import { hash_password } from "../src/server/auth.ts";
import { host_settings, provisioning_settings } from "../src/server/config.ts";
import { Host } from "../src/server/host.ts";
import { agent_snippet, install_snippets, type InstallRecord } from "../src/server/nixos/provision.ts";
import { Poller } from "../src/server/poller.ts";
import { Provisioner } from "../src/server/provisioning.ts";
import { Store } from "../src/server/store.ts";
import { FakeAgent } from "./fake_agent.ts";

const server_main = join(import.meta.dirname, "../src/server/main.ts");
const agent_main = join(import.meta.dirname, "../src/agent/main.ts");

// A throwaway key made in the test's own folder, so no key is ever kept in the repository or read from the machine.
function make_key(directory: string, name: string): { private_file: string; public_line: string } {
  const key = generate_agent_key(name);
  const private_file = join(directory, name);
  writeFileSync(private_file, key.private_text, { mode: 0o600 });
  return { private_file, public_line: key.public_line };
}

// Runs a program to its end, answering with its exit code and what it printed on stderr.
function run_to_end(file: string, environment: Record<string, string>): Promise<{ exit_code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], { env: { ...process.env, ...environment }, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("close", (exit_code) => resolve({ exit_code, stderr }));
  });
}

// ── Reading the server key ───────────────────────────────────────────────────

describe("the server key file", () => {
  const folder = mkdtempSync(join(tmpdir(), "x-nix-server-key-"));

  it("reads an ed25519 key ssh-keygen would write", () => {
    const { private_file } = make_key(folder, "server");

    const key = read_server_key(private_file);

    expect(fingerprint_of(key)).toBe(fingerprint_of(parse_private_key(readFileSync(private_file, "utf8"))));
  });

  it("refuses a missing file, a key that is not ed25519 and text that is no key, without quoting the file", () => {
    const ecdsa_file = join(folder, "ecdsa");
    execFileSync("ssh-keygen", ["-q", "-t", "ecdsa", "-N", "", "-C", "x-nix-server", "-f", ecdsa_file], { stdio: "ignore" });
    const garbage_file = join(folder, "garbage");
    writeFileSync(garbage_file, "not a key at all\n");

    expect(() => read_server_key(join(folder, "missing"))).toThrow(new ServerKeyError(`Could not read the server key file ${join(folder, "missing")}: ENOENT`));
    expect(() => read_server_key(ecdsa_file)).toThrow(/must be an ssh-ed25519 key, not ecdsa/);
    expect(() => read_server_key(garbage_file)).toThrow(/is not an OpenSSH private key/);
    expect(() => read_server_key(garbage_file)).not.toThrow(/not a key at all/);
  });

  it("stops the server at start with the reason when it cannot be used", async () => {
    const accounts_file = join(folder, "accounts");
    writeFileSync(accounts_file, `admin:${hash_password("a test password")}\n`);
    const environment = { X_NIX_PASSWORD_HASH_FILE: accounts_file, X_NIX_STATE_DIR: join(folder, "state"), PORT: "7999", X_NIX_CONFIG: "" };
    const ecdsa_file = join(folder, "ecdsa-for-start");
    execFileSync("ssh-keygen", ["-q", "-t", "ecdsa", "-N", "", "-f", ecdsa_file], { stdio: "ignore" });

    const unreadable = await run_to_end(server_main, { ...environment, X_NIX_SERVER_KEY_FILE: join(folder, "missing") });
    const not_ed25519 = await run_to_end(server_main, { ...environment, X_NIX_SERVER_KEY_FILE: ecdsa_file });

    expect(unreadable).toEqual({ exit_code: 2, stderr: `Could not read the server key file ${join(folder, "missing")}: ENOENT\n` });
    expect(not_ed25519.exit_code).toBe(2);
    expect(not_ed25519.stderr).toContain(`The server key file ${ecdsa_file} must be an ssh-ed25519 key`);
  });
});

// ── The agent's server keys ──────────────────────────────────────────────────

describe("the agent's server keys file", () => {
  const folder = mkdtempSync(join(tmpdir(), "x-nix-server-keys-"));
  const write = (name: string, text: string) => {
    const file = join(folder, name);
    writeFileSync(file, text);
    return file;
  };

  it("reads a JSON list of public lines", () => {
    const lines = [make_key(folder, "old").public_line, make_key(folder, "new").public_line];

    expect(read_server_keys_file(write("keys.json", JSON.stringify(lines)))).toEqual(lines);
    expect(read_server_keys_file(write("empty.json", "[]"))).toEqual([]);
  });

  it("refuses a file that is missing, not JSON, not a list of texts, or holds a line that is no ed25519 key", () => {
    const rsa_line = `ssh-rsa ${make_key(folder, "other").public_line.split(" ")[1]}`;

    expect(() => read_server_keys_file(join(folder, "missing.json"))).toThrow(/Could not read the server keys at/);
    expect(() => read_server_keys_file(write("bad.json", "ssh-ed25519 AAAA"))).toThrow(/Could not read the server keys at/);
    expect(() => read_server_keys_file(write("object.json", '{"key": "ssh-ed25519 AAAA"}'))).toThrow(/must be a JSON list of OpenSSH public key lines/);
    expect(() => read_server_keys_file(write("rsa.json", JSON.stringify([rsa_line])))).toThrow(/rsa\.json: Server key 1 must be an ssh-ed25519 key, not ssh-rsa/);
  });

  it("stops the agent at start with the reason when a line is malformed", async () => {
    const key = make_key(folder, "agent");
    const keys_file = write("cut.json", JSON.stringify(["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5"]));

    const ended = await run_to_end(agent_main, {
      X_NIX_AGENT_URL: "ws://127.0.0.1:9/api/agent", X_NIX_AGENT_KEY_FILE: key.private_file, X_NIX_AGENT_HOST: "odin",
      X_NIX_AGENT_STATE_DIR: join(folder, "state"), X_NIX_AGENT_SERVER_KEYS_FILE: keys_file,
    });

    expect(ended.exit_code).toBe(2);
    expect(ended.stderr).toContain(`In ${keys_file}: Server key 1`);
  });
});

// ── Snippets ─────────────────────────────────────────────────────────────────

describe("the agent snippet", () => {
  it("lists the server's public line when it has a key, and nothing more without one", () => {
    const line = generate_agent_key("x-nix-server").public_line;

    expect(agent_snippet("freya", "/var/lib/x-nix-agent/key", "wss://nix.example/api/agent", line)).toContain(`  serverPublicKeys = [ "${line}" ];\n};`);
    expect(agent_snippet("freya", "/var/lib/x-nix-agent/key", "wss://nix.example/api/agent")).not.toContain("serverPublicKeys");
  });

  it("gives an install's host configuration the server's public line", () => {
    const line = generate_agent_key("x-nix-server").public_line;
    const record = { host: "freya", flake: "/srv/fleet", configuration: "freya", agent_key_path: "/var/lib/x-nix-agent/key", public_line: "ssh-ed25519 AAAA freya" } as InstallRecord;

    expect(install_snippets(record, null, line).host_nix).toContain(`serverPublicKeys = [ "${line}" ];`);
  });
});

// ── Signed messages ──────────────────────────────────────────────────────────

describe("a server with a key", () => {
  const password = "correct horse battery staple";
  let app: FastifyInstance;
  let hub: Hub;
  let folder: string;
  let url: string;
  let server_key: { private_file: string; public_line: string };
  let agent_key: { private_file: string; public_line: string };
  let agents: RunningAgent[];
  let agent_log: string[];
  let cookie: string;

  async function start_server(with_key: boolean) {
    const store = new Store(":memory:");
    const pool = new AgentPool("heimdall", null);
    hub = create_hub(pool, null, { server_key: with_key ? read_server_key(server_key.private_file) : null });
    hub.set_agent_keys(new Map([["odin", agent_key.public_line]]));
    const host = new Host(host_settings({ id: "odin" }), { store, agents: pool });
    const provisioner = new Provisioner(provisioning_settings({ agent_url: "wss://nix.example/api/agent" }), {
      store, agents: new AgentPool("heimdall", new FakeAgent()), default_media_root_dir: join(folder, "media"), declared_hosts: () => new Set(["odin"]),
      server_public_line: () => server_key_view(hub)?.public_line ?? null,
    });
    app = await build_app({
      serve_web: false, logger: false, server_name: "heimdall", accounts: new Map([["admin", hash_password(password)]]), store,
      poller: new Poller([], null, [], [provisioner], [], [host]), hub, agents: pool, provisioner,
    });
    const address = new URL(await app.listen({ host: "127.0.0.1", port: 0 }));
    url = `ws://127.0.0.1:${address.port}/api/agent`;
    const login = await app.inject({ method: "POST", url: "/api/login", payload: { name: "admin", password } });
    cookie = String(login.headers["set-cookie"]).split(";")[0];
  }

  function start_test_agent(server_keys?: string[]): RunningAgent {
    const agent = start_agent({
      url, key_file: agent_key.private_file, state_directory: join(folder, `agent-${agents.length}`), host: "odin", agent_version: "test", server_keys,
      backoff_initial_in_milliseconds: 50, backoff_longest_in_milliseconds: 200, log: (line) => agent_log.push(line),
    });
    agents.push(agent);
    return agent;
  }

  const connected = () => new Promise<void>((resolve) => {
    if (hub.is_connected("odin")) resolve();
    hub.on("connect", (status) => status.host === "odin" && resolve());
  });

  // Resolves once the agent has logged a line holding the text.
  const logged = async (text: string) => {
    while (!agent_log.some((line) => line.includes(text))) await new Promise((resolve) => setTimeout(resolve, 20));
  };

  const host_view = async () => (await app.inject({ method: "GET", url: "/api/hosts/odin", headers: { cookie } })).json<HostView>();

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), "x-nix-signed-"));
    server_key = make_key(folder, "server");
    agent_key = make_key(folder, "odin");
    agents = [];
    agent_log = [];
  });

  afterEach(async () => {
    for (const agent of agents) await agent.stop();
    await app.close();
  });

  it("is answered by an agent listing its key, which runs operations and shows as verifying the server", async () => {
    await start_server(true);
    start_test_agent([server_key.public_line]);
    await connected();

    const ran = await hub.agent("odin")!.run({ kind: "programs", steps: [{ argv: ["echo", "signed"] }] }, { timeout_in_seconds: 5 });

    expect(ran.stdout).toBe("signed");
    expect((await host_view()).agent).toMatchObject({ agent_version: "test", signed_messages: true });
    expect(hub.status("odin")?.signed_messages).toBe(true);
  });

  it("is refused by an agent listing another key", async () => {
    await start_server(true);
    let connections = 0;
    hub.on("connect", () => connections++);
    start_test_agent([make_key(folder, "another-server").public_line]);

    await logged("Refused the server: The server signed with the key");

    expect(connections).toBe(0);
    expect((await host_view()).agent).toBeNull();
  });

  it("still serves an agent listing no keys, which shows as checking it by TLS only", async () => {
    await start_server(true);
    start_test_agent();
    await connected();

    const ran = await hub.agent("odin")!.run({ kind: "programs", steps: [{ argv: ["echo", "unsigned"] }] }, { timeout_in_seconds: 5 });

    expect(ran.stdout).toBe("unsigned");
    expect((await host_view()).agent).toMatchObject({ signed_messages: false });
    expect(agent_log.some((line) => line.startsWith("Warning: the server at") && line.includes("TLS alone"))).toBe(true);
  });

  it("shows its public line and fingerprint, and puts the line in the agent snippet", async () => {
    await start_server(true);

    const view = (await app.inject({ method: "GET", url: "/api/provisioning", headers: { cookie } })).json<ProvisioningView>();

    const fingerprint = fingerprint_of(read_server_key(server_key.private_file));
    expect(view.server_key).toEqual({ public_line: `${server_key.public_line.split(" ").slice(0, 2).join(" ")} x-nix-server`, fingerprint });
    expect(view.agent_snippet).toContain(`serverPublicKeys = [ "${view.server_key!.public_line}" ];`);
    expect(JSON.stringify(view)).not.toContain(readFileSync(server_key.private_file, "utf8").split("\n")[1]);
  });

  it("without a key is refused by an agent listing one, and shows none", async () => {
    await start_server(false);
    start_test_agent([server_key.public_line]);

    await logged("Refused the server: The server did not sign its challenge");
    const view = (await app.inject({ method: "GET", url: "/api/provisioning", headers: { cookie } })).json<ProvisioningView>();

    expect(view.server_key).toBeNull();
    expect(view.agent_snippet).not.toContain("serverPublicKeys");
  });
});
