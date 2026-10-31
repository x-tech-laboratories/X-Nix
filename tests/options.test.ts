import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { AgentPool, type RunResult } from "../src/server/agents/agent.ts";
import { LocalAgent } from "../src/server/agents/local.ts";
import { Catalog } from "../src/server/catalog.ts";
import { ConfigError, deployment_settings } from "../src/server/config.ts";
import { Configurator, flatten, import_line, serialise, set_in_tree, simple_kind, value_refusal } from "../src/server/configurator.ts";
import { Deployment } from "../src/server/deployment.ts";
import { changed_exit_code, content_hash, edit_refusal, read_file_command, write_file_command } from "../src/server/nixos/flake_files.ts";
import {
  cleanup_command, compact_options, compact_packages, option_path, options_command, parse_generated, search, value_command, type OptionEntry,
} from "../src/server/nixos/options.ts";
import { Store } from "../src/server/store.ts";
import { clock, FakeAgent, make_deployment, result } from "./fake_agent.ts";

// ── Setup ────────────────────────────────────────────────────────────────────

const nixpkgs = `/nix/store/${"a".repeat(32)}-source`;

function settings(values: Record<string, unknown> = {}) {
  return deployment_settings({ id: "odin", flake: "/etc/nixos", configuration: "odin", ...values });
}

function fake_programs(programs: Record<string, string>): string {
  const folder = join(mkdtempSync(join(tmpdir(), "x-nix-options-test-")), "bin");
  mkdirSync(folder);
  for (const [name, script] of Object.entries(programs)) {
    writeFileSync(join(folder, name), `#!/bin/sh\n${script}\n`);
    chmodSync(join(folder, name), 0o755);
  }
  return folder;
}

function option(values: Partial<OptionEntry> = {}): OptionEntry {
  return { name: "services.openssh.enable", source: "nixos", type: "boolean", default: "false", example: null, description: "", declared_in: [], read_only: false, ...values };
}

// A git checkout with one commit, standing in for a deployment's local flake.
function local_flake(): string {
  const folder = mkdtempSync(join(tmpdir(), "x-nix-flake-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", folder, "-c", "user.name=Test", "-c", "user.email=test@localhost", ...args], { stdio: "ignore" });
  git("init", "--quiet");
  writeFileSync(join(folder, "flake.nix"), "{ outputs = _: { }; }\n");
  git("add", "flake.nix");
  git("commit", "--quiet", "-m", "init");
  return folder;
}

// ── Generating ───────────────────────────────────────────────────────────────

describe("generating the option lists", () => {
  const nix = fake_programs({
    nix: [
      'case "$*" in',
      `  *pkgs.path*) printf %s ${nixpkgs} ;;`,
      "  *nixos.revision*) printf %s 0123456789abcdef ;;",
      "  *hostPlatform*) printf %s x86_64-linux ;;",
      `  *optionsJSON*) echo /nix/store/${"b".repeat(32)}-options ;;`,
      "  *hasAttr*) echo true ;;",
      `  *docs-json*) echo /nix/store/${"c".repeat(32)}-hm ;;`,
      '  search*) echo "$*" >&2; echo "{}" ;;',
      "esac",
    ].join("\n"),
  });

  it("names each file it made, from the configuration's own pin and Home Manager input", () => {
    const run = spawnSync("sh", ["-c", options_command(settings({ nix_bin: join(nix, "nix"), nix_args: [] }), "odin", 60, [])], { encoding: "utf8" });

    const files = parse_generated(run.stdout);
    expect(run.status).toBe(0);
    expect(files.nixpkgs).toBe(nixpkgs);
    expect(files.revision).toBe("0123456789abcdef");
    expect(files.nixos).toBe(`/nix/store/${"b".repeat(32)}-options/share/doc/nixos/options.json`);
    expect(files.home_manager).toBe(`/nix/store/${"c".repeat(32)}-hm/share/doc/home-manager/options.json`);
    expect(files.packages).toMatch(/x-nix-options\.\w+\/packages\.json$/);
    expect(run.stderr).toContain(`path:${nixpkgs}#legacyPackages.x86_64-linux`);
    expect(cleanup_command(files.folder!)).toContain("rm -rf");
  });

  it("skips the package search for a pin already kept", () => {
    const run = spawnSync("sh", ["-c", options_command(settings({ nix_bin: join(nix, "nix"), nix_args: [] }), "odin", 60, ["a".repeat(32)])], { encoding: "utf8" });

    expect(parse_generated(run.stdout).packages).toBe("cached");
    expect(run.stderr).not.toContain("search");
  });

  it("removes only its own temporary folder", () => {
    expect(cleanup_command("/tmp/x-nix-options.AbC123")).toBe("rm -rf /tmp/x-nix-options.AbC123");
    expect(cleanup_command("/home")).toBeNull();
    expect(cleanup_command("/tmp/../x-nix-options.a")).toBeNull();
  });
});

