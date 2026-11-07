// The Hosts pages: every machine X-Nix reaches in one table to run actions across, and one host with the System it
// runs, its Store, its Boot entries and the Machine itself as tabs under one header.

import { Chip, Chips } from "@x-tech-laboratories/x-libs/web/preact/badges";
import { confirm_dialog } from "@x-tech-laboratories/x-libs/web/preact/dialog";
import { Crumbs, Facts, Section, Stack, Tabs, Toolbar, type Fact } from "@x-tech-laboratories/x-libs/web/preact/layout";
import { Empty, Loaded, use_resource } from "@x-tech-laboratories/x-libs/web/preact/states";
import { DataTable } from "@x-tech-laboratories/x-libs/web/preact/table";
import { toast } from "@x-tech-laboratories/x-libs/web/preact/toasts";
import { current_route, link } from "@x-tech-laboratories/x-libs/web/router";
import { useState } from "preact/hooks";
import {
  api, type ActionOutcome, type Deployment, type EventRow, type Fleet, type FleetActionId, type FleetOutcome, type Host, type Job, type ProvisionedAgent, type Provisioning,
  type Status,
} from "../api.ts";
import { Age } from "@x-tech-laboratories/x-libs/web/preact/time";
import { StatusBadge } from "../ui.tsx";
import { BootTab, load_boot } from "./boot.tsx";
import { action_labels, RunsTable } from "./fleet.tsx";
import {
  ActionButton, duration, error_toast, EventsList, HostActionButton, refresh_interval_in_milliseconds, short_revision, TagChips, WaitingOn,
} from "./shared.tsx";
import { last_collection_tone, load_store, StoreTab } from "./store.tsx";
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
  const [selected, set_selected] = useState<Set<string>>(new Set());
  const [search, set_search] = useState("");
  const [staged, set_staged] = useState(false);
  // The stages start as the fleet's own, read once, so a refresh never wipes what a person is typing.
  const [stages, set_stages] = useState<string | null>(null);
  const [parallel, set_parallel] = useState("");
  const loaded = use_resource(async () => {
    const [rows, fleet] = await Promise.all([host_rows(), api<Fleet>("/api/fleet")]);
    return { rows, fleet };
  }, [], { refresh_in_milliseconds: refresh_interval_in_milliseconds });

  const rows = loaded.data?.rows ?? [];
  const fleet = loaded.data?.fleet ?? null;
  const stages_text = stages ?? fleet?.stages.join("\n") ?? "";
  const deployments = rows.flatMap((row) => (row.deployment === null ? [] : [row.deployment]));
  const pick = (ids: string[]) => set_selected(new Set(ids));

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
        action, ids: [...selected], staged,
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
    const names = deployments.filter((deployment) => selected.has(deployment.id)).map((deployment) => deployment.name).join(", ");
    const how = staged ? "stage by stage, stopping at the first failure" : "up to the parallel limit at once";
    confirm_dialog({ title: `${action_labels[action]} ${selected.size} hosts`, message: `${action_labels[action]} ${names}, ${how}?`, confirm_label: action_labels[action], danger: true, run: () => run(action) });
  };

  return (
    <div class="page">
      <h1>Hosts</h1>
      <p class="muted">Each machine X-Nix reaches, and the NixOS system it runs against what its flake evaluates to. Search by a name glob or @tag, or tick hosts, to run one action across them.</p>
      <Stack tight>
        <form class="toolbar" onSubmit={(event) => {
          event.preventDefault();
          void find(search);
        }}>
          <label class="field">
            <span class="field-label">Search</span>
            <input type="search" class="filter" placeholder="web-* @canary" aria-label="Search" value={search} onInput={(event) => set_search(event.currentTarget.value)} />
          </label>
          <button type="submit">Pick</button>
          <button type="button" onClick={() => pick(deployments.map((deployment) => deployment.id))}>All</button>
          <button type="button" onClick={() => pick([])}>None</button>
          <span class="muted">{loaded.data && `${selected.size} of ${deployments.length} picked`}</span>
        </form>
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
            : <HostsTable rows={rows} selected={selected} on_change={set_selected} />)}
        </Stack>
      </Stack>
      {/* The run controls show only while something is picked. */}
      {selected.size > 0 && (
        <Section title="Run on the picked">
          <Stack>
            <Toolbar>
              <label class="check"><input type="checkbox" checked={staged} onChange={(event) => set_staged(event.currentTarget.checked)} />Staged rollout</label>
              <label class="field">
                <span class="field-label">Stages</span>
                <textarea class="stage-list" placeholder="One stage per line, such as @canary" aria-label="Stages" value={stages_text} onInput={(event) => set_stages(event.currentTarget.value)} />
              </label>
              <label class="field">
                <span class="field-label">At once</span>
                <input type="number" min={1} step={1} aria-label="At once" placeholder={fleet ? String(fleet.parallel) : undefined} value={parallel} onInput={(event) => set_parallel(event.currentTarget.value)} />
              </label>
            </Toolbar>
            <div class="head-actions">
              {(Object.keys(action_labels) as FleetActionId[]).map((action) => (
                <button key={action} class={action === "reboot" ? "danger" : action === "switch" ? "accent solid" : undefined} onClick={() => ask(action)}>{action_labels[action]}</button>
              ))}
            </div>
          </Stack>
        </Section>
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

// Every host with its deployment's state, and a checkbox for each host that runs a deployment.
function HostsTable({ rows, selected, on_change }: { rows: Row[]; selected: Set<string>; on_change: (selected: Set<string>) => void }) {
  const toggle = (id: string, on: boolean) => {
    const changed = new Set(selected);
    if (on) changed.add(id);
    else changed.delete(id);
    on_change(changed);
  };
  const none = <span class="muted">—</span>;
  return (
    <DataTable<Row> caption="Hosts" rows={rows} row_key={({ host }) => host.name} columns={[
      { label: "Pick", cell: ({ host, deployment }) => deployment && (
        <input type="checkbox" checked={selected.has(deployment.id)} aria-label={`Select ${host.display_name}`} onChange={(event) => toggle(deployment.id, event.currentTarget.checked)} />
      ) },
      { label: "Host", cell: ({ host }) => <span><a href={link(["hosts", host.name])}>{host.display_name}</a>{host.own && <span class="muted small"> this server</span>}</span> },
      { label: "Status", cell: (row) => <StatusBadge status={row_status(row)} /> },
      { label: "Tags", cell: ({ deployment }) => (deployment === null ? "" : <TagChips tags={deployment.tags} />) },
      { label: "NixOS", cell: ({ deployment }) => deployment?.reading?.version ?? "—" },
      { label: "Updated", cell: ({ deployment }) => (deployment?.reading?.switched_epoch ? <Age epoch={deployment.reading.switched_epoch} /> : "—") },
      { label: "Pin", cell: ({ deployment }) => (deployment === null ? none : deployment.pin === null ? <span class="muted">head</span> : <code>{short_revision(deployment.pin)}</code>) },
      { label: "Store used", cell: ({ host }) => <StoreUsed host={host} /> },
      { label: "Waiting on", cell: ({ deployment }) => (deployment === null ? <span class="muted">Not deployed</span> : <WaitingOn deployment={deployment} />) },
      { label: "Running", cell: ({ host, deployment }) => {
        const job = deployment?.running_job ?? host.running_job;
        return job === null ? "" : <a href={link(["jobs", String(job.id)])}>{job.kind}</a>;
      } },
    ]} />
  );
}

function StoreUsed({ host }: { host: Host }) {
  const used = host.reading?.store?.used_percent ?? null;
  if (used === null) return <>—</>;
  const tone = host.gc === null ? "none" : last_collection_tone(host);
  return <span class={tone === "none" ? undefined : `tone-${tone}`}>{used.toFixed(1)}%</span>;
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
  }, [name, asked], { refresh_in_milliseconds: refresh_interval_in_milliseconds });
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
    <div class="page">
      <Crumbs items={[["Hosts", link(["hosts"])], [name, null]]} />
      <header class="page-head">
        <div class="card-head">
          <h1>{shown?.host.display_name ?? name}</h1>
          {shown && <span><StatusBadge status={row_status({ host: shown.host, deployment })} /></span>}
        </div>
        <div class="head-actions">
          {shown && <>
            <button onClick={() => void run_refresh()}>Check now</button>
            {/* A deployment's Reboot reboots its host, so only the host's shows. */}
            {deployment?.actions.filter((action) => action.id !== "reboot").map((action) => <ActionButton key={action.id} deployment={deployment} action={action} done={refresh} />)}
            {shown.host.actions.map((action) => <HostActionButton key={action.id} host={shown.host} action={action} done={refresh} />)}
          </>}
        </div>
      </header>
      {shown
        ? <Tabs label="Host" active={shown.tab} items={host_tabs.filter((choice) => shown.has[choice] || choice === shown.tab).map((choice) => ({ id: choice, label: tab_labels[choice], href: link(["hosts", name, choice]) }))} />
        : <nav class="tabs" aria-label="Host" />}
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
  return <div class="page"><Loaded resource={moved}>{() => null}</Loaded></div>;
}

// ── Machine ──────────────────────────────────────────────────────────────────

// The machine itself: its agent and the key it logs in with, how it is woken and read, and its events. It holds no
// tiles, as its one changing state, the agent's connection, shows in the page's status.
function MachineTab({ host, data, refresh }: { host: Host; data: MachineData; refresh: () => void }) {
  const made = data.provisioning.provisioned_agents.find((agent) => agent.host === host.name) ?? null;
  return <>
    <Section title="Details" tools={made && <button class="danger" onClick={() => forget_key(made, refresh)}>Forget the key</button>}>
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
      <Age epoch={made.added_epoch} />, <code class="small" title={made.public_line}>{made.fingerprint}</code>
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

