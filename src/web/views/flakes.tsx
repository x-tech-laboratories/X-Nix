// The Flakes pages: every flake as a card, and one flake with its locked inputs, its Update and what names it.

import { confirm_dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { Card, Cards, Crumbs, Facts, PageHeading, Section, Stack, Tile, Tiles, type Fact } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Empty, Loaded, use_resource } from "@x-tech-laboratories/x-libs/web/react/states";
import { DataTable } from "@x-tech-laboratories/x-libs/web/react/table";
import { toast } from "@x-tech-laboratories/x-libs/web/react/toasts";
import { age, duration, stamp } from "@x-tech-laboratories/x-libs/web/format";
import { link } from "@x-tech-laboratories/x-libs/web/router";
import { api, type ActionOutcome, type EventRow, type Flake, type Job, type LockedInput, type Status } from "../api.ts";
import { Age } from "@x-tech-laboratories/x-libs/web/react/time";
import { StatusBadge } from "../ui.tsx";
import { error_toast, EventsList, job_toast, JobsTable, MessagesList, refresh_interval_in_milliseconds, short_revision } from "./shared.tsx";

const status_tones: Record<Status, string> = { online: "good", info: "good", unavailable: "warn", warning: "warn", failed: "bad" };

// ── List ─────────────────────────────────────────────────────────────────────

export function FlakesView() {
  const flakes = use_resource(() => api<Flake[]>("/api/flakes"), [], { refresh_in_milliseconds: refresh_interval_in_milliseconds });
  return (
    <div className="page">
      <PageHeading title="Flakes" subtitle="Each flake's locked inputs and how old they are, and the update that moves them on for every deployment naming it." />
      <Stack>
        <Loaded resource={flakes}>
          {(found) => (found.length === 0
            ? <Empty title="No flakes yet." hint="Name each flake and how it is updated under flakes in the config file, then name its id in each deployment's flake." />
            : <Cards>{found.map((flake) => <FlakeCard key={flake.id} flake={flake} />)}</Cards>)}
        </Loaded>
      </Stack>
    </div>
  );
}

function FlakeCard({ flake }: { flake: Flake }) {
  const reading = flake.reading;
  const tone = reading === null ? "none" : status_tones[reading.status];
  const job = flake.running_job;
  return (
    <Card title={flake.name} badge={<StatusBadge status={reading?.status ?? null} />} subtitle={flake.url} class_name={`tone-edge-${tone}`} href={link(["flakes", flake.id])}>
      <dl>
        <dt>Revision</dt><dd>{short_revision(reading?.revision ?? null)}</dd>
        <dt>Oldest input</dt><dd>{reading?.inputs_last_modified_epoch ? age(reading.inputs_last_modified_epoch) : "—"}</dd>
        <dt>Updated</dt><dd>{last_update_word(flake)}</dd>
        <dt>Used by</dt><dd>{String(flake.deployments.length + flake.caches.length)}</dd>
        {job && <><dt>Running</dt><dd>{`${job.kind}${job.progress ? `: ${job.progress}` : ""}`}</dd></>}
      </dl>
    </Card>
  );
}

// ── One flake ────────────────────────────────────────────────────────────────

interface FlakePage {
  flake: Flake;
  jobs: Job[];
  events: EventRow[];
}

export function FlakeView({ id }: { id: string }) {
  const path = `/api/flakes/${encodeURIComponent(id)}`;
  const page = use_resource(async (): Promise<FlakePage> => {
    const [flake, jobs, events] = await Promise.all([
      api<Flake>(path),
      api<Job[]>(`/api/jobs?deployment=${encodeURIComponent(id)}&limit=10`),
      api<EventRow[]>(`${path}/events`),
    ]);
    return { flake, jobs, events };
  }, [id], { refresh_in_milliseconds: refresh_interval_in_milliseconds });
  const flake = page.data?.flake ?? null;

  const run_refresh = async () => {
    toast("Reading the flake…");
    await api(`${path}/refresh`, "POST").catch((error) => toast(String(error.message), { tone: "bad" }));
    await page.reload(true);
  };

  const run_update = async () => {
    try {
      const outcome = await api<ActionOutcome>(`${path}/update`, "POST");
      job_toast(outcome.message, outcome.job_id);
    } catch (error) {
      error_toast(error);
    }
    await page.reload(true);
  };

  const ask_update = (shown: Flake) => {
    const where = shown.pushes_to === null ? "writes the lock in place" : `pushes a commit of the new lock to ${shown.pushes_to}`;
    confirm_dialog({
      title: `Update ${shown.name}`,
      message: `Update every input of ${shown.name}'s lock now? It ${where}, and every deployment naming the flake evaluates afresh.`,
      confirm_label: "Update",
      danger: true,
      run: run_update,
    });
  };

  return (
    <div className="page">
      <Crumbs items={[["Flakes", link(["flakes"])], [id, null]]} />
      <PageHeading
        title={<>{flake?.name ?? id} {flake && <StatusBadge status={flake.reading?.status ?? null} />}</>}
        actions={flake && <>
          <button disabled={flake.running_job !== null} title={flake.running_job ? "An update is running" : undefined} onClick={() => void run_refresh()}>Read now</button>
          <button className="accent solid" disabled={flake.update_refusal !== null} title={flake.update_refusal ?? undefined} onClick={() => ask_update(flake)}>Update</button>
        </>}
      />
      <Stack>
        <Loaded resource={page}>
          {({ flake: found, jobs, events }) => <>
            <FlakeTiles flake={found} />
            <Section title="Findings"><MessagesList messages={found.reading?.messages ?? []} /></Section>
            <Section title="Details"><Details flake={found} /></Section>
            <Section title="Used by"><UsedBy flake={found} /></Section>
            <Section title="Locked inputs">{(found.reading?.inputs.length ?? 0) === 0 ? <Empty title="Not read yet." /> : <InputsTable flake={found} />}</Section>
            <Section title="Jobs">{jobs.length === 0 ? <Empty title="No updates yet." /> : <JobsTable jobs={jobs} show_deployment={false} />}</Section>
            <Section title="Events">{events.length === 0 ? <Empty title="No events yet." /> : <EventsList events={events} />}</Section>
          </>}
        </Loaded>
      </Stack>
    </div>
  );
}

