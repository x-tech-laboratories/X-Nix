import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { chosen_commands, host_file_variable, read_host, sent_commands, start_host_unit, type HostDeclarations } from "../src/agent/host_commands.ts";
import { perform } from "../src/agent/operations/index.ts";
import { switch_system } from "../src/agent/operations/switch.ts";
import type { Context, ProgramResult, RunProgram } from "../src/agent/programs.ts";
import { ConfigError, deployment_settings, host_settings } from "../src/server/config.ts";
import { command_text_settings } from "../src/server/deployment.ts";
import { collect_operation, host_gc_unit } from "../src/server/nixos/garbage.ts";
import { switch_job_operation } from "../src/server/nixos/switch.ts";
import type { GcSettings } from "../src/server/config.ts";
import type { SwitchOperation } from "../src/shared/operations.ts";

// ── Setup ────────────────────────────────────────────────────────────────────

const folders: string[] = [];
const default_file = process.env[host_file_variable];

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  process.env[host_file_variable] = default_file;
});

const script = "/nix/store/0123456789abcdfghijklmnpqrsvwxyz-x-nix-post-switch-phosh";

const declared: HostDeclarations = {
  switch_commands: {
    pre_switch_checks: { "boot-space": "test 1 -lt 90" },
    health_commands: { sshd: "systemctl is-active --quiet sshd.service" },
    post_switch: { phosh: script },
  },
  units: [host_gc_unit],
};

// Writes the host's declarations where the agent reads them for this test.
function declare(host: unknown): void {
  const folder = mkdtempSync(join(tmpdir(), "x-nix-host-"));
  folders.push(folder);
  writeFileSync(join(folder, "host.json"), JSON.stringify(host));
  process.env[host_file_variable] = join(folder, "host.json");
}

function fake_context(answer: (argv: string[]) => Partial<ProgramResult> = () => ({})) {
  const ran: string[][] = [];
  let output = "";
  const sink = { write: (chunk: Buffer | string) => void (output += chunk.toString()) };
  const program: RunProgram = async (context, argv, options = {}) => {
    ran.push(argv);
    const result = { exit_code: 0, stdout: "", stderr: "", ...answer(argv) };
    if ((options.stdout ?? "show") === "show") context.out.write(result.stdout);
    return result;
  };
  const context: Context = { out: sink, err: sink, signal: new AbortController().signal, own_groups: false, log: true, stdin: null, program };
  return { context, ran, output: () => output };
}

function plain_switch(values: Partial<SwitchOperation> = {}): SwitchOperation {
  return { kind: "switch", mode: "switch", activation_name: "nixos-rebuild switch", steps: [{ argv: ["nixos-rebuild", "switch"] }], post_switch: null, pre_switch_checks: [], watch: null, ...values };
}

function settings(values: Record<string, unknown> = {}) {
  return deployment_settings({ id: "example", flake: "/etc/nixos", ...values }, 0, undefined, () => host_settings({ id: "example" }));
}

// ── Choosing ─────────────────────────────────────────────────────────────────

describe("the host's own switch commands", () => {
  it("run the server's text on a host that declares none, saying it is deprecated, and skip names", () => {
    const chosen = chosen_commands("health_commands", sent_commands(["true"]), ["sshd"], false, { switch_commands: null, units: [] });
    expect(chosen.commands).toEqual([{ label: "true", argv: ["/bin/sh", "-c", "true"] }]);
    expect(chosen.notes.join("\n")).toContain("deprecated");
    expect(chosen.notes.join("\n")).toContain("sshd are skipped");
  });

  it("run only what the host declares: the names given, or all of a kind the server sent text for", () => {
    expect(chosen_commands("post_switch", [], ["phosh"], true, declared).commands).toEqual([{ label: "phosh", argv: ["sudo", "-n", script] }]);
    const instead = chosen_commands("health_commands", sent_commands(["rm -rf /"]), [], false, declared);
    expect(instead.commands).toEqual([{ label: "sshd: systemctl is-active --quiet sshd.service", argv: ["/bin/sh", "-c", "systemctl is-active --quiet sshd.service"] }]);
    expect(instead.notes.join("\n")).toContain("rather than the text the server sent");
    expect(chosen_commands("pre_switch_checks", [], [], false, declared).commands).toEqual([]);
    expect(chosen_commands("pre_switch_checks", [], ["other"], false, declared).missing).toEqual(["other"]);
  });

  it("read the host's file, keeping only well-named commands, and nothing from a missing or broken one", () => {
    declare({ switch_commands: { post_switch: { phosh: script, "bad name": "/x" } }, units: [host_gc_unit, 3] });
    expect(read_host()).toEqual({ switch_commands: { pre_switch_checks: {}, health_commands: {}, post_switch: { phosh: script } }, units: [host_gc_unit] });
    declare({ switch_commands: null });
    expect(read_host()).toEqual({ switch_commands: null, units: [] });
    process.env[host_file_variable] = "/nonexistent/host.json";
    expect(read_host()).toEqual({ switch_commands: null, units: [] });
  });
});

