import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LongRuns } from "@x-tech-laboratories/x-libs/agent/long_runs";
import { describe, expect, it } from "vitest";

import { local_update } from "../src/agent/operations/deploy.ts";
import type { Context, ProgramOptions, ProgramResult, RunProgram } from "../src/agent/programs.ts";
import { operation_runner, run_unit } from "../src/agent/tasks.ts";
import { deployment_settings, flake_settings, host_settings } from "../src/server/config.ts";
import { next_boot_operation } from "../src/server/nixos/boot.ts";
import { cache_switch_steps, update_operation } from "../src/server/nixos/commands.ts";
import { rollback_operation } from "../src/server/nixos/switch.ts";
import type { LocalUpdateOperation, Operation, ProgramsOperation } from "../src/shared/operations.ts";

// ── Setup ────────────────────────────────────────────────────────────────────

// The argument patterns nix/sudo-rules.nix writes into the sudo rules, with the agent module's defaults filled in.
const patterns = JSON.parse(readFileSync(new URL("../nix/sudo-patterns.json", import.meta.url), "utf8")) as Record<string, string>;

const agent_state_directory = "/var/lib/x-nix-agent";

function pattern(name: string, run_unit_properties: Record<string, string> = { UMask: "0077" }): RegExp {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const properties = Object.entries(run_unit_properties).map(([key, value]) => `|${escape(`${key}=${value}`)}`).join("");
  const filled = patterns[name]!
    .replaceAll("@uid@", "[1-9][0-9]*")
    .replaceAll("@gid@", "[1-9][0-9]*")
    .replaceAll("@runs@", escape(`${agent_state_directory}/runs`))
    .replaceAll("@properties@", properties);
  return new RegExp(filled);
}

// Whether a rule allows a command run under `sudo -n`, by the arguments sudo joins with spaces and matches.
function allowed(name: string, argv: string[], run_unit_properties?: Record<string, string>): boolean {
  expect(argv.slice(0, 2)).toEqual(["sudo", "-n"]);
  return pattern(name, run_unit_properties).test(argv.slice(3).join(" "));
}

function settings(values: Record<string, unknown> = {}) {
  return deployment_settings({ id: "odin-deploy", flake: "/etc/nixos", ...values }, 0, undefined, () => host_settings({ id: "odin" }));
}

const system = "/nix/store/0123456789abcdfghijklmnpqrsvwxyz-nixos-system-odin-26.05.20261120.abcdef0";

// ── Code and rules agree ─────────────────────────────────────────────────────

