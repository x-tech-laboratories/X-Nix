// The Deployments pages: every deployment as a card, and one deployment with its drift, actions, pin, jobs and events.

import { api, type ActionOutcome, type Deployment, type DiffOutcome, type EventRow, type Generation, type Job } from "../api.ts";
import { age, h, stamp } from "../dom.ts";
import { link } from "../router.ts";
import { confirm_dialog, crumbs, data_table, empty, facts, load, section, status_badge, toast } from "../ui.ts";
import {
  action_button, deployment_card, diff_view, drift_state, events_list, jobs_table, messages_list, refresh_interval_in_milliseconds, short_revision, tag_chips,
  tile,
  type View,
} from "./shared.ts";

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

  const refresh = (quiet: boolean): Promise<boolean> => load(body, async () => {
    const [deployment, jobs, events] = await Promise.all([
      api<Deployment>(`/api/deployments/${encodeURIComponent(id)}`),
      api<Job[]>(`/api/jobs?deployment=${encodeURIComponent(id)}&limit=10`),
      api<EventRow[]>(`/api/deployments/${encodeURIComponent(id)}/events`),
    ]);
    heading.textContent = deployment.name;
    badge.replaceChildren(status_badge(deployment.reading?.status ?? null));
    buttons.replaceChildren(
      h("button", { onclick: () => void run_refresh() }, "Check now"),
      // Collect Garbage lives on the deployment's Store page.
      ...deployment.actions.filter((action) => action.id !== "collect").map((action) => action_button(deployment, action, () => refresh(true))),
    );
    return [
      tiles(deployment),
      section("Findings", messages_list(deployment.reading?.messages ?? [])),
      changes_section(deployment, () => refresh(true)),
      section("Details", details(deployment)),
      section("Pin", pin_form(deployment, () => refresh(true))),
      section("Jobs", jobs.length === 0 ? empty("No jobs yet.") : jobs_table(jobs, false)),
      section("Events", events.length === 0 ? empty("No events yet.") : events_list(events)),
    ];
  }, { quiet });

  const run_refresh = async () => {
    toast("Reading the host and evaluating the flake…");
    await api(`/api/deployments/${encodeURIComponent(id)}/refresh`, "POST").catch((error) => toast(String(error.message), "bad"));
    await refresh(true);
  };

  // Generations are read from the host on demand rather than every refresh.
  const generations = h("div");
  const load_generations = (quiet: boolean) => load(generations, async () => {
    const answer = await api<{ generations: Generation[] }>(`/api/deployments/${encodeURIComponent(id)}/generations`);
    return generations_table(id, answer.generations, async () => {
      await refresh(true);
      await load_generations(true);
    });
  }, { quiet });

  void refresh(false);
  void load_generations(false);
  const timer = setInterval(() => void refresh(true), refresh_interval_in_milliseconds);

  return {
    title: id,
    root: h("div", { class: "page" },
      crumbs([["Deployments", link(["deployments"])], [id, null]]),
      h("header", { class: "page-head" }, h("div", { class: "card-head" }, heading, badge), buttons),
      body,
      section("Generations", generations, h("button", { onclick: () => void load_generations(false) }, "Read again")),
    ),
    dispose: () => clearInterval(timer),
  };
}

// ── Parts ────────────────────────────────────────────────────────────────────

function tiles(deployment: Deployment): HTMLElement {
  const reading = deployment.reading;
  const evaluation = deployment.evaluation;
  const [drift, tone] = drift_state(deployment);
  return h("div", { class: "tiles" },
    tile("Flake", drift, tone === "bad" ? "tile-bad" : null),
    tile("Reboot", reading?.reboot_required === true ? "Needed" : reading?.reboot_required === false ? "Not needed" : "—"),
    tile("Generation", String(reading?.generation ?? "—")),
    tile("Last switch", reading?.switched_epoch ? age(reading.switched_epoch) : "—"),
    tile("Revision", short_revision(evaluation.flake_revision)),
    tile("Pin", deployment.pin === null ? "Head" : short_revision(deployment.pin), deployment.pin === null ? null : "tile-info"),
    tile("Oldest input", evaluation.inputs_last_modified_epoch ? age(evaluation.inputs_last_modified_epoch) : "—"),
  );
}

