import { describe, expect, it } from "vitest";

import { AgentError } from "../src/server/agents/agent.ts";
import { latest_slot } from "../src/server/deployment.ts";
import {
  clock, collect, current_closure, cycle, eval_output, kernel, make_deployment, messages_of, metadata, new_kernel, probe, result, rewind_drift,
  rewind_evaluation, rewind_schedule, status_of, target_closure,
} from "./fake_agent.ts";

const matching = result(0, `${current_closure}\n`);
const newer_closure = "/nix/store/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-nixos-system-host-26.11";

// ── Drift ────────────────────────────────────────────────────────────────────

describe("drift", () => {
  it("is online when the running closure is the flake's", async () => {
    const harness = make_deployment();

    await collect(harness, { evaluation: matching });

    expect(status_of(harness)).toBe("online");
    expect(harness.deployment.reading()?.up_to_date).toBe(true);
  });

  it("warns when the running closure differs, naming both", async () => {
    const harness = make_deployment();

    await collect(harness);

    expect(status_of(harness)).toBe("warning");
    expect(harness.deployment.reading()?.up_to_date).toBe(false);
    const message = messages_of(harness).find((text) => text.includes("out of date"))!;
    expect(message).toContain(target_closure);
    expect(message).toContain(current_closure);
  });

  it("takes its status from drift_status, falling back to warning on an unknown one", async () => {
    const failing = make_deployment({ drift_status: "failed" });
    await collect(failing);
    expect(status_of(failing)).toBe("failed");

    expect(make_deployment({ drift_status: "catastrophe" }).deployment.settings.drift_status).toBe("warning");
  });

  it("evaluates a newly running closure again before calling it drift", async () => {
    const harness = make_deployment();
    await collect(harness, { evaluation: matching });

    await collect(harness, { probe: probe({ current: newer_closure }) });

    expect(harness.deployment.reading()?.up_to_date).toBeNull();
    expect(status_of(harness)).toBe("online");
    expect(harness.deployment.due_for_evaluation()).toBe(true);
  });

  it("calls a new closure drift once a fresh evaluation still differs", async () => {
    const harness = make_deployment();
    await collect(harness, { evaluation: matching });
    await collect(harness, { probe: probe({ current: newer_closure }) });

    await collect(harness, { probe: probe({ current: newer_closure }) });

    expect(status_of(harness)).toBe("warning");
    expect(harness.deployment.reading()?.up_to_date).toBe(false);
  });

  it("fails when the evaluation fails", async () => {
    const harness = make_deployment();

    await collect(harness, { evaluation: result(1, "", "error: attribute 'nope' missing") });

    expect(status_of(harness)).toBe("failed");
    expect(harness.deployment.reading()?.up_to_date).toBeNull();
  });

  it("is unavailable on a host that is not NixOS or does not answer", async () => {
    const not_nixos = make_deployment();
    await collect(not_nixos, { probe: result(0, "current=\nbooted=\n") });
    expect(status_of(not_nixos)).toBe("unavailable");

    const unreachable = make_deployment();
    await collect(unreachable, { probe: result(-1, "", "No agent named 'host' is connected") });
    expect(status_of(unreachable)).toBe("unavailable");
  });

  it("is unavailable when the evaluating host has no agent, and starts no job", async () => {
    const harness = make_deployment({ eval_agent: "builder", configuration: "host" });

    await cycle(harness);

    expect(status_of(harness)).toBe("unavailable");
    expect(harness.deployment.reading()?.up_to_date).toBeNull();
    expect(harness.deployment.running_evaluation()).toBeNull();
  });

  it("fails when the evaluation could not start", async () => {
    const harness = make_deployment();
    harness.agent.start_error = new AgentError("Could not start sh.");

    await cycle(harness);

    expect(status_of(harness)).toBe("failed");
    expect(harness.deployment.evaluation().eval_error).toContain("Could not start sh.");
  });

  it("waits for the first probe's hostname before evaluating on another host", async () => {
    const harness = make_deployment({ eval_agent: "builder" });

    expect(await cycle(harness)).toBeUndefined();
    expect(harness.deployment.attribute()).toBe("host");
  });
});

// ── Reboot needed ────────────────────────────────────────────────────────────

