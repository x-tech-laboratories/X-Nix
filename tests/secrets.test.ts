import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { check_keys, parse_key_states, write_key, writer_command } from "../src/agent/keys.ts";
import { AgentError } from "../src/server/agents/agent.ts";
import { build_app, type SecretsView } from "../src/server/app.ts";
import { hash_password } from "../src/server/auth.ts";
import { ConfigError, deployment_settings } from "../src/server/config.ts";
import { Deployment } from "../src/server/deployment.ts";
import { Poller } from "../src/server/poller.ts";
import { Secrets } from "../src/server/secrets.ts";
import { parse_server_message } from "../src/shared/agent_protocol.ts";
import { is_key_destination } from "../src/shared/keys.ts";
import { clock, collect, make_deployment, type Harness } from "./fake_agent.ts";

// ── Setup ────────────────────────────────────────────────────────────────────

const folder = mkdtempSync(join(tmpdir(), "x-nix-secrets-"));
const test_value = "not-a-real-value-0123456789";
const writer_script = join(import.meta.dirname, "../src/agent/key-writer.sh");

// A source file holding a stand-in value, as a deployment's secret reads it.
function source(name: string, value = test_value): string {
  const file = join(folder, name);
  writeFileSync(file, value);
  return file;
}

function with_secrets(values: Record<string, unknown>[] = [{ name: "database", source: source("database") }]): Harness {
  return make_deployment({ secrets: values });
}

function secrets_for(harness: Harness): Secrets {
  return new Secrets({ store: harness.store, agents: harness.agents, now: () => clock.now });
}

// ── Config ───────────────────────────────────────────────────────────────────

describe("the secrets setting", () => {
  it("defaults each secret into the keys folder, owned by root and readable only by it", () => {
    const [secret] = deployment_settings({ id: "odin", secrets: [{ name: "database", source: "/etc/x-nix/database" }] }).secrets;

    expect(secret).toEqual({ name: "database", source: "/etc/x-nix/database", destination: "/run/keys/database", owner: "root", group: "root", mode: "0400" });
  });

  it("is empty when absent, so existing configs read the same", () => {
    expect(deployment_settings({ id: "odin" }).secrets).toEqual([]);
  });

  it("refuses a destination outside the keys folder, a stepping path, a relative source and a repeated name", () => {
    const read = (secret: Record<string, unknown>) => () => deployment_settings({ id: "odin", secrets: [{ name: "database", source: "/s", ...secret }] });

    expect(read({ destination: "/etc/shadow" })).toThrow(ConfigError);
    expect(read({ destination: "/run/keys/../shadow" })).toThrow(ConfigError);
    expect(read({ source: "relative/file" })).toThrow(ConfigError);
    expect(read({ mode: "rw" })).toThrow(ConfigError);
    expect(read({ owner: "bad owner" })).toThrow(ConfigError);
    expect(() => deployment_settings({ id: "odin", secrets: [{ name: "a", source: "/s" }, { name: "a", source: "/t" }] })).toThrow(/Two secrets/);
  });

  it("takes only plain paths under the keys folder as destinations", () => {
    expect(is_key_destination("/run/keys/database")).toBe(true);
    expect(is_key_destination("/run/keys/app/token")).toBe(true);
    expect(is_key_destination("/run/keys/")).toBe(false);
    expect(is_key_destination("/run/keys/a b")).toBe(false);
    expect(is_key_destination("/run/keys/$(id)")).toBe(false);
    expect(is_key_destination("/run/keysmith/x")).toBe(false);
  });
});

// ── Uploading ────────────────────────────────────────────────────────────────

