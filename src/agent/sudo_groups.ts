// The groups of sudo rules the NixOS module left out on this host, read from the file X_NIX_AGENT_SUDO_FILE names, so a
// command one of them would allow fails at once, naming the option that adds it, rather than with sudo's bare refusal.

// ── Imports ──────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";

import { show_argv, type Argv } from "../shared/operations.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

export const sudo_groups_variable = "X_NIX_AGENT_SUDO_FILE";

// The groups each file turned off, read once per file.
const read_files = new Map<string, Set<string>>();

// ── Groups ───────────────────────────────────────────────────────────────────

// The `sudoAllow` group a command run under `sudo -n` needs, or null for one whose rule every host has.
export function sudo_group(argv: Argv): string | null {
  if (argv[0] !== "sudo" || argv[1] !== "-n") return null;
  const [program = "", ...args] = argv.slice(2);
  const name = program.split("/").pop() ?? "";
  if (program === "/bin/sh") return "postSwitch";
  if (name === "ssh") return "targetHost";
  if ((name === "bootctl" && args[0] === "set-oneshot") || name === "grub-reboot" || name === "grub2-reboot" || name === "efibootmgr") return "bootEntries";
  if (name === "kill") return "lockHolders";
  if ((name === "nix" && args.includes("flake") && args.includes("update")) || name === "cp") return "flakeUpdates";
  if (name === "nix-env" && args.includes("--set")) return "cacheSwitch";
  if (name === "systemd-inhibit") return "sleepInhibitors";
  return null;
}

// The groups the module turned off on this host; none when it names no file or the file cannot be read.
export function off_groups(environment: NodeJS.ProcessEnv = process.env): Set<string> {
  const file = environment[sudo_groups_variable];
  if (!file) return new Set();
  let groups = read_files.get(file);
  if (groups === undefined) {
    groups = new Set();
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as { off?: unknown };
      if (Array.isArray(raw.off)) for (const group of raw.off) if (typeof group === "string") groups.add(group);
    } catch {
      // An unreadable file leaves sudo itself to refuse.
    }
    read_files.set(file, groups);
  }
  return groups;
}

// Why sudo would refuse the command on this host, naming the option that allows it, or null when its group is not turned off.
export function sudo_refusal(argv: Argv, off: Set<string> = off_groups()): string | null {
  const group = sudo_group(argv);
  if (group === null || !off.has(group)) return null;
  return `This host's sudo rules leave out ${show_argv(argv.slice(2))}; set sudoAllow.${group} = true in its X-Nix agent module to allow it`;
}
