import { describe, expect, it } from "vitest";

import { AgentError } from "../src/server/agents/agent.ts";
import { ConfigError, deployment_settings } from "../src/server/config.ts";
import { format_bytes } from "../src/server/nixos/garbage.ts";
import { clock, make_deployment, result, type Harness } from "./fake_agent.ts";

const gib = 2 ** 30;
const day = 86400;

// The two lines systemd logs when a run ends, as `journalctl -o short-unix` renders them.
const outcomes = {
  finished: "systemd[1]: Finished Nix Garbage Collector.",
  failed: "systemd[1]: nix-gc.service: Failed with result 'exit-code'.",
};

interface GcProbeOptions {
  size?: number;
  used?: number;
  svc_state?: string;
  svc_result?: string;
  timer_load?: string;
  timer_state?: string;
  timer_next?: number;
  last_gc?: number;
  freed?: string | null;
  deleted?: number;
  outcome?: keyof typeof outcomes | null;
  summary_at?: number;
  error?: string;
  error_at?: number;
  profiles?: [path: string, generation: number, count: number, oldest?: number][];
}

const two_profiles: GcProbeOptions["profiles"] = [
  ["/nix/var/nix/profiles/system", 236, 59],
  ["/nix/var/nix/profiles/per-user/root/profile", 29, 11],
];

// What the store's probe prints on a NixOS host.
function gc_probe(options: GcProbeOptions = {}) {
  const size = options.size ?? 200 * gib;
  const used = options.used ?? 80 * gib;
  const last_gc = options.last_gc ?? clock.now - day;
  const summary_at = options.summary_at ?? last_gc;
  const freed = options.freed === undefined ? "44.4 GiB" : options.freed;
  const outcome = options.outcome === undefined ? "finished" : options.outcome;
  const lines = [
    "hostname=host",
    `df=${size} ${used} ${size - used} /nix/store`,
    "paths=111121",
    "roots=118",
    `svc_state=${options.svc_state ?? "inactive"}`,
    `svc_result=${options.svc_result ?? "success"}`,
    "svc_exit=",
    `timer_load=${options.timer_load ?? "loaded"}`,
    `timer_state=${options.timer_state ?? "active"}`,
    `timer_next=@${options.timer_next ?? clock.now + 3 * day}`,
    freed === null ? "summary=" : `summary=${summary_at}.204758 host nix-gc-start[2166397]: ${options.deleted ?? 21482} store paths deleted, ${freed} freed`,
    outcome === null ? "outcome=" : `outcome=${last_gc}.225681 host ${outcomes[outcome]}`,
    options.error ? `error=${options.error_at ?? last_gc}.100000 host nix-gc-start[2166397]: ${options.error}` : "error=",
  ];
  for (const [path, generation, count, oldest] of options.profiles ?? [["/nix/var/nix/profiles/system", 236, 59]]) {
    lines.push(`profile=${path}|${generation}|${count}|${oldest ?? clock.now - 30 * day}`);
  }
  return result(0, `${lines.join("\n")}\n`);
}

function watched(gc: Record<string, unknown> = {}, values: Record<string, unknown> = {}): Harness {
  return make_deployment({ gc, ...values });
}

// Runs one cycle with the store's probe answering this.
async function read(harness: Harness, probe = gc_probe()): Promise<void> {
  harness.agent.gc_probe_result = probe;
  await harness.deployment.cycle();
}

function store_of(harness: Harness) {
  return harness.deployment.reading()!.store!;
}

function last_of(harness: Harness) {
  return harness.deployment.evaluation().last_collection;
}

function messages(harness: Harness, level: string | null = null): string[] {
  return store_of(harness).messages.filter((message) => level === null || message.level === level).map((message) => message.text);
}

// Starts Collect Garbage and ends its run with this output and exit code.
async function manual_collection(harness: Harness, output: string, exit_code: number | null): Promise<void> {
  expect((await harness.deployment.act("collect")).ok).toBe(true);
  harness.agent.end(harness.agent.last_run("nix-collect-garbage")!, output, exit_code);
  await harness.deployment.cycle();
}

// ── Freshness ────────────────────────────────────────────────────────────────

