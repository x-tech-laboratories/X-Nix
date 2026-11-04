// The Hosts pages: every machine X-Nix reaches in one table to run actions across, and one host with the System it
// runs, its Store, its Boot entries and the Machine itself as tabs under one header.

import {
  api, type ActionOutcome, type Deployment, type EventRow, type Fleet, type FleetActionId, type FleetOutcome, type Host, type ProvisionedAgent, type Provisioning,
  type Status,
} from "../api.ts";
import { age, h, nodes, stamp, type Child } from "../dom.ts";
import { current_route, link } from "../router.ts";
import { confirm_dialog, crumbs, data_table, empty, facts, load, section, status_badge, toast } from "../ui.ts";
import { boot_tab } from "./boot.ts";
import { action_labels, runs_table } from "./fleet.ts";
import {
  action_button, duration, events_list, host_action_button, refresh_interval_in_milliseconds, short_revision, tag_chips, waiting_on, type View,
} from "./shared.ts";
import { last_collection_tone, store_tab } from "./store.ts";
import { generations_section, system_tab } from "./system.ts";

export type HostTab = "system" | "store" | "boot" | "machine";

export const host_tabs: HostTab[] = ["system", "store", "boot", "machine"];

const tab_labels: Record<HostTab, string> = { system: "System", store: "Store", boot: "Boot", machine: "Machine" };

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
export function hosts_view(): View {
  const selected = new Set<string>();
  let rows: Row[] = [];
  const table = h("div", { class: "stack" });
  const runs = h("div", { class: "stack" });
  const tags = h("div", { class: "chips" });
  const count = h("span", { class: "muted" });
  const search = h("input", { type: "search", class: "filter", placeholder: "web-* @canary", "aria-label": "Search" });
  const staged = h("input", { type: "checkbox" });
  const stages = h("textarea", { class: "stage-list", placeholder: "One stage per line, such as @canary", "aria-label": "Stages" });
  const parallel = h("input", { type: "number", min: 1, step: 1, "aria-label": "At once" });
  const buttons = h("div", { class: "head-actions" });
  const run_section = section("Run on the picked", h("div", { class: "stack" },
    h("div", { class: "toolbar" },
      h("label", { class: "check" }, staged, "Staged rollout"),
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Stages"), stages),
      h("label", { class: "field" }, h("span", { class: "field-label" }, "At once"), parallel)),
    buttons));
  run_section.hidden = true;

  const deployments = () => rows.flatMap((row) => (row.deployment === null ? [] : [row.deployment]));
  const draw_table = () => {
    table.replaceChildren(rows.length === 0
      ? empty("No hosts yet.", "Name each machine under hosts in the config file, or name it as a deployment's host.")
      : hosts_table(rows, selected, show_count));
    show_count();
  };
  // The run controls show only while something is picked.
  const show_count = () => {
    count.textContent = `${selected.size} of ${deployments().length} picked`;
    run_section.hidden = selected.size === 0;
  };
  const pick = (ids: string[]) => {
    selected.clear();
    for (const id of ids) selected.add(id);
    draw_table();
  };

  const find = async () => {
    try {
      pick(await api<string[]>(`/api/fleet/select?selector=${encodeURIComponent(search.value)}`));
    } catch (error) {
      toast((error as Error).message, "bad");
    }
  };

  const run = async (action: FleetActionId) => {
    try {
      const outcome = await api<FleetOutcome>("/api/fleet/runs", "POST", {
        action, ids: [...selected], staged: staged.checked,
        stages: staged.checked ? stages.value.split("\n").map((line) => line.trim()).filter(Boolean) : undefined,
        parallel: parallel.value === "" ? undefined : Number(parallel.value),
      });
      toast(outcome.message, "good", outcome.run === null ? null : { href: link(["fleet", String(outcome.run.id)]), text: "Follow it" });
    } catch (error) {
      toast((error as Error).message, "bad");
    }
    await refresh(true);
  };

  buttons.append(...(Object.keys(action_labels) as FleetActionId[]).map((action) => h("button", {
    class: action === "reboot" ? "danger" : action === "switch" ? "accent solid" : null,
    onclick: () => {
      if (action === "build") return void run(action);
      const names = deployments().filter((deployment) => selected.has(deployment.id)).map((deployment) => deployment.name).join(", ");
      const how = staged.checked ? "stage by stage, stopping at the first failure" : "up to the parallel limit at once";
      confirm_dialog(`${action_labels[action]} ${selected.size} hosts`, `${action_labels[action]} ${names}, ${how}?`, action_labels[action], () => run(action));
    },
  }, action_labels[action])));

  let first = true;
  const refresh = (quiet: boolean) => load(runs, async () => {
    const [found, fleet] = await Promise.all([host_rows(), api<Fleet>("/api/fleet")]);
    rows = found;
    draw_table();
    if (first) {
      first = false;
      stages.value = fleet.stages.join("\n");
      parallel.placeholder = String(fleet.parallel);
    }
    tags.hidden = fleet.tags.length === 0;
    tags.replaceChildren(...fleet.tags.map((tag) => h("button", { type: "button", class: "chip", onclick: () => {
      search.value = `@${tag}`;
      void find();
    } }, `@${tag}`)));
    return fleet.runs.length === 0 ? empty("No fleet runs yet.") : runs_table(fleet.runs);
  }, { quiet });
  void refresh(false);
  const timer = setInterval(() => void refresh(true), refresh_interval_in_milliseconds);

  return {
    title: "Hosts",
    root: h("div", { class: "page" },
      h("h1", {}, "Hosts"),
      h("p", { class: "muted" }, "Each machine X-Nix reaches, and the NixOS system it runs against what its flake evaluates to. Search by a name glob or @tag, or tick hosts, to run one action across them."),
      h("div", { class: "stack tight" },
        h("form", { class: "toolbar", onsubmit: (event: Event) => {
          event.preventDefault();
          void find();
        } },
          h("label", { class: "field" }, h("span", { class: "field-label" }, "Search"), search),
          h("button", { type: "submit" }, "Pick"),
          h("button", { type: "button", onclick: () => pick(deployments().map((deployment) => deployment.id)) }, "All"),
          h("button", { type: "button", onclick: () => pick([]) }, "None"),
          count),
        tags,
        table),
      run_section,
      section("Fleet runs", runs),
    ),
    dispose: () => clearInterval(timer),
  };
}

