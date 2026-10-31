// The Cache pages: every Attic cache as a card, and one cache with each target's build and push state and its buttons.

import { api, type ActionOutcome, type BuildAllOutcome, type Cache, type CacheActionId, type EventRow, type Job, type Status, type TargetRow } from "../api.ts";
import { age, bytes, h, stamp } from "../dom.ts";
import { link } from "../router.ts";
import { confirm_dialog, crumbs, data_table, empty, facts, load, section, status_badge, toast } from "../ui.ts";
import { duration, events_list, jobs_table, messages_list, refresh_interval_in_milliseconds, short_revision, tile, type View } from "./shared.ts";

const status_tones: Record<Status, string> = { online: "good", info: "good", unavailable: "warn", warning: "warn", failed: "bad" };

// ── List ─────────────────────────────────────────────────────────────────────

export function caches_view(): View {
  const list = h("div");
  const refresh = (quiet: boolean) => load(list, async () => {
    const caches = await api<Cache[]>("/api/caches");
    if (caches.length === 0) return empty("No caches yet.", "Name each building host, its flake, its targets and its Attic cache under caches in the config file.");
    return h("div", { class: "grid" }, ...caches.map(cache_card));
  }, { quiet });
  void refresh(false);
  const timer = setInterval(() => void refresh(true), refresh_interval_in_milliseconds);

  return {
    title: "Cache",
    root: h("div", { class: "page" },
      h("h1", {}, "Cache"),
      h("p", { class: "muted" }, "Whether each closure is built from the flake's latest revision and pushed to its Attic cache."),
      list,
    ),
    dispose: () => clearInterval(timer),
  };
}

function cache_card(cache: Cache): HTMLElement {
  const reading = cache.reading;
  const tone = reading === null ? "none" : status_tones[reading.status];
  const job = cache.running_job;
  return h("a", { class: `card tone-edge-${tone}`, href: link(["cache", cache.id]) },
    h("div", { class: "card-head" }, h("strong", {}, cache.name), status_badge(reading?.status ?? null)),
    h("div", { class: "muted card-host" }, cache.host ?? "this server"),
    h("dl", {},
      h("dt", {}, "Built"), h("dd", {}, count(cache, (row) => row.built === true)),
      h("dt", {}, "Pushed"), h("dd", {}, count(cache, (row) => row.pushed_ok)),
      h("dt", {}, "Checked"), h("dd", {}, reading ? age(reading.checked_epoch) : "—"),
      cache.server && [h("dt", {}, "Server"), h("dd", { class: `tone-${status_tones[cache.server.status]}` }, server_word(cache))],
      job && [h("dt", {}, "Running"), h("dd", {}, `${job.kind}${job.progress ? `: ${job.progress}` : ""}`)],
    ));
}

// ── One cache ────────────────────────────────────────────────────────────────