describe("freshness", () => {
  it("is online after a recent collection", async () => {
    const harness = watched();
    await read(harness);
    expect(store_of(harness).status).toBe("online");
    expect(last_of(harness)?.succeeded).toBe(true);
  });

  it("fails once the last collection is older than max_age, which is configurable", async () => {
    const harness = watched();
    await read(harness, gc_probe({ last_gc: clock.now - 21 * day }));
    expect(store_of(harness).status).toBe("failed");

    const short = watched({ max_age: "1d" });
    await read(short, gc_probe({ last_gc: clock.now - 2 * day }));
    expect(store_of(short).status).toBe("failed");
  });

  it("takes a stale status from stale_status, falling back to failed on an unknown one", async () => {
    const harness = watched({ stale_status: "warning" });
    await read(harness, gc_probe({ last_gc: clock.now - 21 * day }));
    expect(store_of(harness).status).toBe("warning");

    expect(watched({ stale_status: "catastrophe" }).deployment.settings.gc?.stale_status).toBe("failed");
  });

  it("never calls a running collection stale", async () => {
    const harness = watched();
    await read(harness, gc_probe({ last_gc: clock.now - 21 * day, svc_state: "active" }));
    expect(store_of(harness).status).toBe("online");
  });

  it("fails when the last run failed", async () => {
    const harness = watched();
    await read(harness, gc_probe({ outcome: "failed" }));
    expect(store_of(harness).status).toBe("failed");
    expect(last_of(harness)?.succeeded).toBe(false);
  });

  it("believes a journal failure over a unit Result a switch reset to success", async () => {
    const harness = watched();
    await read(harness, gc_probe({ outcome: "failed", svc_result: "success" }));
    expect(store_of(harness).status).toBe("failed");
  });

  it("does not fail a finished run over a stale unit Result", async () => {
    const harness = watched();
    await read(harness, gc_probe({ outcome: "finished", svc_result: "exit-code" }));
    expect(store_of(harness).status).toBe("online");
  });

  it("reports a failure with the journal's reason, but not one from an earlier run", async () => {
    const harness = watched();
    await read(harness, gc_probe({ outcome: "failed", error: "error: interrupted by the user" }));
    expect(messages(harness, "error")).toEqual(["The last collection failed: error: interrupted by the user"]);

    const stale = watched();
    await read(stale, gc_probe({ outcome: "failed", error: "error: out of disk", error_at: clock.now - 30 * day }));
    expect(messages(stale, "error")).toEqual(["The last collection failed"]);
  });

  it("reports no reason for a run that succeeded", async () => {
    const harness = watched();
    await read(harness, gc_probe({ error: "error: interrupted by the user" }));
    expect(store_of(harness).status).toBe("online");
    expect(messages(harness, "error")).toEqual([]);
  });

  it("goes by the unit's Result when the journal has no outcome", async () => {
    const harness = watched();
    await read(harness, gc_probe({ outcome: null, svc_result: "exit-code" }));
    expect(store_of(harness).status).toBe("failed");
  });

  it("is unavailable with no record of any run", async () => {
    const harness = watched();
    await read(harness, gc_probe({ freed: null, outcome: null }));
    expect(store_of(harness).status).toBe("unavailable");
    expect(last_of(harness)).toBeNull();
  });

  it("keeps its status apart from the deployment's", async () => {
    const harness = watched();
    await read(harness, gc_probe({ outcome: "failed" }));
    expect(harness.deployment.reading()?.status).not.toBe("failed");
    expect(harness.store.events(harness.deployment.id).map((event) => event.message)).toContain("Store now failed: The last collection failed");
  });
});

// ── Yield ────────────────────────────────────────────────────────────────────

describe("yield", () => {
  it("records what the summary line says was freed", async () => {
    const harness = watched();
    await read(harness, gc_probe({ freed: "44.4 GiB", deleted: 21482 }));
    expect(last_of(harness)?.freed_bytes).toBeCloseTo(44.4 * gib);
    expect(last_of(harness)?.deleted).toBe(21482);
  });

  it.each([["512.0 MiB", 512 * 2 ** 20], ["2.0 TiB", 2 * 2 ** 40], ["100 bytes", 100], ["1.5 GB", 1.5e9]])("understands %s", async (rendered, bytes) => {
    const harness = watched();
    await read(harness, gc_probe({ freed: rendered }));
    expect(last_of(harness)?.freed_bytes).toBeCloseTo(bytes);
  });

  it("records no yield for a unit it does not know", async () => {
    const harness = watched();
    await read(harness, gc_probe({ freed: "44.4 parsecs" }));
    expect(last_of(harness)?.freed_bytes).toBeNull();
    expect(store_of(harness).status).toBe("online");
  });

  it("keeps the last known run once the journal has rotated past it", async () => {
    const harness = watched();
    const stamp = clock.now - day;
    await read(harness, gc_probe({ last_gc: stamp }));
    await read(harness, gc_probe({ freed: null, outcome: null }));
    expect(last_of(harness)?.epoch).toBe(stamp);
    expect(last_of(harness)?.freed_bytes).toBeCloseTo(44.4 * gib);
    expect(store_of(harness).status).toBe("online");
  });

  it("keeps the yield a failed run managed", async () => {
    // nix prints its summary a moment before systemd logs the failure; both are one run.
    const harness = watched();
    const stamp = clock.now - 3600;
    await read(harness, gc_probe({ outcome: "failed", last_gc: stamp, summary_at: stamp - 1, freed: "2.8 GiB", deleted: 2048 }));
    expect(store_of(harness).status).toBe("failed");
    expect(last_of(harness)).toMatchObject({ deleted: 2048, succeeded: false });
    expect(last_of(harness)?.freed_bytes).toBeCloseTo(2.8 * gib);
  });

  it("does not take an older run's summary as this run's yield", async () => {
    const harness = watched();
    await read(harness, gc_probe({ summary_at: clock.now - 30 * day }));
    expect(last_of(harness)?.freed_bytes).toBeNull();
  });

  it("clears the old yield for a newer run without a summary", async () => {
    const harness = watched();
    await read(harness, gc_probe({ last_gc: clock.now - day }));
    await read(harness, gc_probe({ last_gc: clock.now - 60, freed: null }));
    expect(last_of(harness)?.freed_bytes).toBeNull();
  });
});

