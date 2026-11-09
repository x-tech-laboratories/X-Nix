import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Poller, type Watched } from "../src/server/poller.ts";
import { Store } from "../src/server/store.ts";

class IdleCache implements Watched {
  readonly id = "cache";
  readonly settings = { interval: 3600, job_poll: 30 };
  cycles = 0;

  async cycle(): Promise<void> {
    this.cycles++;
  }

  busy(): boolean {
    return false;
  }
}

function start_job(store: Store, owner_id: string): void {
  store.create_job({ deployment_id: owner_id, kind: "build-target", command: "{}", agent: null, run_id: "run", trigger: "automatic", started_epoch: 0 });
}

// ── New jobs ─────────────────────────────────────────────────────────────────

describe("the poller", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("polls an idle cache soon after another owner starts a job for it", async () => {
    const store = new Store(":memory:");
    const cache = new IdleCache();
    const poller = new Poller([], null, [cache as never]);
    poller.follow_new_jobs(store);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    start_job(store, "cache");
    await vi.advanceTimersByTimeAsync(2000);

    expect(cache.cycles).toBe(2);
    poller.stop();
  });

  it("leaves its timers alone for a job no watched owns, and stops following once asked", async () => {
    const store = new Store(":memory:");
    const cache = new IdleCache();
    const poller = new Poller([], null, [cache as never]);
    const stop_following = poller.follow_new_jobs(store);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    start_job(store, "odin");
    stop_following();
    start_job(store, "cache");
    await vi.advanceTimersByTimeAsync(2000);

    expect(cache.cycles).toBe(1);
    poller.stop();
  });
});