describe("the sudo rules", () => {
  it("allow the system profile set and the rollback the server asks for, and nothing else", () => {
    const [set] = cache_switch_steps(settings(), system, "switch").map((step) => step.argv).filter((argv) => argv.includes("--set"));
    expect(allowed("set_system_profile", set!)).toBe(true);
    const [reset] = (rollback_operation(settings(), 41, "test") as ProgramsOperation).steps.map((step) => step.argv);
    expect(allowed("switch_generation", reset!)).toBe(true);

    expect(pattern("set_system_profile").test("-p /nix/var/nix/profiles/system --set /nix/store/0123456789abcdfghijklmnpqrsvwxyz-evil")).toBe(false);
    expect(pattern("set_system_profile").test(`-p /nix/var/nix/profiles/system --set ${system} --option x y`)).toBe(false);
    expect(pattern("switch_generation").test("-p /nix/var/nix/profiles/system --switch-generation 0")).toBe(false);
    expect(pattern("switch_generation").test("-p /nix/var/nix/profiles/other --switch-generation 4")).toBe(false);
  });

  it("allow copying the checked lock over a local checkout's, and no other copy", async () => {
    const checkout = mkdtempSync(join(tmpdir(), "x-nix-checkout-"));
    writeFileSync(join(checkout, "flake.lock"), "old");
    const operation = update_operation(flake_settings({ id: "config", url: checkout }), ["packages.x86_64-linux.tool"]) as LocalUpdateOperation;
    const ran: string[][] = [];
    const program: RunProgram = async (_context, argv, _options?: ProgramOptions): Promise<ProgramResult> => {
      ran.push(argv);
      if (argv.includes("--output-lock-file")) writeFileSync(argv[argv.indexOf("--output-lock-file") + 1]!, "new");
      return { exit_code: 0, stdout: "", stderr: "" };
    };
    const sink = { write: () => {} };
    const context: Context = { out: sink, err: sink, signal: new AbortController().signal, own_groups: false, log: false, stdin: null, program };

    expect(await local_update(context, operation)).toBe(0);
    expect(allowed("copy_checked_lock", ran.at(-1)!)).toBe(true);
    rmSync(checkout, { recursive: true });

    expect(pattern("copy_checked_lock").test("-T /tmp/x-nix-update-abcdef/flake.lock /etc/shadow")).toBe(false);
    expect(pattern("copy_checked_lock").test("-T /etc/shadow /tmp/flake.lock")).toBe(false);
  });

  it("allow stopping lock holders by pid, but never PID 1, a process group or a signal of the agent's choosing", () => {
    expect(allowed("kill_term", ["sudo", "-n", "kill", "-TERM", "1234", "56"])).toBe(true);
    expect(allowed("kill_kill", ["sudo", "-n", "kill", "-KILL", "1234"])).toBe(true);
    expect(pattern("kill_term").test("-TERM 1")).toBe(false);
    expect(pattern("kill_term").test("-TERM -1")).toBe(false);
    expect(pattern("kill_term").test("-TERM 12 -HUP 1")).toBe(false);
  });

  it("allow setting the next boot entry each loader names, but no option to the loader's tool", () => {
    const boot = (loader: "systemd-boot" | "grub" | "efi", entry: string) => (next_boot_operation({ loader, entries: [], default: null, next: null } as never, entry, false, true) as ProgramsOperation).steps[0]!.argv;
    expect(allowed("set_oneshot_entry", boot("systemd-boot", "nixos-generation-42.conf"))).toBe(true);
    expect(allowed("grub_reboot_entry", boot("grub", "NixOS - All configurations>NixOS - Configuration 42 (2026-11-20)"))).toBe(true);
    expect(allowed("efi_boot_next", boot("efi", "0003"))).toBe(true);

    expect(pattern("set_oneshot_entry").test("set-oneshot x --esp-path=/tmp")).toBe(false);
    expect(pattern("grub_reboot_entry").test("entry --boot-directory=/tmp")).toBe(false);
    expect(pattern("efi_boot_next").test("--bootnext 0003 --create")).toBe(false);
  });

  it("allow starting a run's unit as the agent's runner exactly as X-Libs starts it, and stopping it", () => {
    const state = mkdtempSync(join(tmpdir(), "x-nix-runs-"));
    const recorded = join(state, "argv.json");
    // A stand-in for systemd-run that writes down the arguments it was given.
    const recorder = join(state, "recorder.mjs");
    writeFileSync(recorder, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(recorded)}, JSON.stringify(process.argv.slice(2)));\n`);
    const unit = { ...run_unit({ slice: "nix-work.slice", properties: { UMask: "0077" } }, {}), start_command: [process.execPath, recorder], show_command: ["true"] };
    const runs = new LongRuns<Operation>(state, operation_runner, { unit });
    runs.start("job-12.a_b", { kind: "generations" }, null);

    // The runner is the agent package's, in the store, under the module's state directory.
    const argv = (JSON.parse(readFileSync(recorded, "utf8")) as string[]).map((argument) => argument.replaceAll(state, agent_state_directory));
    const tail = argv.indexOf("--");
    argv.splice(tail + 1, 2, "/nix/store/0123456789abcdfghijklmnpqrsvwxyz-nodejs-24.11.1/bin/node",
      "/nix/store/0123456789abcdfghijklmnpqrsvwxyz-x-nix-agent-0.1.0/lib/x-nix-agent/src/agent/runner.ts");
    expect(allowed("start_run_unit", ["sudo", "-n", "systemd-run", ...argv])).toBe(true);
    expect(allowed("stop_run_unit", [...unit.stop_command!, "x-nix-run-job-12.a_b.service"])).toBe(true);
    rmSync(state, { recursive: true });

    const started = `--unit=x-nix-run-a.service --quiet --collect --uid=990 --gid=990 --working-directory=${agent_state_directory}/runs/a`;
    const runner = "-- /nix/store/0123456789abcdfghijklmnpqrsvwxyz-n/bin/node /nix/store/0123456789abcdfghijklmnpqrsvwxyz-a/lib/x-nix-agent/src/agent/runner.ts";
    expect(pattern("start_run_unit").test(`${started} ${runner} ${agent_state_directory}/runs/a`)).toBe(true);
    expect(pattern("start_run_unit").test(`${started.replace("--uid=990", "--uid=0")} ${runner} ${agent_state_directory}/runs/a`)).toBe(false);
    expect(pattern("start_run_unit").test(`${started} --property User=root ${runner} ${agent_state_directory}/runs/a`)).toBe(false);
    expect(pattern("start_run_unit").test(`${started} -- /bin/sh -c id`)).toBe(false);
    expect(pattern("stop_run_unit").test("stop x-nix-run-a.service sshd.service")).toBe(false);
  });
});