// ── Schedule ─────────────────────────────────────────────────────────────────

describe("schedule", () => {
  it("warns when the timer is inactive, with its status from timer_status", async () => {
    const harness = watched();
    await read(harness, gc_probe({ timer_state: "inactive" }));
    expect(store_of(harness)).toMatchObject({ status: "warning", timer_active: false });

    const strict = watched({ timer_status: "failed" });
    await read(strict, gc_probe({ timer_state: "inactive" }));
    expect(store_of(strict).status).toBe("failed");
  });

  it("says so when the timer is not installed", async () => {
    const harness = watched();
    await read(harness, gc_probe({ timer_load: "not-found", timer_state: "inactive" }));
    expect(messages(harness).some((text) => text.includes("not installed"))).toBe(true);
  });

  it("records when the timer next runs", async () => {
    const harness = watched();
    await read(harness, gc_probe({ timer_next: clock.now + 3 * day }));
    expect(store_of(harness).next_epoch).toBe(clock.now + 3 * day);
  });
});

// ── Store ────────────────────────────────────────────────────────────────────

describe("store", () => {
  it("measures usage from df, with paths and roots", async () => {
    const harness = watched();
    await read(harness, gc_probe({ size: 200 * gib, used: 100 * gib }));
    expect(store_of(harness)).toMatchObject({ used_percent: 50, size_bytes: 200 * gib, avail_bytes: 100 * gib, paths: 111121, roots: 118 });
  });

  it("warns over the warning and fails over the threshold", async () => {
    const warning = watched();
    await read(warning, gc_probe({ size: 100 * gib, used: 85 * gib }));
    expect(store_of(warning).status).toBe("warning");

    const failing = watched();
    await read(failing, gc_probe({ size: 100 * gib, used: 95 * gib }));
    expect(store_of(failing).status).toBe("failed");
  });

  it("turns either limit off with null", async () => {
    const warning_only = watched({ threshold: null });
    await read(warning_only, gc_probe({ size: 100 * gib, used: 100 * gib }));
    expect(store_of(warning_only).status).toBe("warning");

    const failure_only = watched({ warning: null });
    await read(failure_only, gc_probe({ size: 100 * gib, used: 89 * gib }));
    expect(store_of(failure_only).status).toBe("online");
    await read(failure_only, gc_probe({ size: 100 * gib, used: 95 * gib }));
    expect(store_of(failure_only).status).toBe("failed");
  });

  it("is unavailable when the store is unreadable or the host does not answer", async () => {
    const unreadable = watched();
    await read(unreadable, result(0, "hostname=host\ndf=\n"));
    expect(store_of(unreadable).status).toBe("unavailable");

    const silent = watched();
    await read(silent, result(255, "", "ssh: connect failed"));
    expect(store_of(silent).status).toBe("unavailable");
    expect(messages(silent)[0]).toContain("ssh: connect failed");
  });

  it("is left alone with gc set to false", async () => {
    const harness = make_deployment({ gc: false });
    await read(harness);
    expect(harness.deployment.reading()?.store).toBeNull();
    expect(harness.agent.commands.some((command) => command.includes("journalctl"))).toBe(false);
    expect(harness.deployment.action_refusal("collect")).toContain("gc is off");
  });

  it("rejects a gc that is not an object and a limit that is not a number", () => {
    expect(() => deployment_settings({ id: "host", gc: "yes" })).toThrow(ConfigError);
    expect(() => deployment_settings({ id: "host", gc: { warning: "80%" } })).toThrow(ConfigError);
  });
});

// ── Profiles ─────────────────────────────────────────────────────────────────

