// The Flakes pages: every flake as a card, and one flake with its locked inputs, its Update and what names it.

import { api, type ActionOutcome, type EventRow, type Flake, type Job, type LockedInput, type Status } from "../api.ts";
import { age, h, stamp } from "../dom.ts";
import { link } from "../router.ts";
import { confirm_dialog, crumbs, data_table, empty, facts, load, section, status_badge, toast } from "../ui.ts";
import { duration, events_list, jobs_table, messages_list, refresh_interval_in_milliseconds, short_revision, tile, type View } from "./shared.ts";

const status_tones: Record<Status, string> = { online: "good", info: "good", unavailable: "warn", warning: "warn", failed: "bad" };

// ── List ─────────────────────────────────────────────────────────────────────

export function flakes_view(): View {
  const list = h("div", { class: "stack" });
  const refresh = (quiet: boolean) => load(list, async () => {
    const flakes = await api<Flake[]>("/api/flakes");
    if (flakes.length === 0) return empty("No flakes yet.", "Name each flake and how it is updated under flakes in the config file, then name its id in each deployment's flake.");
    return h("div", { class: "grid" }, ...flakes.map(flake_card));
  }, { quiet });
  void refresh(false);
  const timer = setInterval(() => void refresh(true), refresh_interval_in_milliseconds);

  return {
    title: "Flakes",
    root: h("div", { class: "page" },
      h("h1", {}, "Flakes"),
      h("p", { class: "muted" }, "Each flake's locked inputs and how old they are, and the update that moves them on for every deployment naming it."),
      list,
    ),
    dispose: () => clearInterval(timer),
  };
}

function flake_card(flake: Flake): HTMLElement {
  const reading = flake.reading;
  const tone = reading === null ? "none" : status_tones[reading.status];
  const job = flake.running_job;
  return h("a", { class: `card tone-edge-${tone}`, href: link(["flakes", flake.id]) },
    h("div", { class: "card-head" }, h("strong", {}, flake.name), status_badge(reading?.status ?? null)),
    h("div", { class: "muted card-host" }, flake.url),
    h("dl", {},
      h("dt", {}, "Revision"), h("dd", {}, short_revision(reading?.revision ?? null)),
      h("dt", {}, "Oldest input"), h("dd", {}, reading?.inputs_last_modified_epoch ? age(reading.inputs_last_modified_epoch) : "—"),
      h("dt", {}, "Updated"), h("dd", {}, last_update_word(flake)),
      h("dt", {}, "Used by"), h("dd", {}, String(flake.deployments.length + flake.caches.length)),
      job && [h("dt", {}, "Running"), h("dd", {}, `${job.kind}${job.progress ? `: ${job.progress}` : ""}`)],
    ));
}

// ── One flake ────────────────────────────────────────────────────────────────

export function flake_view(id: string): View {
  const body = h("div", { class: "stack" });
  const heading = h("h1", {}, id);
  const badge = h("span");
  const buttons = h("div", { class: "head-actions" });
  const path = `/api/flakes/${encodeURIComponent(id)}`;

  const refresh = (quiet: boolean) => load(body, async () => {
    const [flake, jobs, events] = await Promise.all([
      api<Flake>(path),
      api<Job[]>(`/api/jobs?deployment=${encodeURIComponent(id)}&limit=10`),
      api<EventRow[]>(`${path}/events`),
    ]);
    heading.textContent = flake.name;
    badge.replaceChildren(status_badge(flake.reading?.status ?? null));
    const where = flake.pushes_to === null ? "writes the lock in place" : `pushes a commit of the new lock to ${flake.pushes_to}`;
    buttons.replaceChildren(
      h("button", { disabled: flake.running_job !== null, title: flake.running_job ? "An update is running" : null, onclick: () => void run_refresh() }, "Read now"),
      h("button", {
        class: "accent solid", disabled: flake.update_refusal !== null, title: flake.update_refusal,
        onclick: () => confirm_dialog(`Update ${flake.name}`, `Update every input of ${flake.name}'s lock now? It ${where}, and every deployment naming the flake evaluates afresh.`, "Update", run_update),
      }, "Update"),
    );
    return [
      tiles(flake),
      section("Findings", messages_list(flake.reading?.messages ?? [])),
      section("Details", details(flake)),
      section("Used by", used_by(flake)),
      section("Locked inputs", (flake.reading?.inputs.length ?? 0) === 0 ? empty("Not read yet.") : inputs_table(flake)),
      section("Jobs", jobs.length === 0 ? empty("No updates yet.") : jobs_table(jobs, false)),
      section("Events", events.length === 0 ? empty("No events yet.") : events_list(events)),
    ];
  }, { quiet });

  const run_refresh = async () => {
    toast("Reading the flake…");
    await api(`${path}/refresh`, "POST").catch((error) => toast(String(error.message), "bad"));
    await refresh(true);
  };

  const run_update = async () => {
    try {
      const outcome = await api<ActionOutcome>(`${path}/update`, "POST");
      toast(outcome.message, "good", outcome.job_id === null ? null : { href: link(["jobs", String(outcome.job_id)]), text: "Follow it" });
    } catch (error) {
      toast((error as Error).message, "bad");
    }
    await refresh(true);
  };

  void refresh(false);
  const timer = setInterval(() => void refresh(true), refresh_interval_in_milliseconds);

  return {
    title: `Flake · ${id}`,
    root: h("div", { class: "page" },
      crumbs([["Flakes", link(["flakes"])], [id, null]]),
      h("header", { class: "page-head" }, h("div", { class: "card-head" }, heading, badge), buttons),
      body,
    ),
    dispose: () => clearInterval(timer),
  };
}

