import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ConfigError, deployment_settings } from "../src/server/config.ts";
import { switch_command } from "../src/server/nixos/commands.ts";
import {
  confirm_command, guarded_switch_command, is_guarded, kept_awake, parse_generations, rollback_command, switch_job_command, switch_verdict, watch_folder,
  watch_token,
} from "../src/server/nixos/switch.ts";
import { target_closure } from "./fake_agent.ts";

// ── Setup ────────────────────────────────────────────────────────────────────

function settings(values: Record<string, unknown> = {}) {
  return deployment_settings({ id: "odin-deploy", flake: "/etc/nixos", ...values });
}

const folders: string[] = [];

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

// A pretend NixOS host in a folder: two systems, a system profile at generation 1, and a nixos-rebuild that moves to
// generation 2, each step written to a log.
function fake_host() {
  const root = mkdtempSync(join(tmpdir(), "x-nix-switch-test-"));
  folders.push(root);
  const bin = join(root, "bin");
  const profiles = join(root, "profiles");
  for (const folder of [bin, profiles, join(root, "old", "bin"), join(root, "new", "bin")]) mkdirSync(folder, { recursive: true });
  const log = join(root, "log");
  const current = join(root, "current-system");
  const write_program = (path: string, script: string) => {
    writeFileSync(path, `#!/bin/sh\n${script}\n`);
    chmodSync(path, 0o755);
  };
  for (const name of ["old", "new"]) write_program(join(root, name, "bin", "switch-to-configuration"), `echo "activate ${name} $1" >> ${log}\nln -sfn ${join(root, name)} ${current}`);
  symlinkSync(join(root, "old"), current);
  symlinkSync(join(root, "old"), join(profiles, "system-1-link"));
  symlinkSync("system-1-link", join(profiles, "system"));
  write_program(join(bin, "nixos-rebuild"), [
    `echo "rebuild $1" >> ${log}`,
    `ln -sfn ${join(root, "new")} ${join(profiles, "system-2-link")}`,
    `ln -sfn system-2-link ${join(profiles, "system")}`,
    `ln -sfn ${join(root, "new")} ${current}`,
    'exit "${REBUILD_EXIT:-0}"',
  ].join("\n"));
  write_program(join(bin, "nix-env"), [
    `echo "nix-env $*" >> ${log}`,
    `if [ "$3" = --set ]; then ln -sfn "$4" ${join(profiles, "system-2-link")}; ln -sfn system-2-link ${join(profiles, "system")}`,
    `else ln -sfn "system-$4-link" ${join(profiles, "system")}; fi`,
  ].join("\n"));
  write_program(join(bin, "nix"), `echo "nix $*" >> ${log}`);
  // Holds the inhibitor until its stdin closes, as systemd-inhibit running cat does.
  write_program(join(bin, "systemd-inhibit"), `echo "inhibit $*" >> ${log}\n[ -z "$INHIBIT_FAILS" ] || exit 1\ncat > /dev/null\necho released >> ${log}`);
  return {
    root, bin, log, current,
    profile: () => readlinkSync(join(profiles, "system")),
    system: () => readlinkSync(current),
    // Points the command's system paths, and the cache's closure, into the folder.
    localise: (command: string) => command.replaceAll("/run/current-system", current).replaceAll("/nix/var/nix/profiles/system", join(profiles, "system"))
      .replaceAll(target_closure, join(root, "new")),
    read_log: () => (existsSync(log) ? readFileSync(log, "utf8") : ""),
  };
}

interface Finished {
  status: number | null;
  output: string;
}

// Runs a command in the background, calling back once its output holds some text.
function run_until(command: string, path_first: string, needle: string | null = null, on_needle: () => void = () => {}): Promise<Finished> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], { env: { ...process.env, PATH: `${path_first}:${process.env.PATH}` } });
    let output = "";
    let seen = false;
    const take = (chunk: Buffer) => {
      output += chunk.toString();
      if (needle !== null && !seen && output.includes(needle)) {
        seen = true;
        on_needle();
      }
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("close", (status) => resolve({ status, output }));
  });
}

function token(): string {
  const value = randomBytes(6).toString("hex");
  folders.push(watch_folder(value));
  return value;
}

const quick = { require_sudo: false, activation_timeout: "20s", confirm_timeout: "2s", health_period: "1s", health_timeout: "2s" };

// ── Settings ─────────────────────────────────────────────────────────────────

