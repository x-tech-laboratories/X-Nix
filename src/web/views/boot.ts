// The Boot tab of a host's page: its boot entries, the entry it boots next, and Boot next and Reboot into.

import { api, type ActionOutcome, type Boot, type BootEntry, type Host, type Job } from "../api.ts";
import { h, type Child } from "../dom.ts";
import { confirm_dialog, data_table, empty, facts, section, toast } from "../ui.ts";
import { jobs_table, tile } from "./shared.ts";

export const loader_names: Record<Boot["loader"], string> = { "systemd-boot": "systemd-boot", grub: "GRUB", efi: "EFI firmware", none: "None found" };

// ── Tab ──────────────────────────────────────────────────────────────────────

export async function boot_tab(host: Host, refresh: () => Promise<unknown>): Promise<Child> {
  const boot = host.reading?.boot ?? null;
  if (!host.boot) return empty("Boot entries are not read.", "Its host sets boot to false.");
  if (boot === null) return empty("No boot entries read.", "They are read every cycle unless the host's boot is false.");
  const jobs = await api<Job[]>(`/api/jobs?deployment=${encodeURIComponent(`host:${host.name}`)}&kind=next-boot&limit=10`);
  return [
    h("div", { class: "tiles" },
      tile("Loader", loader_names[boot.loader]),
      tile("Default", title_of(boot, boot.default)),
      tile("Next boot", next_boot_text(boot), boot.next ? "tile-info" : null),
    ),
    section("Details", facts([["Booted system", host.system?.booted ? h("code", {}, host.system.booted) : "—"]], "rows")),
    section("Boot entries", boot.entries.length === 0 ? empty("No entries read.", "Reading them may need sudo for bootctl.") : entries_table(host, boot, refresh)),
    section("Changes", jobs.length === 0 ? empty("No next boot set from here yet.") : jobs_table(jobs, false)),
  ];
}

// ── Parts ────────────────────────────────────────────────────────────────────

function entries_table(host: Host, boot: Boot, refresh: () => Promise<unknown>): HTMLElement {
  const set_next = async (entry: BootEntry, reboot: boolean) => {
    try {
      const outcome = await api<ActionOutcome>(`/api/hosts/${encodeURIComponent(host.name)}/next-boot`, "POST", { entry: entry.id, reboot });
      toast(outcome.message, "good");
    } catch (error) {
      toast((error as Error).message, "bad");
    }
    await refresh();
  };

  return data_table<BootEntry>([
    { label: "Entry", cell: (entry) => h("span", {}, entry.title, entry.title !== entry.id ? h("span", { class: "muted small" }, ` ${entry.id}`) : null) },
    { label: "Default", cell: (entry) => (entry.default ? "Yes" : "") },
    { label: "Next", cell: (entry) => (entry.next ? "Once" : "") },
    { label: "Actions", cell: (entry) => {
      const refusal = host.next_boot_refusal;
      return h("div", { class: "row-actions" },
        h("button", { disabled: refusal !== null || entry.next, title: refusal, onclick: () => void set_next(entry, false) }, "Boot next"),
        h("button", {
          class: "danger", disabled: refusal !== null, title: refusal,
          onclick: () => confirm_dialog(`Reboot ${host.display_name} into ${entry.title}`,
            `Reboot ${host.display_name} into ${entry.title} once? Everything running on it stops until it is back up, and the boot after returns to ${title_of(boot, boot.default)}.`,
            "Reboot", () => set_next(entry, true)),
        }, "Reboot into"));
    } },
  ], boot.entries, "Boot entries");
}

// ── Wording ──────────────────────────────────────────────────────────────────

function title_of(boot: Boot, id: string | null): string {
  if (id === null) return "—";
  return boot.entries.find((entry) => entry.id === id)?.title ?? id;
}

function next_boot_text(boot: Boot | null): string {
  if (boot === null) return "—";
  return boot.next ? `${title_of(boot, boot.next)} (once)` : title_of(boot, boot.default);
}
