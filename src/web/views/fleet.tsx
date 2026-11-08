// The fleet runs: the table of them on the Hosts page, and one fleet run followed host by host.

import { Crumbs, Facts, PageHeading, Section, Stack } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Loaded, use_resource } from "@x-tech-laboratories/x-libs/web/react/states";
import { DataTable, type TableColumn } from "@x-tech-laboratories/x-libs/web/react/table";
import { toast } from "@x-tech-laboratories/x-libs/web/react/toasts";
import { link } from "@x-tech-laboratories/x-libs/web/router";
import { api, type FleetActionId, type FleetOutcome, type FleetRun } from "../api.ts";
import { Age } from "@x-tech-laboratories/x-libs/web/react/time";
import { FleetHostBadge, FleetRunBadge } from "../ui.tsx";
import { error_toast, refresh_interval_in_milliseconds } from "./shared.tsx";

export const action_labels: Record<FleetActionId, string> = { build: "Build", switch: "Rebuild and switch", reboot: "Reboot" };

type FleetHost = FleetRun["hosts"][number];

// ── Fleet runs ───────────────────────────────────────────────────────────────

function summary(run: FleetRun): string {
  const counts = new Map<string, number>();
  for (const host of run.hosts) counts.set(host.state, (counts.get(host.state) ?? 0) + 1);
  return [...counts].map(([state, number]) => `${number} ${state}`).join(", ");
}

export function RunsTable({ runs }: { runs: FleetRun[] }) {
  return (
    <DataTable<FleetRun> caption="Fleet runs" rows={runs} row_key={(run) => run.id} columns={[
      { label: "Run", cell: (run) => <a href={link(["fleet", String(run.id)])}>{run.action} #{run.id}</a> },
      { label: "State", cell: (run) => <FleetRunBadge state={run.state} /> },
      { label: "Hosts", cell: summary },
      { label: "Staged", cell: (run) => (run.staged ? `stage ${run.current_stage + 1} of ${run.stages.length}` : "no") },
      { label: "Started", cell: (run) => <Age epoch={run.started_epoch} /> },
    ]} />
  );
}

// ── One fleet run ────────────────────────────────────────────────────────────

export function FleetRunView({ id }: { id: number }) {
  const run = use_resource(() => api<FleetRun>(`/api/fleet/runs/${id}`), [id], { refresh_in_milliseconds: refresh_interval_in_milliseconds });

  const stop = async () => {
    try {
      toast((await api<FleetOutcome>(`/api/fleet/runs/${id}/stop`, "POST")).message);
    } catch (error) {
      error_toast(error);
    }
    await run.reload(true);
  };

  const shown = run.data;
  return (
    <div className="page">
      <Crumbs items={[["Hosts", link(["hosts"])], [`Run ${id}`, null]]} />
      <PageHeading title={`Fleet run ${id}`} actions={shown && shown.state === "running" && !shown.stop_requested && <button className="danger" onClick={() => void stop()}>Stop</button>} />
      <Stack>
        <Loaded resource={run}>
          {(found) => <>
            <Facts rows={[
              ["Action", found.action === "update" ? "Update flake" : action_labels[found.action]],
              ["State", <FleetRunBadge state={found.state} />],
              ["Picked", found.selector],
              ["At once", found.parallel],
              ["Started", <Age epoch={found.started_epoch} />],
              ["Finished", <Age epoch={found.finished_epoch} />],
              ["Outcome", found.message ?? summary(found)],
            ]} />
            <Section title="Hosts"><HostsTable run={found} /></Section>
          </>}
        </Loaded>
      </Stack>
    </div>
  );
}

function HostsTable({ run }: { run: FleetRun }) {
  const columns: TableColumn<FleetHost>[] = [
    { label: "Deployment", cell: (host) => <a href={link(["deployments", host.deployment_id])}>{host.name}</a> },
    ...(run.staged ? [{ label: "Stage", cell: (host: FleetHost) => `${host.stage + 1}: ${run.stages[host.stage] ?? ""}` }] : []),
    { label: "State", cell: (host) => <FleetHostBadge state={host.state} /> },
    { label: "Job", cell: (host) => (host.job_id === null ? "" : <a href={link(["jobs", String(host.job_id)])}>#{host.job_id}</a>) },
    { label: "Last word", cell: (host) => <span className="muted small">{host.message ?? ""}</span> },
  ];
  return <DataTable<FleetHost> caption="Hosts" rows={run.hosts} row_key={(host) => host.deployment_id} columns={columns} />;
}
