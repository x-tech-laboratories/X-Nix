import { describe, expect, it } from "vitest";

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
  it("runs nixos-rebuild alone in each mode when nothing guards it", () => {
    const plain = switch_of(switch_job_operation(settings(), "boot", "ab12"));

    expect(plain.steps).toEqual([{ argv: ["sudo", "-n", "nixos-rebuild", "boot", "--flake", "/etc/nixos"] }]);
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
    expect(here.inhibitor).toEqual({ argv: ["sudo", "-n", "systemd-inhibit", "--what=idle:sleep", "--mode=block", "--who=X-Nix", "--why=switching", "cat"] });
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