export function cache_view(id: string): View {
  const body = h("div", { class: "stack" });
  const heading = h("h1", {}, id);
  const badge = h("span");
  const buttons = h("div", { class: "head-actions" });
  const path = `/api/caches/${encodeURIComponent(id)}`;

  const refresh = (quiet: boolean) => load(body, async () => {
    const [cache, jobs, events] = await Promise.all([
      api<Cache>(path),
      api<Job[]>(`/api/jobs?deployment=${encodeURIComponent(id)}&evaluations=1&limit=10`),
      api<EventRow[]>(`${path}/events`),
    ]);
    heading.textContent = cache.name;
    badge.replaceChildren(status_badge(cache.reading?.status ?? null));
    buttons.replaceChildren(
      h("button", { disabled: cache.running_job !== null, title: cache.running_job ? "A job is running" : null, onclick: () => void run_refresh() }, "Check now"),
      h("button", {
        class: "accent solid", disabled: cache.build_all_refusal !== null, title: cache.build_all_refusal,
        onclick: () => confirm_dialog(`Build all of ${cache.name}`, `Evaluate every target in one pass and build each as soon as it is evaluated?${cache.can_push ? " What it builds is pushed to the cache." : ""}`, "Build all", run_build_all),
      }, "Build all"),
    );
    const rows = cache.reading?.rows ?? [];
    const missing = rows.flatMap((row) => row.missing.map((store_path) => ({ name: row.name, store_path })));
    return [
      tiles(cache),
      section("Findings", messages_list(cache.reading?.messages ?? [])),
      cache.server && section(h("span", {}, "Cache server ", status_badge(cache.server.status)), server_details(cache)),
      section("Tracked targets", rows.length === 0 ? empty("Not checked yet.") : targets_table(cache, rows)),
      cache.reading?.build_all && build_all_section(cache.reading.build_all),
      missing.length > 0 && section("Paths not in the cache", data_table<{ name: string; store_path: string }>([
        { label: "Target", cell: (item) => item.name },
        { label: "Store path", cell: (item) => h("code", {}, item.store_path) },
      ], missing, "Paths not in the cache")),
      section("Details", details(cache)),
      section("Jobs", jobs.length === 0 ? empty("No jobs yet.") : jobs_table(jobs, false)),
      section("Events", events.length === 0 ? empty("No events yet.") : events_list(events)),
    ];
  }, { quiet });

  const run_refresh = async () => {
    toast("Checking every target…");
    await api(`${path}/refresh`, "POST").catch((error) => toast(String(error.message), "bad"));
    await refresh(true);
  };

  const run_build_all = async () => {
    try {
      const outcome = await api<ActionOutcome>(`${path}/build-all`, "POST");
      toast(outcome.message, "good", outcome.job_id === null ? null : { href: link(["jobs", String(outcome.job_id)]), text: "Follow it" });
    } catch (error) {
      toast((error as Error).message, "bad");
    }
    await refresh(true);
  };

  const run_action = async (name: string, action: CacheActionId) => {
    try {
      const outcome = await api<ActionOutcome>(`${path}/targets/${encodeURIComponent(name)}/${action}`, "POST");
      toast(outcome.message, "good", outcome.job_id === null ? null : { href: link(["jobs", String(outcome.job_id)]), text: "Follow it" });
    } catch (error) {
      toast((error as Error).message, "bad");
    }
    await refresh(true);
  };

  const targets_table = (cache: Cache, rows: TargetRow[]) => data_table<TargetRow>([
    { label: "Target", cell: (row) => h("strong", { class: `tone-${status_tones[row.status]}` }, row.name) },
    { label: "Built", cell: (row) => (row.built === null ? "—" : row.built ? "Yes" : "No") },
    { label: "Pushed", cell: (row) => row.pushed },
    { label: "State", cell: (row) => row.summary },
    { label: "Store path", cell: (row) => (row.target ? h("code", { class: "small" }, row.target) : "—") },
    { label: "Actions", cell: (row) => {
      const refusals = cache.targets.find((target) => target.name === row.name)?.refusals;
      if (refusals === undefined) return null;
      return h("div", { class: "row-actions" },
        h("button", {
          class: "small", disabled: refusals.build !== null, title: refusals.build,
          onclick: () => confirm_dialog(`Build ${row.name}`, `Build ${row.name} from the latest flake now?${cache.can_push ? " What it builds is pushed to the cache." : ""}`, "Build", () => run_action(row.name, "build")),
        }, "Build"),
        cache.can_push && h("button", { class: "small", disabled: refusals.push !== null, title: refusals.push, onclick: () => void run_action(row.name, "push") }, "Push"));
    } },
  ], rows, "Tracked targets");

  void refresh(false);
  const timer = setInterval(() => void refresh(true), refresh_interval_in_milliseconds);

  return {
    title: `Cache · ${id}`,
    root: h("div", { class: "page" },
      crumbs([["Cache", link(["cache"])], [id, null]]),
      h("header", { class: "page-head" }, h("div", { class: "card-head" }, heading, badge), buttons),
      body,
    ),
    dispose: () => clearInterval(timer),
  };
}

// ── Parts ────────────────────────────────────────────────────────────────────

function tiles(cache: Cache): HTMLElement {
  const reading = cache.reading;
  const rows = reading?.rows ?? [];
  const all = (good: (row: TargetRow) => boolean) => rows.length > 0 && rows.every(good);
  const edge = (good: (row: TargetRow) => boolean) => (rows.length === 0 || all(good) ? null : "tone-edge-warn");
  const missing = rows.reduce((sum, row) => sum + row.missing_count, 0);
  return h("div", { class: "tiles" },
    tile("Built", count(cache, (row) => row.built === true), edge((row) => row.built === true)),
    tile("Pushed", count(cache, (row) => row.pushed_ok), edge((row) => row.pushed_ok)),
    tile("Missing paths", reading ? missing.toLocaleString() : "—", missing > 0 ? "tone-edge-warn" : null),
    tile("Revision", short_revision(reading?.revision ?? null)),
    tile("Checked", reading ? age(reading.checked_epoch) : "—"),
    cache.server && tile("Server", server_word(cache), cache.server.status === "online" ? null : `tone-edge-${status_tones[cache.server.status]}`),
    cache.server?.size_bytes != null && tile("Cache size", bytes(cache.server.size_bytes)),
  );
}

