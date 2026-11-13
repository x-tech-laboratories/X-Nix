// The sidebar: each section as a row, with Flakes, Cache and Hosts folding open onto every flake, cache and host.

import { use_pref } from "@x-tech-laboratories/x-libs/web/react/prefs";
import type { ShellSection } from "@x-tech-laboratories/x-libs/web/react/shell";
import { use_resource } from "@x-tech-laboratories/x-libs/web/react/states";
import { Tree } from "@x-tech-laboratories/x-libs/web/react/tree";
import { link } from "@x-tech-laboratories/x-libs/web/router";
import { api, type Cache, type Flake, type Host } from "./api.ts";
import { live } from "./views/shared.tsx";

// ── Rows ─────────────────────────────────────────────────────────────────────

// A section's row has the id "section:<id>"; an item's row names its section as parent and has the id "<section>/<id>".
interface SidebarRow {
  id: string;
  parent_id: string | null;
  position: number;
  label: string;
  href: string;
}

interface SidebarItems {
  flakes: Flake[];
  caches: Cache[];
  hosts: Host[];
}

const section_row_id = (section: string) => `section:${section}`;

function item_rows(section: string, items: { id: string; label: string }[]): SidebarRow[] {
  return items.map((item, position) => ({
    id: `${section}/${item.id}`, parent_id: section_row_id(section), position, label: item.label, href: link([section, item.id]),
  }));
}

function rows_of(sections: ShellSection[], items: SidebarItems | null): SidebarRow[] {
  const section_rows = sections.map((section, position) => ({ id: section_row_id(section.id), parent_id: null, position, label: section.label, href: section.href }));
  if (items === null) return section_rows;
  return [
    ...section_rows,
    ...item_rows("flakes", items.flakes.map((flake) => ({ id: flake.id, label: flake.name }))),
    ...item_rows("cache", items.caches.map((cache) => ({ id: cache.id, label: cache.name }))),
    ...item_rows("hosts", items.hosts.map((host) => ({ id: host.name, label: host.display_name }))),
  ];
}

function is_id_list(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

// ── Sidebar ──────────────────────────────────────────────────────────────────

interface SidebarProps {
  sections: ShellSection[];
  // The section to light up, such as "hosts".
  section: string;
  // The item within it, such as a host's name, or null on the section's own page.
  item: string | null;
}

export function Sidebar({ sections, section, item }: SidebarProps) {
  const [collapsed_ids, set_collapsed_ids] = use_pref("x-nix-sidebar-collapsed", [] as string[], is_id_list);
  const collapsed = new Set(collapsed_ids);
  const items = use_resource(async (): Promise<SidebarItems> => {
    const [flakes, caches, hosts] = await Promise.all([api<Flake[]>("/api/flakes"), api<Cache[]>("/api/caches"), api<Host[]>("/api/hosts")]);
    return { flakes, caches, hosts };
  }, [], live);

  const rows = rows_of(sections, items.data ?? null);
  const item_id = item === null ? null : `${section}/${item}`;
  // A folded section lights up itself in place of its hidden item.
  const selected_id = item_id !== null && !collapsed.has(section_row_id(section)) && rows.some((row) => row.id === item_id) ? item_id : section_row_id(section);

  return (
    <Tree
      items={rows}
      label="Sections"
      render_item={(row) => row.label}
      name_of={(row) => row.label}
      collapsed={collapsed}
      on_collapsed_change={(next) => set_collapsed_ids([...next])}
      selected_id={selected_id}
      on_select={(row) => {
        window.location.hash = row.href.slice(1);
      }}
    />
  );
}
