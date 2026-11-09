// The Hosts pages: every machine X-Nix reaches in one table to run actions across, and one host with the System it
// runs, its Store, its Boot entries and the Machine itself as tabs under one header.

import { Chip, Chips } from "@x-tech-laboratories/x-libs/web/react/badges";
import { Meters, Sparkline } from "@x-tech-laboratories/x-libs/web/react/charts";
import { confirm_dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { SearchBox, Switch } from "@x-tech-laboratories/x-libs/web/react/controls";
import { Crumbs, Facts, PageHeading, Section, SelectionBar, Stack, Tabs, Toolbar, type Fact } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Empty, Loaded, use_resource } from "@x-tech-laboratories/x-libs/web/react/states";
import { DataTable } from "@x-tech-laboratories/x-libs/web/react/table";
import { toast } from "@x-tech-laboratories/x-libs/web/react/toasts";
import { bytes, duration } from "@x-tech-laboratories/x-libs/web/format";
import { current_route, link } from "@x-tech-laboratories/x-libs/web/router";
import { toggled, with_range } from "@x-tech-laboratories/x-libs/web/selection";
import { useState } from "react";
import {
  api, type ActionOutcome, type Deployment, type EventRow, type Fleet, type FleetActionId, type FleetOutcome, type Host, type Job, type ProvisionedAgent, type Provisioning,
  type Sample, type Status,
} from "../api.ts";
import { Age } from "@x-tech-laboratories/x-libs/web/react/time";
import { StatusBadge } from "../ui.tsx";
import { BootTab, load_boot } from "./boot.tsx";
import { load_samples, points_of } from "./charts.tsx";
import { action_labels, RunsTable } from "./fleet.tsx";
import {
  ActionButton, error_toast, EventsList, HostActionButton, live, short_revision, TagChips, WaitingOn,
} from "./shared.tsx";
import { last_collection_tone, load_store, store_used_color, StoreTab } from "./store.tsx";
import { GenerationsSection, load_system, SystemTab, type SystemData } from "./system.tsx";

export type HostTab = "system" | "store" | "boot" | "machine";

export const host_tabs: HostTab[] = ["system", "store", "boot", "machine"];

export const tab_labels: Record<HostTab, string> = { system: "System", store: "Store", boot: "Boot", machine: "Machine" };

const status_severity: Record<Status, number> = { online: 0, info: 1, unavailable: 2, warning: 3, failed: 4 };

// A host and the deployment it runs, if any.
export interface Row {
  host: Host;
  deployment: Deployment | null;
}

// The worse of the host's own status and its deployment's.
export function row_status({ host, deployment }: Row): Status | null {
  const statuses = [host.reading?.status, deployment?.reading?.status].filter((status): status is Status => status !== undefined);
  return statuses.length === 0 ? null : statuses.reduce((worst, status) => (status_severity[status] > status_severity[worst] ? status : worst));
}

// Every host with the deployment it runs.
export async function host_rows(): Promise<Row[]> {
  const [hosts, deployments] = await Promise.all([api<Host[]>("/api/hosts"), api<Deployment[]>("/api/deployments")]);
  const by_host = new Map(deployments.flatMap((deployment) => (deployment.host_name === null ? [] : [[deployment.host_name, deployment] as const])));
  return hosts.map((host) => ({ host, deployment: by_host.get(host.name) ?? null }));
}

// ── List ─────────────────────────────────────────────────────────────────────