describe("reboot needed", () => {
  it("is not needed while the booted kernel is the current one", async () => {
    const harness = make_deployment();

    await collect(harness, { evaluation: matching });

    expect(harness.deployment.reading()?.reboot_required).toBe(false);
    expect(status_of(harness)).toBe("online");
  });

  it("is needed once the kernel changed, with its status from reboot_status", async () => {
    const warning = make_deployment();
    await collect(warning, { probe: probe({ kernels: [kernel, new_kernel] }), evaluation: matching });
    expect(warning.deployment.reading()?.reboot_required).toBe(true);
    expect(status_of(warning)).toBe("warning");

    const failing = make_deployment({ reboot_status: "failed" });
    await collect(failing, { probe: probe({ kernels: [kernel, new_kernel] }), evaluation: matching });
    expect(status_of(failing)).toBe("failed");
  });
});

// ── Flake metadata ───────────────────────────────────────────────────────────

describe("flake metadata", () => {
  it("records the revision, when the flake changed and its oldest input", async () => {
    const harness = make_deployment();
    const modified = clock.now - 7200;
    const oldest = clock.now - 86400;

    await collect(harness, { metadata: metadata({ revision: "a".repeat(40), last_modified_epoch: modified, inputs: { nixpkgs: oldest, "flake-utils": oldest + 60 } }) });

    const evaluation = harness.deployment.evaluation();
    expect(evaluation.flake_last_modified_epoch).toBe(modified);
    expect(evaluation.inputs_last_modified_epoch).toBe(oldest);
    expect(evaluation.flake_revision).toBe("a".repeat(40));
    expect(evaluation.oldest_input).toBe("nixpkgs");
    expect(harness.deployment.reading()?.flake_reachable).toBe(true);
  });

  it("reads the revision of a checkout with uncommitted changes", async () => {
    const harness = make_deployment();

    await collect(harness, { metadata: metadata({ revision: `${"a".repeat(40)}-dirty`, dirty: true }) });

    expect(harness.deployment.evaluation().flake_revision).toBe(`${"a".repeat(40)}-dirty`);
  });

  it("is unavailable when the metadata cannot be read, keeping the drift verdict", async () => {
    const harness = make_deployment();

    await collect(harness, { evaluation: matching, metadata: result(1, "", "error: unable to fetch") });

    expect(harness.deployment.reading()?.flake_reachable).toBe(false);
    expect(harness.deployment.reading()?.up_to_date).toBe(true);
    expect(status_of(harness)).toBe("unavailable");
  });

  it("warns about stale inputs only when max_input_age is set", async () => {
    const limited = make_deployment({ max_input_age: "7d" });
    await collect(limited, { evaluation: matching, metadata: metadata({ inputs: { nixpkgs: clock.now - 30 * 86400 } }) });
    expect(status_of(limited)).toBe("warning");

    const unlimited = make_deployment();
    await collect(unlimited, { evaluation: matching, metadata: metadata({ inputs: { nixpkgs: clock.now - 365 * 86400 } }) });
    expect(status_of(unlimited)).toBe("online");
  });
});

// ── Evaluation timing ────────────────────────────────────────────────────────

