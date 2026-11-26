// Provisioning new hosts: a nixos-anywhere install over SSH, and a build of install media.
//
// The new host's agent key arrives on stdin, is written into a private folder that nixos-anywhere copies onto the new
// system with `--extra-files`, and is removed with that folder when the install ends. nixos-anywhere turns host key
// checks off for its own SSH connections, so with the target's host key given, the target first proves it holds it, and
// nixos-anywhere then finds an `ssh` first on its PATH that puts a strict check against that key ahead of its options;
// with no host key the install is refused unless the operation trusts whatever key answers. The generated
// hardware-configuration.nix is printed between marker lines so the page can show it.

// ── Imports ──────────────────────────────────────────────────────────────────

import { accessSync, chmodSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hardware_mark, media_mark, missing_tool_exit_code, type InstallOperation, type MediaOperation } from "../../shared/operations.ts";
import { marker, on_path, type Context } from "../programs.ts";
import { real } from "./reads.ts";

// ── Install ──────────────────────────────────────────────────────────────────

// The folders above the key, each with the mode the new system keeps for it, since nixos-anywhere copies modes.
export function key_folders(agent_key_path: string): { path: string; mode: number }[] {
  const parts = agent_key_path.split("/").filter(Boolean).slice(0, -1);
  return parts.map((_, index) => ({ path: parts.slice(0, index + 1).join("/"), mode: index === parts.length - 1 ? 0o700 : 0o755 }));
}

export async function install(context: Context, operation: InstallOperation): Promise<number> {
  const { record } = operation;
  const say = (line: string) => context.out.write(`${line}\n`);
  const host_key = operation.host_key || null;
  const trust = host_key !== null ? ", with its SSH host key pinned" : operation.trust_unknown_host === true ? ", trusting whatever SSH host key answers" : "";
  say(`Installing ${record.flake}#${record.configuration} on ${record.user}@${record.address}${operation.stop_after_partitioning ? ", stopping after partitioning" : ""}${trust}`);
  if (host_key === null && operation.trust_unknown_host !== true) {
    say(`No SSH host key was given for ${record.address}, so nothing was sent to it; give the key from ssh-keyscan, checked on the target's console, or choose to trust whatever key answers`);
    return 2;
  }
  if ((await on_path(operation.tool)) === null) {
    say(`${operation.tool} is not on this host's PATH; add pkgs.nixos-anywhere to the PATH of the host that runs installs`);
    return missing_tool_exit_code;
  }
  try {
    accessSync(operation.ssh_key, constants.R_OK);
  } catch {
    say(`Cannot read the SSH key ${operation.ssh_key} on this host`);
    return 2;
  }

  const scratch = mkdtempSync(join(tmpdir(), "x-nix-install-"));
  try {
    let environment: NodeJS.ProcessEnv | undefined;
    if (host_key !== null) {
      const known_hosts = join(scratch, "known_hosts");
      writeFileSync(known_hosts, `${host_key_alias} ${host_key}\n`, { mode: 0o600 });
      const checked = await context.program(context, host_key_check(operation, known_hosts), { echo: true });
      if (checked.exit_code !== 0) {
        say(`${record.address} did not prove it holds the host key given, so nothing was sent to it`);
        return checked.exit_code;
      }
      const ssh = await on_path("ssh");
      if (ssh === null) {
        say("ssh is not on this host's PATH");
        return missing_tool_exit_code;
      }
      const pinned = join(scratch, "pinned");
      make_folder(pinned, 0o700);
      writeFileSync(join(pinned, "ssh"), pinned_ssh_script(ssh, known_hosts), { mode: 0o700 });
      environment = { ...process.env, PATH: `${pinned}:${process.env.PATH ?? ""}` };
    }
    const argv = [
      operation.tool, "--flake", `${record.flake}#${record.configuration}`, "--target-host", `${record.user}@${record.address}`,
      "--ssh-port", String(record.port), "-i", operation.ssh_key,
    ];
    if (operation.agent_key_path !== null) {
      // The copied folder becomes the new system's root, so it and every folder in it keep the modes those folders need.
      const extra = join(scratch, "extra");
      make_folder(extra, 0o755);
      for (const folder of key_folders(operation.agent_key_path)) make_folder(join(extra, folder.path), folder.mode);
      const key_file = join(extra, operation.agent_key_path.replace(/^\/+/, ""));
      writeFileSync(key_file, context.stdin ?? "", { mode: 0o600 });
      if (statSync(key_file).size === 0) {
        say("The new host's agent key did not arrive");
        return 2;
      }
      argv.push("--extra-files", extra);
    }
    const hardware = join(scratch, "hardware-configuration.nix");
    if (operation.generate_hardware_config) argv.push("--generate-hardware-config", "nixos-generate-config", hardware);
    if (operation.stop_after_partitioning) argv.push("--phases", "kexec,disko");
    argv.push(...operation.extra_args);

    const installed = await context.program(context, argv, { echo: true, env: environment });
    const generated = operation.generate_hardware_config ? read_text(hardware) : "";
    if (generated !== "") say(`${marker(context, hardware_mark)}\n${generated}\n${marker(context, hardware_mark)} end`);
    return installed.exit_code;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// The name the given host key is filed under, so the check does not depend on how the address is written.
const host_key_alias = "x-nix-install-target";

// Logs in to the target only if it holds the given host key, running nothing there.
export function host_key_check(operation: InstallOperation, known_hosts: string): string[] {
  const { record } = operation;
  return [
    "ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${known_hosts}`, "-o", `HostKeyAlias=${host_key_alias}`,
    "-o", "IdentitiesOnly=yes", "-i", operation.ssh_key, "-p", String(record.port), `${record.user}@${record.address}`, "true",
  ];
}

// The options that make ssh accept only the given host key, ahead of any that would turn the check off, since ssh keeps the first value of each.
export function pinned_ssh_options(known_hosts: string): string[] {
  return [
    "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${known_hosts}`, "-o", "GlobalKnownHostsFile=/dev/null", "-o", `HostKeyAlias=${host_key_alias}`,
    "-o", "UpdateHostKeys=no", "-o", "CheckHostIP=no",
  ];
}

// An `ssh` that runs the real one with the pinned options first, for nixos-anywhere, ssh-copy-id and nix copy to find on the PATH.
export function pinned_ssh_script(ssh: string, known_hosts: string): string {
  const quoted = [ssh, ...pinned_ssh_options(known_hosts)].map((word) => `'${word.replaceAll("'", "'\\''")}'`);
  return `#!/bin/sh\nexec ${quoted.join(" ")} "$@"\n`;
}

// Makes a folder with exactly this mode, whatever the umask.
function make_folder(path: string, mode: number): void {
  mkdirSync(path, { mode });
  chmodSync(path, mode);
}

function read_text(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

// ── Media ────────────────────────────────────────────────────────────────────

// Builds the medium with a link in the media folder that roots it, then prints the store path the link points to.
export async function media(context: Context, operation: MediaOperation): Promise<number> {
  if ((await on_path(operation.nix[0])) === null) {
    context.out.write(`${operation.nix[0]} is not on this host's PATH\n`);
    return missing_tool_exit_code;
  }
  mkdirSync(operation.media_root_dir, { recursive: true });
  // A flake named by path or branch is not locked, which getFlake only reads when impure.
  const argv = [...operation.nix, "build", "--impure", "--print-build-logs", "--out-link", operation.link, "--expr", operation.expression];
  const built = await context.program(context, argv, { echo: true });
  if (built.exit_code !== 0) return built.exit_code;
  context.out.write(`${marker(context, media_mark)} ${real(operation.link) ?? ""}\n`);
  return 0;
}
