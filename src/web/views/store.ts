// The Store tab of a host's page: its Nix store, its profiles' generations, and the collections that keep it in check.

import { api, type Host, type Job, type Profile } from "../api.ts";
import { age, bytes, h, stamp, until, type Child } from "../dom.ts";
import { data_table, empty, facts, section } from "../ui.ts";
import { jobs_table, messages_list, tile } from "./shared.ts";

type Tone = "good" | "warn" | "bad" | "none";

// ── Tab ──────────────────────────────────────────────────────────────────────

export async function store_tab(host: Host): Promise<Child> {
  if (host.gc === null) return empty("This store is not watched.", "Its host sets gc to false.");
  const jobs = await api<Job[]>(`/api/jobs?deployment=${encodeURIComponent(`host:${host.name}`)}&kind=collect&limit=10`);
  const store = host.reading?.store ?? null;
  return [
    tiles(host),
    section("Findings", messages_list(store?.messages ?? [])),
    section("Details", details(host)),
    section("Profiles", store === null || store.profiles.length === 0 ? empty("No profiles read yet.") : profiles_table(store.profiles)),
    section("Collections", jobs.length === 0 ? empty("No collections run from here yet.") : jobs_table(jobs, false)),
  ];
}

// ── Parts ────────────────────────────────────────────────────────────────────

function tiles(host: Host): HTMLElement {
  const store = host.reading?.store ?? null;
  const last = host.state.last_collection;
  const gc = host.gc!;
  const used_tone: Tone = store?.used_percent == null ? "none"
    : gc.threshold !== null && store.used_percent >= gc.threshold ? "bad"
      : gc.warning !== null && store.used_percent >= gc.warning ? "warn" : "none";
  const next_tone: Tone = store !== null && !store.timer_active ? "warn" : "none";
  return h("div", { class: "tiles" },
    tile("Last collection", last_collection_text(host), tile_class(last_collection_tone(host))),
    tile("Last yield", last?.freed_bytes == null ? "—" : last.deleted === null ? bytes(last.freed_bytes) : `${bytes(last.freed_bytes)}, ${last.deleted.toLocaleString()} paths`),
    tile("Next collection", next_text(host), tile_class(next_tone)),
    tile("Store used", store?.used_percent == null ? "—" : `${store.used_percent.toFixed(1)}%`, tile_class(used_tone)),
    tile("Store paths", store?.paths == null ? "—" : store.paths.toLocaleString()),
    tile("Generations", store?.generations ?? "—"),
    tile("GC roots", store?.roots == null ? "—" : store.roots.toLocaleString()),
  );
}

function profiles_table(profiles: Profile[]): HTMLElement {
  return data_table<Profile>([
    { label: "Profile", cell: (profile) => h("code", {}, profile.path) },
    { label: "Current", cell: (profile) => profile.generation ?? "—" },
    { label: "Generations", cell: (profile) => profile.count },
    { label: "Oldest kept", cell: (profile) => (profile.oldest_epoch ? h("span", { title: stamp(profile.oldest_epoch) }, age(profile.oldest_epoch)) : "—") },
  ], profiles, "Profiles");
}

function details(host: Host): HTMLElement {
  const store = host.reading?.store ?? null;
  const last = host.state.last_collection;
  const gc = host.gc!;
  const when = (epoch: number | null | undefined) => (epoch ? h("span", { title: stamp(epoch) }, age(epoch)) : "—");
  const rows: Parameters<typeof facts>[0] = [
    ["Store", h("code", {}, gc.store)],
    ["Size", store?.size_bytes == null ? "—" : `${bytes(store.used_bytes ?? 0)} used of ${bytes(store.size_bytes)}, ${bytes(store.avail_bytes ?? 0)} free`],
    ["Unit", h("code", {}, gc.unit)],
    ["Timer", h("span", {}, h("code", {}, gc.timer), store === null ? "" : store.timer_active ? " (active)" : store.timer_loaded ? " (inactive)" : " (not installed)")],
    ["Collect Garbage runs", h("code", {}, gc.command)],
    ["Oldest generation", when(store?.oldest_generation_epoch)],
    ["Last read", when(store?.checked_epoch)],
  ];
  if (last?.error) rows.push(["Collection error", h("pre", { class: "output" }, last.error)]);
  return facts(rows, "rows");
}

// ── Wording ──────────────────────────────────────────────────────────────────

function last_collection_text(host: Host): string {
  const last = host.state.last_collection;
  if (last === null) return host.reading?.store ? "Never seen" : "—";
  return last.succeeded ? age(last.epoch) : `Failed ${age(last.epoch)}`;
}

// Failed or stale reads badly.
export function last_collection_tone(host: Host): Tone {
  const last = host.state.last_collection;
  if (last === null) return host.reading?.store ? "warn" : "none";
  if (!last.succeeded) return "bad";
  return Date.now() / 1000 - last.epoch > host.gc!.max_age && !host.reading?.store?.collecting ? "bad" : "none";
}

function next_text(host: Host): string {
  const store = host.reading?.store ?? null;
  if (store === null) return "—";
  if (store.collecting) return "Collecting now";
  if (!store.timer_active) return "Not scheduled";
  return store.next_epoch === null ? "—" : until(store.next_epoch);
}

function tile_class(tone: Tone): string | null {
  return tone === "none" || tone === "good" ? null : `tone-edge-${tone}`;
}
