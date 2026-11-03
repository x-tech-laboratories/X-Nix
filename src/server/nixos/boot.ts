// A deployment's boot entries: which loader the host boots with, its entries, the default and the one-shot next entry.
//
// The agent reads the loader (see agent/operations/boot.ts) and answers it as JSON. Picking the next boot sets a one-shot entry with the loader's own tool, so
// the default is untouched and the host returns to it on the boot after.

// ── Imports ──────────────────────────────────────────────────────────────────

import { read_facts, type Boot } from "../../shared/facts.ts";
import type { Operation } from "../../shared/operations.ts";

export type { Boot, BootEntry, Loader } from "../../shared/facts.ts";

// ── Reading ──────────────────────────────────────────────────────────────────

export function boot_probe_operation(require_sudo: boolean): Operation {
  return { kind: "boot_probe", require_sudo };
}

// The boot loader the read found, or null when it answered nothing.
export function parse_boot(stdout: string): Boot | null {
  const boot = read_facts<Boot>(stdout);
  return boot !== null && Array.isArray(boot.entries) ? boot : null;
}

// ── Next boot ────────────────────────────────────────────────────────────────

// Sets the one-shot next entry with the loader's own tool, then reboots when asked.
export function next_boot_operation(boot: Boot, entry: string, reboot: boolean, require_sudo: boolean): Operation {
  const sudo = require_sudo ? ["sudo", "-n"] : [];
  let set: string[];
  if (boot.loader === "systemd-boot") set = ["bootctl", "set-oneshot", entry];
  else if (boot.loader === "grub") set = [boot.reboot_tool ?? "grub-reboot", entry];
  else set = ["efibootmgr", "--bootnext", entry];
  const steps = [{ argv: [...sudo, ...set] }, ...(reboot ? [{ argv: [...sudo, "systemctl", "reboot"] }] : [])];
  return { kind: "programs", steps };
}