describe("switch settings", () => {
  it("leave every safety feature off by default", () => {
    const plain = settings();

    expect([plain.magic_rollback, plain.pre_switch_checks, plain.health_commands, plain.health_urls]).toEqual([false, [], [], []]);
    expect([plain.activation_timeout, plain.confirm_timeout, plain.health_period, plain.health_timeout]).toEqual([240, 30, 5, 120]);
    expect(is_guarded(plain, "switch")).toBe(false);
  });

  it("accept only http and https health URLs", () => {
    expect(settings({ health_urls: ["https://odin.example/health"] }).health_urls).toEqual(["https://odin.example/health"]);
    expect(() => settings({ health_urls: ["odin:22"] })).toThrow(ConfigError);
  });
});

// ── Commands ─────────────────────────────────────────────────────────────────

describe("switch commands", () => {
  it("runs nixos-rebuild alone in each mode when nothing guards it", () => {
    expect(switch_job_command(settings(), "switch", "ab12")).toBe("sudo -n nixos-rebuild switch --flake /etc/nixos");
    expect(switch_command(settings(), "boot")).toBe("sudo -n nixos-rebuild boot --flake /etc/nixos");
    expect(switch_job_command(settings({ magic_rollback: true, pre_switch_checks: ["false"] }), "dry-activate", "ab12")).toBe("sudo -n nixos-rebuild dry-activate --flake /etc/nixos");
  });

  it("watches only the modes that activate, but checks before any of them", () => {
    const guarded = settings({ magic_rollback: true });

    expect(watch_token(switch_job_command(guarded, "test", "ab12"))).toBe("ab12");
    expect(switch_job_command(guarded, "boot", "ab12")).toBe("sudo -n nixos-rebuild boot --flake /etc/nixos");
    expect(switch_job_command(settings({ pre_switch_checks: ["true"] }), "boot", "ab12")).toContain("pre-switch-checks");
  });

  it("reaches target_host over SSH as nixos-rebuild does, as root there", () => {
    const guarded = settings({ target_host: "root@odin", magic_rollback: true });

    expect(confirm_command(guarded, "ab12")).toBe("sudo -n ssh $NIX_SSHOPTS root@odin 'touch /tmp/x-nix-switch-ab12/confirmed'");
    expect(rollback_command(guarded, 7, "asked")).toContain("ssh $NIX_SSHOPTS root@odin 'nix-env -p /nix/var/nix/profiles/system --switch-generation 7 &&");
    expect(rollback_command(settings(), 7, "asked")).toContain("sudo -n nix-env");
  });

  it("activates from the cache in each mode when the switch is given a store path", () => {
    const from_cache = settings({ switch_from_cache: true, cache_url: "https://cache.example/fleet", magic_rollback: true });

    expect(switch_job_command(from_cache, "dry-activate", "ab12", target_closure)).toContain(`${target_closure}/bin/switch-to-configuration dry-activate`);
    expect(switch_job_command(from_cache, "switch", "ab12", target_closure)).toContain("x-nix-watchdog");
    expect(switch_job_command(from_cache, "switch", "ab12", target_closure)).not.toContain("nixos-rebuild");
  });

  it("holds the inhibitor only with inhibit_sleep, on target_host when there is one", () => {
    expect(switch_job_command(settings(), "switch", "ab12")).not.toContain("systemd-inhibit");
    expect(switch_job_command(settings({ inhibit_sleep: true }), "switch", "ab12")).toContain("sh -c 'sudo -n systemd-inhibit --what=idle:sleep");
    expect(switch_job_command(settings({ inhibit_sleep: true, target_host: "root@odin" }), "switch", "ab12"))
      .toContain("sudo -n ssh $NIX_SSHOPTS root@odin 'systemd-inhibit --what=idle:sleep");
  });

  it("refuses a generation that is not a number", () => {
    expect(() => rollback_command(settings(), 0, "asked")).toThrow();
  });
});

// ── Running ──────────────────────────────────────────────────────────────────

