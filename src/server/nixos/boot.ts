// A deployment's boot entries: which loader the host boots with, its entries, the default and the one-shot next entry.
//
// systemd-boot is read with `bootctl list` and its one-shot EFI variable, GRUB from its environment block and grub.cfg,
// and any other EFI loader with efibootmgr. Picking the next boot sets a one-shot entry with the loader's own tool, so
// the default is untouched and the host returns to it on the boot after.

// ── Imports ──────────────────────────────────────────────────────────────────

import { shell_quote } from "./commands.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export type Loader = "systemd-boot" | "grub" | "efi" | "none";

export interface BootEntry {
  id: string;
  title: string;
  default: boolean;
  next: boolean;
}

export interface Boot {
  loader: Loader;
  entries: BootEntry[];
  default: string | null;
  next: string | null;
  // grub-reboot or grub2-reboot, for GRUB.
  reboot_tool?: string;
}

const oneshot_variable = "/sys/firmware/efi/efivars/LoaderEntryOneShot-4a67b082-0a4c-41cf-b6c7-440b29bb8c4f";
const grub_configs = ["/boot/grub/grub.cfg", "/boot/grub2/grub.cfg"];
const sections = ["@@entries", "@@env", "@@cfg"] as const;

// ── Reading ──────────────────────────────────────────────────────────────────

// A read that tries sudo first, since /boot is often root's alone, and falls back to trying it unprivileged.
function read(require_sudo: boolean, command: string): string {
  return require_sudo ? `{ sudo -n ${command} 2>/dev/null || ${command} 2>/dev/null; }` : `${command} 2>/dev/null`;
}

export function boot_script(require_sudo: boolean): string {
  return [
    `if out=$(${read(require_sudo, "bootctl list --json=short")}) && [ -n "$out" ]; then`,
    "  echo loader=systemd-boot",
    `  echo "oneshot=$(tail -c +5 ${oneshot_variable} 2>/dev/null | tr -d '\\000')"`,
    '  echo @@entries; printf "%s\\n" "$out"',
    "elif e=$(command -v grub-editenv || command -v grub2-editenv); then",
    '  echo loader=grub; echo "editenv=${e##*/}"',
    '  echo @@env; "$e" list 2>/dev/null; echo @@cfg',
    `  for f in ${grub_configs.join(" ")}; do [ -e "$f" ] && { ${read(require_sudo, 'cat "$f"')}; break; }; done`,
    "elif command -v efibootmgr >/dev/null 2>&1; then",
    "  echo loader=efi; echo @@entries; efibootmgr 2>/dev/null",
    "else",
    "  echo loader=none",
    "fi",
  ].join("\n");
}

export function parse_boot(stdout: string): Boot {
  const header = new Map<string, string>();
  const parts = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of stdout.split("\n")) {
    if ((sections as readonly string[]).includes(line)) {
      current = [];
      parts.set(line, current);
    } else if (current !== null) current.push(line);
    else if (line.includes("=")) header.set(line.slice(0, line.indexOf("=")).trim(), line.slice(line.indexOf("=") + 1).trim());
  }

  let loader = (header.get("loader") ?? "none") as Loader;
  let entries: Omit<BootEntry, "next">[] = [];
  let next: string | null = null;
  if (loader === "systemd-boot") {
    entries = systemd_boot_entries(parts.get("@@entries") ?? []);
    next = header.get("oneshot") || null;
  } else if (loader === "grub") {
    [entries, next] = grub_entries(parts.get("@@env") ?? [], parts.get("@@cfg") ?? []);
  } else if (loader === "efi") {
    [entries, next] = efi_entries(parts.get("@@entries") ?? []);
  } else {
    loader = "none";
  }
  const boot: Boot = {
    loader,
    entries: entries.map((entry) => ({ ...entry, next: entry.id === next })),
    default: entries.find((entry) => entry.default)?.id ?? null,
    next,
  };
  if (loader === "grub") boot.reboot_tool = header.get("editenv") === "grub2-editenv" ? "grub2-reboot" : "grub-reboot";
  return boot;
}

function systemd_boot_entries(lines: string[]): Omit<BootEntry, "next">[] {
  let raw: unknown;
  try {
    raw = JSON.parse(lines.join("\n") || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && Boolean(item.id))
    .map((item) => ({ id: String(item.id), title: String(item.showTitle || item.title || item.id), default: Boolean(item.isDefault) }));
}

// The grub-reboot names of a grub.cfg's entries, a submenu's entries written as "Submenu>Entry".
export function grub_menu_entries(cfg: string): string[] {
  const entries: string[] = [];
  const stack: (string | null)[] = [];
  for (const line of cfg.split("\n")) {
    const stripped = line.trim();
    const match = /^(menuentry|submenu)\s+(['"])(.*?)\2/.exec(stripped);
    if (match && stripped.endsWith("{")) {
      const path = [...stack.filter((title): title is string => title !== null), match[3]];
      if (match[1] === "menuentry") {
        entries.push(path.join(">"));
        stack.push(null);
      } else stack.push(match[3]);
    } else if (stripped.endsWith("{")) stack.push(null);
    else if (stripped === "}" && stack.length > 0) stack.pop();
  }
  return entries;
}

function grub_entries(env_lines: string[], cfg_lines: string[]): [Omit<BootEntry, "next">[], string | null] {
  const env = new Map(env_lines.filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]));
  const titles = grub_menu_entries(cfg_lines.join("\n"));
  const saved = env.get("saved_entry") ?? "";
  let chosen: string | null = titles[0] ?? null;
  if (titles.includes(saved)) chosen = saved;
  else if (/^\d+$/.test(saved) && Number(saved) < titles.length) chosen = titles[Number(saved)];
  return [titles.map((title) => ({ id: title, title, default: title === chosen })), env.get("next_entry") || null];
}

function efi_entries(lines: string[]): [Omit<BootEntry, "next">[], string | null] {
  const header = new Map<string, string>();
  const entries: Omit<BootEntry, "next">[] = [];
  for (const line of lines) {
    const match = /^Boot([0-9A-Fa-f]{4})\*?\s+(.*)$/.exec(line);
    if (match) {
      const title = match[2].split("\t")[0].trim();
      entries.push({ id: match[1].toUpperCase(), title: title || match[1], default: false });
    } else if (line.includes(":")) header.set(line.slice(0, line.indexOf(":")).trim(), line.slice(line.indexOf(":") + 1).trim());
  }
  const first = (header.get("BootOrder") ?? "").split(",").map((item) => item.trim().toUpperCase()).find(Boolean);
  for (const entry of entries) entry.default = entry.id === first;
  return [entries, (header.get("BootNext") ?? "").toUpperCase() || null];
}

// ── Next boot ────────────────────────────────────────────────────────────────

// Sets the one-shot next entry with the loader's own tool, then reboots when asked.
export function next_boot_command(boot: Boot, entry: string, reboot: boolean, require_sudo: boolean): string {
  const sudo = require_sudo ? "sudo -n " : "";
  const quoted = shell_quote(entry);
  let command: string;
  if (boot.loader === "systemd-boot") command = `${sudo}bootctl set-oneshot ${quoted}`;
  else if (boot.loader === "grub") command = `${sudo}${boot.reboot_tool ?? "grub-reboot"} ${quoted}`;
  else command = `${sudo}efibootmgr --bootnext ${quoted}`;
  return reboot ? `${command} && ${sudo}systemctl reboot` : command;
}
