// The Overview: the fleet in counts and by status, the hosts that need attention and why, the jobs running now, and the
// last week of jobs by day and by owner. Each host's own state is on the Hosts page, which every row here links to.

import { Badge, Chips } from "@x-tech-laboratories/x-libs/web/react/badges";
import { Donut } from "@x-tech-laboratories/x-libs/web/react/charts";
import { PageHeading, Section, Stack, Tile, Tiles } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Empty, Loaded, use_resource } from "@x-tech-laboratories/x-libs/web/react/states";
import { DataTable } from "@x-tech-laboratories/x-libs/web/react/table";
import { link } from "@x-tech-laboratories/x-libs/web/router";
import { api, type Health, type Job, type Status } from "../api.ts";
import { Age } from "@x-tech-laboratories/x-libs/web/react/time";
import { StatusBadge } from "../ui.tsx";
import { JobsPerDay, JobTimeline, load_recent_jobs, OutcomeDonut } from "./charts.tsx";
import { host_rows, row_status, type Row } from "./hosts.tsx";
import { drift_state, JobsTable, refresh_interval_in_milliseconds } from "./shared.tsx";
import { last_collection_tone } from "./store.tsx";

// ── View ─────────────────────────────────────────────────────────────────────

export function OverviewView() {
  const refresh = { refresh_in_milliseconds: refresh_interval_in_milliseconds };
  const rows = use_resource(host_rows, [], refresh);
  const running = use_resource(async () => (await api<Job[]>("/api/jobs?limit=100")).filter((job) => job.state === "running"), [], refresh);
  const health = use_resource(() => api<Health>("/api/health"), []);
  const recent = use_resource(() => load_recent_jobs(chart_days), [], refresh);

  return (
    <div className="page">
      <PageHeading title="Overview" subtitle={health.data && <>X-Nix {health.data.version} on {health.data.server_name}, started <Age epoch={health.data.started_epoch} />.</>} />
      <Stack>
        <Loaded resource={rows}>
          {(found) => {
            if (found.length === 0) return <Empty title="No hosts yet." hint="Name each NixOS host and its flake under deployments in the config file." />;
            const attention = found.filter((row) => reasons(row).length > 0 || troubled.has(row_status(row) ?? "online"));
            return <>
              <SummaryTiles rows={found} />
              <div className="charts"><StatusDonut rows={found} /></div>
              <Section title="Needs attention">{attention.length === 0 ? <Empty title="Nothing needs attention." /> : <AttentionTable rows={attention} />}</Section>
            </>;
          }}
        </Loaded>
      </Stack>
      <Section title="Running now">
        <Stack>
          <Loaded resource={running}>
            {(jobs) => (jobs.length === 0 ? <Empty title="Nothing is running." /> : <JobsTable jobs={jobs} show_deployment />)}
          </Loaded>
        </Stack>
      </Section>
      <Section title={`Last ${chart_days} days`}>
        <Stack>
          <Loaded resource={recent}>
            {(jobs) => <>
              <div className="charts">
                <OutcomeDonut jobs={jobs} title="Outcomes" />
                <JobsPerDay jobs={jobs} days={chart_days} />
              </div>
              <JobTimeline jobs={jobs} days={chart_days} />
            </>}
          </Loaded>
        </Stack>
      </Section>
    </div>
  );
}

// How many days the job charts cover.
const chart_days = 7;

// The statuses that put a host on the attention list even when no reason below names why; its page says.
const troubled = new Set<Status>(["unavailable", "warning", "failed"]);

// ── Parts ────────────────────────────────────────────────────────────────────

function SummaryTiles({ rows }: { rows: Row[] }) {
  const deployed = rows.flatMap((row) => (row.deployment === null ? [] : [row.deployment]));
  const counted = (label: string, number: number, tone: "warn" | "bad") => <Tile label={label} value={String(number)} class_name={number > 0 ? `tone-edge-${tone}` : null} />;
  const in_sync = deployed.filter((deployment) => drift_state(deployment)[1] === "good").length;
  return (
    <Tiles>
      <Tile label="Hosts" value={String(rows.length)} />
      <Tile label="In sync" value={`${in_sync} of ${deployed.length}`} class_name={in_sync < deployed.length ? "tone-edge-warn" : null} />
      {counted("Failing", rows.filter((row) => row_status(row) === "failed").length, "bad")}
      {counted("Reboot needed", deployed.filter((deployment) => deployment.reading?.reboot_required === true).length, "warn")}
      {counted("Agents offline", rows.filter(({ host }) => agent_offline(host)).length, "warn")}
    </Tiles>
  );
}

// The hosts by the worse of their own and their deployment's status, with the share that is fine in the middle.
function StatusDonut({ rows }: { rows: Row[] }) {
  const statuses = rows.map(row_status);
  const parts = status_parts.map(([label, color, matches]) => ({ label, color, value: statuses.filter(matches).length }));
  return <Donut title="Hosts by status" parts={parts} center={`${parts[0].value} of ${rows.length}`} center_label="OK" message="No hosts read yet." />;
}

const status_parts: [label: string, color: string, matches: (status: Status | null) => boolean][] = [
  ["OK", "var(--status-success)", (status) => status === "online" || status === "info"],
  ["Warning", "var(--status-warning)", (status) => status === "warning"],
  ["Unreachable", "var(--series-2)", (status) => status === "unavailable"],
  ["Failed", "var(--status-danger)", (status) => status === "failed"],
  ["Not read yet", "var(--text-tertiary)", (status) => status === null],
];

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
