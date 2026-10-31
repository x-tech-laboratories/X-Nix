import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ConfigError, deployment_settings } from "../src/server/config.ts";
import { build_command, eval_command, split_eval_output, switch_command, switch_from_cache_command, update_command } from "../src/server/nixos/commands.ts";
import { github_repository, local_path, short_revision } from "../src/server/nixos/flake.ts";
import { generation_of, parse_probe, reboot_required } from "../src/server/nixos/probe.ts";
import { current_closure } from "./fake_agent.ts";

// ── Setup ────────────────────────────────────────────────────────────────────

function settings(values: Record<string, unknown> = {}) {
  return deployment_settings({ id: "odin-deploy", flake: "/etc/nixos", ...values });
}

// A folder of stand-in programs, each a shell script.
function fake_programs(programs: Record<string, string>): string {
  const folder = join(mkdtempSync(join(tmpdir(), "x-nix-test-")), "bin");
  mkdirSync(folder);
  for (const [name, script] of Object.entries(programs)) {
    writeFileSync(join(folder, name), `#!/bin/sh\n${script}\n`);
    chmodSync(join(folder, name), 0o755);
  }
  return folder;
}

function run_shell(command: string, path_first: string | null = null) {
  const environment = path_first === null ? process.env : { ...process.env, PATH: `${path_first}:${process.env.PATH}` };
  return spawnSync("sh", ["-c", command], { encoding: "utf8", env: environment });
}

// ── Evaluation ───────────────────────────────────────────────────────────────

describe("the evaluation", () => {
  it("never writes the lock file and carries its own timeout", () => {
    const command = eval_command(settings({ eval_timeout: "5m" }), "host");

    expect(command).toContain("--no-write-lock-file");
    expect(command.startsWith("timeout 300 sh -c ")).toBe(true);
  });

  it("refreshes a remote flake but not a local one", () => {
    expect(eval_command(settings(), "host")).not.toContain("--refresh");
    expect(eval_command(settings({ flake: "github:owner/config" }), "host")).toContain("--refresh");
  });

  it("evaluates the configured attribute, or the evaluating host's own name", () => {
    expect(eval_command(settings(), "ragnarok")).toContain("ragnarok");
    expect(eval_command(settings(), null)).toContain("$(uname -n)");
  });

  it("splits back into the toplevel and the metadata when run", () => {
    const nix = fake_programs({
      nix: `case "$*" in *metadata*) echo '{"lastModified": 1}'; echo "fetching" >&2 ;; *) echo "evaluating" >&2; printf %s ${current_closure} ;; esac`,
    });

    const run = run_shell(eval_command(settings({ nix_bin: join(nix, "nix"), nix_args: [] }), "host"));
    const parts = split_eval_output(run.stdout, "missing");

    expect(run.status).toBe(0);
    expect(parts.eval).toEqual({ exit_code: 0, stdout: current_closure, stderr: "evaluating" });
    expect(parts.metadata).toEqual({ exit_code: 0, stdout: '{"lastModified": 1}', stderr: "fetching" });
  });

  it("fails a command the run never reported on", () => {
    const parts = split_eval_output("@@x-nix-eval eval stderr\nkilled\n", "The evaluation ended before reporting");

    expect(parts.eval).toEqual({ exit_code: 1, stdout: "", stderr: "The evaluation ended before reporting" });
    expect(parts.metadata.exit_code).toBe(1);
  });
});

// ── Switch ───────────────────────────────────────────────────────────────────

describe("the switch", () => {
  it("switches to the flake, naming the configuration when set", () => {
    expect(switch_command(settings())).toBe("sudo -n nixos-rebuild switch --flake /etc/nixos");
    expect(switch_command(settings({ configuration: "ragnarok" }))).toContain("--flake '/etc/nixos#ragnarok'");
  });

  it("honours require_sudo and appends rebuild_args", () => {
    expect(switch_command(settings({ require_sudo: false }))).toBe("nixos-rebuild switch --flake /etc/nixos");
    expect(switch_command(settings({ rebuild_args: ["--show-trace"] }))).toContain("--show-trace");
  });

  it("sends compilation to build_host before rebuild_args, and activates on target_host", () => {
    const command = switch_command(settings({ build_host: "root@builder", target_host: "root@odin", rebuild_args: ["--show-trace"] }));

    expect(command).toContain("--build-host root@builder --target-host root@odin --show-trace");
    expect(switch_command(settings())).not.toContain("--build-host");
    expect(switch_command(settings())).not.toContain("--target-host");
  });

  it("runs the wrapper outside sudo", () => {
    expect(switch_command(settings({ switch_wrapper: ["systemd-inhibit", "--what=shutdown"] })))
      .toBe("systemd-inhibit --what=shutdown sudo -n nixos-rebuild switch --flake /etc/nixos");
  });

  it("keeps the switch's exit status after post_switch", () => {
    const command = switch_command(settings({ rebuild_bin: "false", require_sudo: false, post_switch: "true" }));

    expect(run_shell(command).status).toBe(1);
  });
});