describe("evaluation timing", () => {
  it("evaluates on the first cycle and not again while fresh", async () => {
    const harness = make_deployment();
    expect(harness.deployment.due_for_evaluation()).toBe(true);

    await collect(harness);

    expect(harness.deployment.due_for_evaluation()).toBe(false);
  });

  it("evaluates again once eval_interval has passed", async () => {
    const harness = make_deployment();
    await collect(harness);

    rewind_evaluation(harness, 7200);

    expect(harness.deployment.due_for_evaluation()).toBe(true);
  });

  it("retries a failed evaluation or metadata read after retry_interval only", async () => {
    const failed = make_deployment();
    await collect(failed, { evaluation: result(1, "", "error: attribute missing") });
    expect(failed.deployment.due_for_evaluation()).toBe(false);
    rewind_evaluation(failed, 20 * 60);
    expect(failed.deployment.due_for_evaluation()).toBe(true);

    const unfetched = make_deployment();
    await collect(unfetched, { metadata: result(1, "", "error: unable to download") });
    rewind_evaluation(unfetched, 20 * 60);
    expect(unfetched.deployment.due_for_evaluation()).toBe(true);

    const healthy = make_deployment();
    await collect(healthy);
    rewind_evaluation(healthy, 20 * 60);
    expect(healthy.deployment.due_for_evaluation()).toBe(false);
  });

  it("never waits longer to retry than to evaluate", () => {
    expect(make_deployment({ eval_interval: "10m", retry_interval: "15m" }).deployment.settings.retry_interval).toBe(600);
  });

  it("evaluates when a person asks for a refresh", async () => {
    const harness = make_deployment();
    await collect(harness);

    expect(await cycle(harness, { force_eval: true })).toBeDefined();
  });

  it("still judges drift on a cycle that only probes", async () => {
    const harness = make_deployment();
    await collect(harness);

    await collect(harness, { probe: probe({ current: target_closure }) });

    expect(harness.deployment.reading()?.up_to_date).toBe(true);
    expect(status_of(harness)).toBe("online");
  });

  it("keeps an evaluation going across a restart of the server", async () => {
    const harness = make_deployment();
    const launched = (await cycle(harness))!;

    const restarted = make_deployment({}, { store: harness.store, agent: harness.agent });
    harness.agent.end(launched, eval_output(matching, metadata()), 0);
    await cycle(restarted);

    expect(restarted.deployment.reading()?.up_to_date).toBe(true);
    expect(harness.agent.runs).toHaveLength(1);
  });

  it("names a timed-out evaluation", async () => {
    const harness = make_deployment();
    const launched = (await cycle(harness))!;

    harness.agent.end(launched, "", 124);
    await cycle(harness);

    const job = harness.store.jobs({ include_evaluations: true })[0];
    expect(job.error).toBe("Timed out after 10 minutes");
    expect(status_of(harness)).toBe("failed");
  });

  it("stays running when the evaluating host stops answering", async () => {
    const harness = make_deployment();
    await cycle(harness);

    harness.agent.poll_error = new AgentError("No agent named 'host' is connected", true);
    await cycle(harness);

    expect(status_of(harness)).toBe("unavailable");
    expect(harness.deployment.running_evaluation()).not.toBeNull();
  });

  it("leaves evaluations out of the job history", async () => {
    const harness = make_deployment();

    await collect(harness);

    expect(harness.store.jobs()).toHaveLength(0);
    expect(harness.store.jobs({ include_evaluations: true })).toHaveLength(1);
  });
});

// ── Actions ──────────────────────────────────────────────────────────────────

describe("actions", () => {
  it("starts a switch as a job with its command", async () => {
    const harness = make_deployment();

    const outcome = await harness.deployment.act("switch");

    expect(outcome.ok).toBe(true);
    const job = harness.deployment.running_job()!;
    expect(job.kind).toBe("switch");
    expect(job.command).toContain("nixos-rebuild switch --flake /etc/nixos");
  });

  it("starts an update as an update job", async () => {
    const harness = make_deployment();

    await harness.deployment.act("update");

    expect(harness.deployment.running_job()?.kind).toBe("update");
  });

  it("refuses to update a flake whose lock it cannot write", async () => {
    const remote = make_deployment({ flake: "git+https://example.com/config" });
    const refused = await remote.deployment.act("update");
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain("github: flake");
    expect(remote.deployment.running_job()).toBeNull();

    const keyless = make_deployment({ flake: "github:owner/config" });
    expect((await keyless.deployment.act("update")).message).toContain("push_ssh_key");
  });

  it("updates a github: flake through a clone it pushes back", async () => {
    const harness = make_deployment({ flake: "github:owner/config", push_ssh_key: "/run/secrets/deploy_key" });

    expect((await harness.deployment.act("update")).ok).toBe(true);

    expect(harness.deployment.running_job()?.command).toContain("push origin HEAD");
  });

  it("switches a remote flake", async () => {
    const harness = make_deployment({ flake: "github:owner/config" });

    expect((await harness.deployment.act("switch")).ok).toBe(true);
  });

  it("refuses a second job while one runs, reboot included", async () => {
    const harness = make_deployment();
    await harness.deployment.act("switch");

    const refused = await harness.deployment.act("reboot");

    expect(refused.ok).toBe(false);
    expect(refused.message).toContain("already running");
  });

  it("keeps a job that could not start in the history with why", async () => {
    const harness = make_deployment();
    harness.agent.start_error = new AgentError("Could not start sh.");

    const outcome = await harness.deployment.act("switch");

    expect(outcome.ok).toBe(false);
    expect(harness.deployment.running_job()).toBeNull();
    const job = harness.store.job(harness.store.jobs()[0].id)!;
    expect([job.kind, job.state, job.error]).toEqual(["switch", "failed", "The job could not be started"]);
    expect(job.output).toBe("Could not start sh.\n");
  });

  it("reboots the host itself as root and keeps it in the history", async () => {
    const harness = make_deployment({ switch_agent: "builder" });

    const outcome = await harness.deployment.act("reboot");

    expect(outcome.ok).toBe(true);
    expect(harness.agent.commands).toContain("sudo -n systemctl reboot");
    expect(harness.deployment.running_job()).toBeNull();
    const job = harness.store.jobs()[0];
    expect([job.kind, job.state, job.command]).toEqual(["reboot", "succeeded", "sudo -n systemctl reboot"]);
  });

  it("reboots without sudo when require_sudo is off", async () => {
    const harness = make_deployment({ require_sudo: false });

    await harness.deployment.act("reboot");

    expect(harness.agent.commands).toContain("systemctl reboot");
  });

  it("keeps a failed reboot's output", async () => {
    const harness = make_deployment();
    harness.agent.command_result = result(1, "", "sudo: a password is required");

    const outcome = await harness.deployment.act("reboot");

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("password is required");
    const job = harness.store.job(harness.store.jobs()[0].id)!;
    expect([job.state, job.output]).toEqual(["failed", "sudo: a password is required"]);
  });

  it("runs the build on the build agent, else the switch agent", () => {
    expect(make_deployment({ switch_agent: "builder" }).deployment.agent_for("build")).toBe("builder");
    expect(make_deployment({ build_agent: "builder" }).deployment.agent_for("build")).toBe("builder");
    expect(make_deployment({ build_agent: "builder" }).deployment.agent_for("switch")).toBeNull();
  });
});