// Every host in a table, its deployment picked by checkbox, glob or @tag to run one action across them, at once or
// stage by stage, with the fleet runs below.
export function HostsView() {
  const [picked, set_picked] = useState<string[]>([]);
  const [search, set_search] = useState("");
  const [staged, set_staged] = useState(false);
  // The stages start as the fleet's own, read once, so a refresh never wipes what a person is typing.
  const [stages, set_stages] = useState<string | null>(null);
  const [parallel, set_parallel] = useState("");
  const loaded = use_resource(async () => {
    const [rows, fleet, samples] = await Promise.all([host_rows(), api<Fleet>("/api/fleet"), load_samples(["store_used_percent"], 1).catch((): Sample[] => [])]);
    return { rows, fleet, samples };
  }, [], live);

  const rows = loaded.data?.rows ?? [];
  const samples = loaded.data?.samples ?? [];
  const fleet = loaded.data?.fleet ?? null;
  const stages_text = stages ?? fleet?.stages.join("\n") ?? "";
  const deployments = rows.flatMap((row) => (row.deployment === null ? [] : [row.deployment]));
  const pick = (ids: string[]) => set_picked(ids);

  const find = async (selector: string) => {
    try {
      pick(await api<string[]>(`/api/fleet/select?selector=${encodeURIComponent(selector)}`));
    } catch (error) {
      error_toast(error);
    }
  };

  const run = async (action: FleetActionId) => {
    try {
      const outcome = await api<FleetOutcome>("/api/fleet/runs", "POST", {
        action, ids: picked, staged,
        stages: staged ? stages_text.split("\n").map((line) => line.trim()).filter(Boolean) : undefined,
        parallel: parallel === "" ? undefined : Number(parallel),
      });
      toast(outcome.message, { tone: "good", link: outcome.run === null ? null : { href: link(["fleet", String(outcome.run.id)]), text: "Follow it" } });
    } catch (error) {
      error_toast(error);
    }
    await loaded.reload(true);
  };

  const ask = (action: FleetActionId) => {
    if (action === "build") return void run(action);
    const names = deployments.filter((deployment) => picked.includes(deployment.id)).map((deployment) => deployment.name).join(", ");
    const how = staged ? "stage by stage, stopping at the first failure" : "up to the parallel limit at once";
    confirm_dialog({ title: `${action_labels[action]} ${picked.length} hosts`, message: `${action_labels[action]} ${names}, ${how}?`, confirm_label: action_labels[action], danger: true, run: () => run(action) });
  };

  return (
    <div className="page">
      <PageHeading title="Hosts" subtitle="Each machine X-Nix reaches, and the NixOS system it runs against what its flake evaluates to. Search by a name glob or @tag, or tick hosts, to run one action across them." />
      <Stack tight>
        <Toolbar>
          <SearchBox label="Search by glob or @tag" value={search} on_input={set_search} on_submit={(selector) => void find(selector)} submit_label="Pick" />
        </Toolbar>
        {fleet && fleet.tags.length > 0 && (
          <Chips>
            {fleet.tags.map((tag) => <Chip key={tag} on_click={() => {
              set_search(`@${tag}`);
              void find(`@${tag}`);
            }}>@{tag}</Chip>)}
          </Chips>
        )}
        <Stack>
          {loaded.data && (rows.length === 0
            ? <Empty title="No hosts yet." hint="Name each machine under hosts in the config file, or name it as a deployment's host." />
            : <HostsTable rows={rows} samples={samples} picked={picked} on_change={set_picked} />)}
        </Stack>
      </Stack>
      {/* The rollout settings and the actions show only while something is picked. */}
      {picked.length > 0 && (
        <Section title="Rollout">
          <Toolbar>
            <label className="check"><Switch label="Staged rollout" checked={staged} on_change={set_staged} />Staged rollout</label>
            <label className="field">
              <span className="field-label">Stages</span>
              <textarea className="stage-list" placeholder="One stage per line, such as @canary" aria-label="Stages" value={stages_text} onChange={(event) => set_stages(event.currentTarget.value)} />
            </label>
            <label className="field">
              <span className="field-label">At once</span>
              <input type="number" min={1} step={1} aria-label="At once" placeholder={fleet ? String(fleet.parallel) : undefined} value={parallel} onChange={(event) => set_parallel(event.currentTarget.value)} />
            </label>
          </Toolbar>
        </Section>
      )}
      {picked.length > 0 && (
        <SelectionBar count={picked.length} total={deployments.length} on_clear={() => pick([])} on_select_all={() => pick(deployments.map((deployment) => deployment.id))}>
          {(Object.keys(action_labels) as FleetActionId[]).map((action) => (
            <button key={action} className={action === "reboot" ? "danger" : action === "switch" ? "accent solid" : undefined} onClick={() => ask(action)}>{action_labels[action]}</button>
          ))}
        </SelectionBar>
      )}
      <Section title="Fleet runs">
        <Stack>
          <Loaded resource={loaded}>
            {({ fleet: found }) => (found.runs.length === 0 ? <Empty title="No fleet runs yet." /> : <RunsTable runs={found.runs} />)}
          </Loaded>
        </Stack>
      </Section>
    </div>
  );
}

