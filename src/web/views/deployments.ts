// The Deployments pages: every deployment as a card, and one deployment with its drift, actions, jobs and events.

import { api, type ActionView, type Deployment, type EventRow, type Job } from "../api.ts";
import { age, h, stamp } from "../dom.ts";
import { link } from "../router.ts";
import { confirm_dialog, crumbs, empty, facts, level_badge, load, section, status_badge, toast } from "../ui.ts";
import { deployment_card, drift_state, jobs_table, refresh_interval_in_milliseconds, type View } from "./shared.ts";

// ── List ─────────────────────────────────────────────────────────────────────

export function deployments_view(): View {
  const list = h("div");
  const refresh = (quiet: boolean) => load(list, async () => {
    const deployments = await api<Deployment[]>("/api/deployments");
    if (deployments.length === 0) return empty("No deployments yet.", "Name each NixOS host and its flake under deployments in the config file.");
    return h("div", { class: "grid" }, ...deployments.map(deployment_card));
  }, { quiet });
  void refresh(false);
  const timer = setInterval(() => void refresh(true), refresh_interval_in_milliseconds);

  return {
    title: "Deployments",
    root: h("div", { class: "page" },
      h("h1", {}, "Deployments"),
      h("p", { class: "muted" }, "Each NixOS host against what its flake evaluates to."),
      list,
    ),
    dispose: () => clearInterval(timer),
  };
}

// ── One deployment ───────────────────────────────────────────────────────────

export function deployment_view(id: string): View {
  const body = h("div", { class: "stack" });
  const heading = h("h1", {}, id);
  const badge = h("span");
  const buttons = h("div", { class: "head-actions" });

  const refresh = (quiet: boolean) => load(body, async () => {
    const [deployment, jobs, events] = await Promise.all([
      api<Deployment>(`/api/deployments/${encodeURIComponent(id)}`),
      api<Job[]>(`/api/jobs?deployment=${encodeURIComponent(id)}&limit=10`),
      api<EventRow[]>(`/api/deployments/${encodeURIComponent(id)}/events`),
    ]);
    heading.textContent = deployment.name;
    badge.replaceChildren(status_badge(deployment.reading?.status ?? null));
    buttons.replaceChildren(
      h("button", { onclick: () => void run_refresh() }, "Check now"),
      ...deployment.actions.map((action) => action_button(deployment, action)),
    );
    return [
      tiles(deployment),
      section("Findings", findings(deployment)),
      section("Details", details(deployment)),
      section("Jobs", jobs.length === 0 ? empty("No jobs yet.") : jobs_table(jobs, false)),
      section("Events", events.length === 0 ? empty("No events yet.") : events_list(events)),
    ];
  }, { quiet });

  const run_refresh = async () => {
    toast("Reading the host and evaluating the flake…");
    await api(`/api/deployments/${encodeURIComponent(id)}/refresh`, "POST").catch((error) => toast(String(error.message), "bad"));
    await refresh(true);
  };

  const run_action = async (action: ActionView) => {
    try {
      const outcome = await api<{ message: string; job_id: number | null }>(`/api/deployments/${encodeURIComponent(id)}/actions/${action.id}`, "POST");
      toast(outcome.message, "good", outcome.job_id === null ? null : { href: link(["jobs", String(outcome.job_id)]), text: "Follow it" });
    } catch (error) {
      toast((error as Error).message, "bad");
    }
    await refresh(true);
  };

  const action_button = (deployment: Deployment, action: ActionView) => h("button", {
    class: action.id === "reboot" ? "danger" : action.id === "switch" ? "accent solid" : null,
    disabled: action.refusal !== null,
    title: action.refusal,
    onclick: () => {
      if (action.confirm === null) void run_action(action);
      else confirm_dialog(`${action.label} ${deployment.name}`, action.confirm, action.label, () => run_action(action));
    },
  }, action.label);

  void refresh(false);
  const timer = setInterval(() => void refresh(true), refresh_interval_in_milliseconds);

  return {
    title: id,
    root: h("div", { class: "page" },
      crumbs([["Deployments", link(["deployments"])], [id, null]]),
      h("header", { class: "page-head" }, h("div", { class: "card-head" }, heading, badge), buttons),
      body,
    ),
    dispose: () => clearInterval(timer),
  };
}

// ── Parts ────────────────────────────────────────────────────────────────────