describe("profiles", () => {
  it("counts generations across profiles", async () => {
    const harness = watched();
    await read(harness, gc_probe({ profiles: two_profiles }));
    expect(store_of(harness).generations).toBe(70);
    expect(store_of(harness).profiles.map((profile) => [profile.path, profile.generation, profile.count])).toEqual([
      ["/nix/var/nix/profiles/system", 236, 59],
      ["/nix/var/nix/profiles/per-user/root/profile", 29, 11],
    ]);
  });

  it("takes the oldest generation of any profile", async () => {
    const harness = watched();
    const old = clock.now - 90 * day;
    await read(harness, gc_probe({ profiles: [["/nix/var/nix/profiles/system", 236, 59, old], ["/nix/var/nix/profiles/per-user/root/profile", 29, 11, old + day]] }));
    expect(store_of(harness).oldest_generation_epoch).toBe(old);
  });

  it("warns about a generation older than max_generation_age", async () => {
    const harness = watched({ max_generation_age: "7d" });
    await read(harness, gc_probe({ profiles: [["/nix/var/nix/profiles/system", 236, 59, clock.now - 30 * day]] }));
    expect(store_of(harness).status).toBe("warning");
  });

  it("warns about a profile over max_generations, naming it", async () => {
    const harness = watched({ max_generations: 20 });
    await read(harness, gc_probe({ profiles: two_profiles }));
    expect(store_of(harness).status).toBe("warning");
    expect(messages(harness, "warning").join()).toContain("/nix/var/nix/profiles/system (59)");
  });
});

// ── Collect Garbage ──────────────────────────────────────────────────────────

describe("collect garbage", () => {
  it("runs the configured collection under sudo on the host", async () => {
    const harness = watched({ gc_args: ["--delete-older-than", "14d"] });
    expect((await harness.deployment.act("collect")).message).toBe("Collection started");
    const job = harness.deployment.running_job()!;
    expect([job.kind, job.command, job.agent]).toEqual(["collect", "sudo -n nix-collect-garbage --delete-older-than 14d", null]);
  });

  it("runs without sudo when require_sudo is off", async () => {
    const harness = watched({}, { require_sudo: false });
    await harness.deployment.act("collect");
    expect(harness.deployment.running_job()?.command).toBe("nix-collect-garbage --delete-older-than 7d");
  });

  it("keeps a collection that could not start in the history", async () => {
    const harness = watched();
    harness.agent.start_error = new AgentError("Could not start sh.");
    const outcome = await harness.deployment.act("collect");
    expect(outcome).toMatchObject({ ok: false, message: "Could not start the collection: Could not start sh." });
    expect(harness.deployment.running_job()).toBeNull();
  });

  it("refuses a second job while one runs", async () => {
    const harness = watched();
    await harness.deployment.act("collect");
    expect((await harness.deployment.act("collect")).message).toContain("already running");
    expect((await harness.deployment.act("switch")).message).toContain("already running");
  });

  it("shows its progress and finishes by its exit code", async () => {
    const harness = watched();
    await harness.deployment.act("collect");
    harness.agent.write(harness.agent.last_run("nix-collect-garbage")!, "deleting unused links...\n");
    await harness.deployment.cycle();
    expect(harness.deployment.running_job()?.progress).toBe("deleting unused links...");

    harness.agent.end(harness.agent.last_run("nix-collect-garbage")!, "21482 store paths deleted, 44.4 GiB freed\n", 0);
    await harness.deployment.cycle();
    expect(harness.store.jobs()[0]).toMatchObject({ kind: "collect", state: "succeeded" });
    expect(harness.deployment.due_for_evaluation()).toBe(true);
  });

  it("becomes the last collection, which an older timer run in the journal does not undo", async () => {
    const harness = watched();
    const old = clock.now - 16 * day;
    await read(harness, gc_probe({ last_gc: old, freed: "359.3 MiB", deleted: 101 }));

    await manual_collection(harness, "7529 store paths deleted, 3.3 GiB freed\n", 0);
    expect(last_of(harness)).toMatchObject({ epoch: clock.now, deleted: 7529, succeeded: true });
    expect(last_of(harness)?.freed_bytes).toBeCloseTo(3.3 * gib);

    await read(harness, gc_probe({ last_gc: old, freed: "359.3 MiB", deleted: 101 }));
    expect(last_of(harness)?.deleted).toBe(7529);
    expect(store_of(harness).status).toBe("online");
  });

  it("makes a failed collection the last one, failed", async () => {
    const harness = watched();
    await manual_collection(harness, "", 1);
    await read(harness, gc_probe({ last_gc: clock.now - day }));
    expect(store_of(harness).status).toBe("failed");
    expect(last_of(harness)).toMatchObject({ succeeded: false, error: "Exited with status 1" });
  });
});

// ── Sizes ────────────────────────────────────────────────────────────────────

describe("sizes", () => {
  it("are written in binary units", () => {
    expect([format_bytes(100), format_bytes(512 * 2 ** 20), format_bytes(44.4 * gib)]).toEqual(["100 B", "512.0 MiB", "44.4 GiB"]);
  });
});