describe("the switch from the cache", () => {
  const from_cache = { switch_from_cache: true, cache_url: "https://cache.example/fleet" };

  it("fetches the closure, sets the system profile and activates it", () => {
    expect(switch_from_cache_command(settings(from_cache), current_closure)).toBe([
      `nix --extra-experimental-features 'nix-command flakes' copy --from https://cache.example/fleet ${current_closure}`,
      `sudo -n nix-env -p /nix/var/nix/profiles/system --set ${current_closure}`,
      `sudo -n ${current_closure}/bin/switch-to-configuration switch`,
    ].join(" && "));
  });

  it("runs inside the wrapper and keeps its exit status after post_switch", () => {
    const wrapped = switch_from_cache_command(settings({ ...from_cache, switch_wrapper: ["systemd-inhibit", "--what=shutdown"] }), current_closure);
    expect(wrapped.startsWith("systemd-inhibit --what=shutdown sh -c 'nix ")).toBe(true);

    const failing = switch_from_cache_command(settings({ ...from_cache, nix_bin: "false", require_sudo: false, post_switch: "true" }), current_closure);
    expect(run_shell(failing).status).toBe(1);
  });

  it("refuses anything but a store path", () => {
    expect(() => switch_from_cache_command(settings(from_cache), "/nix/store/x; rm -rf /")).toThrow("not a store path");
  });

  it("needs a cache_url", () => {
    expect(() => settings({ switch_from_cache: true })).toThrow(ConfigError);
  });
});

// ── Build ────────────────────────────────────────────────────────────────────

describe("the build", () => {
  it("realises this host's closure without activating it, going on past failures", () => {
    const command = build_command(settings({ flake: "github:owner/config", configuration: "ragnarok" }), "ragnarok");

    expect(command).toContain("build --no-link");
    expect(command).toContain("nixosConfigurations");
    expect(command).toContain("ragnarok");
    expect(command).toContain("--keep-going");
  });

  it("takes its arguments from build_args", () => {
    const command = build_command(settings({ build_args: ["--max-jobs", "2"] }), "host");

    expect(command).toContain("--max-jobs 2");
    expect(command).not.toContain("--keep-going");
  });

  it("keeps one replaceable root per deployment under build_root_dir", () => {
    const command = build_command(settings({ build_root_dir: "/var/lib/agent/build roots" }), "host");

    expect(command.startsWith("mkdir -p '/var/lib/agent/build roots' && ")).toBe(true);
    expect(command).toContain("build --out-link '/var/lib/agent/build roots/odin-deploy'");
    expect(command).not.toContain("--no-link");
  });

  it.each([
    { local: false, cached: true, builds: false },
    { local: true, cached: true, builds: true },
    { local: false, cached: false, builds: true },
  ])("skips a build the cache already holds (local $local, cached $cached)", ({ local, cached, builds }) => {
    const nix = fake_programs({
      nix: [
        'case "$*" in',
        `  *eval*) printf %s ${current_closure} ;;`,
        `  *'--store https://cache.example'*) exit ${cached ? 0 : 1} ;;`,
        `  *path-info*) exit ${local ? 0 : 1} ;;`,
        "  *build*) echo built ;;",
        "esac",
      ].join("\n"),
    });

    const run = run_shell(build_command(settings({ nix_bin: join(nix, "nix"), nix_args: [], cache_url: "https://cache.example/fleet" }), "host"));

    expect(run.status).toBe(0);
    expect(run.stdout).toBe(builds ? "built\n" : `${current_closure} is already in the cache; not building it\n`);
  });
});

