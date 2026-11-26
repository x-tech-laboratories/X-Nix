import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { generate_agent_key, parse_private_key, parse_public_key } from "@x-tech-laboratories/x-libs/agent/keys";

import { host_key_check } from "../src/agent/operations/provision.ts";
import { run_operation } from "../src/agent/run.ts";
import { AgentPool } from "../src/server/agents/agent.ts";
import { build_app, type ProvisioningView } from "../src/server/app.ts";
import { hash_password } from "../src/server/auth.ts";
import { ConfigError, parse_config, provisioning_settings } from "../src/server/config.ts";
import {
  hardware_mark, install_operation, media_operation, media_expression, media_mark, parse_hardware_config, parse_install_record,
  parse_install_request, type InstallRequest,
} from "../src/server/nixos/provision.ts";
import { Poller } from "../src/server/poller.ts";
import { Provisioner } from "../src/server/provisioning.ts";
import { Store } from "../src/server/store.ts";
import { marker_token_of, with_marker_token, type InstallOperation } from "../src/shared/operations.ts";
import { announcement, clock, FakeAgent, mark_line } from "./fake_agent.ts";

const folder = mkdtempSync(join(tmpdir(), "x-nix-provisioning-"));

const request: InstallRequest = {
  host: "freya", address: "192.0.2.10", user: "root", port: 22, flake: "github:owner/fleet", configuration: "freya",
  agent: null, stop_after_partitioning: false, generate_hardware_config: true, host_key: null,
};

const host_key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleHostKeyForXNixTestsOnly000000000000";

function settings(values: Record<string, unknown> = {}) {
  return provisioning_settings({ ssh_key: "/var/lib/x-nix/install_key", agent_url: "wss://nix.example/api/agent", ...values });
}

// ── Keys ─────────────────────────────────────────────────────────────────────

describe("a generated agent key", () => {
  it("is one ssh-keygen reads, whose public half matches the line given", () => {
    const key = generate_agent_key("x-nix-agent-freya");
    const file = join(folder, "generated");
    writeFileSync(file, key.private_text, { mode: 0o600 });

    const derived = execFileSync("ssh-keygen", ["-y", "-f", file], { encoding: "utf8" }).trim();

    expect(derived.split(" ")[1]).toBe(key.public_line.split(" ")[1]);
    expect(key.public_line.endsWith(" x-nix-agent-freya")).toBe(true);
    expect(() => parse_private_key(key.private_text)).not.toThrow();
    expect(() => parse_public_key(key.public_line)).not.toThrow();
  });
});

// ── Settings ─────────────────────────────────────────────────────────────────

describe("provisioning settings", () => {
  it("default to the server running nixos-anywhere and the key in /etc/x-nix-agent", () => {
    const parsed = parse_config({}).provisioning;
    expect(parsed.ssh_key).toBeNull();
    expect(parsed.install_agent).toBeNull();
    expect(parsed.nixos_anywhere_bin).toBe("nixos-anywhere");
    expect(parsed.agent_key_path).toBe("/etc/x-nix-agent/key");
    expect(parsed.job_poll).toBe(30);
  });

  it("refuse a key path that is not absolute and plain", () => {
    expect(() => provisioning_settings({ agent_key_path: "key" })).toThrow(ConfigError);
    expect(() => provisioning_settings({ agent_key_path: "/etc/../key" })).toThrow(ConfigError);
    expect(() => provisioning_settings([])).toThrow(ConfigError);
  });
});

describe("an install request", () => {
  it("fills in the SSH user and port, and checks each value", () => {
    const parsed = parse_install_request({ host: "freya", address: "freya.lan", flake: "/srv/fleet", configuration: "freya" });
    expect(parsed).toMatchObject({ user: "root", port: 22, agent: null, generate_hardware_config: true, stop_after_partitioning: false });
    expect(parse_install_request({ ...request, host: "bad name" })).toContain("Name the new host");
    expect(parse_install_request({ ...request, address: "a;b" })).toContain("SSH address");
    expect(parse_install_request({ ...request, port: 70000 })).toContain("port");
    expect(parse_install_request({ ...request, flake: "two\nlines" })).toContain("flake");
  });

  it("takes the target's host key as ssh-keyscan prints it, and refuses anything else", () => {
    expect(parse_install_request({ ...request, host_key: `192.0.2.10 ${host_key}` })).toMatchObject({ host_key });
    expect(parse_install_request({ ...request, host_key: `${host_key} root@freya` })).toMatchObject({ host_key });
    expect(parse_install_request({ ...request, host_key: "" })).toMatchObject({ host_key: null });
    expect(parse_install_request({ ...request, host_key: "ssh-ed25519 not;base64" })).toContain("host key");
    expect(parse_install_request({ ...request, host_key: "just words" })).toContain("host key");
  });
});