describe("uploading secrets", () => {
  it("writes each secret through the host's agent and keeps a job that names it without its value", async () => {
    const harness = with_secrets([{ name: "database", source: source("database"), owner: "postgres", group: "postgres", mode: "0440" }]);

    const outcome = await secrets_for(harness).upload(harness.deployment, "manual");

    expect(outcome.ok).toBe(true);
    expect(harness.agent.key_writes).toHaveLength(1);
    expect(harness.agent.key_writes[0]).toMatchObject({ destination: "/run/keys/database", owner: "postgres", group: "postgres", mode: "0440", sudo: true });
    expect(Buffer.from(harness.agent.key_writes[0].content_base64, "base64").toString()).toBe(test_value);
    const job = harness.store.job(outcome.job_id!)!;
    expect(job.kind).toBe("secrets");
    expect(job.state).toBe("succeeded");
    expect(job.output).toContain(`database to /run/keys/database (${test_value.length} bytes, postgres:postgres 0440)`);
    expect(JSON.stringify(job)).not.toContain(test_value);
    expect(JSON.stringify(harness.store.events(harness.deployment.id))).not.toContain(test_value);
  });

  it("checks each key against its source by a salted hash, calling it current, stale or missing", async () => {
    const harness = with_secrets([{ name: "first", source: source("first") }, { name: "second", source: source("second") }]);
    const secrets = secrets_for(harness);
    await secrets.upload(harness.deployment, "manual");

    source("second", "a changed stand-in value");
    harness.agent.keys.delete("/run/keys/first");
    const reading = await secrets.check(harness.deployment);

    expect(reading.error).toBeNull();
    expect(reading.secrets.map((secret) => secret.on_host)).toEqual(["missing", "stale"]);
    expect(reading.secrets[1].difference).toBe("Differs on the host: contents");
    expect(JSON.stringify(reading)).not.toContain(test_value);
  });

  it("calls a key with another owner or mode stale", async () => {
    const harness = with_secrets();
    const secrets = secrets_for(harness);
    await secrets.upload(harness.deployment, "manual");

    harness.agent.keys.get("/run/keys/database")!.mode = "644";
    const reading = await secrets.check(harness.deployment);

    expect(reading.secrets[0]).toMatchObject({ on_host: "stale", difference: "Differs on the host: mode 644" });
  });

  it("uploads only what is missing or stale when asked for what is needed, and keeps no job when nothing is", async () => {
    const harness = with_secrets([{ name: "first", source: source("first") }, { name: "second", source: source("second") }]);
    const secrets = secrets_for(harness);
    await secrets.upload(harness.deployment, "manual");
    harness.agent.key_writes.length = 0;

    const nothing = await secrets.upload(harness.deployment, "agent connect", true);
    harness.agent.keys.delete("/run/keys/second");
    const needed = await secrets.upload(harness.deployment, "agent connect", true);

    expect(nothing).toMatchObject({ ok: true, job_id: null });
    expect(needed.ok).toBe(true);
    expect(harness.agent.key_writes.map((write) => write.destination)).toEqual(["/run/keys/second"]);
  });

  it("fails the job naming a secret whose source cannot be read, and one the host would not take", async () => {
    const harness = with_secrets([{ name: "gone", source: join(folder, "no-such-file") }, { name: "kept", source: source("kept") }]);

    harness.agent.key_error = new AgentError("The agent on host refused.");
    const outcome = await secrets_for(harness).upload(harness.deployment, "manual");

    expect(outcome).toMatchObject({ ok: false, message: "Could not upload gone, kept" });
    const job = harness.store.job(outcome.job_id!)!;
    expect(job.output).toContain("Could not read the source of gone");
    expect(job.output).toContain("Could not write kept: The agent on host refused.");
  });

  it("refuses a deployment with no secrets", async () => {
    const harness = make_deployment();

    expect(await secrets_for(harness).upload(harness.deployment, "manual")).toMatchObject({ ok: false, job_id: null });
  });

  it("runs after a switch succeeds", async () => {
    const switched: string[] = [];
    const harness = make_deployment();
    const deployment = new Deployment(harness.deployment.settings, {
      store: harness.store, agents: harness.agents, now: () => clock.now, after_switch: (done) => switched.push(done.id),
    });
    await collect({ ...harness, deployment });

    await deployment.act("switch");
    harness.agent.end(harness.agent.last_run("switch")!, "done\n", 0);
    await deployment.cycle();

    expect(switched).toEqual(["host-deploy"]);
  });
});

// ── Agent ────────────────────────────────────────────────────────────────────

