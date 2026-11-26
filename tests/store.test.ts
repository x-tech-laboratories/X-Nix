import { describe, expect, it } from "vitest";

import { switch_verdict } from "../src/server/nixos/switch.ts";
import { collect_job_ids, kept_events_per_owner, kept_fleet_runs, kept_per_kind, prune_history } from "../src/server/retention.ts";
import { cut_output, kept_output_head_length, kept_output_tail_length, max_job_output_length, output_cut_line, Store, type JobKind } from "../src/server/store.ts";
import { switch_mark } from "../src/shared/operations.ts";

const day = 86400;
const now = 1_800_000_000;

// A finished job of an owner, started and finished at the given time.
function finished_job(store: Store, owner: string, kind: JobKind, epoch: number, state: "succeeded" | "failed" | "running" = "succeeded"): number {
  const id = store.create_job({ deployment_id: owner, kind, command: "{}", agent: null, run_id: null, trigger: "manual", started_epoch: epoch });
  if (state !== "running") store.finish_job(id, state, 0, null, epoch);
  return id;
}

// ── Output ───────────────────────────────────────────────────────────────────

describe("a job's output", () => {
  it("keeps its beginning and end once it passes the limit, cut at whole lines, with the run's offset left alone", () => {
    const store = new Store(":memory:");
    const id = finished_job(store, "web", "switch", now, "running");
    const line = `${"x".repeat(99)}\n`;
    store.append_output(id, `first line\n${line.repeat(kept_output_head_length / 100 + 10)}`, 10);
    for (let round = 0; round < 3; round++) store.append_output(id, line.repeat(max_job_output_length / 100 / 2), 20 + round);
    store.append_output(id, `${switch_mark} activated\n${switch_mark} outcome rolled-back Health checks failed\n`, 99);

    const job = store.job(id)!;
    expect(job.output.length).toBeLessThanOrEqual(max_job_output_length);
    expect(job.output.startsWith("first line\n")).toBe(true);
    expect(job.output.split(output_cut_line)).toHaveLength(2);
    expect(job.output.split("\n").every((text) => text === "" || text === output_cut_line.trim() || text.length === 99 || text.startsWith(switch_mark) || text === "first line")).toBe(true);
    expect(job.output_offset).toBe(99);
    expect(switch_verdict(job.output, null).outcome).toEqual({ kind: "rolled-back", reason: "Health checks failed" });
  });

  it("is cut to the head and the tail even when it has no line breaks at all", () => {
    const cut = cut_output("a".repeat(kept_output_head_length + kept_output_tail_length + 100));
    expect(cut).toBe(`${"a".repeat(kept_output_head_length)}\n${output_cut_line}${"a".repeat(kept_output_tail_length)}`);
    expect(cut_output(`${cut}${"b".repeat(100)}`).split(output_cut_line)[0]).toBe(`${"a".repeat(kept_output_head_length)}\n`);
  });
});

// ── Pruning ──────────────────────────────────────────────────────────────────

describe("pruning the history", () => {
  const retention = 180 * day;
  const old = now - 200 * day;

  it("deletes finished jobs past the retention beyond each owner's newest of a kind, keeping running and recent ones", () => {
    const store = new Store(":memory:");
    const old_evaluations = Array.from({ length: kept_per_kind + 5 }, () => finished_job(store, "web", "eval", old));
    const running = finished_job(store, "web", "switch", old, "running");
    const old_build = finished_job(store, "web", "build", old);
    const recent = finished_job(store, "web", "eval", now - day);
    const install = finished_job(store, "new-host", "install", old);

    const counts = prune_history(store, retention, now);

    // The newest evaluations are kept whatever their age, as the recent one is one of them.
    expect(counts.jobs).toBe(6);
    expect(store.job(old_evaluations[0])).toBeNull();
    expect(store.job(old_evaluations.at(-1)!)).not.toBeNull();
    for (const kept of [running, old_build, recent, install]) expect(store.job(kept)).not.toBeNull();
  });

  it("keeps every job a state, a reading, a fleet run, a build or an agent key names", () => {
    const store = new Store(":memory:");
    const ids = Array.from({ length: kept_per_kind + 8 }, () => finished_job(store, "web", "switch", old));
    store.save_evaluation("web", { switch_wait: { job_id: ids[0], step_job_id: ids[1] }, held_build: ids[2], last_diff: { job_id: ids[3] } });
    store.save_cache_reading("cache", { build_all: { job_id: ids[4] } });
    const fleet_run = store.create_fleet_run("running", { hosts: [{ job_id: ids[5] }], stopped_jobs: [ids[6]] });
    store.add_build({ job_id: ids[7], owner_id: "web", target: "web", agent: null, store_path: null, succeeded: true, started_epoch: now - day, finished_epoch: now - day, products: [] });

    prune_history(store, retention, now);

    for (const kept of ids.slice(0, 8)) expect(store.job(kept)).not.toBeNull();
    expect(store.fleet_run(fleet_run)).not.toBeNull();
    expect(store.jobs({ deployment_id: "web", limit: 1000 })).toHaveLength(8 + kept_per_kind);
  });

  it("deletes old events, builds and finished fleet runs beyond the newest kept", () => {
    const store = new Store(":memory:");
    for (let index = 0; index < kept_events_per_owner + 3; index++) store.add_event("web", old, "info", `event ${index}`);
    store.add_event("db", old, "info", "the only one");
    const runs = Array.from({ length: kept_fleet_runs + 2 }, () => store.create_fleet_run("succeeded", { finished_epoch: old }));
    const running_run = store.create_fleet_run("running", { finished_epoch: null });
    const job = finished_job(store, "web", "build", old);
    for (let index = 0; index < kept_per_kind + 4; index++) {
      store.add_build({ job_id: job, owner_id: "web", target: "web", agent: null, store_path: null, succeeded: true, started_epoch: old, finished_epoch: old, products: [] });
    }

    const counts = prune_history(store, retention, now);

    expect(counts).toEqual({ jobs: 0, builds: 4, events: 3, fleet_runs: 3 });
    expect(store.events("db")).toHaveLength(1);
    expect(store.events("web", 1000)).toHaveLength(kept_events_per_owner);
    expect(store.fleet_run(runs[0])).toBeNull();
    expect(store.fleet_run(running_run)).not.toBeNull();
    expect(store.builds({ limit: 1000 })).toHaveLength(kept_per_kind);
  });

  it("finds job ids under any key naming a job, however deep", () => {
    const ids = new Set<number>();
    collect_job_ids({ a: { job_id: 1, step_job_id: 2, held_build: 3, epoch: 4 }, hosts: [{ job_id: 5 }], stopped_jobs: [6, 7], note: "job" }, ids);
    expect([...ids].sort()).toEqual([1, 2, 3, 5, 6, 7]);
  });
});
