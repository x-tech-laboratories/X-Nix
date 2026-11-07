// The badges every view shares, and X-Nix's own way of saying until.

import { Badge, type Tone } from "@x-tech-laboratories/x-libs/web/react/badges";
import type { EventLevel, FleetHostState, FleetRunState, JobState, Status } from "./api.ts";

// ── Badges ───────────────────────────────────────────────────────────────────

const status_labels: Record<Status, [text: string, tone: Tone]> = {
  online: ["OK", "good"], info: ["OK", "good"], warning: ["Warning", "warn"], unavailable: ["Unreachable", "warn"], failed: ["Failed", "bad"],
};

export function StatusBadge({ status }: { status: Status | null }) {
  if (status === null) return <Badge>Not read yet</Badge>;
  const [text, tone] = status_labels[status];
  return <Badge tone={tone}>{text}</Badge>;
}

const job_tones: Record<JobState, Tone> = { running: "info", succeeded: "good", failed: "bad" };

export function JobBadge({ state }: { state: JobState }) {
  return <Badge tone={job_tones[state]}>{state}</Badge>;
}

const level_tones: Record<EventLevel, Tone> = { info: "none", warning: "warn", error: "bad" };

export function LevelBadge({ level }: { level: EventLevel }) {
  return <Badge tone={level_tones[level]}>{level}</Badge>;
}

const fleet_host_tones: Record<FleetHostState, Tone> = { queued: "none", running: "info", verifying: "info", succeeded: "good", failed: "bad", skipped: "none" };

export function FleetHostBadge({ state }: { state: FleetHostState }) {
  return <Badge tone={fleet_host_tones[state]}>{state}</Badge>;
}

const fleet_run_tones: Record<FleetRunState, Tone> = { running: "info", succeeded: "good", failed: "bad", stopped: "warn" };

export function FleetRunBadge({ state }: { state: FleetRunState }) {
  return <Badge tone={fleet_run_tones[state]}>{state}</Badge>;
}

// ── Times ────────────────────────────────────────────────────────────────────

// How long until a time to come, such as "in 3d", or "now" once it is less than 90 seconds off or has passed.
export function until(epoch: number): string {
  const seconds = Math.max(0, epoch - Date.now() / 1000);
  if (seconds < 90) return "now";
  if (seconds < 5400) return `in ${Math.round(seconds / 60)}m`;
  if (seconds < 129600) return `in ${Math.round(seconds / 3600)}h`;
  return `in ${Math.round(seconds / 86400)}d`;
}
