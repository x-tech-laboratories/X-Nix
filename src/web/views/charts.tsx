// The charts several pages share: jobs per day by outcome, a timeline of each owner's jobs, and the samples kept over time.

import { Donut, StackedBarChart, Timeline, type Stack, type TimelineRow } from "@x-tech-laboratories/x-libs/web/react/charts";
import { api, type Job, type JobState, type Metric, type Sample } from "../api.ts";
import { duration, job_owner_link } from "./shared.tsx";

export const day_in_seconds = 86400;

export function now_seconds(): number {
  return Math.floor(Date.now() / 1000);
}

// ── Loading ──────────────────────────────────────────────────────────────────

// Every job started in the last few days, newest first.
export function load_recent_jobs(days: number): Promise<Job[]> {
  return api<Job[]>(`/api/jobs?since=${now_seconds() - days * day_in_seconds}&limit=5000`);
}

// The samples of these metrics, everyone's or one owner's, from the last few days.
export function load_samples(metrics: Metric[], days: number, owner: string | null = null): Promise<Sample[]> {
  const search = new URLSearchParams({ metrics: metrics.join(","), since: String(now_seconds() - days * day_in_seconds) });
  if (owner !== null) search.set("owner", owner);
  return api<Sample[]>(`/api/samples?${search}`);
}

// One owner's readings of one metric as chart points.
export function points_of(samples: Sample[], metric: Metric, owner: string | null = null): [epoch: number, value: number][] {
  return samples.filter((sample) => sample.metric === metric && (owner === null || sample.owner_id === owner)).map((sample) => [sample.epoch, sample.value]);
}

// ── Outcomes ─────────────────────────────────────────────────────────────────

export const outcome_parts: [state: JobState, label: string, color: string][] = [
  ["succeeded", "succeeded", "var(--status-success)"],
  ["failed", "failed", "var(--status-danger)"],
  ["running", "running", "var(--accent)"],
];

const outcome_legend = outcome_parts.map(([, label, color]): [string, string] => [label, color]);

function outcome_color(state: JobState): string {
  return outcome_parts.find(([candidate]) => candidate === state)![2];
}

// How the finished jobs ended, with the share that succeeded in the middle.
export function OutcomeDonut({ jobs, title }: { jobs: Job[]; title: string }) {
  const finished = jobs.filter((job) => job.state !== "running");
  const parts = outcome_parts.filter(([state]) => state !== "running").map(([state, label, color]) => ({ label, color, value: finished.filter((job) => job.state === state).length }));
  return (
    <Donut title={title} parts={parts} center={finished.length ? `${Math.round((parts[0].value / finished.length) * 100)}%` : "—"} center_label="succeeded"
      message="No job finished in this period." />
  );
}

// The jobs started each day over the last few days, stacked by outcome.
export function JobsPerDay({ jobs, days }: { jobs: Job[]; days: number }) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const first = today.getTime() / 1000 - (days - 1) * day_in_seconds;
  const stacks: Stack[] = Array.from({ length: days }, (_, index) => {
    const from = first + index * day_in_seconds;
    const inside = jobs.filter((job) => job.started_epoch >= from && job.started_epoch < from + day_in_seconds);
    return {
      label: new Date(from * 1000).toLocaleDateString(undefined, { weekday: "short" }),
      parts: outcome_parts.map(([state, label, color]) => ({ label, color, value: inside.filter((job) => job.state === state).length })),
    };
  });
  return <StackedBarChart title={`Jobs per day, last ${days} days`} stacks={stacks} legend={outcome_legend} format={(value) => String(Math.round(value))} />;
}

// ── Timeline ─────────────────────────────────────────────────────────────────

// One lane per deployment, host, cache or flake, each job a span in its outcome's color.
export function JobTimeline({ jobs, days }: { jobs: Job[]; days: number }) {
  const now = now_seconds();
  const from = now - days * day_in_seconds;
  const by_owner = new Map<string, Job[]>();
  for (const job of jobs) by_owner.set(job.deployment_id, [...(by_owner.get(job.deployment_id) ?? []), job]);
  const rows: TimelineRow[] = [...by_owner].sort(([first], [second]) => first.localeCompare(second)).map(([owner, owned]) => ({
    label: owner,
    href: job_owner_link(owned[0]),
    marks: owned.map((job) => {
      const end = job.finished_epoch ?? now;
      return { start: job.started_epoch, end, color: outcome_color(job.state), title: `${job.kind} #${job.id} ${job.state}, took ${duration(Math.max(0, end - job.started_epoch))}` };
    }),
  }));
  return <Timeline title={`Jobs, last ${days} days`} rows={rows} from={from} to={now} legend={outcome_legend} message="No jobs in this period." />;
}