describe("a guarded switch", () => {
  it("refuses before anything changes when a pre-switch check fails", async () => {
    const host = fake_host();
    const command = host.localise(guarded_switch_command(settings({ ...quick, rebuild_bin: "nixos-rebuild", pre_switch_checks: ["true", "echo disk full; exit 4"] }), "switch", token()));

    const run = await run_until(command, host.bin);

    expect(run.status).toBe(3);
    expect(run.output).toContain("disk full");
    expect(switch_verdict(run.output).refused).toBe("Pre-switch check 2 (echo disk full; exit 4) failed with status 4");
    expect(host.system()).toBe(join(host.root, "old"));
  });

  it("rolls back when X-Nix never confirms, with magic_rollback", async () => {
    const host = fake_host();
    const command = host.localise(guarded_switch_command(settings({ ...quick, magic_rollback: true }), "switch", token()));

    const run = await run_until(command, host.bin);

    const verdict = switch_verdict(run.output);
    expect(run.status).toBe(1);
    expect(verdict.awaiting_confirmation).toBe(true);
    expect(verdict.outcome?.kind).toBe("rolled-back");
    expect(verdict.outcome?.reason).toContain("did not confirm");
    expect(host.system()).toBe(join(host.root, "old"));
    expect(host.profile()).toBe("system-1-link");
  }, 20_000);

  it("keeps the new system once X-Nix confirms", async () => {
    const host = fake_host();
    const watch = token();
    const guarded = settings({ ...quick, magic_rollback: true });
    const command = host.localise(guarded_switch_command(guarded, "switch", watch));

    const run = await run_until(command, host.bin, "awaiting-confirmation", () => spawnSync("sh", ["-c", confirm_command(guarded, watch)]));

    expect(run.status).toBe(0);
    expect(switch_verdict(run.output).outcome?.kind).toBe("confirmed");
    expect(host.system()).toBe(join(host.root, "new"));
    expect(host.profile()).toBe("system-2-link");
    expect(existsSync(watch_folder(watch))).toBe(false);
  }, 20_000);

  it("clears the folders that dead runs left a day or more ago, and no newer ones", async () => {
    const host = fake_host();
    const stale = watch_folder(token());
    const recent = watch_folder(token());
    mkdirSync(stale);
    mkdirSync(recent);
    const two_days_ago = new Date(Date.now() - 2 * 86_400_000);
    utimesSync(stale, two_days_ago, two_days_ago);
    const command = host.localise(guarded_switch_command(settings({ ...quick, health_commands: ["true"] }), "switch", token()));

    await run_until(command, host.bin);

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  }, 20_000);

  it("rolls back a failing health check with its output as the reason", async () => {
    const host = fake_host();
    const command = host.localise(guarded_switch_command(settings({ ...quick, health_commands: ["echo nginx is down; exit 1"] }), "switch", token()));

    const run = await run_until(command, host.bin);

    const outcome = switch_verdict(run.output).outcome;
    expect(run.status).toBe(1);
    expect(outcome?.kind).toBe("rolled-back");
    expect(outcome?.reason).toContain("Health check 1 (echo nginx is down; exit 1) failed with status 1: nginx is down");
    expect(host.system()).toBe(join(host.root, "old"));
  }, 20_000);

  it("rolls back a test switch by activating the previous system for now only", async () => {
    const host = fake_host();
    const command = host.localise(guarded_switch_command(settings({ ...quick, rebuild_bin: "nixos-rebuild", health_commands: ["false"] }), "test", token()));

    await run_until(command, host.bin);

    expect(spawnSync("cat", [host.log], { encoding: "utf8" }).stdout).toContain("activate old test");
  }, 20_000);

  it("keeps a switch whose health checks pass even when nothing confirms it, without magic_rollback", async () => {
    const host = fake_host();
    const command = host.localise(guarded_switch_command(settings({ ...quick, health_commands: ["true"] }), "switch", token()));

    const run = await run_until(command, host.bin);

    expect(run.status).toBe(0);
    expect(switch_verdict(run.output).outcome?.kind).toBe("kept");
    expect(host.system()).toBe(join(host.root, "new"));
  }, 20_000);

  it("rolls back a switch whose activation failed", async () => {
    const host = fake_host();
    const command = `REBUILD_EXIT=5; export REBUILD_EXIT\n${host.localise(guarded_switch_command(settings({ ...quick, magic_rollback: true }), "switch", token()))}`;

    const run = await run_until(command, host.bin);

    expect(run.status).toBe(5);
    expect(switch_verdict(run.output).outcome).toEqual({ kind: "rolled-back", reason: "nixos-rebuild switch failed with status 5" });
    expect(host.system()).toBe(join(host.root, "old"));
  }, 20_000);
});

// ── Switch from cache ────────────────────────────────────────────────────────

