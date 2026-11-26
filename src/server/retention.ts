// Prunes the history older than the retention: finished jobs, builds, events and fleet runs, keeping the newest of each
// owner's kind whatever their age, every running job, and every job something still names by id, such as a waiting
// switch, a cache's last Build all, a kept fleet run or a build.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { PruneCounts, PruneLimits, Store } from "./store.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

// How often the history is pruned, and how long after the start the first pass runs.
const prune_interval_in_milliseconds = 6 * 3600 * 1000;
const first_prune_delay_in_milliseconds = 60 * 1000;

// What each owner keeps whatever its age: the newest jobs of each kind and builds of each target, and the newest events.
export const kept_per_kind = 20;
export const kept_events_per_owner = 100;
export const kept_fleet_runs = 20;

// Installs and media point at keys and store paths outside the database, and are few, so they are never pruned.
const lasting_kinds = ["install", "media"] as const;

// ── Pruning ──────────────────────────────────────────────────────────────────

// Prunes everything older than the retention in one transaction, answering how much went.
export function prune_history(store: Store, retention_in_seconds: number, now: number): PruneCounts {
  const limits: PruneLimits = {
    before_epoch: now - retention_in_seconds, kept_per_kind, kept_events_per_owner, kept_fleet_runs, lasting_kinds: [...lasting_kinds],
  };
  return store.transaction(() => {
    const fleet_runs = store.prune_fleet_runs(limits);
    const builds = store.prune_builds(limits);
    const kept_ids = new Set<number>();
    for (const document of store.referencing_documents()) collect_job_ids(document, kept_ids);
    const jobs = store.prune_jobs(limits, kept_ids);
    const events = store.prune_events(limits);
    return { jobs, builds, events, fleet_runs };
  });
}

// Prunes now and then on a timer, with null for a retention that keeps everything; answers a function that stops it.
export function keep_pruning(store: Store, retention_in_seconds: number | null, log: (message: string) => void, now = () => Math.floor(Date.now() / 1000)): () => void {
  if (retention_in_seconds === null) return () => {};
  const pass = () => {
    try {
      const counts = prune_history(store, retention_in_seconds, now());
      const total = counts.jobs + counts.builds + counts.events + counts.fleet_runs;
      if (total > 0) log(`Pruned ${counts.jobs} jobs, ${counts.builds} builds, ${counts.events} events and ${counts.fleet_runs} fleet runs past the retention`);
    } catch (error) {
      log(`Could not prune the history: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const first = setTimeout(pass, first_prune_delay_in_milliseconds);
  const timer = setInterval(pass, prune_interval_in_milliseconds);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Adds every job id a stored document names: any number under a key naming a job, such as job_id, step_job_id,
// held_build or stopped_jobs, however deeply it sits.
export function collect_job_ids(document: unknown, ids: Set<number>, names_job = false): void {
  if (typeof document === "number") {
    if (names_job && Number.isInteger(document)) ids.add(document);
    return;
  }
  if (Array.isArray(document)) {
    for (const item of document) collect_job_ids(item, ids, names_job);
    return;
  }
  if (typeof document !== "object" || document === null) return;
  for (const [key, value] of Object.entries(document)) collect_job_ids(value, ids, /job/.test(key) || key === "held_build");
}