// ── Update ───────────────────────────────────────────────────────────────────

describe("the update", () => {
  const github = { flake: "github:owner/config", push_ssh_key: "/run/secrets/deploy_key" };

  it("updates a local flake in place", () => {
    expect(update_command(settings())).toContain("flake update --flake /etc/nixos");
  });

  it("updates a github: flake unprivileged, pushing over SSH with pinned host keys", () => {
    const command = update_command(settings(github));

    expect(command).not.toContain("sudo");
    expect(command).toContain("git@github.com:owner/config.git");
    expect(command).toContain("-i /run/secrets/deploy_key");
    expect(command).toContain("StrictHostKeyChecking=yes");
    expect(command).not.toContain("https://");
  });

  it("clones the flake's branch and commits as the configured author", () => {
    const command = update_command(settings({ ...github, flake: "github:owner/config/dev", commit_author: "Bot <bot@example.com>", commit_message: "build: bump inputs" }));

    expect(command).toContain("--branch dev");
    expect(command).toContain("user.name=Bot");
    expect(command).toContain("user.email=bot@example.com");
    expect(command).toContain("'build: bump inputs'");
  });

  it.each([{ status: 0, expected: 0 }, { status: 3, expected: 1 }])("prints its log once and keeps its status (nix exits $status)", ({ status, expected }) => {
    const programs = fake_programs({
      nix: `echo "Updated input 'nixpkgs'" >&2\nexit ${status}`,
      // A clone makes its target folder, and diff says the lock is unchanged.
      git: 'case "$*" in clone*) eval mkdir -p "\\${$#}";; esac\nexit 0',
    });

    const run = run_shell(update_command(settings({ ...github, nix_bin: join(programs, "nix"), nix_args: [] })), programs);

    expect(run.status).toBe(expected);
    expect(run.stdout.split("Updated input 'nixpkgs'").length - 1).toBe(1);
    expect(run.stdout.includes("Every input is already current")).toBe(status === 0);
  });
});

// ── Flake references ─────────────────────────────────────────────────────────

describe("flake references", () => {
  it.each([
    ["/etc/nixos", "/etc/nixos"],
    ["path:/etc/nixos", "/etc/nixos"],
    ["git+file:///etc/nixos", "/etc/nixos"],
    ["git+file:///etc/nixos?ref=main", "/etc/nixos"],
    ["./config", "./config"],
    ["github:owner/config", null],
    ["gitlab:owner/config", null],
  ])("reads %s as the local path %s", (reference, expected) => {
    expect(local_path(reference)).toBe(expected);
  });

  it.each([
    ["github:owner/config", { ssh_url: "git@github.com:owner/config.git", branch: null }],
    ["github:owner/config/dev", { ssh_url: "git@github.com:owner/config.git", branch: "dev" }],
    ["github:owner/config?ref=dev", { ssh_url: "git@github.com:owner/config.git", branch: "dev" }],
    ["github:owner", null],
    ["/etc/nixos", null],
  ])("reads %s as a GitHub repository", (reference, expected) => {
    expect(github_repository(reference)).toEqual(expected);
  });

  it("shortens a revision, keeping the dirty mark", () => {
    expect(short_revision("a".repeat(40))).toBe("a".repeat(12));
    expect(short_revision(`${"a".repeat(40)}-dirty`)).toBe(`${"a".repeat(12)}-dirty`);
    expect(short_revision(null)).toBe("—");
  });
});

// ── Probe ────────────────────────────────────────────────────────────────────

describe("the probe", () => {
  it("reads the generation from the profile link", () => {
    expect(generation_of("system-210-link")).toBe(210);
    expect(generation_of("/nix/var/nix/profiles/system-7-link")).toBe(7);
    expect(generation_of("something-else")).toBeNull();
  });

  it("falls back to nixos-version's JSON for the version", () => {
    expect(parse_probe('current=/x\nversion=\nversion_json={"nixosVersion":"26.11"}\n').version).toBe("26.11");
  });

  it("cannot tell about a reboot without the booted parts", () => {
    expect(reboot_required([], [])).toBeNull();
    expect(reboot_required(["", ""], ["/a", "/b"])).toBeNull();
    expect(reboot_required(["/a"], ["/a"])).toBe(false);
    expect(reboot_required(["/a"], ["/b"])).toBe(true);
  });
});