// ── Install script ───────────────────────────────────────────────────────────

// A stand-in nixos-anywhere that records its arguments and what it would copy, and writes the hardware configuration.
function fake_nixos_anywhere(directory: string, exit_code = 0): string {
  const bin = join(directory, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "nixos-anywhere"), `#!/bin/sh
printf '%s\\n' "$@" > "${directory}/arguments"
extra=""
hardware=""
while [ $# -gt 0 ]; do
  case "$1" in
    --extra-files) extra="$2"; shift ;;
    --generate-hardware-config) hardware="$3"; shift 2 ;;
  esac
  shift
done
if [ -n "$extra" ]; then cp -a "$extra" "${directory}/copied"; fi
if [ -n "$hardware" ]; then printf '{ ... }: { boot.initrd.availableKernelModules = [ "nvme" ]; }\\n' > "$hardware"; fi
echo "installing"
exit ${exit_code}
`);
  chmodSync(join(bin, "nixos-anywhere"), 0o755);
  return bin;
}

// Performs the install here, as the agent would, with nixos-anywhere from the folder of stand-ins.
async function run_install(operation: InstallOperation, stdin: string, bin: string) {
  const tool = operation.tool.includes("/") ? operation.tool : join(bin, operation.tool);
  const ran = await run_operation({ ...operation, tool: existsSync(tool) ? tool : operation.tool }, { timeout_in_seconds: 30, stdin });
  return { status: ran.exit_code, stdout: ran.stdout };
}