// Every host with its deployment's state, and a checkbox for each host that runs a deployment; Shift picks every host between.
function HostsTable({ rows, samples, picked, on_change }: { rows: Row[]; samples: Sample[]; picked: string[]; on_change: (picked: string[]) => void }) {
  const [anchor_id, set_anchor_id] = useState<string | null>(null);
  const order = rows.flatMap(({ deployment }) => (deployment === null ? [] : [deployment.id]));
  const click = (id: string, shift: boolean) => {
    on_change(shift ? with_range(order, picked, anchor_id, id) : toggled(picked, id));
    set_anchor_id(id);
  };
  const none = <span className="muted">—</span>;
  return (
    <DataTable<Row> caption="Hosts" rows={rows} row_key={({ host }) => host.name} row_selected={({ deployment }) => deployment !== null && picked.includes(deployment.id)} columns={[
      { label: "Pick", cell: ({ host, deployment }) => deployment && (
        <input type="checkbox" checked={picked.includes(deployment.id)} aria-label={`Select ${host.display_name}`} onChange={() => {}} onClick={(event) => click(deployment.id, event.shiftKey)} />
      ) },
      { label: "Host", cell: ({ host }) => <span><a href={link(["hosts", host.name])}>{host.display_name}</a>{host.own && <span className="muted small"> this server</span>}</span> },
      { label: "Status", cell: (row) => <StatusBadge status={row_status(row)} /> },
      { label: "Tags", cell: ({ deployment }) => (deployment === null ? "" : <TagChips tags={deployment.tags} />) },
      { label: "NixOS", cell: ({ deployment }) => deployment?.reading?.version ?? "—" },
      { label: "Updated", cell: ({ deployment }) => (deployment?.reading?.switched_epoch ? <Age epoch={deployment.reading.switched_epoch} /> : "—") },
      { label: "Pin", cell: ({ deployment }) => (deployment === null ? none : deployment.pin === null ? <span className="muted">head</span> : <code>{short_revision(deployment.pin)}</code>) },
      { label: "Store used", cell: ({ host }) => <StoreUsed host={host} samples={samples} /> },
      { label: "Waiting on", cell: ({ deployment }) => (deployment === null ? <span className="muted">Not deployed</span> : <WaitingOn deployment={deployment} />) },
      { label: "Running", cell: ({ host, deployment }) => {
        const job = deployment?.running_job ?? host.running_job;
        return job === null ? "" : <a href={link(["jobs", String(job.id)])}>{job.kind}</a>;
      } },
    ]} />
  );
}

// How full the store is against where it warns and collects, with the last day of readings beside it.
function StoreUsed({ host, samples }: { host: Host; samples: Sample[] }) {
  const store = host.reading?.store ?? null;
  const used = store?.used_percent ?? null;
  if (store === null || used === null || host.gc === null) return <>—</>;
  const tone = last_collection_tone(host);
  const color = store_used_color(host, used);
  const points = points_of(samples, "store_used_percent", `host:${host.name}`);
  const marks = [host.gc.warning, host.gc.threshold].filter((mark): mark is number => mark !== null);
  return (
    <div className="store-used">
      <Meters message="" rows={[{
        label: store.used_bytes === null || store.size_bytes === null ? "Store" : `${bytes(store.used_bytes)} of ${bytes(store.size_bytes)}`, href: null, value_text: `${used.toFixed(1)}%`, percent: used, color, marks,
        title: tone === "none" ? null : "The last collection failed or is overdue",
      }]} />
      {points.length > 1 && <Sparkline label={`Store used over the last day, now ${used.toFixed(1)}%`} points={points} top={100} color={color} />}
    </div>
  );
}