// The cache server's state in a word or two.
function server_word(cache: Cache): string {
  const server = cache.server;
  if (server === null) return "—";
  if (server.status !== "online") return server.healthy === false ? "Unhealthy" : "Unreachable";
  return server.healthy === true ? "Healthy" : "Answering";
}

// What the cache server's own endpoints answered.
function server_details(cache: Cache): HTMLElement[] {
  const server = cache.server!;
  const code = (text: string) => h("code", {}, text);
  const rows: Parameters<typeof facts>[0] = [];
  if (cache.server_urls.info !== null) rows.push(["Cache info", code(cache.server_urls.info)]);
  for (const [key, value] of Object.entries(server.info ?? {})) rows.push([key, value]);
  if (cache.server_urls.health !== null) rows.push(["Health", h("span", {}, code(cache.server_urls.health), ` ${server.healthy === null ? "" : server.healthy ? "healthy" : "not healthy"}`)]);
  if (cache.server_urls.metrics !== null) rows.push(["Metrics", code(cache.server_urls.metrics)]);
  if (server.size_bytes !== null) rows.push(["Size", bytes(server.size_bytes)]);
  rows.push(["Last read", h("span", { title: stamp(server.checked_epoch) }, age(server.checked_epoch))]);
  const parts = [messages_list(server.messages), facts(rows, "rows")];
  if (server.metrics.length > 0) {
    parts.push(data_table<{ name: string; value: number }>([
      { label: "Metric", cell: (sample) => h("code", { class: "small" }, sample.name) },
      { label: "Value", cell: (sample) => (/_bytes(\{|$)/.test(sample.name) ? bytes(sample.value) : sample.value.toLocaleString()) },
    ], server.metrics, "Cache server metrics"));
  }
  return parts;
}

function details(cache: Cache): HTMLElement {
  const code = (text: string) => h("code", {}, text);
  const rows: Parameters<typeof facts>[0] = [
    ["Builds on", cache.host ?? "this server"],
    ["Flake", code(cache.flake)],
    ["Cache", code(cache.cache_url)],
    ["Checked every", `${Math.round(cache.interval / 60)} minutes`],
    ["Last checked", cache.reading ? h("span", { title: stamp(cache.reading.checked_epoch) }, age(cache.reading.checked_epoch)) : "—"],
  ];
  for (const target of cache.targets) {
    const where = target.build_link === null ? "not rooted" : `rooted at ${target.build_link}${target.kept_only_in_cache ? ", dropped once pushed" : ""}`;
    rows.push([target.name, h("span", {}, code(target.installable), h("span", { class: "muted small" }, ` ${where}`))]);
  }
  return facts(rows, "rows");
}

const build_all_words: Record<string, [text: string, tone: string]> = {
  ok: ["Built", "good"], failed: ["Build failed", "bad"], push_failed: ["Push failed", "bad"], eval_failed: ["Evaluation failed", "bad"], not_reported: ["Not reported", "warn"],
};

// How the last Build all ended for each target.
function build_all_section(outcome: BuildAllOutcome): HTMLElement {
  return section(h("span", {}, "Last build all ", h("a", { class: "small", href: link(["jobs", String(outcome.job_id)]) }, `job #${outcome.job_id}`)), data_table<BuildAllOutcome["results"][number]>([
    { label: "Target", cell: (result) => h("strong", {}, result.name) },
    { label: "Result", cell: (result) => {
      const [text, tone] = build_all_words[result.result] ?? [result.result, "none"];
      return h("span", { class: `badge tone-${tone}` }, text);
    } },
    { label: "Took", cell: (result) => (result.seconds === null ? "—" : duration(result.seconds)) },
  ], outcome.results, "Last build all"));
}

// How many targets pass, out of all of them.
function count(cache: Cache, good: (row: TargetRow) => boolean): string {
  const rows = cache.reading?.rows ?? [];
  return rows.length === 0 ? "—" : `${rows.filter(good).length} / ${rows.length}`;
}