function tiles(deployment: Deployment): HTMLElement {
  const reading = deployment.reading;
  const evaluation = deployment.evaluation;
  const [drift, tone] = drift_state(deployment);
  const tile = (label: string, value: string, class_name: string | null = null) =>
    h("div", { class: `tile${class_name ? ` ${class_name}` : ""}` }, h("div", { class: "tile-label" }, label), h("div", { class: "tile-value" }, value));
  return h("div", { class: "tiles" },
    tile("Flake", drift, tone === "bad" ? "tile-bad" : null),
    tile("Reboot", reading?.reboot_required === true ? "Needed" : reading?.reboot_required === false ? "Not needed" : "—"),
    tile("Generation", String(reading?.generation ?? "—")),
    tile("Last switch", reading?.switched_epoch ? age(reading.switched_epoch) : "—"),
    tile("Revision", short_revision(evaluation.flake_revision)),
    tile("Oldest input", evaluation.inputs_last_modified_epoch ? age(evaluation.inputs_last_modified_epoch) : "—"),
  );
}

function findings(deployment: Deployment): HTMLElement {
  const messages = deployment.reading?.messages ?? [];
  if (messages.length === 0) return empty("Not read yet.");
  return h("ul", { class: "events" }, ...messages.map((message) => h("li", {}, level_badge(message.level), " ", h("span", { class: "event-message" }, message.text))));
}

function details(deployment: Deployment): HTMLElement {
  const reading = deployment.reading;
  const evaluation = deployment.evaluation;
  const when = (epoch: number | null | undefined) => (epoch ? h("span", { title: stamp(epoch) }, age(epoch)) : "—");
  const code = (text: string | null | undefined) => (text ? h("code", {}, text) : "—");
  const rows: [string, ReturnType<typeof when> | string, string?][] = [
    ["Host", deployment.host ?? "this server"],
    ["Flake", code(deployment.flake)],
    ["Configuration", deployment.configuration ?? reading?.hostname ?? "the host's own name"],
    ["NixOS version", reading?.version ?? "—"],
    ["Running closure", code(reading?.current), "path"],
    ["Flake closure", code(evaluation.target), "path"],
    ["Flake revision", code(evaluation.flake_revision)],
    ["Flake last changed", when(evaluation.flake_last_modified_epoch)],
    ["Oldest input", h("span", {}, evaluation.oldest_input ?? "—", " (", when(evaluation.inputs_last_modified_epoch), ")")],
    ["Last evaluated", deployment.evaluating ? "evaluating now" : when(evaluation.evaluated_epoch)],
    ["Last read", when(reading?.checked_epoch)],
  ];
  if (deployment.agents.eval !== deployment.host) rows.push(["Evaluates on", deployment.agents.eval ?? "this server"]);
  if (deployment.agents.build !== deployment.host) rows.push(["Builds on", deployment.agents.build ?? "this server"]);
  if (deployment.agents.switch !== deployment.host) rows.push(["Switches from", deployment.agents.switch ?? "this server"]);
  for (const kind of ["update", "build"] as const) {
    const at = deployment.schedule[kind];
    if (at !== null) rows.push([`Daily ${kind}`, h("span", {}, `at ${at}, last slot `, when(evaluation.scheduled[kind]))]);
  }
  if (deployment.auto_switch) rows.push(["Automatic switch", "on"]);
  if (evaluation.eval_error) rows.push(["Evaluation error", h("pre", { class: "output" }, evaluation.eval_error)]);
  if (evaluation.metadata_error) rows.push(["Metadata error", h("pre", { class: "output" }, evaluation.metadata_error)]);
  return facts(rows, "rows");
}

function events_list(events: EventRow[]): HTMLElement {
  return h("ul", { class: "events" }, ...events.map((event) => h("li", {},
    h("span", { class: "event-time muted small", title: stamp(event.epoch) }, age(event.epoch)), " ",
    level_badge(event.level), " ",
    h("span", { class: "event-message" }, event.message))));
}

// A flake revision cut to fit a tile, keeping the -dirty mark.
function short_revision(revision: string | null): string {
  if (!revision) return "—";
  const dash = revision.indexOf("-");
  return dash === -1 ? revision.slice(0, 8) : revision.slice(0, Math.min(dash, 8)) + revision.slice(dash);
}
