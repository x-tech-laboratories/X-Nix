// Reads the host's boot loader: systemd-boot with `bootctl list` and its one-shot EFI variable, GRUB from its environment
// block and grub.cfg, and any other EFI loader with efibootmgr.

// ── Imports ──────────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";

import type { Boot, BootEntry, Loader } from "../../shared/facts.ts";
import type { Argv, BootProbeOperation } from "../../shared/operations.ts";
import { on_path, type Context } from "../programs.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

const oneshot_variable = "/sys/firmware/efi/efivars/LoaderEntryOneShot-4a67b082-0a4c-41cf-b6c7-440b29bb8c4f";
const grub_configs = ["/boot/grub/grub.cfg", "/boot/grub2/grub.cfg"];

type Entry = Omit<BootEntry, "next">;

// ── Reading ──────────────────────────────────────────────────────────────────

export async function boot_probe(context: Context, operation: BootProbeOperation): Promise<number> {
  context.out.write(JSON.stringify(await read_boot(context, operation.require_sudo)));
  return 0;
}

async function read_boot(context: Context, require_sudo: boolean): Promise<Boot> {
  // /boot is often root's alone, so a read tries sudo first and falls back to trying it unprivileged.
  const read = async (argv: Argv): Promise<string> => {
    if (require_sudo) {
      const raised = await context.program(context, ["sudo", "-n", ...argv], { stdout: "keep", stderr: "drop" });
      if (raised.exit_code === 0 && raised.stdout.trim() !== "") return raised.stdout;
    }
    const plain = await context.program(context, argv, { stdout: "keep", stderr: "drop" });
    return plain.exit_code === 0 ? plain.stdout : "";
  };

  const listed = await read(["bootctl", "list", "--json=short"]);
  if (listed.trim() !== "") return finish("systemd-boot", systemd_boot_entries(listed), oneshot_entry());

  const editenv = (await on_path("grub-editenv")) ?? (await on_path("grub2-editenv"));
  if (editenv !== null) {
    const env = await read([editenv, "list"]);
    const config = grub_configs.find((path) => existsSync(path));
    const cfg = config === undefined ? "" : await read(["cat", config]);
    const [entries, next] = grub_entries(env, cfg);
    return { ...finish("grub", entries, next), reboot_tool: basename(editenv) === "grub2-editenv" ? "grub2-reboot" : "grub-reboot" };
  }

  if ((await on_path("efibootmgr")) !== null) {
    const listing = await context.program(context, ["efibootmgr"], { stdout: "keep", stderr: "drop" });
    const [entries, next] = efi_entries(listing.stdout);
    return finish("efi", entries, next);
  }
  return finish("none", [], null);
}

function finish(loader: Loader, entries: Entry[], next: string | null): Boot {
  return {
    loader,
    entries: entries.map((entry) => ({ ...entry, next: entry.id === next })),
    default: entries.find((entry) => entry.default)?.id ?? null,
    next,
  };
}

// The one-shot entry systemd-boot boots next, which its EFI variable holds as UTF-16 after four bytes of attributes.
function oneshot_entry(): string | null {
  try {
    return readFileSync(oneshot_variable).subarray(4).toString("utf16le").replaceAll("\0", "") || null;
  } catch {
    return null;
  }
}

// ── Parsing ──────────────────────────────────────────────────────────────────

export function systemd_boot_entries(json: string): Entry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json || "[]");
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

export function grub_entries(env_text: string, cfg: string): [Entry[], string | null] {
  const lines = env_text.split("\n").filter((line) => line.includes("="));
  const env = new Map(lines.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]));
  const titles = grub_menu_entries(cfg);
  const saved = env.get("saved_entry") ?? "";
  let chosen: string | null = titles[0] ?? null;
  if (titles.includes(saved)) chosen = saved;
  else if (/^\d+$/.test(saved) && Number(saved) < titles.length) chosen = titles[Number(saved)];
  return [titles.map((title) => ({ id: title, title, default: title === chosen })), env.get("next_entry") || null];
}

export function efi_entries(listing: string): [Entry[], string | null] {
  const header = new Map<string, string>();
  const entries: Entry[] = [];
  for (const line of listing.split("\n")) {
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
