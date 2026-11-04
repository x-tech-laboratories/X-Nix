// The fleet runs: the table of them on the Hosts page, and one fleet run followed host by host.

import { api, type FleetActionId, type FleetOutcome, type FleetRun } from "../api.ts";
import { age, h, stamp } from "../dom.ts";
import { link } from "../router.ts";
import { crumbs, data_table, facts, load, section, toast } from "../ui.ts";
import { fleet_host_badge, fleet_run_badge, refresh_interval_in_milliseconds, type View } from "./shared.ts";

export const action_labels: Record<FleetActionId, string> = { build: "Build", switch: "Rebuild and switch", reboot: "Reboot" };

// ── Fleet runs ───────────────────────────────────────────────────────────────

function summary(run: FleetRun): string {
  const counts = new Map<string, number>();
  for (const host of run.hosts) counts.set(host.state, (counts.get(host.state) ?? 0) + 1);
  return [...counts].map(([state, number]) => `${number} ${state}`).join(", ");
}

export function runs_table(runs: FleetRun[]): HTMLElement {
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
        ["Action", run.action === "update" ? "Update flake" : action_labels[run.action]],
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
      crumbs([["Hosts", link(["hosts"])], [`Run ${id}`, null]]),
      h("header", { class: "page-head" }, h("h1", {}, `Fleet run ${id}`), buttons),
      body,
    ),
    dispose: () => clearInterval(timer),
  };
}