describe("a guarded switch from the cache", () => {
  const from_cache = { ...quick, switch_from_cache: true, cache_url: "https://cache.example/fleet", magic_rollback: true };

  it("fetches, sets the profile and activates, keeping the new system once X-Nix confirms", async () => {
    const host = fake_host();
    const watch = token();
    const guarded = settings(from_cache);
    const command = host.localise(switch_job_command(guarded, "switch", watch, target_closure));

    const run = await run_until(command, host.bin, "awaiting-confirmation", () => spawnSync("sh", ["-c", confirm_command(guarded, watch)]));

    expect(run.status).toBe(0);
    expect(switch_verdict(run.output).outcome?.kind).toBe("confirmed");
    expect(host.read_log()).toContain("copy --from https://cache.example/fleet");
    expect(host.system()).toBe(join(host.root, "new"));
    expect(host.profile()).toBe("system-2-link");
  }, 20_000);

  it("rolls back the system and its profile when X-Nix never confirms", async () => {
    const host = fake_host();
    const command = host.localise(switch_job_command(settings(from_cache), "switch", token(), target_closure));

    const run = await run_until(command, host.bin);

    expect(run.status).toBe(1);
    expect(switch_verdict(run.output).outcome?.kind).toBe("rolled-back");
    expect(host.system()).toBe(join(host.root, "old"));
    expect(host.profile()).toBe("system-1-link");
  }, 20_000);

  it("rolls back a test switch without touching the profile", async () => {
    const host = fake_host();
    const command = host.localise(switch_job_command(settings(from_cache), "test", token(), target_closure));

    await run_until(command, host.bin);

    expect(host.read_log()).toContain("activate new test");
    expect(host.read_log()).toContain("activate old test");
    expect(host.read_log()).not.toContain("nix-env");
    expect(host.profile()).toBe("system-1-link");
  }, 20_000);
});

// ── Keeping the host awake ───────────────────────────────────────────────────

describe("inhibit_sleep", () => {
  // Waits until the log holds some text, or gives up after a while.
  async function log_holds(host: ReturnType<typeof fake_host>, text: string): Promise<boolean> {
    for (let attempt = 0; attempt < 40; attempt++) {
      if (host.read_log().includes(text)) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }

  it("holds the inhibitor while the switch runs and releases it once the run ends, even past what the switch leaves running", async () => {
    const host = fake_host();
    const command = kept_awake(settings({ ...quick, inhibit_sleep: true }), [
      `for attempt in 1 2 3 4 5 6 7 8 9 10; do grep -q inhibit ${host.log} && break; sleep 0.2; done`,
      `(sleep 5 > /dev/null 2>&1 &); grep -c released ${host.log} || true`,
    ].join("\n"));

    const run = await run_until(command, host.bin);

    expect(run.status).toBe(0);
    expect(run.output.trim()).toBe("0");
    expect(host.read_log()).toContain("inhibit --what=idle:sleep --mode=block --who=X-Nix --why=switching cat");
    expect(await log_holds(host, "released")).toBe(true);
  });

  it("switches anyway with a warning when the inhibitor cannot be held, keeping the switch's status", async () => {
    const host = fake_host();
    const command = `INHIBIT_FAILS=1; export INHIBIT_FAILS\n${kept_awake(settings({ ...quick, inhibit_sleep: true }), "sleep 0.5; exit 4")}`;

    const run = await run_until(command, host.bin);

    expect(run.status).toBe(4);
    expect(run.output).toContain("Could not keep the host awake during the switch; switching anyway");
  });
});

// ── Generations ──────────────────────────────────────────────────────────────

describe("generations", () => {
  it("reads each generation, newest first, marking the running, booted and default ones", () => {
    const stdout = [
      "current\t/nix/store/b-nixos-system",
      "booted\t/nix/store/a-nixos-system",
      "profile\tsystem-2-link",
      "generation\tsystem-1-link\t1700000000\t/nix/store/a-nixos-system\t26.05",
      "generation\tsystem-2-link\t1700100000\t/nix/store/b-nixos-system\t26.11",
      "generation\tnot-a-link\t1\t/x\t",
    ].join("\n");

    expect(parse_generations(stdout)).toEqual([
      { generation: 2, created_epoch: 1700100000, path: "/nix/store/b-nixos-system", version: "26.11", current: true, booted: false, profile: true },
      { generation: 1, created_epoch: 1700000000, path: "/nix/store/a-nixos-system", version: "26.05", current: false, booted: true, profile: false },
    ]);
  });
});
