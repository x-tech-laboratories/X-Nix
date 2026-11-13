// Jobs that run well past the time they should take, judged by how long the owner's recent jobs of the kind took: the
// warning the owner shows while one runs, and a watch that notes each in the owner's history and sends a notification.

// ── Imports ──────────────────────────────────────────────────────────────────

import { format_duration } from "@x-tech-laboratories/x-libs/durations";

import { stall_mark } from "../shared/operations.ts";
import type { Notifier } from "./notifications.ts";
import type { Job, Store } from "./store.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

// A job may take three times the longest of its recent kind, and never less than half an hour.
const allowance_factor = 3;
const shortest_allowance_in_seconds = 1800;
// A job with nothing of its kind to go by gets an hour.
const first_allowance_in_seconds = 3600;

const look_interval_in_milliseconds = 60_000;

// ── Judging ──────────────────────────────────────────────────────────────────

export function allowance(store: Store, job: Job): number {
  const longest = store.longest_success(job.deployment_id, job.kind);
  return longest === null ? first_allowance_in_seconds : Math.max(shortest_allowance_in_seconds, allowance_factor * longest);
}

// Why a running job is overdue, with what its run last said it waits for, or null while it is within its time.
export function overdue_text(store: Store, job: Job, now: number): string | null {
  const ran = now - job.started_epoch;
  const allowed = allowance(store, job);
  if (ran <= allowed) return null;
  const note = stall_note(store.job(job.id)?.output ?? "");
  return `The ${job.kind} job ${job.id} has run for ${format_duration(ran)}, well past the ${format_duration(allowed)} it should take${note === null ? "" : `: ${note}`}`;
}

// The run's last word on what it waits for, or else the last thing it said about its stall.
export function stall_note(output: string): string | null {
  const notes = output.split("\n").filter((line) => line.startsWith(`${stall_mark} `)).map((line) => line.slice(stall_mark.length + 1).trim());
  return notes.findLast((note) => note.includes(" waits for ")) ?? notes.at(-1) ?? null;
}

// ── Watching ─────────────────────────────────────────────────────────────────

export class OverdueJobs {
  private readonly store: Store;
  private readonly notifier: Notifier;
  private readonly now: () => number;
  private readonly noted = new Set<number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(store: Store, notifier: Notifier, now: () => number = () => Math.floor(Date.now() / 1000)) {
    this.store = store;
    this.notifier = notifier;
    this.now = now;
  }

  // Notes each overdue job once: a warning in its owner's history and a notification.
  async check(): Promise<void> {
    for (const job of this.store.all_running_jobs()) {
      if (this.noted.has(job.id)) continue;
      const text = overdue_text(this.store, job, this.now());
      if (text === null) continue;
      this.noted.add(job.id);
      this.store.add_event(job.deployment_id, this.now(), "warning", text);
      await this.notifier.send({ title: `X-Nix: a job on ${job.deployment_id} is overdue`, body: text, level: "warning" });
    }
  }

  start(): void {
    this.timer ??= setInterval(() => void this.check(), look_interval_in_milliseconds);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}