// ── Lists ────────────────────────────────────────────────────────────────────

describe("the kept lists", () => {
  it("keep each option's type, default, example, description and where it is declared", () => {
    const entries = compact_options({
      "services.openssh.enable": { type: "boolean", default: { _type: "literalExpression", text: "false" }, description: "Whether to enable sshd.", declarations: ["nixos/modules/services/networking/ssh/sshd.nix"], readOnly: false },
      "programs.git.enable": { type: "boolean", default: false, example: true, declarations: [{ name: "<home-manager/modules/programs/git.nix>", url: "https://example" }] },
      "_module.args": { type: "attribute set", internal: true },
    }, "nixos");

    expect(entries.map((entry) => entry.name)).toEqual(["programs.git.enable", "services.openssh.enable"]);
    expect(entries[1]).toMatchObject({ default: "false", description: "Whether to enable sshd.", declared_in: ["nixos/modules/services/networking/ssh/sshd.nix"] });
    expect(entries[0]).toMatchObject({ default: "false", example: "true", declared_in: ["<home-manager/modules/programs/git.nix>"] });
  });

  it("keep packages by attribute without the system prefix", () => {
    expect(compact_packages({ "legacyPackages.x86_64-linux.hello": { pname: "hello", version: "2.12", description: "Says hello" } })).toEqual([
      { attribute: "hello", name: "hello", version: "2.12", description: "Says hello" },
    ]);
  });

  it("rank an exact name first, then a name ending in the query, then descriptions", () => {
    const entries = ["networking.firewall.enable", "services.openssh.enable", "services.openssh.settings.PermitRootLogin", "programs.ssh.startAgent"].map((name) => option({ name, description: name === "programs.ssh.startAgent" ? "Uses openssh agent" : "" }));

    const found = search(entries, "openssh", (entry) => entry.name, (entry) => entry.description, 10);

    expect(found.total).toBe(3);
    expect(found.entries.map((entry) => entry.name)).toEqual(["services.openssh.enable", "services.openssh.settings.PermitRootLogin", "programs.ssh.startAgent"]);
    expect(search(entries, "services.openssh.enable", (entry) => entry.name, () => "", 1).entries[0].name).toBe("services.openssh.enable");
  });

  it("evaluate a current value only for an option naming one", () => {
    expect(option_path("users.users.<name>.isNormalUser")).toBeNull();
    expect(value_command(settings(), "odin", option_path("services.openssh.enable")!)).toContain('nixosConfigurations.\\"odin\\".\\"config\\".\\"services\\".\\"openssh\\".\\"enable\\"');
  });
});

// ── Catalog ──────────────────────────────────────────────────────────────────

