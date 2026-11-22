// The Overview: hosts, flakes, caches, jobs, deployments, reboots and agents by status, the hosts that need attention and
// why, a map of which flakes build which caches and hosts, the last day or week of jobs by hour or day and by owner, and the
// jobs running now. Each host's own state is on the Hosts page, which every row here links to.

import { Badge, Chips } from "@x-tech-laboratories/x-libs/web/react/badges";
import { Donut } from "@x-tech-laboratories/x-libs/web/react/charts";
import { Segmented } from "@x-tech-laboratories/x-libs/web/react/controls";
import { PageHeading, Section, Stack } from "@x-tech-laboratories/x-libs/web/react/layout";
import { use_pref } from "@x-tech-laboratories/x-libs/web/react/prefs";
import { Empty, Loaded, use_resource } from "@x-tech-laboratories/x-libs/web/react/states";
import { DataTable } from "@x-tech-laboratories/x-libs/web/react/table";
import { one_of } from "@x-tech-laboratories/x-libs/web/prefs";
import { link } from "@x-tech-laboratories/x-libs/web/router";
import { api, type Cache, type Flake, type Health, type Job, type Status } from "../api.ts";
import { Age } from "@x-tech-laboratories/x-libs/web/react/time";
import { StatusBadge } from "../ui.tsx";
import { JobsOverTime, JobTimeline, load_recent_jobs, OutcomeDonut, outcome_parts, periods, type Period } from "./charts.tsx";
import { host_rows, row_status, type Row } from "./hosts.tsx";
import { MapSection } from "./map.tsx";
import { drift_state, JobsTable, live } from "./shared.tsx";
import { last_collection_tone } from "./store.tsx";

// ── View ─────────────────────────────────────────────────────────────────────

export function OverviewView() {
  const refresh = live;
  const rows = use_resource(host_rows, [], refresh);
  const flakes = use_resource(() => api<Flake[]>("/api/flakes"), [], refresh);
  const caches = use_resource(() => api<Cache[]>("/api/caches"), [], refresh);
  const latest = use_resource(() => api<Job[]>("/api/jobs?limit=500"), [], refresh);
  const health = use_resource(() => api<Health>("/api/health"), []);
  const [period, set_period] = use_pref<Period>("x-nix.overview.period", "week", one_of("day", "week"));
  const recent = use_resource(() => load_recent_jobs(period), [period], refresh);

  return (
    <div className="page">
      <PageHeading title="Overview" subtitle={health.data && <>X-Nix {health.data.version} on {health.data.server_name}, started <Age epoch={health.data.started_epoch} />.</>} />
      <div className="charts">
        <Loaded resource={rows}>{(found) => <StatusDonut title="Hosts" statuses={found.map(row_status)} message="No hosts read yet." />}</Loaded>
        <Loaded resource={flakes}>{(found) => <StatusDonut title="Flakes" statuses={found.map((flake) => flake.reading?.status ?? null)} message="No flakes yet." />}</Loaded>
        <Loaded resource={caches}>{(found) => <StatusDonut title="Caches" statuses={found.map((cache) => cache.reading?.status ?? null)} message="No caches yet." />}</Loaded>
        <Loaded resource={latest}>{(jobs) => <LatestJobsDonut jobs={jobs} />}</Loaded>
        <Loaded resource={rows}>{(found) => <>
          <SyncDonut rows={found} />
          <RebootDonut rows={found} />
          <AgentsDonut rows={found} />
        </>}</Loaded>
      </div>
      <Section title="Needs attention">
        <Stack>
          <Loaded resource={rows}>
            {(found) => {
              if (found.length === 0) return <Empty title="No hosts yet." hint="Name each NixOS host and its flake under deployments in the config file." />;
              const attention = found.filter((row) => reasons(row).length > 0 || troubled.has(row_status(row) ?? "online"));
              return attention.length === 0 ? <Empty title="Nothing needs attention." /> : <AttentionTable rows={attention} />;
            }}
          </Loaded>
        </Stack>
      </Section>
      <MapSection />
      <Section title={periods[period].label} tools={<Segmented<Period> label="Period" value={period} on_change={set_period}
        choices={(Object.keys(periods) as Period[]).map((value) => ({ value, label: periods[value].label }))} />}>
        <Stack>
          <Loaded resource={recent}>
            {(jobs) => <>
              <div className="charts">
                <OutcomeDonut jobs={jobs} title="Outcomes" />
                <JobsOverTime jobs={jobs} period={period} />
              </div>
              <JobTimeline jobs={jobs} period={period} />
            </>}
          </Loaded>
        </Stack>
      </Section>
      <Section title="Running now">
        <Stack>
          <Loaded resource={latest}>
            {(jobs) => {
              const running = jobs.filter((job) => job.state === "running");
              return running.length === 0 ? <Empty title="Nothing is running." /> : <JobsTable jobs={running} show_deployment />;
            }}
          </Loaded>
        </Stack>
      </Section>
    </div>
  );
}

// The statuses that put a host on the attention list even when no reason below names why; its page says.
const troubled = new Set<Status>(["unavailable", "warning", "failed"]);

// ── Parts ────────────────────────────────────────────────────────────────────

