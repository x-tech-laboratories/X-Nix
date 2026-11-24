// The sidebar's sections, with Flakes, Cache and Hosts folding open onto every flake, cache and host.

import type { ShellSection, ShellSectionItem } from "@x-tech-laboratories/x-libs/web/react/shell";
import { use_resource } from "@x-tech-laboratories/x-libs/web/react/states";
import { link } from "@x-tech-laboratories/x-libs/web/router";
import { api, type Cache, type Flake, type Host } from "./api.ts";
import { live } from "./views/shared.tsx";

// Where the folded sections are kept.
export const sidebar_pref = "x-nix-sidebar-collapsed";

type SectionItems = Record<string, ShellSectionItem[]>;

function items_of(section: string, items: { id: string; label: string }[]): ShellSectionItem[] {
  return items.map((item) => ({ id: item.id, label: item.label, href: link([section, item.id]) }));
}

// The sections with their items once signed in, loaded again as they change.
export function use_sidebar_sections(sections: ShellSection[], signed_in: boolean): ShellSection[] {
  const items = use_resource(async (): Promise<SectionItems> => {
    if (!signed_in) return {};
    const [flakes, caches, hosts] = await Promise.all([api<Flake[]>("/api/flakes"), api<Cache[]>("/api/caches"), api<Host[]>("/api/hosts")]);
    return {
      flakes: items_of("flakes", flakes.map((flake) => ({ id: flake.id, label: flake.name }))),
      cache: items_of("cache", caches.map((cache) => ({ id: cache.id, label: cache.name }))),
      hosts: items_of("hosts", hosts.map((host) => ({ id: host.name, label: host.display_name }))),
    };
  }, [signed_in], live);
  return sections.map((section) => ({ ...section, children: items.data?.[section.id] ?? [] }));
}
