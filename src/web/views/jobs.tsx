// The Jobs pages: every update, build, switch, reboot, collection, cache build and push, and one job with its whole output.
// The Builds tab beside the list is builds.tsx.

import { Badge } from "@x-tech-laboratories/x-libs/web/react/badges";
import { FollowingOutput } from "@x-tech-laboratories/x-libs/web/react/following";
import { Crumbs, Facts, PageHeading, Section, Stack, Tabs, Tile, Tiles } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Empty, Loaded, use_resource } from "@x-tech-laboratories/x-libs/web/react/states";
import { link } from "@x-tech-laboratories/x-libs/web/router";
import { useEffect, useState } from "react";
import { api, type BuildProgress, type Job, type JobWithOutput } from "../api.ts";
import { Age } from "@x-tech-laboratories/x-libs/web/react/time";
import { JobBadge } from "../ui.tsx";
import { job_owner_link, JobsTable, refresh_interval_in_milliseconds } from "./shared.tsx";

// The tabs over the job history: every job, or the finished builds with what they made.
export function JobsTabs({ active }: { active: "jobs" | "builds" }) {
  return <Tabs label="Jobs" active={active} items={[{ id: "jobs", label: "All jobs", href: link(["jobs"]) }, { id: "builds", label: "Builds", href: link(["builds"]) }]} />;
}

// ── List ─────────────────────────────────────────────────────────────────────

export function JobsView({ show_evaluations }: { show_evaluations: boolean }) {
  const jobs = use_resource(() => api<Job[]>(`/api/jobs?limit=200${show_evaluations ? "&evaluations=1" : ""}`), [show_evaluations], { refresh_in_milliseconds: refresh_interval_in_milliseconds });
  return (
    <div className="page">
      <PageHeading title="Jobs" subtitle={<>
        Every update, build, switch, reboot, collection, cache build and push, install and media build, newest first.{" "}
        <a href={link(["jobs"], { evaluations: show_evaluations ? null : "1" })}>{show_evaluations ? "Hide evaluations and checks" : "Show evaluations and checks"}</a>
      </>} />
      <JobsTabs active="jobs" />
      <Section title="History">
        <Stack>
          <Loaded resource={jobs}>
            {(found) => (found.length === 0
              ? <Empty title="No jobs yet." hint="Updates, builds, switches, reboots, collections, cache builds and pushes show here with their output." />
              : <JobsTable jobs={found} show_deployment />)}
          </Loaded>
        </Stack>
      </Section>
    </div>
  );
}

// ── One job ──────────────────────────────────────────────────────────────────

export function JobView({ id }: { id: number }) {
  // A finished job's output no longer changes, so its page stops fetching it again.
  const [finished, set_finished] = useState(false);
  const job = use_resource(() => api<JobWithOutput>(`/api/jobs/${id}`), [id], { refresh_in_milliseconds: finished ? undefined : refresh_interval_in_milliseconds });
  const state = job.data?.state;
  useEffect(() => {
    if (state !== undefined) set_finished(state !== "running");
  }, [state]);

  return (
    <div className="page">
      <Crumbs items={[["Jobs", link(["jobs"])], [`Job ${id}`, null]]} />
      <PageHeading title={`Job ${id}`} />
      <Stack>
        <Loaded resource={job}>
          {(found) => {
            const operation = operation_text(found.command);
            return <>
              <Facts rows={[
                ["For", <a href={job_owner_link(found)}>{found.deployment_id}</a>],
                ["State", <JobBadge state={found.state} />],
                ["Started", <Age epoch={found.started_epoch} />],
                ["Finished", <Age epoch={found.finished_epoch} />],
                ["Exit code", found.exit_code ?? "—"],
                ["Started by", found.trigger],
                ["Runs on", found.agent ?? "this server"],
              ]} />
              {found.error && <p className="tone-bad">{found.error}</p>}
              {found.live && <Section title="Progress"><ProgressView progress={JSON.parse(found.live) as BuildProgress} running={found.state === "running"} /></Section>}
              <Section title={operation === null ? "Command" : "Operation"}><pre className="output">{operation ?? found.command}</pre></Section>
              <Section title="Output">
                {found.output ? <FollowingOutput text={found.output} active={found.state === "running"} toggle={found.state === "running"} class_name="run-output" /> : <Empty title={found.state === "running" ? "Nothing printed yet." : "It printed nothing."} />}
              </Section>
            </>;
          }}
        </Loaded>
      </Stack>
    </div>
  );
}

// ── Build progress ───────────────────────────────────────────────────────────

// Nix's activity type for building one derivation.
const build_activity_type = 105;

// What a build has built and downloaded, and what it is building and downloading now.
function ProgressView({ progress, running }: { progress: BuildProgress; running: boolean }) {
  const activities = Object.values(progress.activities);
  const building = activities.filter((activity) => activity.type === build_activity_type);
  const downloading = activities.filter((activity) => activity.type !== build_activity_type);
  const of = (expected: number | null) => (expected === null ? "" : ` of ${expected}`);
  const built = Math.max(0, progress.builds_done - progress.builds_failed);
  return (
    <Stack tight>
      <Tiles>
        <Tile label="Built" value={`${built}${of(progress.builds_expected)}`} />
        <Tile label="Building" value={String(building.length)} />
        <Tile label="Failed" value={String(progress.builds_failed)} class_name={progress.builds_failed > 0 ? "tile-bad" : null} />
        <Tile label="Downloaded" value={`${progress.downloads_done}${of(progress.downloads_expected)}`} />
        <Tile label="Downloading" value={String(downloading.length)} />
      </Tiles>
      {running && activities.length > 0 && (
        <ul className="activities">
          {building.map((activity, index) => (
            <li key={`build-${index}`}><Badge tone="info">building</Badge><code>{activity.name}</code>{activity.phase && <span className="muted small">{activity.phase}</span>}</li>
          ))}
          {downloading.map((activity, index) => <li key={`download-${index}`}><Badge>downloading</Badge><code>{activity.name}</code></li>)}
        </ul>
      )}
    </Stack>
  );
}

// A job's operation laid out to read, or null for a job from before operations, whose command is a line of its own.
function operation_text(command: string): string | null {
  try {
    const value: unknown = JSON.parse(command);
    return typeof value === "object" && value !== null ? JSON.stringify(value, null, 2) : null;
  } catch {
    return null;
  }
}
