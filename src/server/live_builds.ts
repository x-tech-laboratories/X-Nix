// The live progress of any job whose nix prints its structured log, a deployment's Build or switch or a cache's Build
// and Build all: the log is read into the job's counts and tree as it comes, the tree learns from the building host
// which planned paths each derivation needs, and the job's progress names what is building.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { AgentPool } from "./agents/agent.ts";
import { empty_progress, needs_operation, read_build_log, read_needs, summarise, type BuildProgress } from "./nixos/build_log.ts";
import type { Translate } from "./runs.ts";
import type { Job, JobKind, Store } from "./store.ts";
import { read_facts } from "../shared/facts.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

const needs_timeout_in_seconds = 60;

// The jobs that only build, whose progress is always the build's; any other job's is only while something builds.
const build_kinds: JobKind[] = ["build", "build-target", "build-all"];

// ── Following ────────────────────────────────────────────────────────────────

export function prints_build_log(job: Job): boolean {
  return job.command.includes("internal-json");
}

// Reads a job's structured log into its live progress and readable lines; null for a job that prints none.
export function build_translation(store: Store, job: Job, now: () => number): Translate | null {
  if (!prints_build_log(job)) return null;
  return (current, chunk, ended) => {
    const progress = live_progress(store, current.id);
    const text = read_build_log(progress, chunk, ended, now());
    store.set_live(current.id, progress);
    return text;
  };
}

// After a poll: reads which planned paths each newly planned derivation needs, then names what is building as the
// job's progress, answering whether it did.
export async function tend_build(store: Store, agents: AgentPool, job: Job): Promise<boolean> {
  if (!prints_build_log(job)) return false;
  await read_build_needs(store, agents, job);
  const progress = live_progress(store, job.id);
  const building = Object.keys(progress.activities).length > 0;
  if (!build_kinds.includes(job.kind) && !building) return false;
  store.set_progress(job.id, summarise(progress));
  return true;
}

// Reads which planned paths each newly planned derivation needs from the host building it, for the job's tree.
async function read_build_needs(store: Store, agents: AgentPool, job: Job): Promise<void> {
  const asked = needs_operation(live_progress(store, job.id));
  if (asked === null) return;
  const result = await agents.get(job.agent).run(asked, { timeout_in_seconds: needs_timeout_in_seconds });
  // The build went on while the host answered, so its latest progress takes the answer.
  const progress = live_progress(store, job.id);
  read_needs(progress, asked, result.exit_code === 0 ? read_facts<Record<string, string[]>>(result.stdout) : null);
  store.set_live(job.id, progress);
}

function live_progress(store: Store, job_id: number): BuildProgress {
  const live = store.job(job_id)?.live ?? null;
  return live === null ? empty_progress() : { ...empty_progress(), ...(JSON.parse(live) as BuildProgress) };
}