// Every host with its deployment's state, and a checkbox for each host that runs a deployment.
function hosts_table(rows: Row[], selected: Set<string>, changed: () => void): HTMLElement {
  const pick = ({ host, deployment }: Row) => deployment && h("input", {
    type: "checkbox", checked: selected.has(deployment.id), "aria-label": `Select ${host.display_name}`,
    onchange: (event: Event) => {
      if ((event.target as HTMLInputElement).checked) selected.add(deployment.id);
      else selected.delete(deployment.id);
      changed();
    },
  });
  const none = () => h("span", { class: "muted" }, "—");
  return data_table<Row>([
    { label: "Pick", cell: pick },
    { label: "Host", cell: ({ host }) => h("span", {}, h("a", { href: link(["hosts", host.name]) }, host.display_name), host.own ? h("span", { class: "muted small" }, " this server") : null) },
    { label: "Status", cell: (row) => status_badge(row_status(row)) },
    { label: "Tags", cell: ({ deployment }) => (deployment === null ? "" : tag_chips(deployment.tags)) },
    { label: "NixOS", cell: ({ deployment }) => deployment?.reading?.version ?? "—" },
    { label: "Updated", cell: ({ deployment }) => (deployment?.reading?.switched_epoch ? h("span", { title: stamp(deployment.reading.switched_epoch) }, age(deployment.reading.switched_epoch)) : "—") },
    { label: "Pin", cell: ({ deployment }) => (deployment === null ? none() : deployment.pin === null ? h("span", { class: "muted" }, "head") : h("code", {}, short_revision(deployment.pin))) },
    { label: "Store used", cell: ({ host }) => store_used(host) },
    { label: "Waiting on", cell: ({ deployment }) => (deployment === null ? h("span", { class: "muted" }, "Not deployed") : waiting_on(deployment)) },
    { label: "Running", cell: ({ host, deployment }) => {
      const job = deployment?.running_job ?? host.running_job;
      return job === null ? "" : h("a", { href: link(["jobs", String(job.id)]) }, job.kind);
    } },
  ], rows, "Hosts");
}