// ── Parts ────────────────────────────────────────────────────────────────────

function FlakeTiles({ flake }: { flake: Flake }) {
  const reading = flake.reading;
  const failed = flake.last_update !== null && !flake.last_update.succeeded;
  return (
    <Tiles>
      <Tile label="Revision" value={short_revision(reading?.revision ?? null)} />
      <Tile label="Last changed" value={reading?.last_modified_epoch ? age(reading.last_modified_epoch) : "—"} />
      <Tile label="Oldest input" value={reading?.inputs_last_modified_epoch ? age(reading.inputs_last_modified_epoch) : "—"} class_name={is_stale(flake, reading?.inputs_last_modified_epoch ?? null) ? "tone-edge-warn" : null} />
      <Tile
        label="Last update"
        value={flake.last_update === null ? "—" : <a href={link(["jobs", String(flake.last_update.job_id)])} title={flake.last_update.summary}>{last_update_word(flake)}</a>}
        class_name={failed ? "tile-bad" : null}
      />
    </Tiles>
  );
}

// When the last update ended and whether it worked, in a few words.
function last_update_word(flake: Flake): string {
  const last = flake.last_update;
  if (last === null) return "—";
  return last.succeeded ? age(last.finished_epoch) : `Failed ${age(last.finished_epoch)}`;
}

// Whether an input last changed longer ago than the flake's max_input_age allows.
function is_stale(flake: Flake, epoch: number | null): boolean {
  return flake.max_input_age !== null && epoch !== null && Date.now() / 1000 - epoch > flake.max_input_age;
}

function InputsTable({ flake }: { flake: Flake }) {
  return (
    <DataTable<LockedInput> caption="Locked inputs" rows={flake.reading!.inputs} row_key={(input) => input.name} columns={[
      { label: "Input", cell: (input) => <strong>{input.name}</strong> },
      { label: "Source", cell: (input) => (input.follows !== null ? <span className="muted">follows {input.follows}</span> : input.source ? <code>{input.source}</code> : "—") },
      { label: "Revision", cell: (input) => (input.revision ? <code>{short_revision(input.revision)}</code> : "—") },
      { label: "Last changed", cell: (input) => (input.last_modified_epoch === null ? "—" : (
        <span className={is_stale(flake, input.last_modified_epoch) ? "tone-warn" : undefined} title={stamp(input.last_modified_epoch)}>{age(input.last_modified_epoch)}</span>
      )) },
    ]} />
  );
}

interface UsedEntry {
  id: string;
  name: string;
  kind: string;
  href: string;
}

function UsedBy({ flake }: { flake: Flake }) {
  if (flake.deployments.length + flake.caches.length === 0) return <Empty title="Nothing names this flake." hint="Name its id in a deployment's or a cache's flake." />;
  const entries: UsedEntry[] = [
    ...flake.deployments.map((deployment) => ({ id: deployment.id, name: deployment.name, kind: "Deployment", href: link(["deployments", deployment.id]) })),
    ...flake.caches.map((cache) => ({ id: cache.id, name: cache.name, kind: "Cache", href: link(["cache", cache.id]) })),
  ];
  return (
    <DataTable<UsedEntry> caption="Used by" rows={entries} row_key={(entry) => entry.href} columns={[
      { label: "Name", cell: (entry) => <a href={entry.href}>{entry.name}</a> },
      { label: "Kind", cell: (entry) => entry.kind },
    ]} />
  );
}

function Details({ flake }: { flake: Flake }) {
  const reading = flake.reading;
  const rows: Fact[] = [
    ["Reference", <code>{flake.url}</code>],
    ["Reads and updates on", flake.host ?? "this server"],
    ["Read every", duration(flake.interval)],
    ["Last read", <Age epoch={reading?.checked_epoch} />],
    ["Daily update", flake.update_at === null ? "off" : <span>at {flake.update_at}, last slot <Age epoch={flake.scheduled_update} /></span>],
    ["Update", flake.update_refusal !== null && flake.running_job === null ? flake.update_refusal : flake.pushes_to === null ? "writes the lock in place" : <span>pushes to <code>{flake.pushes_to}</code></span>],
  ];
  if (flake.pushes_to !== null) rows.push(["Commit author", flake.commit_author], ["Commit message", <code>{flake.commit_message}</code>]);
  if (flake.max_input_age !== null) rows.push(["Input age limit", duration(flake.max_input_age)]);
  if (flake.last_update !== null) rows.push(["Last update changed", flake.last_update.summary]);
  if (reading?.metadata_error) rows.push(["Read error", <pre className="output">{reading.metadata_error}</pre>]);
  return <Facts rows={rows} layout="rows" />;
}