describe("the install script", () => {
  it("places the key from stdin with the new system's modes, and prints the record and hardware configuration", async () => {
    const directory = mkdtempSync(join(folder, "install-"));
    const ssh_key = join(directory, "ssh_key");
    writeFileSync(ssh_key, "not a real key", { mode: 0o600 });
    const key = generate_agent_key("x-nix-agent-freya");
    const operation = install_operation(settings({ ssh_key, nixos_anywhere_args: ["--build-on", "remote"] }), request, key.public_line);
    const command = JSON.stringify(operation);

    const ran = await run_install(operation, key.private_text, fake_nixos_anywhere(directory));

    expect(ran.status).toBe(0);
    expect(command).not.toContain(key.private_text.split("\n")[1]);
    const arguments_given = readFileSync(join(directory, "arguments"), "utf8").split("\n");
    expect(arguments_given.slice(0, 8)).toEqual(["--flake", "github:owner/fleet#freya", "--target-host", "root@192.0.2.10", "--ssh-port", "22", "-i", ssh_key]);
    expect(arguments_given).toContain("nixos-generate-config");
    expect(arguments_given.slice(-3, -1)).toEqual(["--build-on", "remote"]);
    expect(arguments_given).not.toContain("--phases");
    const copied = join(directory, "copied");
    expect(statSync(copied).mode & 0o777).toBe(0o755);
    expect(statSync(join(copied, "etc")).mode & 0o777).toBe(0o755);
    expect(statSync(join(copied, "etc/x-nix-agent")).mode & 0o777).toBe(0o700);
    expect(statSync(join(copied, "etc/x-nix-agent/key")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(copied, "etc/x-nix-agent/key"), "utf8") === key.private_text).toBe(true);
    expect(ran.stdout).toContain("Installing github:owner/fleet#freya on root@192.0.2.10");
    expect(parse_install_record(command)).toMatchObject({ host: "freya", public_line: key.public_line, agent_key_path: "/etc/x-nix-agent/key" });
    expect(parse_hardware_config(ran.stdout, null)).toContain('availableKernelModules = [ "nvme" ]');
  });

  it("stops after partitioning with no key, and passes on nixos-anywhere's failure", async () => {
    const directory = mkdtempSync(join(folder, "partition-"));
    const ssh_key = join(directory, "ssh_key");
    writeFileSync(ssh_key, "not a real key", { mode: 0o600 });
    const operation = install_operation(settings({ ssh_key }), { ...request, stop_after_partitioning: true, generate_hardware_config: false }, null);

    const ran = await run_install(operation, "", fake_nixos_anywhere(directory, 3));

    expect(ran.status).toBe(3);
    const arguments_given = readFileSync(join(directory, "arguments"), "utf8");
    expect(arguments_given).toContain("--phases\nkexec,disko");
    expect(arguments_given).not.toContain("--extra-files");
    expect(arguments_given).not.toContain("--generate-hardware-config");
  });

  it("first has the target prove it holds the host key given, and sends nothing when it does not", async () => {
    const directory = mkdtempSync(join(folder, "host-key-"));
    const ssh_key = join(directory, "ssh_key");
    writeFileSync(ssh_key, "not a real key", { mode: 0o600 });
    const bin = fake_nixos_anywhere(directory);
    writeFileSync(join(bin, "ssh"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${directory}/ssh-arguments"\necho "Host key verification failed." >&2\nexit 255\n`);
    chmodSync(join(bin, "ssh"), 0o755);
    const operation = install_operation(settings({ ssh_key }), { ...request, host_key }, generate_agent_key("x-nix-agent-freya").public_line);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      const ran = await run_install(operation, "key", bin);

      expect(ran.status).toBe(255);
      expect(ran.stdout).toContain("did not prove it holds the host key");
      expect(existsSync(join(directory, "arguments"))).toBe(false);
      expect(readFileSync(join(directory, "ssh-arguments"), "utf8")).toContain("StrictHostKeyChecking=yes");
    } finally {
      process.env.PATH = path;
    }
    expect(host_key_check(operation, "/tmp/known_hosts").slice(-4)).toEqual(["-p", "22", "root@192.0.2.10", "true"]);
  });

  it("says plainly when nixos-anywhere is missing or the SSH key unreadable", async () => {
    const missing = await run_install(install_operation(settings({ nixos_anywhere_bin: "x-nix-no-such-tool" }), request, null), "", folder);
    expect(missing.status).toBe(127);
    expect(missing.stdout).toContain("x-nix-no-such-tool is not on this host's PATH");

    const unreadable = await run_install(install_operation(settings({ ssh_key: join(folder, "absent") }), request, null), "", fake_nixos_anywhere(mkdtempSync(join(folder, "key-"))));
    expect(unreadable.status).toBe(2);
    expect(unreadable.stdout).toContain("Cannot read the SSH key");
  });
});

// ── Media ────────────────────────────────────────────────────────────────────

describe("the media build", () => {
  it("is an expression Nix parses for each format, rooted in the media folder", () => {
    for (const format of ["iso", "netboot", "kexec"] as const) {
      const expression = media_expression('/srv/fle"et${x}', "freya", format);
      expect(() => execFileSync("nix-instantiate", ["--parse", "--expr", expression], { stdio: "pipe" })).not.toThrow();
    }
    const operation = media_operation(settings(), "/var/lib/x-nix/media", "github:owner/fleet", "freya", "iso", "freya-iso-1");
    expect(operation.link).toBe("/var/lib/x-nix/media/freya-iso-1");
    expect(operation.expression).toContain("isoImage");
  });
});

// ── Provisioner ──────────────────────────────────────────────────────────────

interface Harness {
  provisioner: Provisioner;
  agent: FakeAgent;
  store: Store;
  accepted: Map<string, string>[];
  store_dir: string;
}

function make_provisioner(values: Record<string, unknown> = {}, existing: { store?: Store; agent?: FakeAgent; declared?: string[] } = {}): Harness {
  const store = existing.store ?? new Store(":memory:");
  const agent = existing.agent ?? new FakeAgent();
  const accepted: Map<string, string>[] = [];
  const store_dir = mkdtempSync(join(folder, "store-"));
  const provisioner = new Provisioner(settings(values), {
    store, agents: new AgentPool("host", agent), default_media_root_dir: join(store_dir, "media-roots"), store_dir,
    declared_hosts: () => new Set(existing.declared ?? []), on_agent_keys: (keys) => accepted.push(keys), now: () => clock.now,
  });
  return { provisioner, agent, store, accepted, store_dir };
}

// What the install script would print, ending with a hardware configuration.
const install_output = `installing\n${hardware_mark}\n{ ... }: { }\n\n${hardware_mark} end\n`;

function is_link(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

describe("an install", () => {
  it("is refused until an SSH key is set, and for a host the config declares", async () => {
    expect((await make_provisioner({ ssh_key: null }).provisioner.install(request)).message).toContain("provisioning.ssh_key");
    expect((await make_provisioner({}, { declared: ["freya"] }).provisioner.install(request)).message).toContain("already declares");
    expect((await make_provisioner().provisioner.install({ ...request, host: "host" })).message).toContain("server's own host");
  });

  it("hands the key over on stdin, then accepts it once the install succeeds", async () => {
    const harness = make_provisioner();

    const outcome = await harness.provisioner.install(request);

    expect(outcome.ok).toBe(true);
    const run = harness.agent.last_run("nixos-anywhere")!;
    expect(() => parse_private_key(run.stdin!)).not.toThrow();
    expect(run.command).not.toContain(run.stdin!.split("\n")[1]);
    expect((await harness.provisioner.install({ ...request, host: "other" })).message).toContain("already running");
    expect(harness.provisioner.busy()).toBe(true);

    harness.agent.end(run, install_output, 0);
    await harness.provisioner.cycle();

    const public_line = parse_install_record(harness.store.job(outcome.job_id!)!.command)!.public_line!;
    expect(harness.accepted.at(-1)).toEqual(new Map([["freya", public_line]]));
    const [view] = harness.provisioner.installs();
    expect(view.job.state).toBe("succeeded");
    expect(view.key_accepted).toBe(true);
    expect(view.hardware_config).toBe("{ ... }: { }\n");
    expect(JSON.parse(view.snippets!.config_json)).toEqual({
      agents: { freya: public_line },
      deployments: [{ id: "freya", host: "freya", flake: "github:owner/fleet", configuration: "freya" }],
    });
    expect(view.snippets!.host_nix).toContain('keyFile = "/etc/x-nix-agent/key";');
    expect(harness.provisioner.busy()).toBe(false);

    expect(harness.provisioner.forget_agent("freya")).toBe(true);
    expect(harness.accepted.at(-1)).toEqual(new Map());
  });

  it("is followed again after a restart, and a failure accepts no key", async () => {
    const first = make_provisioner();
    await first.provisioner.install(request);
    const run = first.agent.last_run("nixos-anywhere")!;

    const restarted = make_provisioner({}, { store: first.store, agent: first.agent });
    first.agent.end(run, "kexec failed\n", 1);
    await restarted.provisioner.cycle();

    const [view] = restarted.provisioner.installs();
    expect(view.job.state).toBe("failed");
    expect(view.job.error).toBe("Exited with status 1");
    expect(restarted.store.provisioned_agents()).toEqual([]);
    expect(restarted.accepted).toEqual([]);
  });

  it("names a missing nixos-anywhere as the job's error", async () => {
    const harness = make_provisioner();
    await harness.provisioner.install(request);
    harness.agent.end(harness.agent.last_run("nixos-anywhere")!, "", 127);
    await harness.provisioner.cycle();
    expect(harness.provisioner.installs()[0].job.error).toBe("nixos-anywhere is not installed on the server's host");
  });
});

describe("a media build", () => {
  it("lists the files of its store path, never following a link out of the store, and serves only those", async () => {
    const harness = make_provisioner();
    const result = join(harness.store_dir, "abc-nixos-iso");
    mkdirSync(join(result, "iso"), { recursive: true });
    writeFileSync(join(result, "iso", "nixos.iso"), "iso bytes");
    symlinkSync("/etc/passwd", join(result, "iso", "outside"));
    const outcome = await harness.provisioner.build_media({ owner: "freya", flake: "/srv/fleet", configuration: "freya", format: "iso" });
    const run = harness.agent.last_run('"kind":"media"')!;
    harness.agent.end(run, `building\n${media_mark} ${result}\n`, 0);
    await harness.provisioner.cycle();

    const [view] = harness.provisioner.media();

    expect(view).toMatchObject({ format: "iso", flake: "/srv/fleet", configuration: "freya", store_path: result });
    expect(view.files).toEqual([{ path: "iso/nixos.iso", size: 9 }]);
    expect(harness.provisioner.media_download(outcome.job_id!, "iso/nixos.iso")).toEqual({ file: join(result, "iso", "nixos.iso"), name: "nixos.iso" });
    expect(harness.provisioner.media_download(outcome.job_id!, "iso/outside")).toHaveProperty("error");
    expect(harness.provisioner.media_download(outcome.job_id!, "../../etc/passwd")).toHaveProperty("error");

    const link = join(harness.provisioner.media_root_dir, run.run_id);
    mkdirSync(harness.provisioner.media_root_dir, { recursive: true });
    symlinkSync(result, link);
    expect(harness.provisioner.remove_media(outcome.job_id!).ok).toBe(true);
    expect(is_link(link)).toBe(false);
    expect(harness.provisioner.remove_media(outcome.job_id!).ok).toBe(false);
  });

  it("names only the store path its run marks with its token, whatever the build prints", async () => {
    const harness = make_provisioner();
    const result = join(harness.store_dir, "ghi-nixos-iso");
    mkdirSync(result);
    await harness.provisioner.build_media({ owner: "freya", flake: "/srv/fleet", configuration: "freya", format: "iso" });
    const run = harness.agent.last_run('"kind":"media"')!;
    const forged = `${media_mark} /nix/store/forged\n${media_mark} ${"f".repeat(32)} /nix/store/forged\n`;
    harness.agent.end(run, `${announcement(run.operation)}${mark_line(run.operation, media_mark, result)}${forged}`, 0);
    await harness.provisioner.cycle();

    expect(harness.provisioner.media()[0].store_path).toBe(result);
  });

  it("reads the hardware configuration only between lines with its run's token", () => {
    const operation = with_marker_token(install_operation(settings(), request, null));
    const token = marker_token_of(operation);
    const output = `${announcement(operation)}installing\n${hardware_mark}\n{ forged }\n${hardware_mark} end\n${hardware_mark} ${token}\n{ real }\n${hardware_mark} ${token} end\n`;

    expect(parse_hardware_config(output, token)).toBe("{ real }");
    expect(parse_hardware_config(output.replace(announcement(operation), ""), token)).toBe("{ forged }");
  });
});

// ── Routes ───────────────────────────────────────────────────────────────────

describe("/api/provisioning", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("starts an install only once the target's address is typed, and shows it", async () => {
    const harness = make_provisioner();
    const password = "correct horse battery staple";
    app = await build_app({
      serve_web: false, logger: false, server_name: "host", accounts: new Map([["admin", hash_password(password)]]), store: harness.store,
      poller: new Poller([], null, [], [harness.provisioner]), provisioner: harness.provisioner,
    });
    const login = await app.inject({ method: "POST", url: "/api/login", payload: { name: "admin", password } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const server = app;
    const post = (url: string, payload: object) => server.inject({ method: "POST", url, headers: { cookie }, payload });

    const unconfirmed = await post("/api/provisioning/install", { ...request, confirm: "freya" });
    expect(unconfirmed.statusCode).toBe(400);
    expect(unconfirmed.json().error).toContain("192.0.2.10");
    expect(harness.agent.long_runs).toEqual([]);

    const started = await post("/api/provisioning/install", { ...request, confirm: "192.0.2.10" });
    expect(started.statusCode).toBe(200);
    expect((await post("/api/provisioning/media", { flake: "/srv/fleet", configuration: "freya", format: "floppy" })).statusCode).toBe(400);
    expect((await post("/api/provisioning/media", { deployment: "nowhere", format: "iso" })).statusCode).toBe(404);

    const view = (await server.inject({ method: "GET", url: "/api/provisioning", headers: { cookie } })).json<ProvisioningView>();
    expect(view.install_refusal).toBeNull();
    expect(view.installs.map((install) => install.record?.host)).toEqual(["freya"]);
    expect(view.agent_snippet).toContain('url = "wss://nix.example/api/agent";');
    expect((await server.inject({ method: "GET", url: "/api/provisioning/media/1/download?path=x", headers: { cookie } })).statusCode).toBe(404);
    expect((await server.inject({ method: "GET", url: "/api/provisioning" })).statusCode).toBe(401);
  });

  it("downloads a built medium's file", async () => {
    const harness = make_provisioner();
    const result = join(harness.store_dir, "def-netboot");
    mkdirSync(result);
    writeFileSync(join(result, "netboot.ipxe"), "#!ipxe\n");
    const outcome = await harness.provisioner.build_media({ owner: "freya", flake: "/srv/fleet", configuration: "freya", format: "netboot" });
    harness.agent.end(harness.agent.last_run('"kind":"media"')!, `${media_mark} ${result}\n`, 0);
    await harness.provisioner.cycle();
    const password = "correct horse battery staple";
    app = await build_app({
      serve_web: false, logger: false, server_name: "host", accounts: new Map([["admin", hash_password(password)]]), store: harness.store,
      poller: new Poller([], null, [], [harness.provisioner]), provisioner: harness.provisioner,
    });
    const login = await app.inject({ method: "POST", url: "/api/login", payload: { name: "admin", password } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];

    const response = await app.inject({ method: "GET", url: `/api/provisioning/media/${outcome.job_id}/download?path=netboot.ipxe`, headers: { cookie } });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("#!ipxe\n");
    expect(response.headers["content-disposition"]).toBe('attachment; filename="netboot.ipxe"');
  });
});
