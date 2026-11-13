// The Jobs pages: every update, build, switch, reboot, collection, cache build and push, and one job with its whole output.
// The Builds tab beside the list is builds.tsx.

import { Badge, StateBadge, type Tone } from "@x-tech-laboratories/x-libs/web/react/badges";
import { FollowingOutput } from "@x-tech-laboratories/x-libs/web/react/following";
import { Crumbs, Facts, PageHeading, Section, Stack, Tabs, Tile, Tiles } from "@x-tech-laboratories/x-libs/web/react/layout";
import { ProgressBar } from "@x-tech-laboratories/x-libs/web/react/progress";
import { Empty, Loaded, use_resource } from "@x-tech-laboratories/x-libs/web/react/states";
import { DataTable } from "@x-tech-laboratories/x-libs/web/react/table";
import { duration } from "@x-tech-laboratories/x-libs/web/format";
import { link } from "@x-tech-laboratories/x-libs/web/router";
import { useEffect, useMemo, useState } from "react";
import { plan_tree, type PlannedPath, type PlannedState, type PlanRow } from "../../shared/build_plan.ts";
import { api, type BuildProgress, type Job, type JobWithOutput } from "../api.ts";
import { Age } from "@x-tech-laboratories/x-libs/web/react/time";
import { JobBadge } from "../ui.tsx";
import { job_owner_link, JobsTable, live } from "./shared.tsx";

// The tabs over the job history: every job, or the finished builds with what they made.
export function JobsTabs({ active }: { active: "jobs" | "builds" }) {
  return <Tabs label="Jobs" active={active} items={[{ id: "jobs", label: "All jobs", href: link(["jobs"]) }, { id: "builds", label: "Builds", href: link(["builds"]) }]} />;
}

// ── List ─────────────────────────────────────────────────────────────────────

export function JobsView({ show_evaluations }: { show_evaluations: boolean }) {
  const jobs = use_resource(() => api<Job[]>(`/api/jobs?limit=200${show_evaluations ? "&evaluations=1" : ""}`), [show_evaluations], live);
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
  const job = use_resource(() => api<JobWithOutput>(`/api/jobs/${id}`), [id], finished ? {} : live);
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
              {found.live && <LiveProgress progress={JSON.parse(found.live) as BuildProgress} running={found.state === "running"} />}
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

// What a build has built and downloaded, and, when nix listed its plan, every derivation in it as a tree.
function LiveProgress({ progress, running }: { progress: BuildProgress; running: boolean }) {
  const planned = progress.planned ?? {};
  return <>
    <Section title="Progress"><ProgressView progress={progress} running={running} /></Section>
    {Object.keys(planned).length > 0 && <Section title="Derivations"><PlanTable planned={planned} running={running} /></Section>}
  </>;
}

// What a build has built and downloaded, and what it is building and downloading now.
function ProgressView({ progress, running }: { progress: BuildProgress; running: boolean }) {
  const activities = Object.values(progress.activities);
  const building = activities.filter((activity) => activity.type === build_activity_type);
  const downloading = activities.filter((activity) => activity.type !== build_activity_type);
  const of = (expected: number | null) => (expected === null ? "" : ` of ${expected}`);
  const built = Math.max(0, progress.builds_done - progress.builds_failed);
  return (
    <Stack tight>
      {running && <ProgressBar label="Built" value={progress.builds_expected === null ? null : built} max={progress.builds_expected ?? undefined} detail={`${built}${of(progress.builds_expected)} built`} />}
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

// ── Derivations ──────────────────────────────────────────────────────────────

const planned_labels: Record<PlannedState, [text: string, tone: Tone]> = {
  waiting: ["waiting", "none"], building: ["building", "info"], built: ["built", "good"], failed: ["failed", "bad"],
  "dependency-failed": ["dependency failed", "warn"], fetching: ["fetching", "info"], fetched: ["fetched", "good"], stopped: ["stopped", "warn"],
};

// Past this many planned paths, the tree opens only its top rows at first.
const opened_plan_size = 200;

// Every derivation the build plans to build, each under one that needs it, with the paths it fetches, and how each went.
function PlanTable({ planned, running }: { planned: Record<string, PlannedPath>; running: boolean }) {
  const rows = useMemo(() => plan_tree(planned), [planned]);
  const [expanded, set_expanded] = useState<string[] | true>(() => (Object.keys(planned).length > opened_plan_size ? [] : true));
  const now = Date.now() / 1000;
  return (
    <DataTable<PlanRow> caption="Derivations" rows={rows} row_key={(row) => row.path} get_children={(row) => row.children}
      expanded={expanded} on_expanded_change={set_expanded} fill_last_column columns={[
        { label: "Derivation", cell: (row) => (row.planned === null ? <strong>{row.name}</strong> : <code className="small path" title={row.path}>{row.name}</code>) },
        { label: "Status", cell: (row) => <PlanStatus row={row} running={running} /> },
        { label: "Took", cell: (row) => {
          const started = row.planned?.started_epoch ?? null;
          if (started === null) return "";
          const finished = row.planned!.finished_epoch ?? (running ? now : null);
          return finished === null ? "" : duration(Math.max(0, Math.round(finished - started)));
        } },
        { label: "Needed by", cell: (row) => (row.needed_by > 1 ? <span className="muted small" title="Shown once, under the first that needs it">{row.needed_by} derivations</span> : "") },
      ]} />
  );
}

function PlanStatus({ row, running }: { row: PlanRow; running: boolean }) {
  if (row.planned === null) {
    const done = row.children.filter((child) => child.planned?.state === "fetched").length;
    return <span className="muted small">{done} of {row.children.length} fetched</span>;
  }
  const { state, phase, kind } = row.planned;
  // A path still waiting once the build has ended was never reached.
  if (state === "waiting" && !running) return <Badge>{kind === "build" ? "not built" : "not fetched"}</Badge>;
  return <><StateBadge labels={planned_labels} state={state} />{phase &&<span className="muted small"> {phase}</span>}</>;
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
