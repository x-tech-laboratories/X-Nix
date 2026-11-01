// The Jobs pages: every update, build, switch, reboot, collection, cache build and push, and one job with its whole output.

import { api, type BuildProgress, type Job, type JobWithOutput } from "../api.ts";
import { age, h, stamp } from "../dom.ts";
import { current_route, link } from "../router.ts";
import { crumbs, empty, facts, job_badge, load, section } from "../ui.ts";
import { job_owner_link, jobs_table, refresh_interval_in_milliseconds, tile, type View } from "./shared.ts";

// ── List ─────────────────────────────────────────────────────────────────────

export function jobs_view(): View {
  const show_evaluations = current_route().query.get("evaluations") === "1";
  const list = h("div");
  const refresh = (quiet: boolean) => load(list, async () => {
    const jobs = await api<Job[]>(`/api/jobs?limit=200${show_evaluations ? "&evaluations=1" : ""}`);
    return jobs.length === 0 ? empty("No jobs yet.", "Updates, builds, switches, reboots, collections, cache builds and pushes show here with their output.") : jobs_table(jobs, true);
  }, { quiet });
  void refresh(false);
  const timer = setInterval(() => void refresh(true), refresh_interval_in_milliseconds);

  return {
    title: "Jobs",
    root: h("div", { class: "page" },
      h("h1", {}, "Jobs"),
      h("p", { class: "muted" }, "Every update, build, switch, reboot, collection, cache build and push, install and media build, newest first. ",
        h("a", { href: link(["jobs"], { evaluations: show_evaluations ? null : "1" }) }, show_evaluations ? "Hide evaluations and checks" : "Show evaluations and checks")),
      section("History", list),
    ),
    dispose: () => clearInterval(timer),
  };
}

// ── One job ──────────────────────────────────────────────────────────────────

export function job_view(id: number): View {
  const body = h("div", { class: "stack" });
  let timer: number | undefined;

  const refresh = (quiet: boolean) => load(body, async () => {
    const job = await api<JobWithOutput>(`/api/jobs/${id}`);
    // A finished job's output no longer changes.
    if (job.state !== "running") clearInterval(timer);
    return [
      facts([
        ["For", h("a", { href: job_owner_link(job) }, job.deployment_id)],
        ["State", job_badge(job.state)],
        ["Started", h("span", { title: stamp(job.started_epoch) }, age(job.started_epoch))],
        ["Finished", job.finished_epoch ? h("span", { title: stamp(job.finished_epoch) }, age(job.finished_epoch)) : "—"],
        ["Exit code", job.exit_code ?? "—"],
        ["Started by", job.trigger],
        ["Runs on", job.agent ?? "this server"],
      ]),
      job.error && h("p", { class: "tone-bad" }, job.error),
      job.live && section("Progress", progress_view(JSON.parse(job.live) as BuildProgress, job.state === "running")),
      section("Command", h("pre", { class: "output" }, job.command)),
      section("Output", job.output ? h("pre", { class: "output run-output" }, job.output) : empty(job.state === "running" ? "Nothing printed yet." : "It printed nothing.")),
    ];
  }, { quiet });
  void refresh(false);
  timer = window.setInterval(() => void refresh(true), refresh_interval_in_milliseconds);

  return {
    title: `Job ${id}`,
    root: h("div", { class: "page" },
      crumbs([["Jobs", link(["jobs"])], [`Job ${id}`, null]]),
      h("h1", {}, `Job ${id}`),
      body,
    ),
    dispose: () => clearInterval(timer),
  };
}

// ── Build progress ───────────────────────────────────────────────────────────

// Nix's activity type for building one derivation.
const build_activity_type = 105;

// What a build has built and downloaded, and what it is building and downloading now.
function progress_view(progress: BuildProgress, running: boolean): HTMLElement {
  const activities = Object.values(progress.activities);
  const building = activities.filter((activity) => activity.type === build_activity_type);
  const downloading = activities.filter((activity) => activity.type !== build_activity_type);
  const of = (expected: number | null) => (expected === null ? "" : ` of ${expected}`);
  const built = Math.max(0, progress.builds_done - progress.builds_failed);
  return h("div", {},
    h("div", { class: "tiles" },
      tile("Built", `${built}${of(progress.builds_expected)}`),
      tile("Building", String(building.length)),
      tile("Failed", String(progress.builds_failed), progress.builds_failed > 0 ? "tile-bad" : null),
      tile("Downloaded", `${progress.downloads_done}${of(progress.downloads_expected)}`),
      tile("Downloading", String(downloading.length))),
    running && activities.length > 0 && h("ul", { class: "activities" },
      ...building.map((activity) => h("li", {}, h("span", { class: "badge tone-info" }, "building"), h("code", {}, activity.name), activity.phase && h("span", { class: "muted small" }, activity.phase))),
      ...downloading.map((activity) => h("li", {}, h("span", { class: "badge tone-none" }, "downloading"), h("code", {}, activity.name)))),
  );
}
