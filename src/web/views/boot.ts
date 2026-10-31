// The Boot pages: every deployment's boot loader as a card, and one host's boot entries with the next boot and Reboot.

import { api, type ActionOutcome, type Boot, type BootEntry, type Deployment, type Job } from "../api.ts";
import { h, nodes } from "../dom.ts";
import { link } from "../router.ts";
import { confirm_dialog, crumbs, data_table, empty, facts, load, section, toast } from "../ui.ts";
import { action_button, jobs_table, refresh_interval_in_milliseconds, tile, type View } from "./shared.ts";

const loader_names: Record<Boot["loader"], string> = { "systemd-boot": "systemd-boot", grub: "GRUB", efi: "EFI firmware", none: "None found" };

// ── List ─────────────────────────────────────────────────────────────────────

export function boots_view(): View {
  const list = h("div");
  const refresh = (quiet: boolean) => load(list, async () => {
    const deployments = await api<Deployment[]>("/api/deployments");
    if (deployments.length === 0) return empty("No deployments yet.", "Name each NixOS host and its flake under deployments in the config file.");
    return h("div", { class: "grid" }, ...deployments.map(boot_card));
  }, { quiet });
  void refresh(false);
  const timer = setInterval(() => void refresh(true), refresh_interval_in_milliseconds);

  return {
    title: "Boot",
    root: h("div", { class: "page" },
      h("h1", {}, "Boot"),
      h("p", { class: "muted" }, "Each host's boot entries, the entry it boots next, and whether it needs a reboot."),
      list,
    ),
    dispose: () => clearInterval(timer),
  };
}

function boot_card(deployment: Deployment): HTMLElement {
  const boot = deployment.reading?.boot ?? null;
  const reboot = deployment.reading?.reboot_required ?? null;
  const tone = reboot === true ? "warn" : boot === null ? "none" : "good";
  return h("a", { class: `card tone-edge-${tone}`, href: link(["boot", deployment.id]) },
    h("div", { class: "card-head" }, h("strong", {}, deployment.name)),
    h("div", { class: "muted card-host" }, deployment.host ?? "this server"),
    h("dl", {},
      h("dt", {}, "Loader"), h("dd", {}, boot === null ? "—" : loader_names[boot.loader]),
      h("dt", {}, "Next boot"), h("dd", {}, next_text(boot)),
      h("dt", {}, "Reboot"), h("dd", { class: reboot === true ? "tone-warn" : null }, reboot_text(reboot)),
    ));
}

// ── One host ─────────────────────────────────────────────────────────────────

export function boot_view(id: string): View {
  const body = h("div", { class: "stack" });
  const heading = h("h1", {}, id);
  const buttons = h("div", { class: "head-actions" });
  const path = `/api/deployments/${encodeURIComponent(id)}`;

  const refresh = (quiet: boolean) => load(body, async () => {
    const [deployment, jobs] = await Promise.all([
      api<Deployment>(path),
      api<Job[]>(`/api/jobs?deployment=${encodeURIComponent(id)}&kind=next-boot&limit=10`),
    ]);
    heading.textContent = deployment.name;
    const reboot = deployment.actions.find((action) => action.id === "reboot");
    buttons.replaceChildren(...nodes([
      h("button", { onclick: () => void run_refresh() }, "Check now"),
      reboot && action_button(deployment, reboot, () => refresh(true)),
    ]));
    const boot = deployment.reading?.boot ?? null;
    if (boot === null) return empty("No boot entries read.", "They are read every cycle unless the deployment's boot is false.");
    return [
      h("div", { class: "tiles" },
        tile("Loader", loader_names[boot.loader]),
        tile("Default", title_of(boot, boot.default)),
        tile("Next boot", next_text(boot), boot.next ? "tile-info" : null),
        tile("Reboot", reboot_text(deployment.reading?.reboot_required ?? null), deployment.reading?.reboot_required ? "tone-edge-warn" : null),
      ),
      section("Boot entries", boot.entries.length === 0 ? empty("No entries read.", "Reading them may need sudo for bootctl.") : entries_table(deployment, boot)),
      section("Changes", jobs.length === 0 ? empty("No next boot set from here yet.") : jobs_table(jobs, false)),
      section("Details", facts([
        ["Host", deployment.host ?? "this server"],
        ["Booted system", deployment.reading?.booted ? h("code", {}, deployment.reading.booted) : "—"],
        ["Running system", deployment.reading?.current ? h("code", {}, deployment.reading.current) : "—"],
      ], "rows")),
    ];
  }, { quiet });

  const run_refresh = async () => {
    toast("Reading the host…");
    await api(`${path}/refresh`, "POST").catch((error) => toast(String(error.message), "bad"));
    await refresh(true);
  };

  const set_next = async (entry: BootEntry, reboot: boolean) => {
    try {
      const outcome = await api<ActionOutcome>(`${path}/next-boot`, "POST", { entry: entry.id, reboot });
      toast(outcome.message, "good");
    } catch (error) {
      toast((error as Error).message, "bad");
    }
    await refresh(true);
  };

  const entries_table = (deployment: Deployment, boot: Boot) => data_table<BootEntry>([
    { label: "Entry", cell: (entry) => h("span", {}, entry.title, entry.title !== entry.id ? h("span", { class: "muted small" }, ` ${entry.id}`) : null) },
    { label: "Default", cell: (entry) => (entry.default ? "Yes" : "") },
    { label: "Next", cell: (entry) => (entry.next ? "Once" : "") },
    { label: "Actions", cell: (entry) => {
      const refusal = deployment.next_boot_refusal;
      return h("div", { class: "row-actions" },
        h("button", { disabled: refusal !== null || entry.next, title: refusal, onclick: () => void set_next(entry, false) }, "Boot next"),
        h("button", {
          class: "danger", disabled: refusal !== null, title: refusal,
          onclick: () => confirm_dialog(`Reboot ${deployment.name} into ${entry.title}`,
            `Reboot ${deployment.name} into ${entry.title} once? Everything running on it stops until it is back up, and the boot after returns to ${title_of(boot, boot.default)}.`,
            "Reboot", () => set_next(entry, true)),
        }, "Reboot into"));
    } },
  ], boot.entries, "Boot entries");

  void refresh(false);
  const timer = setInterval(() => void refresh(true), refresh_interval_in_milliseconds);

  return {
    title: `Boot · ${id}`,
    root: h("div", { class: "page" },
      crumbs([["Boot", link(["boot"])], [id, null]]),
      h("header", { class: "page-head" }, h("div", { class: "card-head" }, heading), buttons),
      body,
    ),
    dispose: () => clearInterval(timer),
  };
}

// ── Wording ──────────────────────────────────────────────────────────────────

function title_of(boot: Boot, id: string | null): string {
  if (id === null) return "—";
  return boot.entries.find((entry) => entry.id === id)?.title ?? id;
}

function next_text(boot: Boot | null): string {
  if (boot === null) return "—";
  return boot.next ? `${title_of(boot, boot.next)} (once)` : title_of(boot, boot.default);
}

function reboot_text(reboot: boolean | null): string {
  return reboot === true ? "Needed" : reboot === false ? "Not needed" : "—";
}