// ── One host ─────────────────────────────────────────────────────────────────

interface MachineData {
  events: EventRow[];
  provisioning: Provisioning;
}

// What the shown tab reads besides the host and its deployment.
type Contents =
  | { tab: "system"; system: SystemData | null }
  | { tab: "store"; jobs: Job[] | null }
  | { tab: "boot"; jobs: Job[] | null }
  | { tab: "machine"; machine: MachineData };

async function load_contents(tab: HostTab, host: Host, deployment: Deployment | null): Promise<Contents> {
  if (tab === "system") return { tab, system: deployment === null ? null : await load_system(deployment) };
  if (tab === "store") return { tab, jobs: await load_store(host) };
  if (tab === "boot") return { tab, jobs: await load_boot(host) };
  const [events, provisioning] = await Promise.all([
    api<EventRow[]>(`/api/hosts/${encodeURIComponent(host.name)}/events`),
    api<Provisioning>("/api/provisioning"),
  ]);
  return { tab, machine: { events, provisioning } };
}

// One host's page, on the tab asked for or the first it has: the System when it runs a deployment.
export function HostView({ name, asked }: { name: string; asked: HostTab | null }) {
  const path = `/api/hosts/${encodeURIComponent(name)}`;
  const page = use_resource(async () => {
    const host = await api<Host>(path);
    const deployed = host.deployments[0];
    const deployment = deployed === undefined ? null : await api<Deployment>(`/api/deployments/${encodeURIComponent(deployed.id)}`);
    const has: Record<HostTab, boolean> = { system: deployment !== null, store: host.gc !== null, boot: host.boot, machine: true };
    const tab = asked ?? host_tabs.find((choice) => has[choice])!;
    return { host, deployment, has, tab, contents: await load_contents(tab, host, deployment) };
  }, [name, asked], live);
  const refresh = () => page.reload(true);
  const shown = page.data;
  const deployment = shown?.deployment ?? null;

  const run_refresh = async () => {
    toast(deployment === null ? "Reading the host…" : "Reading the host and evaluating the flake…");
    await Promise.all([
      api(`${path}/refresh`, "POST"),
      deployment === null ? null : api(`/api/deployments/${encodeURIComponent(deployment.id)}/refresh`, "POST"),
    ]).catch((error) => toast(String(error.message), { tone: "bad" }));
    refresh();
  };

  return (
    <div className="page">
      <Crumbs items={[["Hosts", link(["hosts"])], [name, null]]} />
      <PageHeading
        title={<>{shown?.host.display_name ?? name} {shown && <StatusBadge status={row_status({ host: shown.host, deployment })} />}</>}
        actions={shown && <>
          <button onClick={() => void run_refresh()}>Check now</button>
          {/* A deployment's Reboot reboots its host, so only the host's shows. */}
          {deployment?.actions.filter((action) => action.id !== "reboot").map((action) => <ActionButton key={action.id} deployment={deployment} action={action} done={refresh} />)}
          {shown.host.actions.map((action) => <HostActionButton key={action.id} host={shown.host} action={action} done={refresh} />)}
        </>}
      />
      {shown
        ? <Tabs label="Host" active={shown.tab} items={host_tabs.filter((choice) => shown.has[choice] || choice === shown.tab).map((choice) => ({ id: choice, label: tab_labels[choice], href: link(["hosts", name, choice]) }))} />
        : <nav className="tabs" aria-label="Host" />}
      <Stack>
        <Loaded resource={page}>
          {({ host, contents }) => {
            if (contents.tab === "system") return contents.system === null || deployment === null
              ? <Empty title="Nothing is deployed to this host." hint="Name it as a deployment's host in the config file." />
              : <SystemTab deployment={deployment} data={contents.system} refresh={refresh} />;
            if (contents.tab === "store") return <StoreTab host={host} jobs={contents.jobs} />;
            if (contents.tab === "boot") return <BootTab host={host} jobs={contents.jobs} refresh={refresh} />;
            return <MachineTab host={host} data={contents.machine} refresh={refresh} />;
          }}
        </Loaded>
      </Stack>
      {shown?.tab === "system" && deployment !== null && <GenerationsSection deployment={deployment} refresh={refresh} />}
    </div>
  );
}

