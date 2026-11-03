// The Store pages: every host's Nix store as a card, and one store with its profiles, collections and Collect Garbage.

import { api, type Host, type Job, type Profile, type Status } from "../api.ts";
import { age, bytes, h, nodes, stamp, until } from "../dom.ts";
import { link } from "../router.ts";
import { crumbs, data_table, empty, facts, load, section, status_badge, toast } from "../ui.ts";
import { host_action_button, jobs_table, messages_list, refresh_interval_in_milliseconds, tile, type View } from "./shared.ts";

type Tone = "good" | "warn" | "bad" | "none";

const status_tones: Record<Status, Tone> = { online: "good", info: "good", unavailable: "warn", warning: "warn", failed: "bad" };

// ── List ─────────────────────────────────────────────────────────────────────

export function stores_view(): View {
  const list = h("div");
  const refresh = (quiet: boolean) => load(list, async () => {
    const watched = (await api<Host[]>("/api/hosts")).filter((host) => host.gc !== null);
    if (watched.length === 0) return empty("No stores watched.", "Every host's store is watched unless its gc is set to false.");
    return h("div", { class: "grid" }, ...watched.map(store_card));
  }, { quiet });
  void refresh(false);
  const timer = setInterval(() => void refresh(true), refresh_interval_in_milliseconds);

  return {
    title: "Store",
    root: h("div", { class: "page" },
      h("h1", {}, "Store"),
      h("p", { class: "muted" }, "Each host's Nix store, its profiles' generations, and whether garbage collection keeps it in check."),
      list,
    ),
    dispose: () => clearInterval(timer),
  };
}

function store_card(host: Host): HTMLElement {
  const store = host.reading?.store ?? null;
  const tone = store === null ? "none" : status_tones[store.status];
  return h("a", { class: `card tone-edge-${tone}`, href: link(["store", host.name]) },
    h("div", { class: "card-head" }, h("strong", {}, host.display_name), status_badge(store?.status ?? null)),
    h("div", { class: "muted card-host" }, host.own ? "this server" : host.name),
    h("dl", {},
      h("dt", {}, "Used"), h("dd", {}, used_text(host)),
      h("dt", {}, "Last collected"), h("dd", { class: tone_class(last_tone(host)) }, last_text(host)),
      h("dt", {}, "Next"), h("dd", {}, next_text(host)),
      h("dt", {}, "Generations"), h("dd", {}, store?.generations ?? "—"),
    ));
}

// ── One store ────────────────────────────────────────────────────────────────

export function store_view(id: string): View {
  const body = h("div", { class: "stack" });
  const heading = h("h1", {}, id);
  const badge = h("span");
  const buttons = h("div", { class: "head-actions" });

  const refresh = (quiet: boolean) => load(body, async () => {
    const [host, jobs] = await Promise.all([
      api<Host>(`/api/hosts/${encodeURIComponent(id)}`),
      api<Job[]>(`/api/jobs?deployment=${encodeURIComponent(`host:${id}`)}&kind=collect&limit=10`),
    ]);
    heading.textContent = host.display_name;
    badge.replaceChildren(status_badge(host.reading?.store?.status ?? null));
    const collect = host.actions.find((action) => action.id === "collect");
    buttons.replaceChildren(...nodes([
      h("button", { onclick: () => void run_refresh() }, "Check now"),
      collect && host.gc !== null ? host_action_button(host, collect, () => refresh(true)) : null,
    ]));
    if (host.gc === null) return empty("This store is not watched.", "Its host sets gc to false.");
    const store = host.reading?.store ?? null;
    return [
      tiles(host),
      section("Findings", messages_list(store?.messages ?? [])),
      section("Profiles", store === null || store.profiles.length === 0 ? empty("No profiles read yet.") : profiles_table(store.profiles)),
      section("Details", details(host)),
      section("Collections", jobs.length === 0 ? empty("No collections run from here yet.") : jobs_table(jobs, false)),
    ];
  }, { quiet });

  const run_refresh = async () => {
    toast("Reading the store…");
    await api(`/api/hosts/${encodeURIComponent(id)}/refresh`, "POST").catch((error) => toast(String(error.message), "bad"));
    await refresh(true);
  };

  void refresh(false);
  const timer = setInterval(() => void refresh(true), refresh_interval_in_milliseconds);

  return {
    title: `Store · ${id}`,
    root: h("div", { class: "page" },
      crumbs([["Store", link(["store"])], [id, null]]),
      h("header", { class: "page-head" }, h("div", { class: "card-head" }, heading, badge), buttons),
      body,
    ),
    dispose: () => clearInterval(timer),
  };
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
    tile("Last collection", last_text(host), tile_class(last_tone(host))),
    tile("Last yield", last?.freed_bytes == null ? "—" : bytes(last.freed_bytes)),
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
    ["Host", h("a", { href: link(["hosts", host.name]) }, host.own ? `${host.name} (this server)` : host.name)],
    ["Store", h("code", {}, gc.store)],
    ["Size", store?.size_bytes == null ? "—" : `${bytes(store.used_bytes ?? 0)} used of ${bytes(store.size_bytes)}, ${bytes(store.avail_bytes ?? 0)} free`],
    ["Unit", h("code", {}, gc.unit)],
    ["Timer", h("span", {}, h("code", {}, gc.timer), store === null ? "" : store.timer_active ? " (active)" : store.timer_loaded ? " (inactive)" : " (not installed)")],
    ["Collect Garbage runs", h("code", {}, gc.command)],
    ["Last collection", last === null ? "none seen" : h("span", {}, when(last.epoch), last.succeeded ? ", succeeded" : ", failed",
      last.deleted === null ? "" : `, ${last.deleted.toLocaleString()} paths deleted`)],
    ["Oldest generation", when(store?.oldest_generation_epoch)],
    ["Last read", when(store?.checked_epoch)],
  ];
  if (last?.error) rows.push(["Collection error", h("pre", { class: "output" }, last.error)]);
  return facts(rows, "rows");
}

// ── Wording ──────────────────────────────────────────────────────────────────

function used_text(host: Host): string {
  const store = host.reading?.store ?? null;
  if (store?.used_percent == null) return "—";
  return `${store.used_percent.toFixed(1)}% of ${bytes(store.size_bytes ?? 0)}`;
}

function last_text(host: Host): string {
  const last = host.state.last_collection;
  if (last === null) return host.reading?.store ? "Never seen" : "—";
  return last.succeeded ? age(last.epoch) : `Failed ${age(last.epoch)}`;
}

// Failed or stale reads badly.
function last_tone(host: Host): Tone {
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

function tone_class(tone: Tone): string | null {
  return tone === "none" || tone === "good" ? null : `tone-${tone}`;
}

function tile_class(tone: Tone): string | null {
  return tone === "none" || tone === "good" ? null : `tone-edge-${tone}`;
}
