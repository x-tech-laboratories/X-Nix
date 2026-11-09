// The Cache pages: every Attic cache as a card, and one cache with each target's build and push state and its buttons.

import { Badge } from "@x-tech-laboratories/x-libs/web/react/badges";
import { confirm_dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { Card, Cards, Crumbs, Facts, PageHeading, Section, Stack, Tile, Tiles, type Fact } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Empty, Loaded, use_resource } from "@x-tech-laboratories/x-libs/web/react/states";
import { DataTable } from "@x-tech-laboratories/x-libs/web/react/table";
import { toast } from "@x-tech-laboratories/x-libs/web/react/toasts";
import { age, bytes, duration } from "@x-tech-laboratories/x-libs/web/format";
import { link } from "@x-tech-laboratories/x-libs/web/router";
import { Fragment } from "react";
import { api, type ActionOutcome, type BuildAllOutcome, type Cache, type CacheActionId, type EventRow, type Job, type Status, type TargetRow } from "../api.ts";
import { Age } from "@x-tech-laboratories/x-libs/web/react/time";
import { StatusBadge } from "../ui.tsx";
import { error_toast, EventsList, FlakeLink, job_toast, JobsTable, MessagesList, refresh_interval_in_milliseconds, short_revision } from "./shared.tsx";

const status_tones: Record<Status, string> = { online: "good", info: "good", unavailable: "warn", warning: "warn", failed: "bad" };

// ── List ─────────────────────────────────────────────────────────────────────

export function CachesView() {
  const caches = use_resource(() => api<Cache[]>("/api/caches"), [], { refresh_in_milliseconds: refresh_interval_in_milliseconds });
  return (
    <div className="page">
      <PageHeading title="Cache" subtitle="Whether each closure is built from the flake's latest revision and pushed to its Attic cache." />
      <Stack>
        <Loaded resource={caches}>
          {(found) => (found.length === 0
            ? <Empty title="No caches yet." hint="Name each building host, its flake, its targets and its Attic cache under caches in the config file." />
            : <Cards>{found.map((cache) => <CacheCard key={cache.id} cache={cache} />)}</Cards>)}
        </Loaded>
      </Stack>
    </div>
  );
}

function CacheCard({ cache }: { cache: Cache }) {
  const reading = cache.reading;
  const tone = reading === null ? "none" : status_tones[reading.status];
  const job = cache.running_job;
  return (
    <Card title={cache.name} badge={<StatusBadge status={reading?.status ?? null} />} subtitle={cache.host ?? "this server"} class_name={`tone-edge-${tone}`} href={link(["cache", cache.id])}>
      <dl>
        <dt>Built</dt><dd>{count(cache, (row) => row.built === true)}</dd>
        <dt>Pushed</dt><dd>{count(cache, (row) => row.pushed_ok)}</dd>
        <dt>Checked</dt><dd>{reading ? age(reading.checked_epoch) : "—"}</dd>
        {cache.server && <><dt>Server</dt><dd className={`tone-${status_tones[cache.server.status]}`}>{server_word(cache)}</dd></>}
        {job && <><dt>Running</dt><dd>{`${job.kind}${job.progress ? `: ${job.progress}` : ""}`}</dd></>}
      </dl>
    </Card>
  );
}

// ── One cache ────────────────────────────────────────────────────────────────

interface CachePage {
  cache: Cache;
  jobs: Job[];
  events: EventRow[];
}

interface MissingPath {
  name: string;
  store_path: string;
}