// Hosts, flakes or caches by status, with the share that is fine in the middle.
function StatusDonut({ title, statuses, message }: { title: string; statuses: (Status | null)[]; message: string }) {
  const parts = status_parts.map(([label, color, matches]) => ({ label, color, value: statuses.filter(matches).length }));
  return <Donut title={title} parts={parts} center={`${parts[0].value} of ${statuses.length}`} center_label="OK" message={message} />;
}

const status_parts: [label: string, color: string, matches: (status: Status | null) => boolean][] = [
  ["OK", "var(--status-success)", (status) => status === "online" || status === "info"],
  ["Warning", "var(--status-warning)", (status) => status === "warning"],
  ["Unreachable", "var(--series-2)", (status) => status === "unavailable"],
  ["Failed", "var(--status-danger)", (status) => status === "failed"],
  ["Not read yet", "var(--text-tertiary)", (status) => status === null],
];

// How each deployment, host, cache and flake's latest job went, with the jobs running now in the middle.
function LatestJobsDonut({ jobs }: { jobs: Job[] }) {
  const latest = new Map<string, Job>();
  for (const job of jobs) if (!latest.has(job.deployment_id)) latest.set(job.deployment_id, job);
  const states = [...latest.values()].map((job) => job.state);
  const running = jobs.filter((job) => job.state === "running").length;
  const parts = outcome_parts.map(([state, label, color]) => ({ label, color, value: states.filter((found) => found === state).length }));
  return <Donut title="Latest job of each" parts={parts} center={String(running)} center_label="running" message="No jobs yet." />;
}

// The deployments by whether they run what their flake evaluates to.
function SyncDonut({ rows }: { rows: Row[] }) {
  const tones = deployed(rows).map((deployment) => drift_state(deployment)[1]);
  const parts = ([
    ["In sync", "var(--status-success)", "good"],
    ["Drifting", "var(--status-warning)", "warn"],
    ["Evaluation failed", "var(--status-danger)", "bad"],
    ["Not evaluated yet", "var(--text-tertiary)", "none"],
  ] as const).map(([label, color, tone]) => ({ label, color, value: tones.filter((found) => found === tone).length }));
  return <Donut title="Deployments" parts={parts} center={`${parts[0].value} of ${tones.length}`} center_label="in sync" message="No deployments yet." />;
}

// The deployments by whether they booted the system they run.
function RebootDonut({ rows }: { rows: Row[] }) {
  const needed = deployed(rows).map((deployment) => deployment.reading?.reboot_required ?? null);
  const parts = [
    { label: "Booted", color: "var(--status-success)", value: needed.filter((found) => found === false).length },
    { label: "Reboot needed", color: "var(--status-warning)", value: needed.filter((found) => found === true).length },
    { label: "Not read yet", color: "var(--text-tertiary)", value: needed.filter((found) => found === null).length },
  ];
  return <Donut title="Reboots" parts={parts} center={String(parts[1].value)} center_label="to reboot" message="No deployments yet." />;
}

// The hosts by whether their agent is connected; this server needs none.
function AgentsDonut({ rows }: { rows: Row[] }) {
  const parts = [
    { label: "Connected", color: "var(--status-success)", value: rows.filter(({ host }) => !host.own && host.agent !== null).length },
    { label: "Offline", color: "var(--status-warning)", value: rows.filter(({ host }) => agent_offline(host)).length },
    { label: "This server", color: "var(--series-1)", value: rows.filter(({ host }) => host.own).length },
  ];
  return <Donut title="Agents" parts={parts} center={`${parts[0].value + parts[2].value} of ${rows.length}`} center_label="reachable" message="No hosts yet." />;
}

function deployed(rows: Row[]): NonNullable<Row["deployment"]>[] {
  return rows.flatMap((row) => (row.deployment === null ? [] : [row.deployment]));
}

function AttentionTable({ rows }: { rows: Row[] }) {
  return (
    <DataTable<Row> caption="Needs attention" rows={rows} row_key={({ host }) => host.name} columns={[
      { label: "Host", cell: ({ host }) => <a href={link(["hosts", host.name])}>{host.display_name}</a> },
      { label: "Status", cell: (row) => <StatusBadge status={row_status(row)} /> },
      { label: "Why", cell: (row) => <Chips inline>{reasons(row).map(([text, tone]) => <Badge key={text} tone={tone}>{text}</Badge>)}</Chips> },
    ]} />
  );
}

// What is wrong with a host and its deployment, each in a word or two with a tone.
function reasons({ host, deployment }: Row): [text: string, tone: "warn" | "bad"][] {
  const found: [string, "warn" | "bad"][] = [];
  if (agent_offline(host)) found.push(["Agent offline", "warn"]);
  if (deployment !== null) {
    const [drift, tone] = drift_state(deployment);
    if (tone === "warn" || tone === "bad") found.push([drift, tone]);
    if (deployment.reading?.reboot_required === true) found.push(["Reboot needed", "warn"]);
  }
  // A host whose agent is offline has never had a collection read, which says nothing about its store.
  const store = host.gc === null || agent_offline(host) ? "none" : last_collection_tone(host);
  if (store === "warn" || store === "bad") found.push(["Garbage collection", store]);
  return found;
}

function agent_offline(host: Row["host"]): boolean {
  return !host.own && host.agent === null;
}
