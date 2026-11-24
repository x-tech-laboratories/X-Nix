import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { changed_parts } from "../src/agent/operations/switch.ts";
import type { Context } from "../src/agent/programs.ts";

import { ConfigError, deployment_settings, host_settings } from "../src/server/config.ts";
import {
  confirm_operation, kept_awake, parse_generations, rollback_operation, rollback_signal_operation, switch_job_operation, watch_token,
} from "../src/server/nixos/switch.ts";
import type { KeptAwakeOperation, Operation, ProgramsOperation, SwitchOperation } from "../src/shared/operations.ts";
import { host_values, target_closure } from "./fake_agent.ts";

// ── Setup ────────────────────────────────────────────────────────────────────

function settings(values: Record<string, unknown> = {}) {
  const [own, of_host] = host_values(values);
  return deployment_settings({ id: "odin-deploy", flake: "/etc/nixos", ...own }, 0, undefined, () => host_settings({ id: "odin", ...of_host }));
}

// The switch inside any inhibitor.
function switch_of(operation: Operation): SwitchOperation {
  const inner = operation.kind === "kept_awake" ? operation.operation : operation;
  if (inner.kind !== "switch") throw new Error(`${inner.kind} is not a switch`);
  return inner;
}

function token_of(operation: Operation): string | null {
  return watch_token(JSON.stringify(operation));
}

// ── Settings ─────────────────────────────────────────────────────────────────

describe("switch settings", () => {
  it("leave every safety feature off by default", () => {
    const plain = settings();

    expect([plain.magic_rollback, plain.pre_switch_checks, plain.health_commands, plain.health_urls]).toEqual([false, [], [], []]);
    expect([plain.activation_timeout, plain.confirm_timeout, plain.health_period, plain.health_timeout]).toEqual([240, 30, 5, 120]);
    const operation = switch_of(switch_job_operation(plain, "switch", "ab12"));
    expect([operation.watch, operation.pre_switch_checks]).toEqual([null, []]);
  });

  it("have a switch stop what holds the Nix store database open only when asked, and never for a target_host", () => {
    const asked = switch_of(switch_job_operation(settings({ close_nix_lock_holders: true }), "switch", "ab12"));
    const remote = switch_of(switch_job_operation(settings({ close_nix_lock_holders: true, target_host: "root@odin" }), "switch", "ab12"));

    expect(switch_of(switch_job_operation(settings(), "switch", "ab12")).close_nix_lock_holders).toBeUndefined();
    expect(asked.close_nix_lock_holders).toEqual({ sudo: true });
    expect(remote.close_nix_lock_holders).toBeUndefined();
  });

  it("set a switch for the next boot only when defer_switch_on names parts and the host's own new system is known", () => {
    const cached = switch_of(switch_job_operation(settings({ defer_switch_on: ["kernel", "systemd"] }), "switch", "ab12", target_closure));
    const built = switch_of(switch_job_operation(settings({ defer_switch_on: ["kernel"], configuration: "odin" }), "switch", "ab12"));

    expect(cached.defer).toMatchObject({ parts: ["kernel", "systemd"], system: target_closure });
    expect(cached.defer!.boot_steps.at(-1)!.argv).toEqual(["sudo", "-n", `${target_closure}/bin/switch-to-configuration`, "boot"]);
    expect(built.defer!.system).toBe('/etc/nixos#nixosConfigurations."odin".config.system.build.toplevel');
    expect(built.fetch_steps).toHaveLength(1);
    expect(switch_of(switch_job_operation(settings(), "switch", "ab12", target_closure)).defer).toBeNull();
    expect(switch_of(switch_job_operation(settings({ defer_switch_on: ["kernel"] }), "boot", "ab12", target_closure)).defer).toBeNull();
    expect(switch_of(switch_job_operation(settings({ defer_switch_on: ["kernel"], target_host: "root@odin" }), "switch", "ab12", target_closure)).defer).toBeNull();
    expect(() => settings({ defer_switch_on: ["firmware"] })).toThrow(ConfigError);
  });

  it("name the parts the new system changes from the running one", async () => {
    const root = mkdtempSync(join(tmpdir(), "x-nix-defer-"));
    // Two systems sharing systemd but not the kernel.
    for (const name of ["kernel-a", "kernel-b", "systemd", "running", "next"]) mkdirSync(join(root, name));
    symlinkSync(join(root, "kernel-a"), join(root, "running", "kernel"));
    symlinkSync(join(root, "kernel-b"), join(root, "next", "kernel"));
    for (const system of ["running", "next"]) symlinkSync(join(root, "systemd"), join(root, system, "systemd"));
    const context = { out: { write: () => true } } as unknown as Context;

    const defer = { parts: ["kernel", "systemd", "dbus"] as const, nix: ["nix"], boot_steps: [] };
    expect(await changed_parts(context, { ...defer, parts: [...defer.parts], system: join(root, "next") }, join(root, "running"))).toEqual(["kernel"]);
    expect(await changed_parts(context, { ...defer, parts: [...defer.parts], system: join(root, "running") }, join(root, "running"))).toEqual([]);
    rmSync(root, { recursive: true });
  });

  it("accept only http and https health URLs", () => {
    expect(settings({ health_urls: ["https://odin.example/health"] }).health_urls).toEqual(["https://odin.example/health"]);
    expect(() => settings({ health_urls: ["odin:22"] })).toThrow(ConfigError);
  });

  it("refuse a target_host for a guarded switch, whose checks and watchdog run in the activated host's agent", () => {
    expect(() => settings({ target_host: "root@odin" })).not.toThrow();
    for (const guard of [{ magic_rollback: true }, { pre_switch_checks: ["true"] }, { health_commands: ["true"] }, { health_urls: ["https://odin.example/health"] }]) {
      expect(() => settings({ target_host: "root@odin", ...guard })).toThrow(/target_host/);
    }
  });
});