// ── Parts ────────────────────────────────────────────────────────────────────

function tiles(flake: Flake): HTMLElement {
  const reading = flake.reading;
  const failed = flake.last_update !== null && !flake.last_update.succeeded;
  return h("div", { class: "tiles" },
    tile("Revision", short_revision(reading?.revision ?? null)),
    tile("Last changed", reading?.last_modified_epoch ? age(reading.last_modified_epoch) : "—"),
    tile("Oldest input", reading?.inputs_last_modified_epoch ? age(reading.inputs_last_modified_epoch) : "—", is_stale(flake, reading?.inputs_last_modified_epoch ?? null) ? "tone-edge-warn" : null),
    tile("Last update", flake.last_update === null ? "—" : h("a", { href: link(["jobs", String(flake.last_update.job_id)]), title: flake.last_update.summary }, last_update_word(flake)), failed ? "tile-bad" : null),
  );
}

// When the last update ended and whether it worked, in a few words.
function last_update_word(flake: Flake): string {
  const last = flake.last_update;
  if (last === null) return "—";
  return last.succeeded ? age(last.finished_epoch) : `Failed ${age(last.finished_epoch)}`;
}

// Whether an input last changed longer ago than the flake's max_input_age allows.
function is_stale(flake: Flake, epoch: number | null): boolean {
  return flake.max_input_age !== null && epoch !== null && Date.now() / 1000 - epoch > flake.max_input_age;
}

function inputs_table(flake: Flake): HTMLElement {
  return data_table<LockedInput>([
    { label: "Input", cell: (input) => h("strong", {}, input.name) },
    { label: "Source", cell: (input) => (input.follows !== null ? h("span", { class: "muted" }, `follows ${input.follows}`) : input.source ? h("code", {}, input.source) : "—") },
    { label: "Revision", cell: (input) => (input.revision ? h("code", {}, short_revision(input.revision)) : "—") },
    { label: "Last changed", cell: (input) => input.last_modified_epoch === null ? "—" : h("span", {
      class: is_stale(flake, input.last_modified_epoch) ? "tone-warn" : null, title: stamp(input.last_modified_epoch),
    }, age(input.last_modified_epoch)) },
  ], flake.reading!.inputs, "Locked inputs");
}

function used_by(flake: Flake): HTMLElement {
  if (flake.deployments.length + flake.caches.length === 0) return empty("Nothing names this flake.", "Name its id in a deployment's or a cache's flake.");
  const entries = [
    ...flake.deployments.map((deployment) => ({ ...deployment, kind: "Deployment", href: link(["deployments", deployment.id]) })),
    ...flake.caches.map((cache) => ({ ...cache, kind: "Cache", href: link(["cache", cache.id]) })),
  ];
  return data_table<(typeof entries)[number]>([
    { label: "Name", cell: (entry) => h("a", { href: entry.href }, entry.name) },
    { label: "Kind", cell: (entry) => entry.kind },
  ], entries, "Used by");
}

function details(flake: Flake): HTMLElement {
  const reading = flake.reading;
  const when = (epoch: number | null | undefined) => (epoch ? h("span", { title: stamp(epoch) }, age(epoch)) : "—");
  const rows: Parameters<typeof facts>[0] = [
    ["Reference", h("code", {}, flake.url)],
    ["Reads and updates on", flake.host ?? "this server"],
    ["Read every", duration(flake.interval)],
    ["Last read", when(reading?.checked_epoch)],
    ["Daily update", flake.update_at === null ? "off" : h("span", {}, `at ${flake.update_at}, last slot `, when(flake.scheduled_update))],
    ["Update", flake.update_refusal !== null && flake.running_job === null ? flake.update_refusal : flake.pushes_to === null ? "writes the lock in place" : h("span", {}, "pushes to ", h("code", {}, flake.pushes_to))],
  ];
  if (flake.pushes_to !== null) rows.push(["Commit author", flake.commit_author], ["Commit message", h("code", {}, flake.commit_message)]);
  if (flake.max_input_age !== null) rows.push(["Input age limit", duration(flake.max_input_age)]);
  if (flake.last_update !== null) {
    rows.push(["Last update changed", flake.last_update.summary]);
  }
  if (reading?.metadata_error) rows.push(["Read error", h("pre", { class: "output" }, reading.metadata_error)]);
  return facts(rows, "rows");
}