// An old address of a deployment's page, which now lives on its host's page.
export function DeploymentRedirect({ id, page }: { id: string; page: string | undefined }) {
  const moved = use_resource(async () => {
    const deployment = await api<Deployment>(`/api/deployments/${encodeURIComponent(id)}`);
    if (deployment.host_name === null) throw new Error(`The deployment ${id} names no host`);
    const query = page === "closure" ? Object.fromEntries(current_route().query) : {};
    location.replace(link(["hosts", deployment.host_name, page === "closure" ? "closure" : "system"], query));
    return true;
  }, [id, page]);
  return <div className="page"><Loaded resource={moved}>{() => null}</Loaded></div>;
}

// ── Machine ──────────────────────────────────────────────────────────────────

// The machine itself: its agent and the key it logs in with, how it is woken and read, and its events. It holds no
// tiles, as its one changing state, the agent's connection, shows in the page's status.
function MachineTab({ host, data, refresh }: { host: Host; data: MachineData; refresh: () => void }) {
  const made = data.provisioning.provisioned_agents.find((agent) => agent.host === host.name) ?? null;
  return <>
    <Section title="Details" tools={made && <button className="danger" onClick={() => forget_key(made, refresh)}>Forget the key</button>}>
      <Details host={host} made={made} />
    </Section>
    <Section title="Events">{data.events.length === 0 ? <Empty title="No events yet." /> : <EventsList events={data.events} />}</Section>
  </>;
}

function Details({ host, made }: { host: Host; made: ProvisionedAgent | null }) {
  const rows: Fact[] = [
    ["Agent", host.own ? "the server itself" : host.agent === null ? "not connected" : <span>version {host.agent.agent_version}, connected <Age epoch={host.agent.connected_epoch} /></span>],
  ];
  if (!host.own) rows.push(["Agent key", <KeyText host={host} made={made} />]);
  rows.push(
    ["Woken by", host.wake === null ? "never woken" : <span>wake-on-LAN to <code>{host.wake.mac}</code>{` via ${host.wake.via ?? "the server"} on ${host.wake.broadcast}, waiting up to ${duration(host.wake.timeout)}`}</span>],
    ["Kept awake", host.keep_awake ? "through every job and switch" : "no"],
    ["Read every", duration(host.interval)],
  );
  return <Facts rows={rows} layout="rows" />;
}

// Where the agent's key comes from: the config, or an install that made it.
function KeyText({ host, made }: { host: Host; made: ProvisionedAgent | null }) {
  if (made === null) return <>{host.agent_key ? "declared in the config" : "none declared"}</>;
  return (
    <span>
      {made.overridden ? "declared in the config, used instead of the one made by " : "made by "}
      <a href={link(["jobs", String(made.job_id)])}>install #{made.job_id}</a>{" "}
      <Age epoch={made.added_epoch} />, <code className="small" title={made.public_line}>{made.fingerprint}</code>
    </span>
  );
}

export function forget_key(agent: ProvisionedAgent, done: () => void): void {
  confirm_dialog({
    title: `Forget ${agent.host}'s key`,
    message: `Stop accepting the agent key X-Nix made for ${agent.host}? Its agent is hung up on and cannot log in again unless the config declares its key.`,
    confirm_label: "Forget",
    danger: true,
    run: async () => {
      try {
        toast((await api<ActionOutcome>(`/api/provisioning/agents/${encodeURIComponent(agent.host)}/forget`, "POST")).message, { tone: "good" });
      } catch (error) {
        error_toast(error);
      }
      done();
    },
  });
}