describe("the catalog", () => {
  // An agent whose fetches answer with gzipped lists, as the host would print them.
  class ListingAgent extends FakeAgent {
    files = new Map<string, unknown>();
    override async run(command: string): Promise<RunResult> {
      this.commands.push(command);
      for (const [path, value] of this.files) {
        if (command.includes(path) && command.startsWith("gzip")) return result(0, gzipSync(JSON.stringify(value)).toString("base64"));
      }
      return result(0);
    }
  }

  it("generates on the evaluating host, then keeps the lists it fetches under the pin and removes the host's folder", async () => {
    const agent = new ListingAgent();
    const harness = make_deployment({ configuration: "odin" }, { agent });
    const directory = mkdtempSync(join(tmpdir(), "x-nix-catalog-"));
    const catalog = new Catalog(harness.deployment, { store: harness.store, agents: harness.agents, directory, now: () => clock.now });
    agent.files.set("/nix/store/options.json", { "services.openssh.enable": { type: "boolean", description: "Whether to enable sshd." } });
    agent.files.set("/tmp/x-nix-options.abc/packages.json", { "legacyPackages.x86_64-linux.hello": { pname: "hello", version: "2.12", description: "" } });

    const outcome = await catalog.generate("manual");
    agent.end(agent.last_run("optionsJSON")!, [
      "@@x-nix-options folder /tmp/x-nix-options.abc", `@@x-nix-options nixpkgs ${nixpkgs}`, "@@x-nix-options nixos /nix/store/options.json",
      "@@x-nix-options packages /tmp/x-nix-options.abc/packages.json", "",
    ].join("\n"), 0);
    await catalog.follow();

    expect(outcome.ok).toBe(true);
    expect(catalog.info()).toMatchObject({ key: "a".repeat(32), counts: { nixos: 1, home_manager: 0, packages: 1 } });
    expect(catalog.search_options("ssh", "nixos", 10).entries[0].name).toBe("services.openssh.enable");
    expect(catalog.search_packages("hello", 10).total).toBe(1);
    expect(agent.commands).toContain("rm -rf /tmp/x-nix-options.abc");
    expect(harness.store.job(outcome.job_id!)!.output).toContain("Kept 1 NixOS options");
    expect(await catalog.generate("manual")).toMatchObject({ ok: true });
  });
});

// ── Form ─────────────────────────────────────────────────────────────────────