// ── Job polling ──────────────────────────────────────────────────────────────

describe("job polling", () => {
  it("copies output into the job and shows its last line while it runs", async () => {
    const harness = make_deployment();
    await harness.deployment.act("switch");
    harness.agent.write(harness.agent.last_run("switch")!, "building\nactivating\n");

    await cycle(harness);

    const job = harness.store.job(harness.deployment.running_job()!.id)!;
    expect(job.output).toBe("building\nactivating\n");
    expect(job.progress).toBe("activating");
  });

  it("reads nothing else from the host while a job runs", async () => {
    const harness = make_deployment();
    await harness.deployment.act("switch");

    await cycle(harness);

    expect(harness.agent.commands).toHaveLength(0);
  });

  it("finishes a job that succeeded and evaluates afresh after it", async () => {
    const harness = make_deployment();
    await collect(harness);
    await harness.deployment.act("switch");
    harness.agent.end(harness.agent.last_run("switch")!, "done\n", 0);

    await cycle(harness);

    expect(harness.store.jobs()[0].state).toBe("succeeded");
    expect(harness.deployment.due_for_evaluation()).toBe(true);
  });

  it("fails a job that exited badly or ended without an exit code", async () => {
    const failed = make_deployment();
    await failed.deployment.act("switch");
    failed.agent.end(failed.agent.last_run("switch")!, "error: build failed\n", 1);
    await cycle(failed);
    expect(failed.store.jobs()[0]).toMatchObject({ state: "failed", exit_code: 1, error: "Exited with status 1" });

    const lost = make_deployment();
    await lost.deployment.act("switch");
    lost.agent.end(lost.agent.last_run("switch")!, "", null);
    await cycle(lost);
    expect(lost.store.jobs()[0]).toMatchObject({ state: "failed", error: "The run ended without writing an exit code" });
  });

  it("keeps a job running when its host does not answer a poll", async () => {
    const harness = make_deployment();
    await harness.deployment.act("switch");
    harness.agent.poll_error = new AgentError("No agent named 'host' is connected", true);

    await cycle(harness);

    expect(harness.deployment.running_job()).not.toBeNull();
  });
});

// ── Switch from cache ────────────────────────────────────────────────────────

describe("switch from cache", () => {
  const from_cache = { switch_from_cache: true, cache_url: "https://cache.example/fleet" };

  it("waits for a successful evaluation", async () => {
    const harness = make_deployment(from_cache);
    expect(harness.deployment.action_refusal("switch")).toContain("successful evaluation");

    await collect(harness, { evaluation: result(1, "", "error: infinite recursion") });

    expect((await harness.deployment.act("switch")).ok).toBe(false);
  });

  it("activates the evaluated store path instead of rebuilding", async () => {
    const harness = make_deployment(from_cache);
    await collect(harness);

    expect((await harness.deployment.act("switch")).ok).toBe(true);

    const command = harness.deployment.running_job()!.command;
    expect(command).toContain(`copy --from https://cache.example/fleet ${target_closure}`);
    expect(command).toContain(`sudo -n ${target_closure}/bin/switch-to-configuration switch`);
    expect(command).not.toContain("nixos-rebuild");
  });

  it("is used by the automatic switch too", async () => {
    const harness = make_deployment({ ...from_cache, auto_switch: true, auto_switch_after: "30m" });
    await collect(harness, { metadata: metadata({ last_modified_epoch: clock.now - 3600 }) });
    rewind_drift(harness, 1801);
    await collect(harness);

    await cycle(harness);

    expect(harness.deployment.running_job()?.command).toContain(`nix-env -p /nix/var/nix/profiles/system --set ${target_closure}`);
  });
});