describe("the agent's key writer", () => {
  // A stand-in writer that keeps its arguments and stdin apart, so a test can see where the value went.
  function recording_writer(): { writer: string; arguments_file: string; stdin_file: string } {
    const directory = mkdtempSync(join(tmpdir(), "x-nix-writer-"));
    const writer = join(directory, "writer");
    const arguments_file = join(directory, "arguments");
    const stdin_file = join(directory, "stdin");
    writeFileSync(writer, `#!/bin/sh\necho "$@" > ${arguments_file}\ncat > ${stdin_file}\n`);
    chmodSync(writer, 0o755);
    return { writer, arguments_file, stdin_file };
  }

  it("hands the value over on stdin, never in the command's arguments", async () => {
    const { writer, arguments_file, stdin_file } = recording_writer();

    const result = await write_key({ destination: "/run/keys/database", owner: "postgres", group: "postgres", mode: "0400", content_base64: Buffer.from(test_value).toString("base64"), sudo: false }, writer);

    expect(result.exit_code).toBe(0);
    expect(readFileSync(arguments_file, "utf8").trim()).toBe("write /run/keys/database postgres postgres 0400");
    expect(readFileSync(stdin_file, "utf8")).toBe(test_value);
  });

  it("refuses a destination outside the keys folder before running anything", async () => {
    const { writer } = recording_writer();

    await expect(write_key({ destination: "/etc/shadow", owner: "root", group: "root", mode: "0400", content_base64: "", sudo: false }, writer)).rejects.toThrow(/not a plain path/);
  });

  it("runs under sudo when asked, and the bundled script when no writer is named", () => {
    expect(writer_command(true, "/nix/store/writer")).toBe("sudo -n /nix/store/writer");
    expect(writer_command(false, "")).toMatch(/^sh .*key-writer\.sh$/);
  });

  it("reads the check's lines into one state per destination, in the order asked", () => {
    const output = "present abc123 27 postgres keys 440 /run/keys/database\nmissing /run/keys/token\n";

    expect(parse_key_states(output, ["/run/keys/token", "/run/keys/database"])).toEqual([
      { destination: "/run/keys/token", present: false, salted_hash: null, size: null, owner: null, group: null, mode: null },
      { destination: "/run/keys/database", present: true, salted_hash: "abc123", size: 27, owner: "postgres", group: "keys", mode: "440" },
    ]);
  });

  it("reports a key that is not there as missing, from the bundled script", async () => {
    const states = await check_keys(["/run/keys/x-nix-test-never-written"], "salt0", false, writer_script);

    expect(states[0].present).toBe(false);
  });

  it("refuses, in the bundled script itself, a destination outside the keys folder", () => {
    const run = spawnSync("sh", [writer_script, "write", "/tmp/x-nix-escape", "root", "root", "0400"], { input: "x", encoding: "utf8" });

    expect(run.status).toBe(2);
    expect(run.stderr).toContain("is not under /run/keys");
  });

  it("travels in protocol messages the agent recognises", () => {
    const message = parse_server_message(JSON.stringify({ type: "check_keys", id: "r1", destinations: ["/run/keys/a"], salt: "abc", sudo: true }));

    expect(message?.type).toBe("check_keys");
    expect(parse_server_message(JSON.stringify({ type: "check_keys", id: "r1", destinations: [], salt: "abc", sudo: "yes" }))).toBeNull();
  });
});

// ── API ──────────────────────────────────────────────────────────────────────

describe("the secrets routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("list, check and upload a deployment's secrets, never answering with a value", async () => {
    const password = "correct horse battery staple";
    const harness = with_secrets();
    app = await build_app({
      serve_web: false, logger: false, password_hash: hash_password(password), store: harness.store, poller: new Poller([harness.deployment]), secrets: secrets_for(harness),
    });
    const login = await app.inject({ method: "POST", url: "/api/login", payload: { password } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const inject = (method: "GET" | "POST", url: string) => app!.inject({ method, url, headers: { cookie } });

    const before = (await inject("GET", "/api/deployments/host-deploy/secrets")).json<SecretsView>();
    const upload = await inject("POST", "/api/deployments/host-deploy/secrets/upload");
    const after = (await inject("GET", "/api/secrets")).json<SecretsView[]>();

    expect(before.reading?.secrets[0].on_host).toBe("missing");
    expect(upload.statusCode).toBe(200);
    expect(after[0].reading?.secrets[0].on_host).toBe("current");
    expect(upload.body + JSON.stringify(after)).not.toContain(test_value);
  });
});
