// The Fleet pages: pick deployments by checkbox, glob or @tag and run one action across them, at once or stage by stage,
// and follow each fleet run host by host.

import { api, type Deployment, type Fleet, type FleetActionId, type FleetOutcome, type FleetRun } from "../api.ts";
import { age, h, stamp } from "../dom.ts";
import { link } from "../router.ts";
import { confirm_dialog, crumbs, data_table, empty, facts, load, section, toast } from "../ui.ts";
import { fleet_host_badge, fleet_run_badge, fleet_status_table, refresh_interval_in_milliseconds, type View } from "./shared.ts";

const action_labels: Record<FleetActionId, string> = { update: "Update flake", build: "Build", switch: "Rebuild and switch", reboot: "Reboot" };

// ── Fleet ────────────────────────────────────────────────────────────────────

export function fleet_view(): View {
  const selected = new Set<string>();
  let deployments: Deployment[] = [];
  const table = h("div");
  const runs = h("div");
  const tags = h("div", { class: "chips" });
  const count = h("span", { class: "muted" });
  const selector = h("input", { type: "text", class: "filter", placeholder: "web-* @canary", "aria-label": "Selector" });
  const staged = h("input", { type: "checkbox" });
  const stages = h("textarea", { class: "stage-list", placeholder: "One stage per line, such as @canary", "aria-label": "Stages" });
  const parallel = h("input", { type: "number", min: 1, step: 1, "aria-label": "At once" });
  const buttons = h("div", { class: "head-actions" });

  const draw_table = () => {
    table.replaceChildren(deployments.length === 0
      ? empty("No deployments yet.", "Name each NixOS host and its flake under deployments in the config file.")
      : fleet_status_table(deployments, { selected, changed: show_count }));
    show_count();
  };
  const show_count = () => {
    count.textContent = `${selected.size} of ${deployments.length} picked`;
    for (const button of buttons.querySelectorAll("button")) button.disabled = selected.size === 0;
  };
  const pick = (ids: string[]) => {
    selected.clear();
    for (const id of ids) selected.add(id);
    draw_table();
  };

  const select = async () => {
    try {
      pick(await api<string[]>(`/api/fleet/select?selector=${encodeURIComponent(selector.value)}`));
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
    disabled: true,
    onclick: () => {
      if (action === "update" || action === "build") return void run(action);
      const names = deployments.filter((deployment) => selected.has(deployment.id)).map((deployment) => deployment.name).join(", ");
      const how = staged.checked ? "stage by stage, stopping at the first failure" : "up to the parallel limit at once";
      confirm_dialog(`${action_labels[action]} ${selected.size} deployments`, `${action_labels[action]} ${names}, ${how}?`, action_labels[action], () => run(action));
    },
  }, action_labels[action])));

  let first = true;
  const refresh = (quiet: boolean) => load(runs, async () => {
    const [list, fleet] = await Promise.all([api<Deployment[]>("/api/deployments"), api<Fleet>("/api/fleet")]);
    deployments = list;
    draw_table();
    if (first) {
      first = false;
      stages.value = fleet.stages.join("\n");
      parallel.placeholder = String(fleet.parallel);
    }
    tags.replaceChildren(...fleet.tags.map((tag) => h("button", { class: "link", onclick: () => {
      selector.value = `@${tag}`;
      void select();
    } }, `@${tag}`)));
    return fleet.runs.length === 0 ? empty("No fleet runs yet.") : runs_table(fleet.runs);
  }, { quiet });
  void refresh(false);
  const timer = setInterval(() => void refresh(true), refresh_interval_in_milliseconds);

  return {
    title: "Fleet",
    root: h("div", { class: "page" },
      h("h1", {}, "Fleet"),
      h("p", { class: "muted" }, "Run one action across many deployments, picked by checkbox, by a name glob or by @tag."),
      section("Deployments", h("div", {},
        h("form", { class: "toolbar", onsubmit: (event: Event) => {
          event.preventDefault();
          void select();
        } },
          h("label", { class: "field" }, h("span", { class: "field-label" }, "Selector"), selector),
          h("button", { type: "submit" }, "Pick"),
          h("button", { type: "button", onclick: () => pick(deployments.map((deployment) => deployment.id)) }, "All"),
          h("button", { type: "button", onclick: () => pick([]) }, "None"),
          count),
        tags,
        table), null),
      section("Run", h("div", { class: "stack" },
        h("div", { class: "toolbar" },
          h("label", { class: "check" }, staged, "Staged rollout"),
          h("label", { class: "field" }, h("span", { class: "field-label" }, "Stages"), stages),
          h("label", { class: "field" }, h("span", { class: "field-label" }, "At once"), parallel)),
        buttons)),
      section("Fleet runs", runs),
    ),
    dispose: () => clearInterval(timer),
  };
}