// ── Automatic switch ─────────────────────────────────────────────────────────

describe("automatic switch", () => {
  const automatic = { auto_switch: true, auto_switch_after: "30m" };

  // A flake changed after the running generation, so switching moves the host forward.
  const newer_flake = () => metadata({ last_modified_epoch: clock.now - 3600 });

  async function drift_long_enough(values: Record<string, unknown> = automatic) {
    const harness = make_deployment(values);
    await collect(harness, { metadata: newer_flake() });
    rewind_drift(harness, 1801);
    await collect(harness);
    return harness;
  }

  it("is off by default", async () => {
    const harness = await drift_long_enough({});

    await cycle(harness);

    expect(harness.deployment.running_job()).toBeNull();
  });

  it("waits out auto_switch_after", async () => {
    const harness = make_deployment(automatic);

    await collect(harness, { metadata: newer_flake() });

    expect(messages_of(harness).some((text) => text.includes("once the drift has lasted"))).toBe(true);
    expect(harness.deployment.busy()).toBe(false);
  });

  it("switches once the drift has lasted long enough", async () => {
    const harness = await drift_long_enough();

    await cycle(harness);

    const job = harness.deployment.running_job()!;
    expect([job.kind, job.trigger]).toEqual(["switch", "automatic"]);
    expect(job.command).toContain("nixos-rebuild switch --flake /etc/nixos");
  });

  it("never retries the same target", async () => {
    const harness = await drift_long_enough();
    await cycle(harness);
    harness.agent.end(harness.agent.last_run("switch")!, "error: build failed\n", 1);
    await cycle(harness);

    await collect(harness);

    expect(harness.deployment.busy()).toBe(false);
  });

  it("starts the wait over for a new target", async () => {
    const harness = await drift_long_enough();
    await cycle(harness);
    harness.agent.end(harness.agent.last_run("switch")!, "", 1);
    await cycle(harness);

    await collect(harness, { evaluation: result(0, `${newer_closure}\n`), metadata: newer_flake() });
    expect(harness.deployment.busy()).toBe(false);

    rewind_drift(harness, 1801);
    await collect(harness);
    await cycle(harness);
    expect(harness.deployment.running_job()?.trigger).toBe("automatic");
  });

  it("leaves alone a generation newer than the flake", async () => {
    const harness = make_deployment(automatic);
    await collect(harness, { probe: probe({ created_epoch: clock.now - 60 }) });
    rewind_drift(harness, 7200);

    await collect(harness, { probe: probe({ created_epoch: clock.now - 60 }) });

    expect(harness.deployment.busy()).toBe(false);
    expect(messages_of(harness).some((text) => text.includes("newer than the flake"))).toBe(true);
  });

  it("never switches on a failed evaluation", async () => {
    const harness = make_deployment(automatic);
    await collect(harness, { metadata: newer_flake() });
    rewind_evaluation(harness, 7200);
    await collect(harness, { evaluation: result(1, "", "error: undefined variable"), metadata: newer_flake() });
    rewind_drift(harness, 7200);

    await collect(harness);

    expect(harness.deployment.busy()).toBe(false);
  });

  it("clears the drift once the closure matches", async () => {
    const harness = make_deployment(automatic);
    await collect(harness);

    await collect(harness, { probe: probe({ current: target_closure }) });

    expect(harness.deployment.evaluation().drift_since_epoch).toBeNull();
  });

  it("tries again when the host did not answer, but not after a failed start", async () => {
    const unreachable = await drift_long_enough();
    unreachable.agent.start_error = new AgentError("No agent named 'host' is connected", true);
    await cycle(unreachable);
    expect(unreachable.deployment.running_job()).toBeNull();
    unreachable.agent.start_error = null;
    await collect(unreachable);
    await cycle(unreachable);
    expect(unreachable.deployment.running_job()?.trigger).toBe("automatic");

    const broken = await drift_long_enough();
    broken.agent.start_error = new AgentError("Could not start sh.");
    await cycle(broken);
    expect(broken.store.jobs()[0]).toMatchObject({ state: "failed", trigger: "automatic" });
    broken.agent.start_error = null;
    await collect(broken);
    expect(broken.deployment.busy()).toBe(false);
  });
});