// ── Switching ────────────────────────────────────────────────────────────────

describe("a switch on a host that declares its commands", () => {
  it("runs the named post_switch script under sudo and never the server's shell text", async () => {
    declare(declared);
    const { context, ran } = fake_context();
    const status = await switch_system(context, plain_switch({ post_switch: ["sudo", "-n", "/bin/sh", "-c", "id"], host_commands: { pre_switch_checks: [], post_switch: ["phosh"], sudo: true } }));
    expect(status).toBe(0);
    expect(ran).toContainEqual(["sudo", "-n", script]);
    expect(ran.some((argv) => argv.includes("/bin/sh"))).toBe(false);
  });

  it("refuses a switch whose pre-switch check the host does not declare, before anything changes", async () => {
    declare(declared);
    const { context, ran, output } = fake_context();
    const status = await switch_system(context, plain_switch({ host_commands: { pre_switch_checks: ["missing"], post_switch: [], sudo: true } }));
    expect(status).toBe(3);
    expect(output()).toContain("refused This host declares no pre-switch check named missing");
    expect(ran).toEqual([]);
  });

  it("still runs the server's post_switch on a host that declares none", async () => {
    const { context, ran, output } = fake_context();
    await switch_system(context, plain_switch({ post_switch: ["sudo", "-n", "/bin/sh", "-c", "true"] }));
    expect(ran).toContainEqual(["sudo", "-n", "/bin/sh", "-c", "true"]);
    expect(output()).toContain("deprecated");
  });

  it("is built by the server with the names its settings give, and refuses a bad name", () => {
    const operation = switch_job_operation(settings({ host_pre_switch_checks: ["boot-space"], host_post_switch: ["phosh"], host_health_commands: ["sshd"] }), "switch", "ab12") as SwitchOperation;
    expect(operation.host_commands).toEqual({ pre_switch_checks: ["boot-space"], post_switch: ["phosh"], sudo: true });
    expect(operation.watch?.host_health_commands).toEqual(["sshd"]);
    expect(operation.watch).not.toBeNull();
    expect((switch_job_operation(settings(), "switch", "ab12") as SwitchOperation).host_commands).toBeUndefined();
    expect(() => settings({ host_post_switch: ["a b"] })).toThrow(ConfigError);
  });

  it("names the deprecated settings that still send command text", () => {
    expect(command_text_settings(settings({ post_switch: "true", health_commands: ["true"] }))).toEqual(["health_commands", "post_switch"]);
    expect(command_text_settings(settings({ host_post_switch: ["phosh"] }))).toEqual([]);
  });
});

// ── Garbage collection ───────────────────────────────────────────────────────

describe("garbage collection", () => {
  const gc = { gc_bin: "nix-collect-garbage", gc_args: ["--delete-older-than", "7d"] } as GcSettings;
  const invocation = "0123456789abcdef0123456789abcdef";
  const answer = (argv: string[]) => (argv[0] === "systemctl" && argv[1] === "show" ? { stdout: `${invocation}\n` } : {});

  it("starts the host's fixed unit and shows its log when the host declares it", async () => {
    declare(declared);
    const { context, ran } = fake_context(answer);
    expect(await perform(context, collect_operation(gc, true))).toBe(0);
    expect(ran).toEqual([
      ["sudo", "-n", "systemctl", "start", host_gc_unit],
      ["systemctl", "show", "--property=InvocationID", "--value", host_gc_unit],
      ["journalctl", "--no-pager", "--output=cat", `_SYSTEMD_INVOCATION_ID=${invocation}`],
    ]);
  });

  it("runs the server's command on a host without the unit, and answers the unit's failure", async () => {
    const { context, ran } = fake_context(answer);
    await perform(context, collect_operation(gc, true));
    expect(ran).toEqual([["sudo", "-n", "nix-collect-garbage", "--delete-older-than", "7d"]]);

    const failing = fake_context((argv) => (argv[1] === "-n" ? { exit_code: 1 } : {}));
    expect(await start_host_unit(failing.context, { unit: host_gc_unit, sudo: true })).toBe(1);
    expect(failing.ran).toHaveLength(2);
  });
});