describe("the option form", () => {
  it("sets booleans, integers, strings and enums, and leaves other types to the flake", () => {
    expect(simple_kind("boolean")).toEqual({ kind: "boolean" });
    expect(simple_kind("null or string")).toEqual({ kind: "string" });
    expect(simple_kind("16 bit unsigned integer; between 0 and 65535 (both inclusive)")).toEqual({ kind: "integer", minimum: 0, maximum: 65535 });
    expect(simple_kind("positive integer, meaning >0")).toEqual({ kind: "integer", minimum: 1, maximum: null });
    expect(simple_kind('one of "stable", "latest"')).toEqual({ kind: "enum", choices: ["stable", "latest"] });
    expect(simple_kind("list of string")).toBeNull();
    expect(simple_kind("attribute set of (submodule)")).toBeNull();
  });

  it("refuses a value that does not fit the option's type", () => {
    expect(value_refusal(option(), true)).toBeNull();
    expect(value_refusal(option(), "yes")).toContain("true or false");
    expect(value_refusal(option({ type: "integer between 1 and 10 (both inclusive)" }), 11)).toContain("10 or less");
    expect(value_refusal(option({ type: 'one of "a", "b"' }), "c")).toContain("one of a, b");
    expect(value_refusal(option({ read_only: true }), true)).toContain("read-only");
    expect(value_refusal(option({ name: "users.users.<name>.isNormalUser" }), true)).toContain("no single value");
  });

  it("nests values under their path, prunes emptied parents and writes keys sorted", () => {
    const set = set_in_tree(set_in_tree({}, ["services", "openssh", "enable"], true), ["time", "timeZone"], "UTC");
    const unset = set_in_tree(set, ["services", "openssh", "enable"], null);

    expect(flatten(set)).toEqual({ "services.openssh.enable": true, "time.timeZone": "UTC" });
    expect(unset).toEqual({ time: { timeZone: "UTC" } });
    expect(serialise({ z: 1, a: { c: true, b: "x" } })).toBe('{\n  "a": {\n    "b": "x",\n    "c": true\n  },\n  "z": 1\n}\n');
    expect(import_line("x-nix/odin.json")).toBe("({ lib, ... }: { config = lib.mapAttrsRecursive (_: lib.mkOverride 90) (lib.importJSON ./x-nix/odin.json); })");
  });

  it("takes a plain options_file inside the flake only", () => {
    expect(settings({ options_file: "hosts/odin/x-nix.json" }).options_file).toBe("hosts/odin/x-nix.json");
    expect(() => settings({ options_file: "../outside.json" })).toThrow(ConfigError);
  });

  it("commits each change to the local checkout, then sees the file as X-Nix wrote it", async () => {
    const flake = local_flake();
    const store = new Store(":memory:");
    const agents = new AgentPool("host", new LocalAgent(mkdtempSync(join(tmpdir(), "x-nix-agent-"))));
    const deployment = new Deployment(deployment_settings({ id: "odin", flake, configuration: "odin", commit_author: "X-Nix <x-nix@localhost>" }), { store, agents, now: () => clock.now });
    const configurator = new Configurator(deployment, { store, agents, now: () => clock.now });

    const first = await configurator.set(option(), true, "manual");
    const second = await configurator.set(option({ name: "time.timeZone", type: "null or string" }), "UTC", "manual");
    const again = await configurator.set(option(), true, "manual");
    const view = await configurator.view();

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(again).toMatchObject({ ok: true, job_id: null });
    expect(view.values).toEqual({ "services.openssh.enable": true, "time.timeZone": "UTC" });
    expect(JSON.parse(readFileSync(join(flake, "x-nix/odin.json"), "utf8"))).toEqual({ services: { openssh: { enable: true } }, time: { timeZone: "UTC" } });
    expect(execFileSync("git", ["-C", flake, "log", "--format=%s"], { encoding: "utf8" })).toContain("chore(x-nix): set time.timeZone to \"UTC\"");
    expect(store.job(second.job_id!)!.kind).toBe("configure");
  });

  it("refuses a github: flake with no push key", () => {
    expect(edit_refusal(settings({ flake: "github:owner/config" }))).toContain("push_ssh_key");
    expect(edit_refusal(settings({ flake: "github:owner/config", push_ssh_key: "/k" }))).toBeNull();
  });
});

// ── Flake files ──────────────────────────────────────────────────────────────

describe("a file in the flake", () => {
  const repository = (flake: string) => ({ flake, push_ssh_key: null, commit_author: "X-Nix <x-nix@localhost>" });

  it("is written only when it still has the hash it was read with", () => {
    const flake = local_flake();
    writeFileSync(join(flake, "inventory.json"), "{}");

    const stale = spawnSync("sh", ["-c", write_file_command(repository(flake), "inventory.json", "{\"machines\":{}}\n", "update", "missing")], { encoding: "utf8" });
    const read = spawnSync("sh", ["-c", read_file_command(repository(flake), "inventory.json")], { encoding: "utf8" });

    expect(stale.status).toBe(changed_exit_code);
    expect(stale.stderr).toContain("changed since it was read");
    expect(read.stdout).toBe(`@@x-nix-file present ${content_hash("{}")}\n{}`);
  });

  it("is cloned, committed and pushed back for a github: flake", () => {
    const command = write_file_command({ flake: "github:owner/config/main", push_ssh_key: "/var/lib/x-nix/key", commit_author: "X-Nix <x@localhost>" }, "inventory.json", "{}\n", "chore: inventory", "missing");

    expect(command).toContain("git clone --quiet --depth 1 --branch main git@github.com:owner/config.git");
    expect(command).toContain("push --quiet origin HEAD");
    expect(command).toContain("-c user.email=x@localhost");
  });
});