// ── Daily jobs ───────────────────────────────────────────────────────────────

describe("daily jobs", () => {
  it("never start as soon as they are set", async () => {
    const harness = make_deployment({ update_at: "02:00", build_at: "02:30" });

    await collect(harness);

    expect(harness.deployment.scheduled_due()).toBeNull();
  });

  it("start a build once its slot has passed", async () => {
    const harness = make_deployment({ build_at: "02:30" });
    await collect(harness);
    rewind_schedule(harness, "build");

    await cycle(harness);

    const job = harness.deployment.running_job()!;
    expect([job.kind, job.trigger]).toEqual(["build", "schedule"]);
    expect(job.command).toContain("build --no-link");
  });

  it("run the update before the build", async () => {
    const harness = make_deployment({ update_at: "02:00", build_at: "02:30" });
    await collect(harness);
    rewind_schedule(harness, "update");
    rewind_schedule(harness, "build");

    await cycle(harness);
    expect(harness.deployment.running_job()?.kind).toBe("update");
    harness.agent.end(harness.agent.last_run("flake update")!, "done\n", 0);
    await cycle(harness);
    await cycle(harness);

    expect(harness.deployment.running_job()?.kind).toBe("build");
  });

  it("run several missed slots once, and not again after a restart", async () => {
    const harness = make_deployment({ build_at: "02:30" });
    await collect(harness);
    rewind_schedule(harness, "build", 3);
    await cycle(harness);
    harness.agent.end(harness.agent.last_run("build --no-link")!, "done\n", 0);
    await cycle(harness);

    expect(harness.deployment.scheduled_due()).toBeNull();
    expect(make_deployment({ build_at: "02:30" }, { store: harness.store }).deployment.scheduled_due()).toBeNull();
  });

  it("wait for a running job", async () => {
    const harness = make_deployment({ build_at: "02:30" });
    await collect(harness);
    await harness.deployment.act("switch");
    rewind_schedule(harness, "build");

    await cycle(harness);
    expect(harness.deployment.running_job()?.kind).toBe("switch");
    harness.agent.end(harness.agent.last_run("switch")!, "done\n", 0);
    await cycle(harness);
    await cycle(harness);

    expect(harness.deployment.running_job()?.kind).toBe("build");
  });

  it("try again when the host did not answer, but not after a failed start", async () => {
    const unreachable = make_deployment({ build_at: "02:30" });
    await collect(unreachable);
    rewind_schedule(unreachable, "build");
    unreachable.agent.start_error = new AgentError("No agent named 'host' is connected", true);
    await cycle(unreachable);
    expect(unreachable.deployment.scheduled_due()).not.toBeNull();

    const broken = make_deployment({ build_at: "02:30" });
    await collect(broken);
    rewind_schedule(broken, "build");
    broken.agent.start_error = new AgentError("Could not start sh.");
    await cycle(broken);
    expect(broken.deployment.scheduled_due()).toBeNull();
    expect(broken.store.jobs()[0].state).toBe("failed");
  });

  it("never update a flake X-Nix cannot write, and say so", async () => {
    const harness = make_deployment({ flake: "github:owner/config", update_at: "02:00" });
    await collect(harness);
    rewind_schedule(harness, "update");

    await collect(harness);

    expect(harness.deployment.scheduled_due()).toBeNull();
    expect(status_of(harness)).toBe("warning");
    expect(messages_of(harness).some((text) => text.includes("Scheduled update never runs"))).toBe(true);
  });

  it("reject a time that is not a time of day", () => {
    expect(() => make_deployment({ build_at: "half past two" })).toThrow(/build_at/);
  });

  it("take the latest slot, never one in the future", () => {
    const one_am = new Date(2026, 9, 10, 1, 0).getTime() / 1000;

    expect(latest_slot({ hour: 2, minute: 30 }, one_am)).toBe(new Date(2026, 9, 9, 2, 30).getTime() / 1000);
    expect(latest_slot({ hour: 0, minute: 30 }, one_am)).toBe(new Date(2026, 9, 10, 0, 30).getTime() / 1000);
  });
});