// The commit or tag the deployment is fixed at, and a form that pins it, follows the head, or goes back to the settings.
function pin_form(deployment: Deployment, done: () => Promise<unknown>): HTMLElement {
  const input = h("input", { type: "text", class: "filter", placeholder: "commit hash or tag", "aria-label": "Pin", value: deployment.pin ?? "" });
  const send = async (body: { pin?: string | null; reset?: boolean }) => {
    try {
      toast((await api<ActionOutcome>(`/api/deployments/${encodeURIComponent(deployment.id)}/pin`, "POST", body)).message, "good");
    } catch (error) {
      toast((error as Error).message, "bad");
    }
    await done();
  };
  const where = deployment.pin_overridden ? "set here" : "from the settings";
  return h("div", { class: "stack" },
    h("p", {}, deployment.pin === null
      ? `Following the branch head of ${deployment.flake} (${where}).`
      : h("span", {}, "Evaluating, building and switching ", h("code", {}, deployment.pin), ` of ${deployment.flake} (${where}).`)),
    h("form", { class: "toolbar", onsubmit: (event: Event) => {
      event.preventDefault();
      void send({ pin: input.value.trim() === "" ? null : input.value.trim() });
    } },
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Commit or tag"), input),
      h("button", { type: "submit", class: "accent solid" }, "Pin"),
      h("button", { type: "button", disabled: deployment.pin === null, onclick: () => void send({ pin: null }) }, "Follow the branch head"),
      deployment.pin_overridden && h("button", { type: "button", onclick: () => void send({ reset: true }) },
        deployment.configured_pin === null ? "Use the settings (head)" : `Use the settings (${deployment.configured_pin})`)));
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
    ["Tags", deployment.tags.length === 0 ? "—" : tag_chips(deployment.tags)],
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
  if (deployment.switch_from_cache) rows.push(["Switch", "fetches the flake closure from the cache and activates it"]);
  rows.push(["Switch safety", safety_text(deployment)]);
  if (reading?.current) rows.push(["Closure browser", h("a", { href: link(["deployments", deployment.id, "closure"]) }, "Browse the running closure")]);
  if (evaluation.eval_error) rows.push(["Evaluation error", h("pre", { class: "output" }, evaluation.eval_error)]);
  if (evaluation.metadata_error) rows.push(["Metadata error", h("pre", { class: "output" }, evaluation.metadata_error)]);
  return facts(rows, "rows");
}

// What guards a switch, in one line.
function safety_text(deployment: Deployment): string {
  const safety = deployment.safety;
  const parts: string[] = [];
  if (safety.pre_switch_checks.length > 0) parts.push(`${safety.pre_switch_checks.length} pre-switch check${safety.pre_switch_checks.length === 1 ? "" : "s"}`);
  const health = safety.health_commands.length + safety.health_urls.length;
  if (health > 0) parts.push(`${health} health check${health === 1 ? "" : "s"} every ${safety.health_period}s for up to ${safety.health_timeout}s`);
  if (safety.magic_rollback) parts.push(`rolled back unless confirmed within ${safety.confirm_timeout}s of an activation that takes up to ${safety.activation_timeout}s`);
  if (safety.inhibit_sleep) parts.push("the host is kept awake while it switches");
  return parts.length === 0 ? "none; the switch runs alone" : parts.join("; ");
}

// ── What a switch changes ────────────────────────────────────────────────────

// The last package diff, when it compares the running closure with the flake's current one.
function changes_section(deployment: Deployment, done: () => Promise<unknown>): HTMLElement | null {
  const current = deployment.reading?.current ?? null;
  const target = deployment.evaluation.target;
  if (current === null || target === null || current === target) return null;
  const diff = deployment.evaluation.last_diff;
  const compare = async () => {
    toast("Comparing the running closure with the flake's…");
    try {
      const outcome = await api<DiffOutcome>(`/api/deployments/${encodeURIComponent(deployment.id)}/diff`, "POST", { force: true });
      if (outcome.message !== null) toast(outcome.message);
    } catch (error) {
      toast((error as Error).message, "bad");
    }
    await done();
  };
  const fresh = diff !== null && diff.from === current && diff.to === target;
  return section("What a switch changes",
    fresh ? diff_view(diff) : empty("Not compared yet.", "Compare the running closure with the flake's, or a Build on the host compares them once it ends."),
    h("button", { onclick: () => void compare() }, fresh ? "Compare again" : "Compare now"));
}

// ── Generations ──────────────────────────────────────────────────────────────

function generations_table(id: string, generations: Generation[], done: () => Promise<unknown>): HTMLElement {
  if (generations.length === 0) return empty("No generations read.");
  const roll_back = (generation: Generation) => confirm_dialog(
    `Roll back to generation ${generation.generation}`,
    `Activate generation ${generation.generation} and boot it from now on? The rollback is kept in the job history.`,
    "Roll back",
    async () => {
      try {
        const outcome = await api<ActionOutcome>(`/api/deployments/${encodeURIComponent(id)}/rollback`, "POST", { generation: generation.generation });
        toast(outcome.message, "good", outcome.job_id === null ? null : { href: link(["jobs", String(outcome.job_id)]), text: "Follow it" });
      } catch (error) {
        toast((error as Error).message, "bad");
      }
      await done();
    },
  );
  return data_table<Generation>([
    { label: "Generation", class: "number", cell: (generation) => String(generation.generation) },
    { label: "Created", cell: (generation) => (generation.created_epoch ? h("span", { title: stamp(generation.created_epoch) }, age(generation.created_epoch)) : "—") },
    { label: "Version", cell: (generation) => generation.version ?? "—" },
    { label: "State", cell: (generation) => h("span", { class: "chips" },
      generation.current && h("span", { class: "badge tone-good" }, "running"),
      generation.booted && h("span", { class: "badge tone-info" }, "booted"),
      generation.profile && h("span", { class: "badge tone-none" }, "default")) },
    { label: "Actions", class: "actions-cell", cell: (generation) => h("span", { class: "row-actions" },
      h("a", { class: "button", href: link(["deployments", id, "closure"], { generation: generation.generation }) }, "Closure"),
      generation.current && generation.profile ? null : h("button", { class: "danger", onclick: () => roll_back(generation) }, "Roll back")) },
  ], generations, "Generations");
}
