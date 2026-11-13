import { describe, expect, it } from "vitest";

import { Notifier, read_channels, type Notification } from "../src/server/notifications.ts";
import { allowance, OverdueJobs, overdue_text } from "../src/server/overdue.ts";
import { Store, type JobKind } from "../src/server/store.ts";

// ── Setup ────────────────────────────────────────────────────────────────────

const hour = 3600;

// A store whose deployment has finished switches that took the given seconds.
function store_with(durations: number[], kind: JobKind = "switch"): Store {
  const store = new Store(":memory:");
  for (const seconds of durations) {
    const id = store.create_job({ deployment_id: "odin", kind, command: "{}", agent: "odin", run_id: null, trigger: "test", started_epoch: 0 });
    store.finish_job(id, "succeeded", 0, null, seconds);
  }
  return store;
}

function start(store: Store, kind: JobKind = "switch"): number {
  return store.create_job({ deployment_id: "odin", kind, command: "{}", agent: "odin", run_id: "r1", trigger: "test", started_epoch: 0 });
}

// ── Overdue jobs ─────────────────────────────────────────────────────────────

describe("an overdue job", () => {
  it("is given three times the longest recent run of its kind, at least half an hour, and an hour with nothing to go by", () => {
    const store = store_with([120, 4 * hour]);
    const job = store.job(start(store))!;

    expect(allowance(store, job)).toBe(12 * hour);
    expect(allowance(store_with([120]), job)).toBe(1800);
    expect(allowance(store_with([]), job)).toBe(hour);
  });

  it("is named with how long it ran and what its run last said it waits for", () => {
    const store = store_with([240]);
    const id = start(store);
    store.append_output(id, "@@x-nix-stall No output for 5 minutes; still running nix-env (pid 9)\n@@x-nix-stall nix-env (pid 9) waits for the Nix store database\n");

    expect(overdue_text(store, store.job(id)!, 1799)).toBeNull();
    expect(overdue_text(store, store.job(id)!, 7 * hour)).toBe(
      `The switch job ${id} has run for 7 hours, well past the 30 minutes it should take: nix-env (pid 9) waits for the Nix store database`,
    );
  });

  it("is noted in the history and sent once, however often the watch looks", async () => {
    const store = store_with([]);
    const id = start(store);
    const sent: Notification[] = [];
    const watch = new OverdueJobs(store, new Notifier([async (notification) => void sent.push(notification)]), () => 2 * hour);

    await watch.check();
    await watch.check();

    expect(sent).toEqual([{ title: "X-Nix: a job on odin is overdue", body: `The switch job ${id} has run for 2 hours, well past the 1 hour it should take`, level: "warning" }]);
    expect(store.events("odin").filter((event) => event.level === "warning")).toHaveLength(1);
  });
});

// ── Notifications ────────────────────────────────────────────────────────────

describe("notification channels", () => {
  it("are read from the config, refusing one of no known type", () => {
    expect(read_channels(undefined)).toEqual([]);
    expect(read_channels([{ type: "ntfy", topic: "x-nix" }, { type: "webhook", url: "https://hooks.example/x-nix" }, { type: "apprise", urls: ["ntfys://x-nix"] }])).toHaveLength(3);
    expect(() => read_channels([{ type: "pager" }])).toThrow("notifications[0]: `type` must be one of ntfy, webhook, apprise");
    expect(() => read_channels([{ type: "ntfy" }])).toThrow(/notifications\[0\].*topic/);
  });

  it("each get the notification, one failing leaving the rest", async () => {
    const logged: string[] = [];
    let delivered = 0;
    const notifier = new Notifier([async () => { throw new Error("ntfy is down"); }, async () => void delivered++], (message) => logged.push(message));

    await notifier.send({ title: "t", body: "b", level: "warning" });

    expect(delivered).toBe(1);
    expect(logged).toEqual(["Notification channel 1 failed: ntfy is down"]);
  });
});