export function CacheView({ id }: { id: string }) {
  const path = `/api/caches/${encodeURIComponent(id)}`;
  const page = use_resource(async (): Promise<CachePage> => {
    const [cache, jobs, events] = await Promise.all([
      api<Cache>(path),
      api<Job[]>(`/api/jobs?deployment=${encodeURIComponent(id)}&evaluations=1&limit=10`),
      api<EventRow[]>(`${path}/events`),
    ]);
    return { cache, jobs, events };
  }, [id], { refresh_in_milliseconds: refresh_interval_in_milliseconds });
  const cache = page.data?.cache ?? null;

  const run_refresh = async () => {
    toast("Checking every target…");
    await api(`${path}/refresh`, "POST").catch((error) => toast(String(error.message), { tone: "bad" }));
    await page.reload(true);
  };

  const run_build_all = async () => {
    try {
      const outcome = await api<ActionOutcome>(`${path}/build-all`, "POST");
      job_toast(outcome.message, outcome.job_id);
    } catch (error) {
      error_toast(error);
    }
    await page.reload(true);
  };

  const run_action = async (name: string, action: CacheActionId) => {
    try {
      const outcome = await api<ActionOutcome>(`${path}/targets/${encodeURIComponent(name)}/${action}`, "POST");
      job_toast(outcome.message, outcome.job_id);
    } catch (error) {
      error_toast(error);
    }
    await page.reload(true);
  };

  const pushed_note = (shown: Cache) => (shown.can_push ? " What it builds is pushed to the cache." : "");

  const targets_table = (shown: Cache, rows: TargetRow[]) => (
    <DataTable<TargetRow> caption="Tracked targets" rows={rows} row_key={(row) => row.name} columns={[
      { label: "Target", cell: (row) => <strong className={`tone-${status_tones[row.status]}`}>{row.name}</strong> },
      { label: "Built", cell: (row) => (row.built === null ? "—" : row.built ? "Yes" : "No") },
      { label: "Pushed", cell: (row) => row.pushed },
      { label: "State", cell: (row) => row.summary },
      { label: "Store path", cell: (row) => (row.target ? <code className="small">{row.target}</code> : "—") },
      { label: "Actions", cell: (row) => {
        const refusals = shown.targets.find((target) => target.name === row.name)?.refusals;
        if (refusals === undefined) return null;
        return (
          <div className="row-actions">
            <button className="small" disabled={refusals.build !== null} title={refusals.build ?? undefined} onClick={() => confirm_dialog({
              title: `Build ${row.name}`,
              message: `Build ${row.name} from the latest flake now?${pushed_note(shown)}`,
              confirm_label: "Build",
              danger: true,
              run: () => run_action(row.name, "build"),
            })}>Build</button>
            {shown.can_push && <button className="small" disabled={refusals.push !== null} title={refusals.push ?? undefined} onClick={() => void run_action(row.name, "push")}>Push</button>}
          </div>
        );
      } },
    ]} />
  );

  return (
    <div className="page">
      <Crumbs items={[["Cache", link(["cache"])], [id, null]]} />
      <PageHeading
        title={<>{cache?.name ?? id} {cache && <StatusBadge status={cache.reading?.status ?? null} />}</>}
        actions={cache && <>
          <button disabled={cache.running_job !== null} title={cache.running_job ? "A job is running" : undefined} onClick={() => void run_refresh()}>Check now</button>
          <button className="accent solid" disabled={cache.build_all_refusal !== null} title={cache.build_all_refusal ?? undefined} onClick={() => confirm_dialog({
            title: `Build all of ${cache.name}`,
            message: `Evaluate every target in one pass and build each as soon as it is evaluated?${pushed_note(cache)}`,
            confirm_label: "Build all",
            danger: true,
            run: run_build_all,
          })}>Build all</button>
        </>}
      />
      <Stack>
        <Loaded resource={page}>
          {({ cache: found, jobs, events }) => {
            const rows = found.reading?.rows ?? [];
            const missing: MissingPath[] = rows.flatMap((row) => row.missing.map((store_path) => ({ name: row.name, store_path })));
            return <>
              <CacheTiles cache={found} />
              <Section title="Findings"><MessagesList messages={found.reading?.messages ?? []} /></Section>
              <Section title="Details"><Details cache={found} /></Section>
              {found.server && <Section title={<span>Cache server <StatusBadge status={found.server.status} /></span>}><ServerDetails cache={found} /></Section>}
              <Section title="Tracked targets">{rows.length === 0 ? <Empty title="Not checked yet." /> : targets_table(found, rows)}</Section>
              {found.reading?.build_all && <BuildAllSection outcome={found.reading.build_all} />}
              {missing.length > 0 && (
                <Section title="Paths not in the cache">
                  <DataTable<MissingPath> caption="Paths not in the cache" rows={missing} columns={[
                    { label: "Target", cell: (item) => item.name },
                    { label: "Store path", cell: (item) => <code>{item.store_path}</code> },
                  ]} />
                </Section>
              )}
              <Section title="Jobs" tools={<a href={link(["builds"], { owner: found.id })}>Build history</a>}>
                {jobs.length === 0 ? <Empty title="No jobs yet." /> : <JobsTable jobs={jobs} show_deployment={false} />}
              </Section>
              <Section title="Events">{events.length === 0 ? <Empty title="No events yet." /> : <EventsList events={events} />}</Section>
            </>;
          }}
        </Loaded>
      </Stack>
    </div>
  );
}

// ── Parts ────────────────────────────────────────────────────────────────────

function CacheTiles({ cache }: { cache: Cache }) {
  const reading = cache.reading;
  const rows = reading?.rows ?? [];
  const all = (good: (row: TargetRow) => boolean) => rows.length > 0 && rows.every(good);
  const edge = (good: (row: TargetRow) => boolean) => (rows.length === 0 || all(good) ? null : "tone-edge-warn");
  const missing = rows.reduce((sum, row) => sum + row.missing_count, 0);
  return (
    <Tiles>
      <Tile label="Built" value={count(cache, (row) => row.built === true)} class_name={edge((row) => row.built === true)} />
      <Tile label="Pushed" value={count(cache, (row) => row.pushed_ok)} class_name={edge((row) => row.pushed_ok)} />
      <Tile label="Missing paths" value={reading ? missing.toLocaleString() : "—"} class_name={missing > 0 ? "tone-edge-warn" : null} />
      <Tile label="Revision" value={short_revision(reading?.revision ?? null)} />
      <Tile label="Checked" value={reading ? age(reading.checked_epoch) : "—"} />
      {cache.server && <Tile label="Server" value={server_word(cache)} class_name={cache.server.status === "online" ? null : `tone-edge-${status_tones[cache.server.status]}`} />}
      {cache.server?.size_bytes != null && <Tile label="Cache size" value={bytes(cache.server.size_bytes)} />}
    </Tiles>
  );
}