function store_used(host: Host): Child {
  const used = host.reading?.store?.used_percent ?? null;
  if (used === null) return "—";
  const tone = host.gc === null ? "none" : last_collection_tone(host);
  return h("span", { class: tone === "none" ? null : `tone-${tone}` }, `${used.toFixed(1)}%`);
}

// ── One host ─────────────────────────────────────────────────────────────────

// One host's page, on the tab asked for or the first it has: the System when it runs a deployment.
export function host_view(name: string, asked: HostTab | null = null): View {
  const body = h("div", { class: "stack" });
  const heading = h("h1", {}, name);
  const badge = h("span");
  const buttons = h("div", { class: "head-actions" });
  const tabs = h("nav", { class: "tabs", "aria-label": "Host" });
  const page = h("div", { class: "page" },
    crumbs([["Hosts", link(["hosts"])], [name, null]]),
    h("header", { class: "page-head" }, h("div", { class: "card-head" }, heading, badge), buttons),
    tabs,
    body,
  );
  const path = `/api/hosts/${encodeURIComponent(name)}`;
  let deployment: Deployment | null = null;
  let generations: HTMLElement | null = null;

  const refresh = (quiet: boolean): Promise<boolean> => load(body, async () => {
    const host = await api<Host>(path);
    const deployed = host.deployments[0];
    const current = deployed === undefined ? null : await api<Deployment>(`/api/deployments/${encodeURIComponent(deployed.id)}`);
    deployment = current;
    const has: Record<HostTab, boolean> = { system: current !== null, store: host.gc !== null, boot: host.boot, machine: true };
    const tab = asked ?? host_tabs.find((choice) => has[choice])!;
    heading.textContent = host.display_name;
    badge.replaceChildren(status_badge(row_status({ host, deployment: current })));
    // A deployment's Reboot reboots its host, so only the host's shows.
    buttons.replaceChildren(
      h("button", { onclick: () => void run_refresh() }, "Check now"),
      ...(current === null ? [] : current.actions.filter((action) => action.id !== "reboot").map((action) => action_button(current, action, () => refresh(true)))),
      ...host.actions.map((action) => host_action_button(host, action, () => refresh(true))),
    );
    tabs.replaceChildren(...nodes(host_tabs.map((choice) => (has[choice] || choice === tab) && tab_link(choice, tab))));
    if (tab === "system" && current !== null && generations === null) {
      generations = generations_section(current, () => refresh(true));
      page.append(generations);
    }
    if (tab === "system") return current === null ? empty("Nothing is deployed to this host.", "Name it as a deployment's host in the config file.") : system_tab(current, () => refresh(true));
    if (tab === "store") return store_tab(host);
    if (tab === "boot") return boot_tab(host, () => refresh(true));
    return machine_tab(host, () => refresh(true));
  }, { quiet });

  const run_refresh = async () => {
    toast(deployment === null ? "Reading the host…" : "Reading the host and evaluating the flake…");
    await Promise.all([
      api(`${path}/refresh`, "POST"),
      deployment === null ? null : api(`/api/deployments/${encodeURIComponent(deployment.id)}/refresh`, "POST"),
    ]).catch((error) => toast(String(error.message), "bad"));
    await refresh(true);
  };

  const tab_link = (choice: HostTab, tab: HostTab) => h("a", {
    class: choice === tab ? "tab active" : "tab",
    href: link(["hosts", name, choice]),
    "aria-current": choice === tab ? "page" : null,
  }, tab_labels[choice]);

  void refresh(false);
  const timer = setInterval(() => void refresh(true), refresh_interval_in_milliseconds);

  return {
    title: asked === null ? name : `${tab_labels[asked]} · ${name}`,
    root: page,
    dispose: () => clearInterval(timer),
  };
}

