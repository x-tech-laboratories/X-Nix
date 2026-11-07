// The Store tab of a host's page: its Nix store, its profiles' generations, and the collections that keep it in check.

import { Facts, Section, Tile, Tiles, type Fact } from "@x-tech-laboratories/x-libs/web/preact/layout";
import { Empty } from "@x-tech-laboratories/x-libs/web/preact/states";
import { DataTable } from "@x-tech-laboratories/x-libs/web/preact/table";
import { age, bytes } from "@x-tech-laboratories/x-libs/web/format";
import { api, type Host, type Job, type Profile } from "../api.ts";
import { Age } from "@x-tech-laboratories/x-libs/web/preact/time";
import { until } from "../ui.tsx";
import { JobsTable, MessagesList } from "./shared.tsx";

type Tone = "good" | "warn" | "bad" | "none";

// ── Tab ──────────────────────────────────────────────────────────────────────

// The collections run from here, or null for a store that is not watched.
export async function load_store(host: Host): Promise<Job[] | null> {
  if (host.gc === null) return null;
  return api<Job[]>(`/api/jobs?deployment=${encodeURIComponent(`host:${host.name}`)}&kind=collect&limit=10`);
}

export function StoreTab({ host, jobs }: { host: Host; jobs: Job[] | null }) {
  if (host.gc === null || jobs === null) return <Empty title="This store is not watched." hint="Its host sets gc to false." />;
  const store = host.reading?.store ?? null;
  return <>
    <StoreTiles host={host} />
    <Section title="Findings"><MessagesList messages={store?.messages ?? []} /></Section>
    <Section title="Details"><Details host={host} /></Section>
    <Section title="Profiles">{store === null || store.profiles.length === 0 ? <Empty title="No profiles read yet." /> : <ProfilesTable profiles={store.profiles} />}</Section>
    <Section title="Collections">{jobs.length === 0 ? <Empty title="No collections run from here yet." /> : <JobsTable jobs={jobs} show_deployment={false} />}</Section>
  </>;
}

// ── Parts ────────────────────────────────────────────────────────────────────

function StoreTiles({ host }: { host: Host }) {
  const store = host.reading?.store ?? null;
  const last = host.state.last_collection;
  const gc = host.gc!;
  const used_tone: Tone = store?.used_percent == null ? "none"
    : gc.threshold !== null && store.used_percent >= gc.threshold ? "bad"
      : gc.warning !== null && store.used_percent >= gc.warning ? "warn" : "none";
  const next_tone: Tone = store !== null && !store.timer_active ? "warn" : "none";
  return (
    <Tiles>
      <Tile label="Last collection" value={last_collection_text(host)} class_name={tile_class(last_collection_tone(host))} />
      <Tile label="Last yield" value={last?.freed_bytes == null ? "—" : last.deleted === null ? bytes(last.freed_bytes) : `${bytes(last.freed_bytes)}, ${last.deleted.toLocaleString()} paths`} />
      <Tile label="Next collection" value={next_text(host)} class_name={tile_class(next_tone)} />
      <Tile label="Store used" value={store?.used_percent == null ? "—" : `${store.used_percent.toFixed(1)}%`} class_name={tile_class(used_tone)} />
      <Tile label="Store paths" value={store?.paths == null ? "—" : store.paths.toLocaleString()} />
      <Tile label="Generations" value={store?.generations ?? "—"} />
      <Tile label="GC roots" value={store?.roots == null ? "—" : store.roots.toLocaleString()} />
    </Tiles>
  );
}

function ProfilesTable({ profiles }: { profiles: Profile[] }) {
  return (
    <DataTable<Profile> caption="Profiles" rows={profiles} row_key={(profile) => profile.path} columns={[
      { label: "Profile", cell: (profile) => <code>{profile.path}</code> },
      { label: "Current", cell: (profile) => profile.generation ?? "—" },
      { label: "Generations", cell: (profile) => profile.count },
      { label: "Oldest kept", cell: (profile) => (profile.oldest_epoch ? <Age epoch={profile.oldest_epoch} /> : "—") },
    ]} />
  );
}

function Details({ host }: { host: Host }) {
  const store = host.reading?.store ?? null;
  const last = host.state.last_collection;
  const gc = host.gc!;
  const rows: Fact[] = [
    ["Store", <code>{gc.store}</code>],
    ["Size", store?.size_bytes == null ? "—" : `${bytes(store.used_bytes ?? 0)} used of ${bytes(store.size_bytes)}, ${bytes(store.avail_bytes ?? 0)} free`],
    ["Unit", <code>{gc.unit}</code>],
    ["Timer", <span><code>{gc.timer}</code>{store === null ? "" : store.timer_active ? " (active)" : store.timer_loaded ? " (inactive)" : " (not installed)"}</span>],
    ["Collect Garbage runs", <code>{gc.command}</code>],
    ["Oldest generation", <Age epoch={store?.oldest_generation_epoch} />],
    ["Last read", <Age epoch={store?.checked_epoch} />],
  ];
  if (last?.error) rows.push(["Collection error", <pre class="output">{last.error}</pre>]);
  return <Facts rows={rows} layout="rows" />;
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
