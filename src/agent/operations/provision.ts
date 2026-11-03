// Provisioning new hosts: a nixos-anywhere install over SSH, and a build of install media.
//
// The new host's agent key arrives on stdin, is written into a private folder that nixos-anywhere copies onto the new
// system with `--extra-files`, and is removed with that folder when the install ends. The generated
// hardware-configuration.nix is printed between marker lines so the page can show it.

// ── Imports ──────────────────────────────────────────────────────────────────

import { accessSync, chmodSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hardware_mark, media_mark, missing_tool_exit_code, type InstallOperation, type MediaOperation } from "../../shared/operations.ts";
import { on_path, type Context } from "../programs.ts";
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
  say(`Installing ${record.flake}#${record.configuration} on ${record.user}@${record.address}${operation.stop_after_partitioning ? ", stopping after partitioning" : ""}`);
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

    const installed = await context.program(context, argv, { echo: true });
    const generated = operation.generate_hardware_config ? read_text(hardware) : "";
    if (generated !== "") say(`${hardware_mark}\n${generated}\n${hardware_mark} end`);
    return installed.exit_code;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
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
  context.out.write(`${media_mark} ${real(operation.link) ?? ""}\n`);
  return 0;
}