// The cache server's state in a word or two.
function server_word(cache: Cache): string {
  const server = cache.server;
  if (server === null) return "—";
  if (server.status !== "online") return server.healthy === false ? "Unhealthy" : "Unreachable";
  return server.healthy === true ? "Healthy" : "Answering";
}

interface Sample {
  name: string;
  value: number;
}

// What the cache server's own endpoints answered.
function ServerDetails({ cache }: { cache: Cache }) {
  const server = cache.server!;
  const rows: Fact[] = [];
  if (cache.server_urls.info !== null) rows.push(["Cache info", <code>{cache.server_urls.info}</code>]);
  for (const [key, value] of Object.entries(server.info ?? {})) rows.push([key, value]);
  if (cache.server_urls.health !== null) rows.push(["Health", <span><code>{cache.server_urls.health}</code>{` ${server.healthy === null ? "" : server.healthy ? "healthy" : "not healthy"}`}</span>]);
  if (cache.server_urls.metrics !== null) rows.push(["Metrics", <code>{cache.server_urls.metrics}</code>]);
  rows.push(["Last read", <Age epoch={server.checked_epoch} />]);
  return <>
    <MessagesList messages={server.messages} />
    <Facts rows={rows} layout="rows" />
    {server.metrics.length > 0 && (
      <DataTable<Sample> caption="Cache server metrics" rows={server.metrics} columns={[
        { label: "Metric", cell: (sample) => <code className="small">{sample.name}</code> },
        { label: "Value", cell: (sample) => (/_bytes(\{|$)/.test(sample.name) ? bytes(sample.value) : sample.value.toLocaleString()) },
      ]} />
    )}
  </>;
}

function Details({ cache }: { cache: Cache }) {
  const rows: Fact[] = [
    ["Builds on", cache.hosts.length === 0 ? "this server" : cache.hosts.join(", then ")],
    ["Flake", <FlakeLink flake_id={cache.flake_id} reference={cache.flake} />],
    ["Cache", <code>{cache.cache_url}</code>],
    ["Checked every", `${Math.round(cache.interval / 60)} minutes`],
    ["Daily Build all", cache.build_at === null ? "off" : <span>at {cache.build_at}, last slot <Age epoch={cache.scheduled_build} /></span>],
    ["Builds for", cache.deployments.length === 0 ? "no deployment names it" : (
      <span>{cache.deployments.map((deployment, index) => <Fragment key={deployment.id}>{index === 0 ? "" : ", "}<a href={link(["deployments", deployment.id])}>{deployment.name}</a></Fragment>)}</span>
    )],
  ];
  for (const target of cache.targets) {
    const where = target.build_link === null ? "not rooted" : `rooted at ${target.build_link}${target.kept_only_in_cache ? ", dropped once pushed" : ""}`;
    rows.push([target.name, <span><code>{target.installable}</code><span className="muted small"> {where}</span></span>]);
  }
  return <Facts rows={rows} layout="rows" />;
}

const build_all_words: Record<string, [text: string, tone: "good" | "bad" | "warn"]> = {
  ok: ["Built", "good"], failed: ["Build failed", "bad"], push_failed: ["Push failed", "bad"], eval_failed: ["Evaluation failed", "bad"], not_reported: ["Not reported", "warn"],
};

type BuildAllResult = BuildAllOutcome["results"][number];

// How the last Build all ended for each target.
function BuildAllSection({ outcome }: { outcome: BuildAllOutcome }) {
  return (
    <Section title={<span>Last build all <a className="small" href={link(["jobs", String(outcome.job_id)])}>job #{outcome.job_id}</a></span>}>
      <DataTable<BuildAllResult> caption="Last build all" rows={outcome.results} row_key={(result) => result.name} columns={[
        { label: "Target", cell: (result) => <strong>{result.name}</strong> },
        { label: "Result", cell: (result) => {
          const [text, tone] = build_all_words[result.result] ?? [result.result, "none"];
          return <Badge tone={tone}>{text}</Badge>;
        } },
        { label: "Took", cell: (result) => (result.seconds === null ? "—" : duration(result.seconds)) },
      ]} />
    </Section>
  );
}

// How many targets pass, out of all of them.
function count(cache: Cache, good: (row: TargetRow) => boolean): string {
  const rows = cache.reading?.rows ?? [];
  return rows.length === 0 ? "—" : `${rows.filter(good).length} / ${rows.length}`;
}