// ── Operations ───────────────────────────────────────────────────────────────

describe("switch operations", () => {
  it("builds the system before the watchdog starts for a guarded nixos-rebuild, so the build never uses up the activation's time", () => {
    const guarded = switch_of(switch_job_operation(settings({ magic_rollback: true, configuration: "Odin", build_progress: false }), "switch", "ab12"));

    expect(guarded.fetch_steps).toEqual([{
      argv: ["nix", "--extra-experimental-features", "nix-command flakes", "build", "--no-link", "--keep-going", "--print-build-logs",
        '/etc/nixos#nixosConfigurations."Odin".config.system.build.toplevel'],
    }]);
    expect(switch_of(switch_job_operation(settings({ configuration: "Odin", build_progress: false }), "switch", "ab12")).fetch_steps).toEqual([]);
    expect(switch_of(switch_job_operation(settings({ magic_rollback: true }), "switch", "ab12")).fetch_steps).toEqual([]);
    expect(switch_of(switch_job_operation(settings({ magic_rollback: true, configuration: "Odin", build_host: "root@thor" }), "switch", "ab12")).fetch_steps).toEqual([]);
  });

  it("with build_progress, builds a guarded system first printing nix's structured log, and leaves an unguarded one to nixos-rebuild", () => {
    const guarded = switch_of(switch_job_operation(settings({ magic_rollback: true, configuration: "Odin" }), "switch", "ab12"));
    const plain = switch_of(switch_job_operation(settings({ configuration: "Odin" }), "switch", "ab12"));

    expect(guarded.fetch_steps!.map((step) => step.argv.join(" "))).toEqual([
      'nix --extra-experimental-features nix-command flakes build --no-link --log-format internal-json -v --keep-going --print-build-logs /etc/nixos#nixosConfigurations."Odin".config.system.build.toplevel',
    ]);
    expect(plain.fetch_steps).toEqual([]);
    expect(plain.steps[0].argv.join(" ")).toContain("nixos-rebuild switch --flake /etc/nixos#Odin --log-format internal-json");
  });

  it("runs nixos-rebuild alone in each mode when nothing guards it", () => {
    const plain = switch_of(switch_job_operation(settings(), "boot", "ab12"));

    expect(plain.steps).toEqual([{ argv: ["sudo", "-n", "nixos-rebuild", "boot", "--flake", "/etc/nixos", "--log-format", "internal-json"] }]);
    expect(plain.activation_name).toBe("nixos-rebuild boot");
    const dry = switch_of(switch_job_operation(settings({ magic_rollback: true, pre_switch_checks: ["false"] }), "dry-activate", "ab12"));
    expect([dry.watch, dry.pre_switch_checks]).toEqual([null, []]);
  });

  it("watches only the modes that activate, but checks before any of them", () => {
    const guarded = settings({ magic_rollback: true });

    expect(token_of(switch_job_operation(guarded, "test", "ab12"))).toBe("ab12");
    expect(token_of(switch_job_operation(guarded, "boot", "ab12"))).toBeNull();
    expect(switch_of(switch_job_operation(settings({ pre_switch_checks: ["true"] }), "boot", "ab12")).pre_switch_checks).toEqual(["true"]);
  });

  it("gives the watchdog its timeouts and worded reasons", () => {
    const watch = switch_of(switch_job_operation(settings({ magic_rollback: true, health_commands: ["true"], confirm_timeout: "30s", health_timeout: "1m" }), "test", "ab12")).watch!;

    expect(watch).toMatchObject({ token: "ab12", rollback_mode: "test", require_sudo: true, confirm_window: 90, magic_rollback: true, health_commands: ["true"] });
    expect(watch.unconfirmed_reason).toContain("did not confirm");
    expect(watch.activation_reason).toContain("did not finish");
  });

  it("confirms and asks for a rollback through the switch agent", () => {
    expect(confirm_operation("ab12")).toEqual({ kind: "confirm_switch", token: "ab12" });
    expect(rollback_signal_operation("ab12", "asked")).toEqual({ kind: "signal_rollback", token: "ab12", reason: "asked" });
  });

  it("rolls back on target_host over SSH as nixos-rebuild does, and here under sudo", () => {
    const remote = rollback_operation(settings({ target_host: "root@odin" }), 7, "asked") as ProgramsOperation;
    const local = rollback_operation(settings(), 7, "asked") as ProgramsOperation;

    expect(remote.note).toBe("Rolling back to generation 7: asked");
    expect(remote.steps[0]).toEqual({ argv: ["nix-env", "-p", "/nix/var/nix/profiles/system", "--switch-generation", "7"], ssh: { host: "root@odin", sudo: true } });
    expect(local.steps.map((step) => step.argv)).toEqual([
      ["sudo", "-n", "nix-env", "-p", "/nix/var/nix/profiles/system", "--switch-generation", "7"],
      ["sudo", "-n", "/nix/var/nix/profiles/system/bin/switch-to-configuration", "switch"],
    ]);
  });

  it("activates from the cache in each mode when the switch is given a store path", () => {
    const from_cache = settings({ switch_from_cache: true, cache_url: "https://cache.example/fleet", magic_rollback: true });

    expect(switch_of(switch_job_operation(from_cache, "dry-activate", "ab12", target_closure)).steps.at(-1)!.argv)
      .toEqual(["sudo", "-n", `${target_closure}/bin/switch-to-configuration`, "dry-activate"]);
    const switching = switch_of(switch_job_operation(from_cache, "switch", "ab12", target_closure));
    expect(switching.watch?.token).toBe("ab12");
    expect(switching.activation_name).toBe("The switch from the cache");
    expect(JSON.stringify(switching)).not.toContain("nixos-rebuild");
  });

  it("holds the inhibitor only with inhibit_sleep, on target_host when there is one", () => {
    expect(switch_job_operation(settings(), "switch", "ab12").kind).toBe("switch");
    const here = switch_job_operation(settings({ inhibit_sleep: true }), "switch", "ab12") as KeptAwakeOperation;
    expect(here.kind).toBe("kept_awake");
    expect(here.inhibitor).toEqual({ argv: ["sudo", "-n", "systemd-inhibit", "--what=sleep", "--mode=block", "--who=X-Nix", "--why=switching", "cat"] });
    const there = switch_job_operation(settings({ inhibit_sleep: true, target_host: "root@odin" }), "switch", "ab12") as KeptAwakeOperation;
    expect(there.inhibitor.ssh).toEqual({ host: "root@odin", sudo: true });
    expect(there.inhibitor.argv[0]).toBe("systemd-inhibit");
    expect((kept_awake(settings({ inhibit_sleep: true }), rollback_operation(settings(), 3, "asked")) as KeptAwakeOperation).warning)
      .toBe("Could not keep the host awake during the switch; switching anyway");
  });

  it("refuses a generation that is not a number", () => {
    expect(() => rollback_operation(settings(), 0, "asked")).toThrow();
  });

  it("finds no watch token in a command from before operations", () => {
    expect(watch_token("sudo -n nixos-rebuild switch --flake /etc/nixos")).toBeNull();
  });
});

// ── Generations ──────────────────────────────────────────────────────────────

describe("generations", () => {
  it("reads the generations the agent printed, and none from a read that printed nothing", () => {
    const generations = [{ generation: 2, created_epoch: 1700100000, path: "/nix/store/b-nixos-system", version: "26.11", current: true, booted: false, profile: true }];

    expect(parse_generations(JSON.stringify(generations))).toEqual(generations);
    expect(parse_generations("")).toEqual([]);
    expect(parse_generations("{}")).toEqual([]);
  });
});