function summary(run: FleetRun): string {
  const counts = new Map<string, number>();
  for (const host of run.hosts) counts.set(host.state, (counts.get(host.state) ?? 0) + 1);
  return [...counts].map(([state, number]) => `${number} ${state}`).join(", ");
}

function runs_table(runs: FleetRun[]): HTMLElement {
  return data_table<FleetRun>([
    { label: "Run", cell: (run) => h("a", { href: link(["fleet", String(run.id)]) }, `${run.action} #${run.id}`) },
    { label: "State", cell: (run) => fleet_run_badge(run.state) },
    { label: "Hosts", cell: summary },
    { label: "Staged", cell: (run) => (run.staged ? `stage ${run.current_stage + 1} of ${run.stages.length}` : "no") },
    { label: "Started", cell: (run) => h("span", { title: stamp(run.started_epoch) }, age(run.started_epoch)) },
  ], runs, "Fleet runs");
}

// ── One fleet run ────────────────────────────────────────────────────────────

export function fleet_run_view(id: number): View {
  const body = h("div", { class: "stack" });
  const buttons = h("div", { class: "head-actions" });

  const refresh = (quiet: boolean) => load(body, async () => {
    const run = await api<FleetRun>(`/api/fleet/runs/${id}`);
    buttons.replaceChildren(run.state === "running" && !run.stop_requested ? h("button", { class: "danger", onclick: () => void stop() }, "Stop") : "");
    return [
      facts([
        ["Action", action_labels[run.action]],
        ["State", fleet_run_badge(run.state)],
        ["Picked", run.selector],
        ["At once", run.parallel],
        ["Started", h("span", { title: stamp(run.started_epoch) }, age(run.started_epoch))],
        ["Finished", run.finished_epoch ? h("span", { title: stamp(run.finished_epoch) }, age(run.finished_epoch)) : "—"],
        ["Outcome", run.message ?? summary(run)],
      ]),
      section("Hosts", data_table([
        { label: "Deployment", cell: (host) => h("a", { href: link(["deployments", host.deployment_id]) }, host.name) },
        ...(run.staged ? [{ label: "Stage", cell: (host: FleetRun["hosts"][number]) => `${host.stage + 1}: ${run.stages[host.stage] ?? ""}` }] : []),
        { label: "State", cell: (host) => fleet_host_badge(host.state) },
        { label: "Job", cell: (host) => (host.job_id === null ? "" : h("a", { href: link(["jobs", String(host.job_id)]) }, `#${host.job_id}`)) },
        { label: "Last word", cell: (host) => h("span", { class: "muted small" }, host.message ?? "") },
      ], run.hosts, "Hosts")),
    ];
  }, { quiet });

  const stop = async () => {
    try {
      toast((await api<FleetOutcome>(`/api/fleet/runs/${id}/stop`, "POST")).message);
    } catch (error) {
      toast((error as Error).message, "bad");
    }
    await refresh(true);
  };

  void refresh(false);
  const timer = setInterval(() => void refresh(true), refresh_interval_in_milliseconds);

  return {
    title: `Fleet run ${id}`,
    root: h("div", { class: "page" },
      crumbs([["Fleet", link(["fleet"])], [`Run ${id}`, null]]),
      h("header", { class: "page-head" }, h("h1", {}, `Fleet run ${id}`), buttons),
      body,
    ),
    dispose: () => clearInterval(timer),
  };
}
