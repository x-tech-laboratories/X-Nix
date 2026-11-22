// The badges every view shares.

import { Badge, ToneBadge, type Tone } from "@x-tech-laboratories/x-libs/web/react/badges";
import type { FleetHostState, FleetRunState, Status } from "./api.ts";

// ── Badges ───────────────────────────────────────────────────────────────────

const status_labels: Record<Status, [text: string, tone: Tone]> = {
  online: ["OK", "good"], info: ["OK", "good"], warning: ["Warning", "warn"], unavailable: ["Unreachable", "warn"], failed: ["Failed", "bad"],
};

export function StatusBadge({ status }: { status: Status | null }) {
  if (status === null) return <Badge>Not read yet</Badge>;
  const [text, tone] = status_labels[status];
  return <Badge tone={tone}>{text}</Badge>;
}

const fleet_host_tones: Record<FleetHostState, Tone> = { queued: "none", running: "info", verifying: "info", succeeded: "good", failed: "bad", skipped: "none" };

export function FleetHostBadge({ state }: { state: FleetHostState }) {
  return <ToneBadge tones={fleet_host_tones} state={state} />;
}

const fleet_run_tones: Record<FleetRunState, Tone> = { running: "info", succeeded: "good", failed: "bad", stopped: "warn" };

export function FleetRunBadge({ state }: { state: FleetRunState }) {
  return <ToneBadge tones={fleet_run_tones} state={state} />;
}