// An old address of a deployment's page, which now lives on its host's page.
export function deployment_redirect(id: string, page: string | undefined): View {
  const root = h("div", { class: "page" });
  void load(root, async () => {
    const deployment = await api<Deployment>(`/api/deployments/${encodeURIComponent(id)}`);
    if (deployment.host_name === null) throw new Error(`The deployment ${id} names no host`);
    const query = page === "closure" ? Object.fromEntries(current_route().query) : {};
    location.replace(link(["hosts", deployment.host_name, page === "closure" ? "closure" : "system"], query));
    return null;
  });
  return { title: id, root };
}

// ── Machine ──────────────────────────────────────────────────────────────────

// The machine itself: its agent and the key it logs in with, how it is woken and read, and its events. It holds no
// tiles, as its one changing state, the agent's connection, shows in the page's status.
async function machine_tab(host: Host, refresh: () => Promise<unknown>): Promise<Child> {
  const [events, provisioning] = await Promise.all([
    api<EventRow[]>(`/api/hosts/${encodeURIComponent(host.name)}/events`),
    api<Provisioning>("/api/provisioning"),
  ]);
  const made = provisioning.provisioned_agents.find((agent) => agent.host === host.name) ?? null;
  return [
    section("Details", details(host, made), made && h("button", { class: "danger", onclick: () => forget_key(made, refresh) }, "Forget the key")),
    section("Events", events.length === 0 ? empty("No events yet.") : events_list(events)),
  ];
}

function details(host: Host, made: ProvisionedAgent | null): HTMLElement {
  const when = (epoch: number) => h("span", { title: stamp(epoch) }, age(epoch));
  const rows: Parameters<typeof facts>[0] = [
    ["Agent", host.own ? "the server itself" : host.agent === null ? "not connected" : h("span", {}, `version ${host.agent.agent_version}, connected `, when(host.agent.connected_epoch))],
  ];
  if (!host.own) rows.push(["Agent key", key_text(host, made)]);
  rows.push(
    ["Woken by", host.wake === null ? "never woken" : h("span", {}, "wake-on-LAN to ", h("code", {}, host.wake.mac), ` via ${host.wake.via ?? "the server"} on ${host.wake.broadcast}, waiting up to ${duration(host.wake.timeout)}`)],
    ["Kept awake", host.keep_awake ? "through every job and switch" : "no"],
    ["Read every", duration(host.interval)],
  );
  return facts(rows, "rows");
}

// Where the agent's key comes from: the config, or an install that made it.
function key_text(host: Host, made: ProvisionedAgent | null): Child {
  if (made === null) return host.agent_key ? "declared in the config" : "none declared";
  return h("span", {},
    made.overridden ? "declared in the config, used instead of the one made by " : "made by ",
    h("a", { href: link(["jobs", String(made.job_id)]) }, `install #${made.job_id}`), " ",
    h("span", { title: stamp(made.added_epoch) }, age(made.added_epoch)), ", ",
    h("code", { class: "small", title: made.public_line }, made.fingerprint));
}

export function forget_key(agent: ProvisionedAgent, done: () => Promise<unknown>): void {
  confirm_dialog(`Forget ${agent.host}'s key`,
    `Stop accepting the agent key X-Nix made for ${agent.host}? Its agent is hung up on and cannot log in again unless the config declares its key.`,
    "Forget", async () => {
      try {
        toast((await api<ActionOutcome>(`/api/provisioning/agents/${encodeURIComponent(agent.host)}/forget`, "POST")).message, "good");
      } catch (error) {
        toast((error as Error).message, "bad");
      }
      await done();
    });
}
