import { describe, expect, it } from "vitest";

import { AgentError, AgentPool } from "../src/server/agents/agent.ts";
import { Cache } from "../src/server/cache.ts";
import { cache_settings, deployment_settings, flake_settings, host_settings } from "../src/server/config.ts";
import { Deployment, latest_slot } from "../src/server/deployment.ts";
import { report_mark } from "../src/server/nixos/attic.ts";
import { Store } from "../src/server/store.ts";
import {
  announcement, clock, collect, current_closure, cycle, eval_output, FakeAgent, generations_result, kernel, make_deployment, messages_of, metadata, new_kernel, probe, result,
  mark_line, rewind_drift, rewind_evaluation, rewind_schedule, shown_command, status_of, target_closure,
} from "./fake_agent.ts";
import { command_marker_token, innermost, marker_token_of, unfetchable_exit_code, type SwitchOperation } from "../src/shared/operations.ts";

const matching = result(0, `${current_closure}\n`);
const newer_closure = "/nix/store/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-nixos-system-host-26.11";

// Saves an evaluation that names this system, as a finished evaluation would.
function evaluated(store: Store, deployment_id: string, target = target_closure, values: Record<string, unknown> = {}): void {
  store.save_evaluation(deployment_id, { ...store.evaluation<Record<string, unknown>>(deployment_id), target, evaluated_epoch: clock.now, ...values });
}

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
    expect(harness.agent.long_runs).toHaveLength(1);
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
    expect(shown_command(job.command)).toContain("nixos-rebuild switch --flake /etc/nixos");
  });

  it("switches a remote flake", async () => {
    const harness = make_deployment({ flake: "github:owner/config" });

    expect((await harness.deployment.act("switch")).ok).toBe(true);
  });

  it("builds and switches a remote flake at the commit it evaluated, so a branch that moves meanwhile changes neither", async () => {
    const harness = make_deployment({ flake: "github:owner/config/main", configuration: "laptop", magic_rollback: true });
    const revision = "a".repeat(40);
    await collect(harness, { metadata: metadata({ revision }) });

    await harness.deployment.act("switch");

    const command = shown_command(harness.deployment.running_job()!.command);
    expect(command).toContain(`build --no-link`);
    expect(command).toContain(`'github:owner/config?rev=${revision}#nixosConfigurations."laptop".config.system.build.toplevel'`);
    expect(command).toContain(`nixos-rebuild switch --flake 'github:owner/config?rev=${revision}#laptop'`);
    expect(command).not.toContain("github:owner/config/main");
  });

  it("switches a remote flake as it is when nothing has been evaluated yet", async () => {
    const harness = make_deployment({ flake: "github:owner/config" });

    await harness.deployment.act("switch");

    expect(shown_command(harness.deployment.running_job()!.command)).toContain("nixos-rebuild switch --flake github:owner/config ");
  });

  it("switches a local checkout as it is on disk, uncommitted changes included", async () => {
    const harness = make_deployment();
    await collect(harness, { metadata: metadata({ revision: "a".repeat(40) }) });

    await harness.deployment.act("switch");

    const command = shown_command(harness.deployment.running_job()!.command);
    expect(command).toContain("nixos-rebuild switch --flake /etc/nixos ");
    expect(command).not.toContain("rev=");
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
    expect(harness.agent.ran("sudo -n systemctl reboot")).toBe(true);
    expect(harness.deployment.running_job()).toBeNull();
    const job = harness.store.jobs()[0];
    expect([job.kind, job.state, shown_command(job.command).split("\n")[1]]).toEqual(["reboot", "succeeded", "sudo -n systemctl reboot"]);
  });

  it("reboots without sudo when require_sudo is off", async () => {
    const harness = make_deployment({ require_sudo: false });

    await harness.deployment.act("reboot");

    expect(harness.agent.ran("systemctl reboot")).toBe(true);
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

  it("runs the build on the most preferred build agent that is connected, else one that can be woken", () => {
    const agents = new AgentPool("server", new FakeAgent());
    const settings = deployment_settings({ id: "pi", host: "pi", build_agent: ["odin", "thor", "server"] });
    const deployment = new Deployment(settings, { store: new Store(":memory:"), agents, now: () => clock.now });
    expect(deployment.agent_for("build")).toBe("server");

    agents.add("odin", new FakeAgent());
    expect(deployment.agent_for("build")).toBe("odin");

    agents.set_wake(new Map([["thor", { mac: "aa:bb:cc:dd:ee:ff", broadcast: "127.0.0.1", port: 9, timeout: 60, via: null, screen_off: null }]]));
    agents.remove("odin");
    expect(agents.pick(["odin", "thor"])).toBe("thor");
    expect(agents.pick(["odin", "thor"], false)).toBe("odin");
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

// ── Building elsewhere ───────────────────────────────────────────────────────

describe("building elsewhere", () => {
  // A deployment whose cache builds on another host, as Odin builds for the fleet.
  function with_builder(values: Record<string, unknown> = {}) {
    const store = new Store(":memory:");
    const agent = new FakeAgent();
    const cache = new Cache(cache_settings({ id: "fleet", name: "Fleet", host: "builder", flake: "/etc/nixos", configurations: ["host"], cache_url: "https://cache.example/fleet/", info_url: false }), {
      store, agents: new AgentPool("host", agent), now: () => clock.now,
    });
    const harness = make_deployment({ configuration: "host", cache: "fleet", ...values }, { store, agent, caches: [cache] });
    const builder = new FakeAgent();
    harness.agents.add("builder", builder);
    evaluated(store, harness.deployment.id);
    return { ...harness, cache, builder };
  }

  // Starts an action that builds on the builder first, and ends that build with the system it made.
  async function built(harness: ReturnType<typeof with_builder>, action: "switch" | "boot" | "test" = "switch") {
    const outcome = await harness.deployment.act(action);
    harness.builder.end(harness.builder.last_run('"kind":"cache_build"')!, `${target_closure}\n`, 0);
    await harness.deployment.cycle();
    return outcome;
  }

  it("reads the cache's build of the system into the build job's counts and tree", async () => {
    const harness = with_builder();
    const outcome = await harness.deployment.act("build");
    const run = harness.builder.last_run('"kind":"cache_build"')!;
    expect(run.command).toContain("internal-json");
    const hello = "/nix/store/dddddddddddddddddddddddddddddddd-hello-2.12.drv";
    const message = (msg: string) => `@nix ${JSON.stringify({ action: "msg", level: 3, msg })}\n`;
    harness.builder.write(run, message("this derivation will be built:") + message(`  ${hello}`)
      + `@nix ${JSON.stringify({ action: "start", id: 5, type: 105, fields: [hello] })}\n`);

    await harness.deployment.cycle();

    const job = harness.store.job(outcome.job_id!)!;
    expect(job.progress).toBe("Built 0, building 1; downloaded 0");
    expect(JSON.parse(job.live!).planned[hello]).toMatchObject({ kind: "build", state: "building" });
  });

  it("builds a switch on the cache's first host, which pushes it, then fetches and activates it under the same job", async () => {
    const harness = with_builder();

    const outcome = await harness.deployment.act("switch");

    expect(outcome).toMatchObject({ ok: true, message: "Building on builder first; the switch starts once it is built" });
    expect(harness.store.job(outcome.job_id!)).toMatchObject({ kind: "switch", state: "running", progress: "Building on builder" });
    const build = harness.builder.last_run('"kind":"cache_build"')!;
    expect(harness.agent.last_run('"kind":"evaluate"')).toBeUndefined();
    expect(harness.cache.running_job()).toBeNull();

    harness.builder.end(build, `${target_closure}\n`, 0);
    await harness.deployment.cycle();

    const switching = harness.agent.last_run("switch-to-configuration")!;
    expect(switching.run_id).toBe(harness.store.job(outcome.job_id!)!.run_id);
    expect(shown_command(switching.command)).toContain(`build --no-link --log-format internal-json -v ${target_closure}`);
    expect(shown_command(switching.command)).toContain(`sudo -n nix-env -p /nix/var/nix/profiles/system --set ${target_closure}`);
    expect(shown_command(switching.command)).not.toContain("nixos-rebuild");
    expect(harness.store.job(outcome.job_id!)!.output).toContain("The cache holds the system; switching");
    expect(harness.deployment.evaluation().switch_wait).toBeUndefined();
  });

  it("waits to build while another system builds on the same host, then builds", async () => {
    const harness = with_builder();
    const other = harness.store.create_job({ deployment_id: "other", kind: "build", command: "{}", agent: "builder", run_id: "other-build", trigger: "automatic", started_epoch: 0 });

    const outcome = await harness.deployment.act("switch");

    expect(outcome.ok).toBe(true);
    expect(harness.builder.last_run('"kind":"cache_build"')).toBeUndefined();
    expect(harness.store.job(outcome.job_id!)).toMatchObject({ state: "running", progress: `Waiting to build on builder: job #${other} of other is building there` });

    harness.store.finish_job(other, "succeeded", 0, null, clock.now);
    await harness.deployment.cycle();

    expect(harness.builder.last_run('"kind":"cache_build"')).toBeDefined();
    expect(harness.store.job(outcome.job_id!)!.progress).toBe("Building on builder");
  });

  it("holds a Build while another system builds on the same host, then starts it under the same job", async () => {
    const harness = with_builder();
    const other = harness.store.create_job({ deployment_id: "other", kind: "build", command: "{}", agent: "builder", run_id: "other-build", trigger: "automatic", started_epoch: 0 });

    const outcome = await harness.deployment.act("build");

    expect(outcome).toMatchObject({ ok: true, message: `Build waits: job #${other} of other is building there; it starts once that ends` });
    expect(harness.builder.last_run('"kind":"cache_build"')).toBeUndefined();
    expect(harness.store.job(outcome.job_id!)).toMatchObject({ kind: "build", state: "running", run_id: null, progress: `Waiting to build on builder: job #${other} of other is building there` });
    expect(await harness.deployment.act("build")).toMatchObject({ ok: false, message: "A job is already running for this deployment" });

    await harness.deployment.cycle();
    expect(harness.builder.last_run('"kind":"cache_build"')).toBeUndefined();
    harness.store.finish_job(other, "succeeded", 0, null, clock.now);
    await harness.deployment.cycle();

    const run = harness.builder.last_run('"kind":"cache_build"')!;
    expect(harness.store.job(outcome.job_id!)).toMatchObject({ state: "running", run_id: run.run_id, progress: "Building on builder" });
    expect(harness.deployment.evaluation().held_build).toBeUndefined();
    harness.builder.end(run, `${target_closure}\n`, 0);
    await harness.deployment.cycle();
    expect(harness.store.job(outcome.job_id!)!.state).toBe("succeeded");
  });

  it("lets a held Build be stopped before it starts, and never starts it", async () => {
    const harness = with_builder();
    const other = harness.store.create_job({ deployment_id: "other", kind: "build", command: "{}", agent: "builder", run_id: "other-build", trigger: "automatic", started_epoch: 0 });
    const outcome = await harness.deployment.act("build");

    expect(await harness.deployment.stop_held_build(outcome.job_id!, "admin")).toEqual({ ok: true, message: `Stopped job #${outcome.job_id}`, job_id: outcome.job_id });
    expect(await harness.deployment.stop_held_build(outcome.job_id!, "admin")).toBeNull();
    harness.store.finish_job(other, "succeeded", 0, null, clock.now);
    await harness.deployment.cycle();

    expect(harness.store.job(outcome.job_id!)).toMatchObject({ state: "failed", error: "admin stopped it before it started" });
    expect(harness.builder.last_run('"kind":"cache_build"')).toBeUndefined();
  });

  it("builds at once beside a Build that is only held, which builds nothing yet", async () => {
    const harness = with_builder();
    harness.store.create_job({ deployment_id: "other", kind: "build", command: "{}", agent: "builder", run_id: null, trigger: "manual", started_epoch: 0 });

    await harness.deployment.act("switch");

    expect(harness.builder.last_run('"kind":"cache_build"')).toBeDefined();
  });

  it("fails a held Build whose host cannot start it, with why", async () => {
    const harness = with_builder();
    const other = harness.store.create_job({ deployment_id: "other", kind: "build", command: "{}", agent: "builder", run_id: "other-build", trigger: "automatic", started_epoch: 0 });
    const outcome = await harness.deployment.act("build");
    harness.store.finish_job(other, "succeeded", 0, null, clock.now);
    harness.builder.start_error = new AgentError("The builder hung up");

    await harness.deployment.cycle();

    expect(harness.store.job(outcome.job_id!)).toMatchObject({ state: "failed", error: "The job could not be started" });
    expect(harness.deployment.evaluation().held_build).toBeUndefined();
  });

  it("activates boot and test from what the build pushed too", async () => {
    const harness = with_builder();

    await built(harness, "boot");
    const boot = harness.deployment.running_job()!;
    harness.agent.end(harness.agent.last_run("switch-to-configuration")!, "", 0);
    await cycle(harness);
    await built(harness, "test");

    expect(shown_command(boot.command)).toContain(`--set ${target_closure}\nsudo -n ${target_closure}/bin/switch-to-configuration boot`);
    expect(shown_command(harness.deployment.running_job()!.command)).toContain(`${target_closure}/bin/switch-to-configuration test`);
    expect(shown_command(harness.deployment.running_job()!.command)).not.toContain("nixos-rebuild");
  });

  it("guards a fetched switch on the host's own agent, which confirms it, and runs post_switch as root", async () => {
    const harness = with_builder({ pre_switch_checks: ["true"], magic_rollback: true, post_switch: "systemctl restart greetd" });

    await built(harness);
    const run = harness.agent.last_run('"pre_switch_checks":["true"]')!;
    harness.agent.write(run, "@@x-nix-switch activated\n@@x-nix-switch awaiting-confirmation\n");
    await cycle(harness);

    const operation = innermost(run.operation) as SwitchOperation;
    expect(operation.watch?.magic_rollback).toBe(true);
    expect(operation.activation_name).toBe("The switch from the cache");
    expect(run.command).toContain(`sudo -n ${target_closure}/bin/switch-to-configuration switch`);
    expect(run.command).toContain("sudo -n /bin/sh -c 'systemctl restart greetd'");
    expect(harness.agent.operations.some((sent) => sent.kind === "confirm_switch" && sent.token === operation.watch?.token)).toBe(true);
  });

  it("keeps the host awake through the whole fetched switch with inhibit_sleep", async () => {
    const harness = with_builder({ inhibit_sleep: true });

    await built(harness);

    const command = shown_command(harness.deployment.running_job()!.command);
    expect(command).toContain("sudo -n systemd-inhibit --what=sleep --mode=block --who=X-Nix --why=switching cat");
    expect(command.indexOf("systemd-inhibit")).toBeLessThan(command.indexOf("build --no-link"));
  });

  it("shows the output of the build it waits on as the build prints it, and fails without starting when the build fails", async () => {
    const harness = with_builder();
    const outcome = await harness.deployment.act("switch");
    const build = harness.builder.last_run('"kind":"cache_build"')!;

    harness.builder.write(build, "building hello\nhalf");
    await harness.deployment.cycle();
    expect(harness.store.job(outcome.job_id!)!.output).toMatch(/first, job #\d+\nbuilding hello\n$/);

    harness.builder.end(build, " done\nerror: build failed", 1);
    await harness.deployment.cycle();
    await harness.deployment.cycle();

    const output = harness.store.job(outcome.job_id!)!.output;
    expect(output.match(/building hello/g)).toHaveLength(1);
    expect(output).toContain("building hello\nhalf done\nerror: build failed\nThe build on builder failed");
    expect(harness.store.job(outcome.job_id!)).toMatchObject({ state: "failed", error: "The build on builder failed: Exited with status 1" });
    expect(harness.agent.last_run("switch-to-configuration")).toBeUndefined();
    expect(harness.deployment.running_job()).toBeNull();
  });

  it("waits for a system built on another build agent to reach the cache, and gives up in time", async () => {
    const agents = new AgentPool("host", new FakeAgent());
    const builder = new FakeAgent();
    agents.add("builder", builder);
    const own = agents.get(null) as FakeAgent;
    const store = new Store(":memory:");
    const deployment = new Deployment(deployment_settings({ id: "host-deploy", cache_url: "https://cache.example/fleet", build_agent: "builder" }), { store, agents, now: () => clock.now });
    evaluated(store, deployment.id);
    const lacking: [string, ReturnType<typeof result>] = ['"kind":"cache_holds"', result(1)];
    own.answers.push(lacking);
    builder.answers.push(lacking);

    const outcome = await deployment.act("switch");
    builder.end(builder.last_run('"kind":"build"')!, `${target_closure}\n`, 0);
    await deployment.cycle();

    expect(store.job(outcome.job_id!)!.progress).toBe(`Waiting for ${target_closure} to reach the cache`);
    expect(own.last_run("switch-to-configuration")).toBeUndefined();

    own.answers.splice(0);
    builder.answers.splice(0);
    await deployment.cycle();
    expect(own.last_run("switch-to-configuration")?.run_id).toBe(store.job(outcome.job_id!)!.run_id);

    own.answers.push(lacking);
    builder.answers.push(lacking);
    store.finish_job(outcome.job_id!, "succeeded", 0, null, clock.now);
    const late = await deployment.act("test");
    builder.end(builder.last_run('"kind":"build"')!, `${target_closure}\n`, 0);
    await deployment.cycle();
    const waiting = deployment.evaluation();
    waiting.switch_wait!.since_epoch -= 901;
    store.save_evaluation(deployment.id, waiting);
    await deployment.cycle();
    expect(store.job(late.job_id!)!.error).toContain("was built but never reached the cache");
  });

  it("says when the cache holds the system but the host cannot fetch all of it", async () => {
    const agents = new AgentPool("host", new FakeAgent());
    const builder = new FakeAgent();
    agents.add("builder", builder);
    const own = agents.get(null) as FakeAgent;
    const store = new Store(":memory:");
    const deployment = new Deployment(deployment_settings({ id: "host-deploy", cache_url: "https://cache.example/fleet", build_agent: "builder" }), { store, agents, now: () => clock.now });
    evaluated(store, deployment.id);
    own.answers.push(['"kind":"cache_holds"', result(unfetchable_exit_code)]);

    const outcome = await deployment.act("switch");
    builder.end(builder.last_run('"kind":"build"')!, `${target_closure}\n`, 0);
    await deployment.cycle();
    expect(store.job(outcome.job_id!)!.progress).toBe(`${target_closure} is in the cache, but host cannot fetch all of it yet; it may still hold a miss from before the push`);

    const waiting = deployment.evaluation();
    waiting.switch_wait!.since_epoch -= 901;
    store.save_evaluation(deployment.id, waiting);
    await deployment.cycle();
    expect(store.job(outcome.job_id!)!.error).toContain("reached the cache, but host could not fetch all of it");
  });

  it("runs Build on the cache's first host, as the cache's build that pushes it, at the pin when there is one", async () => {
    const harness = with_builder();

    expect((await harness.deployment.act("build")).ok).toBe(true);

    expect(harness.deployment.running_job()).toMatchObject({ kind: "build", agent: "builder" });
    expect(innermost(harness.builder.last_run('"kind":"cache_build"')!.operation)).toMatchObject({ cache: { flake: "/etc/nixos" } });
    expect(harness.cache.running_job()).toBeNull();

    const pinned = with_builder({ flake: "github:example/nixos-config", pin: "v1" });
    expect((await pinned.deployment.act("build")).ok).toBe(true);
    const build = innermost(pinned.builder.last_run('"kind":"cache_build"')!.operation);
    expect(build).toMatchObject({ cache: { flake: "github:example/nixos-config?ref=v1", push_command: null } });
  });

  it("builds on the host itself or on the server, as direct_on says", async () => {
    const on_host = with_builder({ direct_on: "host" });
    expect((await on_host.deployment.act("switch")).message).toBe("Switch started");
    expect(on_host.agent.last_run("nixos-rebuild switch")).toBeDefined();
    expect(on_host.builder.long_runs).toHaveLength(0);

    const on_server = with_builder({ direct_on: "server" });
    expect((await on_server.deployment.act("build")).ok).toBe(true);
    expect(on_server.deployment.running_job()?.agent).toBeNull();
    expect(on_server.builder.long_runs).toHaveLength(0);

    expect(() => with_builder({ direct_on: "elsewhere" })).toThrow("`direct_on` of deployment 'host-deploy' must be one of host, server, ranked");
  });

  it("runs nixos-rebuild at once when it builds on the switching host, as with no build agent elsewhere", async () => {
    const harness = make_deployment({ cache_url: "https://cache.example/fleet" });

    const outcome = await harness.deployment.act("switch");

    expect(outcome).toMatchObject({ ok: true, message: "Switch started" });
    expect(shown_command(harness.deployment.running_job()!.command)).toContain("nixos-rebuild switch");
    expect(harness.deployment.evaluation().switch_wait).toBeUndefined();
  });

  it("refuses a switch built on another host when no cache_url brings the system back", () => {
    const harness = make_deployment({ build_agent: "builder" });
    harness.agents.add("builder", new FakeAgent());

    expect(harness.deployment.action_refusal("switch")).toBe("direct_on builds on builder, which needs a cache_url to bring the system to host");
    expect(harness.deployment.action_refusal("build")).toBeNull();
  });

  it("ends a switch still building first when another switch starts, which takes over its build", async () => {
    const harness = with_builder();
    const waiting = await harness.deployment.act("switch");
    const first_build = harness.deployment.evaluation().switch_wait!.step_job_id!;
    expect(harness.deployment.action_refusal("test")).toBeNull();
    expect(harness.deployment.action_refusal("reboot")).toBe("A job is already running for this deployment");

    const outcome = await harness.deployment.act("test");

    expect(outcome).toMatchObject({ ok: true, message: "Building on builder first; the test switch starts once it is built" });
    expect(harness.store.job(waiting.job_id!)).toMatchObject({ state: "failed", error: `A test switch took its place before it started, taking over its build #${first_build}` });
    expect(harness.deployment.evaluation().switch_wait).toMatchObject({ job_id: outcome.job_id, step_job_id: first_build });
    expect(harness.builder.long_runs.filter((run) => run.command.includes('"kind":"cache_build"'))).toHaveLength(1);
    expect(await harness.deployment.act("build")).toMatchObject({ ok: true, message: `Build already running, job #${first_build}`, job_id: first_build });

    harness.builder.end(harness.builder.last_run('"kind":"cache_build"')!, `${target_closure}\n`, 0);
    await harness.deployment.cycle();
    expect(harness.agent.last_run("switch-to-configuration")?.run_id).toBe(harness.store.job(outcome.job_id!)!.run_id);
  });

  it("builds elsewhere first for an automatic switch too, once per target", async () => {
    const harness = with_builder({ cache: undefined, cache_url: "https://cache.example/fleet/", auto_switch: true, auto_switch_after: "30m" });
    rewind_evaluation(harness, 7200);
    await collect(harness, { metadata: metadata({ last_modified_epoch: clock.now - 3600 }) });
    rewind_drift(harness, 1801);
    await collect(harness);

    await cycle(harness);

    const job = harness.store.jobs({ kind: "switch" })[0];
    expect(job).toMatchObject({ trigger: "automatic", state: "running", progress: "Building on builder" });
    expect(harness.deployment.evaluation().auto_switch_target).toBe(target_closure);
    expect(harness.agent.last_run("switch-to-configuration")).toBeUndefined();

    harness.builder.end(harness.builder.last_run('"kind":"cache_build"')!, `${target_closure}\n`, 0);
    await harness.deployment.cycle();
    expect(harness.agent.last_run("switch-to-configuration")?.run_id).toBe(job.run_id);
  });

  it("ends a switch an older X-Nix left waiting on the cache's queue", async () => {
    const harness = with_builder();
    const outcome = await harness.deployment.act("switch");
    const evaluation = harness.deployment.evaluation();
    // Its step's job ran in the cache, so the switch's own job is the deployment's running one.
    harness.store.finish_job(evaluation.switch_wait!.step_job_id!, "succeeded", 0, null, clock.now);
    evaluation.switch_wait = { ...evaluation.switch_wait!, step: "cache-build" as never, step_job_id: null };
    harness.store.save_evaluation(harness.deployment.id, evaluation);

    await harness.deployment.cycle();

    expect(harness.store.job(outcome.job_id!)).toMatchObject({ state: "failed", error: "X-Nix no longer waits on the cache this way (cache-build); switch again" });
  });

  it("activates nothing when the build made another system than the evaluation named, and evaluates again", async () => {
    const harness = with_builder();
    const other_host_system = "/nix/store/ffffffffffffffffffffffffffffffff-nixos-system-other-26.11";
    for (const printed of [`${newer_closure}\n`, `${report_mark}\thost\ttarget\t${other_host_system}\n`]) {
      const outcome = await harness.deployment.act("switch");
      harness.builder.end(harness.builder.last_run('"kind":"cache_build"')!, printed, 0);
      await harness.deployment.cycle();

      const built = printed.includes(report_mark) ? other_host_system : newer_closure;
      const job = harness.store.job(outcome.job_id!)!;
      expect(job.state).toBe("failed");
      expect(job.error).toBe(`The build made ${built}, but the flake evaluates to ${target_closure}; only the evaluated system is activated; nothing was activated, so evaluate and switch again`);
      expect(harness.deployment.evaluation().switch_wait).toBeUndefined();
      expect(harness.store.events(harness.deployment.id).some((event) => event.message.startsWith(`Switch failed: The build made ${built}`))).toBe(true);
    }
    expect(harness.agent.long_runs.some((run) => run.command.includes("switch-to-configuration"))).toBe(false);
    expect(harness.agent.operations.some((operation) => innermost(operation).kind === "switch")).toBe(false);
    expect(harness.agent.operations.some((operation) => operation.kind === "cache_holds")).toBe(false);
  });

  it("evaluates again after a build that made another system, and refuses a switch built elsewhere before any evaluation", async () => {
    const agents = new AgentPool("host", new FakeAgent());
    const builder = new FakeAgent();
    agents.add("builder", builder);
    const store = new Store(":memory:");
    const deployment = new Deployment(deployment_settings({ id: "host-deploy", cache_url: "https://cache.example/fleet", build_agent: "builder" }), { store, agents, now: () => clock.now });
    expect((await deployment.act("switch")).message).toBe("The flake has not been evaluated yet, and a system built on builder is only activated once it matches the evaluation");
    expect(builder.long_runs).toHaveLength(0);

    evaluated(store, deployment.id);
    expect(deployment.due_for_evaluation()).toBe(false);
    const outcome = await deployment.act("switch");
    builder.end(builder.last_run('"kind":"build"')!, `${newer_closure}\n`, 0);
    await deployment.cycle();

    expect(store.job(outcome.job_id!)!.state).toBe("failed");
    expect(deployment.due_for_evaluation()).toBe(true);
    expect((agents.get(null) as FakeAgent).long_runs).toHaveLength(0);
  });

  it("fails cleanly on a build that names something other than a store path, activating nothing", async () => {
    const harness = with_builder();
    const outcome = await harness.deployment.act("switch");
    harness.builder.end(harness.builder.last_run('"kind":"cache_build"')!, `${report_mark}\thost\ttarget\t/etc/../tmp/system\n`, 0);
    await harness.deployment.cycle();
    expect(harness.store.job(outcome.job_id!)).toMatchObject({ state: "failed", error: "The build on builder finished without naming the system it built" });

    const waiting = await harness.deployment.act("switch");
    const evaluation = harness.deployment.evaluation();
    harness.store.finish_job(evaluation.switch_wait!.step_job_id!, "succeeded", 0, null, clock.now);
    evaluation.switch_wait = { ...evaluation.switch_wait!, step: "push", step_job_id: null, target: "/tmp/system" };
    harness.store.save_evaluation(harness.deployment.id, evaluation);
    await harness.deployment.cycle();

    expect(harness.store.job(waiting.job_id!)).toMatchObject({ state: "failed" });
    expect(harness.store.job(waiting.job_id!)!.error).toContain('The build named "/tmp/system" as the system it built, which is not a store path');
    expect(harness.deployment.evaluation().switch_wait).toBeUndefined();
    expect(harness.deployment.running_job()).toBeNull();
    expect(harness.agent.long_runs.some((run) => run.command.includes("switch-to-configuration"))).toBe(false);
  });

  it("builds the commit it evaluated, for a switch, a Build and a cache's build, even once the branch has moved", async () => {
    const revision = "a".repeat(40);
    const agents = new AgentPool("host", new FakeAgent());
    const builder = new FakeAgent();
    agents.add("builder", builder);
    const store = new Store(":memory:");
    const deployment = new Deployment(deployment_settings({
      id: "host-deploy", flake: "github:owner/config/main", configuration: "host", cache_url: "https://cache.example/fleet", build_agent: "builder",
    }), { store, agents, now: () => clock.now });
    evaluated(store, deployment.id, target_closure, { flake_revision: revision });

    await deployment.act("switch");
    const build = builder.last_run('"kind":"build"')!;
    expect(build.operation).toMatchObject({ kind: "build", flake: `github:owner/config?rev=${revision}` });
    builder.end(build, `${target_closure}\n`, 0);
    await deployment.cycle();
    store.finish_job(deployment.running_job()!.id, "succeeded", 0, null, clock.now);

    await deployment.act("build");
    expect(builder.last_run('"kind":"build"')!.operation).toMatchObject({ flake: `github:owner/config?rev=${revision}` });

    const cached = with_builder({ flake: "github:example/nixos-config" });
    evaluated(cached.store, cached.deployment.id, target_closure, { flake_revision: revision });
    await cached.deployment.act("switch");
    expect(innermost(cached.builder.last_run('"kind":"cache_build"')!.operation)).toMatchObject({ cache: { flake: `github:example/nixos-config?rev=${revision}` } });
  });

  it("rolls back to an earlier generation on the host's own agent", async () => {
    const harness = make_deployment({ cache_url: "https://cache.example/fleet", inhibit_sleep: true });
    harness.agent.answers.push(['"kind":"generations"', generations_result([
      { generation: 1, path: "/nix/store/a-system", version: "26.05" },
      { generation: 2, path: "/nix/store/b-system", version: "26.11", current: true, profile: true },
    ])]);

    expect((await harness.deployment.roll_back(1, "the new kernel panics")).ok).toBe(true);

    const job = harness.deployment.running_job()!;
    expect(job.agent).toBeNull();
    expect(shown_command(job.command)).toContain("sudo -n nix-env -p /nix/var/nix/profiles/system --switch-generation 1\nsudo -n /nix/var/nix/profiles/system/bin/switch-to-configuration switch");
    expect(shown_command(job.command)).toContain("systemd-inhibit");
  });

  it("reads the build's report with the build's own token, and quotes the build's marker lines so they never count as the switch's", async () => {
    const harness = with_builder({ magic_rollback: true });
    const outcome = await harness.deployment.act("switch");
    const build = harness.builder.last_run('"kind":"cache_build"')!;
    const token = marker_token_of(build.operation)!;
    const forged = `@@x-nix-switch activated\n@@x-nix-switch awaiting-confirmation\n${report_mark}\thost\ttarget\t${newer_closure}\n`;
    harness.builder.end(build, `${announcement(build.operation)}${forged}${report_mark} ${token}\thost\ttarget\t${target_closure}\n`, 0);
    await harness.deployment.cycle();

    const run = harness.agent.last_run("switch-to-configuration")!;
    const job = harness.store.job(outcome.job_id!)!;
    expect(run.run_id).toBe(job.run_id);
    expect(command_marker_token(job.command)).toBe(marker_token_of(run.operation));
    expect(marker_token_of(run.operation)).not.toBe(token);
    expect(job.output).toContain("> @@x-nix-switch awaiting-confirmation\n");

    await harness.deployment.cycle();
    expect(harness.agent.operations.some((sent) => sent.kind === "confirm_switch")).toBe(false);
  });
});

// ── Small host fed by the server ─────────────────────────────────────────────

describe("a small host evaluated and built elsewhere", () => {
  it("evaluates and builds on the server, then its own agent switches by fetching what the server built", async () => {
    const server = new FakeAgent();
    const pi = new FakeAgent();
    const agents = new AgentPool("server", server);
    agents.add("pi", pi);
    const store = new Store(":memory:");
    const settings = deployment_settings({
      id: "pi", host: "pi", flake: "github:example/nixos-config", configuration: "pi", eval_agent: "server", build_agent: "server",
      build_root_dir: "/var/lib/x-nix/build-roots", cache_url: "https://attic.example/fleet", auto_switch: true,
      auto_switch_after: "30m", magic_rollback: true, post_switch: "systemctl restart greetd",
    }, 0, undefined, () => host_settings({ id: "pi", keep_awake: true }));
    const deployment = new Deployment(settings, { store, agents, now: () => clock.now });

    await deployment.cycle();
    const evaluation = server.last_run('"kind":"evaluate"')!;
    server.end(evaluation, eval_output(result(0, `${target_closure}\n`), metadata()), 0);
    await deployment.cycle();
    expect(innermost(evaluation.operation)).toMatchObject({ kind: "evaluate", attribute: "pi", flake: "github:example/nixos-config", refresh: true });
    expect(pi.long_runs).toHaveLength(0);

    const drifting = deployment.evaluation();
    drifting.drift_since_epoch = clock.now - 1801;
    store.save_evaluation(deployment.id, drifting);
    await deployment.cycle();
    await deployment.cycle();
    const build = server.last_run('"kind":"build"')!;
    expect(build.operation).toMatchObject({ kind: "build", root_link: "/var/lib/x-nix/build-roots/pi", cache_url: "https://attic.example/fleet" });
    expect(pi.long_runs).toHaveLength(0);
    server.end(build, `${target_closure}\n`, 0);
    await deployment.cycle();

    const switching = pi.last_run("switch-to-configuration")!;
    expect(deployment.running_job()).toMatchObject({ kind: "switch", agent: "pi", trigger: "automatic" });
    expect(shown_command(switching.command)).toContain(`build --no-link --log-format internal-json -v ${target_closure}`);
    expect(shown_command(switching.command)).toContain(`sudo -n nix-env -p /nix/var/nix/profiles/system --set ${target_closure}`);
    expect(switching.command).toContain('"magic_rollback":true');
    expect(shown_command(switching.command)).toContain("systemd-inhibit");
    expect(shown_command(switching.command)).toContain("sudo -n /bin/sh -c ");
    expect(shown_command(switching.command)).not.toContain("nixos-rebuild");
    expect(server.long_runs.some((run) => run.command.includes("switch-to-configuration"))).toBe(false);
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
    expect(shown_command(job.command)).toContain("nixos-rebuild switch --flake /etc/nixos");
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

  // A deployment whose cache builds on another host, drifted long enough to switch by itself, with the builder away.
  async function drift_built_elsewhere() {
    const store = new Store(":memory:");
    const agent = new FakeAgent();
    const cache = new Cache(cache_settings({ id: "fleet", name: "Fleet", host: "builder", flake: "/etc/nixos", configurations: ["host"], cache_url: "https://cache.example/fleet/", info_url: false }), {
      store, agents: new AgentPool("host", agent), now: () => clock.now,
    });
    const harness = make_deployment({ configuration: "host", cache: "fleet", ...automatic }, { store, agent, caches: [cache] });
    evaluated(store, harness.deployment.id, target_closure, { flake_last_modified_epoch: clock.now - 3600 });
    await collect(harness);
    rewind_drift(harness, 1801);
    await collect(harness);
    return { ...harness, builder: new FakeAgent() };
  }

  const switch_jobs = (harness: { store: Store }) => harness.store.jobs().filter((job) => job.kind !== "eval");

  it("waits for an absent build agent without a failed job, then switches once it is back", async () => {
    const harness = await drift_built_elsewhere();

    await cycle(harness);

    expect(messages_of(harness)).toContain("Waiting to switch automatically: agent 'builder' is not connected");
    expect(switch_jobs(harness)).toEqual([]);
    expect(harness.deployment.busy()).toBe(false);

    harness.agents.add("builder", harness.builder);
    await collect(harness);
    await cycle(harness);

    expect(harness.store.jobs().find((job) => job.kind === "switch")).toMatchObject({ state: "running", trigger: "automatic" });
    expect(harness.builder.last_run('"kind":"cache_build"')).toBeDefined();
  });

  it("starts nothing when the build agent leaves between finding the switch due and starting it", async () => {
    const harness = await drift_built_elsewhere();
    harness.agents.add("builder", harness.builder);
    await collect(harness);
    harness.agents.remove("builder");

    await cycle(harness);

    expect(switch_jobs(harness)).toEqual([]);
    harness.agents.add("builder", harness.builder);
    await collect(harness);
    await cycle(harness);
    expect(harness.store.jobs().find((job) => job.kind === "switch")).toMatchObject({ state: "running", trigger: "automatic" });
  });

  it("never retries a target whose build failed", async () => {
    const harness = await drift_built_elsewhere();
    harness.agents.add("builder", harness.builder);
    await collect(harness);
    await cycle(harness);
    harness.builder.end(harness.builder.last_run('"kind":"cache_build"')!, "error: build failed\n", 1);
    await cycle(harness);
    expect(switch_jobs(harness).every((job) => job.state === "failed")).toBe(true);

    await collect(harness);
    await cycle(harness);

    expect(harness.deployment.busy()).toBe(false);
    expect(harness.builder.long_runs.filter((run) => run.command.includes('"kind":"cache_build"'))).toHaveLength(1);
  });
});

// ── Daily jobs ───────────────────────────────────────────────────────────────

describe("daily jobs", () => {
  it("never start as soon as they are set", async () => {
    const harness = make_deployment({ build_at: "02:30" });

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
    expect(JSON.parse(job.command)).toMatchObject({ kind: "build", root_link: null });
  });

  it("run several missed slots once, and not again after a restart", async () => {
    const harness = make_deployment({ build_at: "02:30" });
    await collect(harness);
    rewind_schedule(harness, "build", 3);
    await cycle(harness);
    harness.agent.end(harness.agent.last_run('"kind":"build"')!, "done\n", 0);
    await cycle(harness);

    expect(harness.deployment.scheduled_due()).toBeNull();
    expect(make_deployment({ build_at: "02:30" }, { store: harness.store }).deployment.scheduled_due()).toBeNull();
  });

  it("hold a build while another system builds on the host, and count its slot as handled", async () => {
    const harness = make_deployment({ build_at: "02:30" });
    await collect(harness);
    const other = harness.store.create_job({ deployment_id: "other", kind: "build", command: "{}", agent: "host", run_id: "other-build", trigger: "automatic", started_epoch: 0 });
    rewind_schedule(harness, "build");

    await cycle(harness);

    const job = harness.deployment.running_job()!;
    expect([job.kind, job.trigger, job.run_id]).toEqual(["build", "schedule", null]);
    expect(harness.deployment.scheduled_due()).toBeNull();
    expect(harness.agent.last_run('"kind":"build"')).toBeUndefined();
    harness.store.finish_job(other, "succeeded", 0, null, clock.now);
    await cycle(harness);
    expect(harness.agent.last_run('"kind":"build"')).toBeDefined();
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

  it("reject a time that is not a time of day", () => {
    expect(() => make_deployment({ build_at: "half past two" })).toThrow(/build_at/);
  });

  it("take the latest slot, never one in the future", () => {
    const one_am = new Date(2026, 9, 10, 1, 0).getTime() / 1000;

    expect(latest_slot({ hour: 2, minute: 30 }, one_am)).toBe(new Date(2026, 9, 9, 2, 30).getTime() / 1000);
    expect(latest_slot({ hour: 0, minute: 30 }, one_am)).toBe(new Date(2026, 9, 10, 0, 30).getTime() / 1000);
  });
});

// ── Safer switches ───────────────────────────────────────────────────────────

describe("safer switches", () => {
  const guarded = { magic_rollback: true, health_urls: ["https://host.example/health"], health_timeout: "2m" };

  // Starts a guarded switch and has it print that it awaits confirmation.
  async function awaiting(values: Record<string, unknown> = guarded, http_check: (url: string) => Promise<string | null> = async () => null) {
    const harness = make_deployment(values, { http_check });
    await harness.deployment.act("switch");
    const run = harness.agent.last_run('"watch":{')!;
    harness.agent.write(run, "@@x-nix-switch activated\n@@x-nix-switch awaiting-confirmation\n");
    return { harness, run };
  }

  it("runs each mode as its own job, and dry activation unguarded", async () => {
    const harness = make_deployment(guarded);

    await harness.deployment.act("dry-activate");

    const job = harness.deployment.running_job()!;
    expect(job.kind).toBe("dry-activate");
    expect(JSON.parse(job.command)).toMatchObject({ kind: "switch", mode: "dry-activate", watch: null, pre_switch_checks: [] });
    expect(shown_command(job.command).split("\n").slice(1)).toEqual(["sudo -n nixos-rebuild dry-activate --flake /etc/nixos --log-format internal-json"]);
  });

  it("confirms a switch once its HTTP checks pass, and only once", async () => {
    const { harness } = await awaiting();

    await cycle(harness);
    await cycle(harness);

    expect(harness.agent.commands.filter((command) => command.includes('"kind":"confirm_switch"'))).toHaveLength(1);
    expect(harness.store.job(harness.deployment.running_job()!.id)!.output).toContain("confirmed the switch");
  });

  it("polls a guarded switch every health_period", async () => {
    const { harness } = await awaiting({ ...guarded, health_period: "3s" });

    expect(harness.deployment.poll_interval()).toBe(3);
  });

  it("waits for a failing HTTP check, then tells the watchdog to roll back with why", async () => {
    const { harness } = await awaiting(guarded, async () => "answered 502 Bad Gateway");

    await cycle(harness);
    expect(harness.agent.commands.some((command) => command.includes('"kind":"signal_rollback"'))).toBe(false);
    clock.now += 121;
    await cycle(harness);
    clock.now -= 121;

    const signal = harness.agent.commands.find((command) => command.includes('"kind":"signal_rollback"'))!;
    expect(signal).toContain("HTTP health check failed: https://host.example/health: answered 502 Bad Gateway");
    expect(harness.agent.commands.some((command) => command.includes('"kind":"confirm_switch"'))).toBe(false);
  });

  it("records why a switch was rolled back", async () => {
    const { harness, run } = await awaiting();
    harness.agent.end(run, "@@x-nix-switch outcome rolled-back Health check 1 (curl) failed with status 7\n", 1);

    await cycle(harness);

    const job = harness.store.jobs()[0];
    expect(job.error).toBe("Rolled back to the previous system: Health check 1 (curl) failed with status 7");
    expect(harness.store.events(harness.deployment.id)[0].message).toContain("Switch rolled back to the previous system: Health check 1");
  });

  it("notes a switch set for the next boot until the host runs another system", async () => {
    const harness = make_deployment();
    await collect(harness);
    await harness.deployment.act("switch");
    harness.agent.end(harness.agent.last_run('"kind":"switch"')!, "@@x-nix-switch outcome deferred The new system changes kernel, so it starts at the next boot\n", 0);

    await cycle(harness);
    await collect(harness);

    expect(harness.store.events(harness.deployment.id).some((event) => event.message.includes("Switch set for the next boot: The new system changes kernel"))).toBe(true);
    expect(harness.deployment.reading()!.messages.map((message) => message.text)).toContain("Waiting on a reboot: The new system changes kernel, so it starts at the next boot");
  });

  it("keeps a switch whose units partly failed as succeeded, warning with them until the host runs another system", async () => {
    const harness = make_deployment();
    await collect(harness);
    await harness.deployment.act("switch");
    const output = "warning: the following units failed: borgmatic.service\n@@x-nix-switch units-failed\n@@x-nix-switch outcome confirmed X-Nix confirmed the switch\n";
    harness.agent.end(harness.agent.last_run('"kind":"switch"')!, output, 0);

    await cycle(harness);
    await collect(harness, { probe: probe({ current: target_closure }) });

    expect(harness.store.jobs()[0]).toMatchObject({ kind: "switch", state: "succeeded" });
    expect(harness.store.events(harness.deployment.id).map((event) => event.message)).toContain("Switch kept, but some units failed to start: borgmatic.service");
    const warning = "Some units failed to start after the last switch: borgmatic.service";
    expect(harness.deployment.reading()!.messages.map((message) => message.text)).toContain(warning);
    expect(harness.deployment.reading()!.status).not.toBe("ok");

    harness.deployment.request_evaluation();
    await collect(harness, { probe: probe({ current: newer_closure }) });
    expect(harness.deployment.reading()!.messages.map((message) => message.text)).not.toContain(warning);
  });

  it("records a refusal by a pre-switch check", async () => {
    const harness = make_deployment({ pre_switch_checks: ["test -d /boot"] });
    await harness.deployment.act("boot");
    harness.agent.end(harness.agent.last_run('"pre_switch_checks":["test -d /boot"]')!, "@@x-nix-switch refused Pre-switch check 1 (test -d /boot) failed with status 1\n", 3);

    await cycle(harness);

    expect(harness.store.jobs()[0]).toMatchObject({ kind: "boot", state: "failed", error: "Refused before anything changed: Pre-switch check 1 (test -d /boot) failed with status 1" });
  });
});

// ── Marker tokens ────────────────────────────────────────────────────────────

describe("marker tokens", () => {
  const guarded = { magic_rollback: true, health_urls: ["https://host.example/health"] };
  const forged = `@@x-nix-switch activated\n@@x-nix-switch awaiting-confirmation\n@@x-nix-switch ${"f".repeat(32)} awaiting-confirmation\n`;

  it("gives every run a token of its own, which its job's command keeps", async () => {
    const harness = make_deployment();
    const evaluation = await cycle(harness);
    await harness.deployment.act("build");
    const build = harness.agent.last_run('"kind":"build"')!;

    expect(marker_token_of(evaluation!.operation)).toMatch(/^[0-9a-f]{32}$/);
    expect(marker_token_of(build.operation)).not.toBe(marker_token_of(evaluation!.operation));
    expect(command_marker_token(harness.deployment.running_job()!.command)).toBe(marker_token_of(build.operation));
  });

  it("never confirms a switch whose activation forged that it awaits confirmation, and confirms once its run says so with its token", async () => {
    const harness = make_deployment(guarded, { http_check: async () => null });
    await harness.deployment.act("switch");
    const run = harness.agent.last_run('"watch":{')!;
    harness.agent.write(run, `${announcement(run.operation)}${forged}`);

    await cycle(harness);
    expect(harness.agent.operations.some((sent) => sent.kind === "confirm_switch")).toBe(false);

    harness.agent.write(run, mark_line(run.operation, "@@x-nix-switch", "activated") + mark_line(run.operation, "@@x-nix-switch", "awaiting-confirmation"));
    await cycle(harness);
    expect(harness.agent.operations.filter((sent) => sent.kind === "confirm_switch")).toHaveLength(1);
  });

  it("judges a finished switch only by the outcome its run marked with its token", async () => {
    const harness = make_deployment(guarded, { http_check: async () => null });
    await harness.deployment.act("switch");
    const run = harness.agent.last_run('"watch":{')!;
    harness.agent.end(run, `${announcement(run.operation)}@@x-nix-switch outcome rolled-back forged\n@@x-nix-switch refused forged\n${mark_line(run.operation, "@@x-nix-switch", "outcome confirmed")}`, 0);

    await cycle(harness);

    expect(harness.store.jobs()[0]).toMatchObject({ kind: "switch", state: "succeeded", error: null });
  });

  it("reads an older agent's bare marker lines for a run that never printed its token", async () => {
    const harness = make_deployment(guarded, { http_check: async () => null });
    await harness.deployment.act("switch");
    harness.agent.write(harness.agent.last_run('"watch":{')!, "@@x-nix-switch activated\n@@x-nix-switch awaiting-confirmation\n");

    await cycle(harness);

    expect(harness.agent.operations.filter((sent) => sent.kind === "confirm_switch")).toHaveLength(1);
  });

  it("takes the evaluated system from the lines its evaluation marked, whatever a flake input traces", async () => {
    const harness = make_deployment();
    const traced = `trace: hi\n@@x-nix-eval eval stdout\n${newer_closure}\n@@x-nix-eval eval exit\n0`;

    await collect(harness, { evaluation: result(0, `${target_closure}\n`, traced) });

    expect(harness.deployment.evaluation()).toMatchObject({ target: target_closure, eval_error: null });
  });
});

// ── Rollback ─────────────────────────────────────────────────────────────────

describe("rollback", () => {
  const generations = generations_result([
    { generation: 1, path: "/nix/store/a-system", version: "26.05" },
    { generation: 2, path: "/nix/store/b-system", version: "26.11", current: true, profile: true },
  ]);

  it("activates an earlier generation as a job, recording why", async () => {
    const harness = make_deployment();
    harness.agent.answers.push(['"kind":"generations"', generations]);

    const outcome = await harness.deployment.roll_back(1, "the new kernel panics");

    expect(outcome.ok).toBe(true);
    const job = harness.deployment.running_job()!;
    expect(job.kind).toBe("rollback");
    expect(shown_command(job.command)).toContain("Rolling back to generation 1: the new kernel panics");
    expect(shown_command(job.command)).toContain("--switch-generation 1");
    expect(harness.store.events(harness.deployment.id)[0].message).toBe("Rolling back to generation 1: the new kernel panics");
  });

  it("refuses the running generation and one that does not exist", async () => {
    const harness = make_deployment();
    harness.agent.answers.push(['"kind":"generations"', generations]);

    expect((await harness.deployment.roll_back(2, "x")).message).toContain("already running");
    expect((await harness.deployment.roll_back(9, "x")).message).toContain("not one of");
    expect(harness.deployment.running_job()).toBeNull();
  });
});

// ── Package diff ─────────────────────────────────────────────────────────────

describe("package diff", () => {
  const diff_output = result(0, "@@x-nix-diff closures\nhello: 2.11 → 2.12, +4.0 KiB\n@@x-nix-diff sizes\n{}\n@@x-nix-diff derivations\n");

  it("compares the running closure with the flake's as a job, and reuses it for the same two", async () => {
    const harness = make_deployment();
    await collect(harness);
    harness.agent.answers.push(['"kind":"closure_diff"', diff_output]);

    const first = await harness.deployment.diff(false);
    await harness.deployment.diff(false);

    expect(first.diff?.changed.map((change) => change.name)).toEqual(["hello"]);
    expect(harness.store.jobs({ kind: "diff" })).toHaveLength(1);
    expect(harness.deployment.evaluation().last_diff?.job_id).toBe(first.diff?.job_id);
  });

  it("says the flake's closure is not built yet", async () => {
    const harness = make_deployment();
    await collect(harness);
    harness.agent.answers.push(['"kind":"closure_diff"', result(0, "@@x-nix-diff missing\n")]);

    const outcome = await harness.deployment.diff(false);

    expect(outcome.diff?.built).toBe(false);
    expect(outcome.message).toContain("not in the host's store yet");
  });

  it("has nothing to compare before an evaluation", async () => {
    expect((await make_deployment().deployment.diff(false)).message).toContain("not been read");
  });
});

// ── Live build progress ──────────────────────────────────────────────────────

describe("live build progress", () => {
  it("keeps a build's counts with its job and shows them as its progress", async () => {
    const harness = make_deployment();
    await harness.deployment.act("build");
    const run = harness.agent.last_run("internal-json")!;
    harness.agent.write(run, `@nix ${JSON.stringify({ action: "start", id: 5, type: 105, fields: ["/nix/store/dddddddddddddddddddddddddddddddd-hello-2.12.drv"] })}\n`
      + `@nix ${JSON.stringify({ action: "result", id: 5, type: 101, fields: ["make"] })}\n`);

    await cycle(harness);

    const job = harness.store.job(harness.deployment.running_job()!.id)!;
    expect(job.output).toBe("hello-2.12> make\n");
    expect(job.progress).toBe("Built 0, building 1; downloaded 0");
    expect(JSON.parse(job.live!).activities["5"].name).toBe("hello-2.12");
  });

  it("reads from the build's host which planned paths each planned derivation needs", async () => {
    const harness = make_deployment();
    const [hello, app] = ["/nix/store/dddddddddddddddddddddddddddddddd-hello-2.12.drv", "/nix/store/ffffffffffffffffffffffffffffffff-app-1.0.drv"];
    await harness.deployment.act("build");
    const run = harness.agent.last_run("internal-json")!;
    harness.agent.answers.push(['"kind":"derivations"', result(0, JSON.stringify({ [app]: [hello] }))]);
    const message = (msg: string) => `@nix ${JSON.stringify({ action: "msg", level: 3, msg })}\n`;
    harness.agent.write(run, message("these 2 derivations will be built:") + message(`  ${hello}`) + message(`  ${app}`));

    await cycle(harness);

    const asked = harness.agent.operations.find((operation) => operation.kind === "derivations");
    expect(asked).toEqual({ kind: "derivations", derivations: [hello, app], planned: [hello, app] });
    const planned = JSON.parse(harness.store.job(harness.deployment.running_job()!.id)!.live!).planned;
    expect(planned[app].needs).toEqual([hello]);
    expect(planned[hello].needs).toEqual([]);
  });

  it("reads a switch that builds on its own host, naming the build as its progress only while it builds", async () => {
    const harness = make_deployment({ configuration: "host" });
    const outcome = await harness.deployment.act("switch");
    const run = harness.agent.last_run("internal-json")!;
    const line = (entry: Record<string, unknown>) => `@nix ${JSON.stringify(entry)}\n`;
    harness.agent.write(run, line({ action: "start", id: 5, type: 105, fields: ["/nix/store/dddddddddddddddddddddddddddddddd-hello-2.12.drv"] }));

    await cycle(harness);

    expect(harness.store.job(outcome.job_id!)).toMatchObject({ kind: "switch", progress: "Built 0, building 1; downloaded 0" });
    harness.agent.write(run, line({ action: "stop", id: 5 }) + "activating the configuration...\n");
    await cycle(harness);
    const job = harness.store.job(outcome.job_id!)!;
    expect(job.progress).toBe("activating the configuration...");
    expect(JSON.parse(job.live!).builds_done).toBe(1);
  });
});

// ── Sleeping host ────────────────────────────────────────────────────────────

describe("a sleeping host that can be woken", () => {
  const wake = (timeout: number) => new Map([["pi", { mac: "aa:bb:cc:dd:ee:ff", broadcast: "127.0.0.1", port: 9, timeout, via: null, screen_off: null }]]);

  it("gets its job at once as waking, and the run starts once its agent dials in", async () => {
    const pi = new FakeAgent();
    let wakes = 0;
    const agents = new AgentPool("server", new FakeAgent(), async () => void wakes++);
    agents.set_wake(wake(60));
    const store = new Store(":memory:");
    const deployment = new Deployment(deployment_settings({ id: "pi", host: "pi" }), { store, agents, now: () => clock.now });

    const outcome = await deployment.act("switch");
    await deployment.cycle();
    expect(outcome.ok).toBe(true);
    expect(wakes).toBe(1);
    expect(store.job(outcome.job_id!)).toMatchObject({ state: "running", progress: "Waking pi" });

    agents.add("pi", pi);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pi.long_runs).toHaveLength(1);
    expect(store.job(outcome.job_id!)?.run_id).toBe(pi.long_runs[0].run_id);
  });

  it("fails the job with why once the host does not wake in time", async () => {
    const agents = new AgentPool("server", new FakeAgent(), async () => {});
    agents.set_wake(wake(0.02));
    const store = new Store(":memory:");
    const deployment = new Deployment(deployment_settings({ id: "pi", host: "pi" }), { store, agents, now: () => clock.now });

    const outcome = await deployment.act("switch");
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(store.job(outcome.job_id!)).toMatchObject({ state: "failed", error: "The job could not be started" });
    expect(store.job(outcome.job_id!)?.output).toMatch(/did not connect within/);
    expect(deployment.running_job()).toBeNull();
  });
});

// ── Evaluated by its cache ───────────────────────────────────────────────────

describe("a deployment its cache builds", () => {
  const flake_epoch = clock.now - 7200;

  function fed(values: Record<string, unknown> = {}) {
    const store = new Store(":memory:");
    const agent = new FakeAgent();
    const cache = new Cache(cache_settings({ id: "fleet", name: "Fleet", flake: "/etc/nixos", configurations: ["host"], cache_url: "https://cache.example/fleet", info_url: false }), {
      store, agents: new AgentPool("host", agent), now: () => clock.now,
    });
    const checked: string[] = [];
    const harness = make_deployment({ cache: "fleet", configuration: "host", ...values }, { store, agent, caches: [cache], check_cache: (asked) => checked.push(asked.id) });
    const save_check = (row: Record<string, unknown>, evaluated_epoch = clock.now - 60) => store.save_cache_reading("fleet", {
      status: "online", checked_epoch: evaluated_epoch, messages: [], revision: "a".repeat(40), evaluated_epoch,
      flake: { last_modified_epoch: flake_epoch, oldest_input: "nixpkgs", inputs_last_modified_epoch: flake_epoch },
      rows: [{ name: "host", target: target_closure, eval_error: null, ...row }],
    });
    return { ...harness, cache, checked, save_check };
  }

  it("takes its target and revision from the cache's check rather than evaluating on its own", async () => {
    const harness = fed();
    harness.save_check({});

    await collect(harness);

    expect(harness.agent.long_runs.some((run) => run.command.includes("@@x-nix-eval"))).toBe(false);
    expect(harness.deployment.evaluation()).toMatchObject({ target: target_closure, flake_revision: "a".repeat(40), flake_last_modified_epoch: flake_epoch, evaluated_epoch: clock.now - 60 });
    expect(harness.deployment.reading()?.up_to_date).toBe(false);
  });

  it("remembers which of the cache's hosts evaluated it, so the flake's reading on another host can be compared", async () => {
    const harness = fed();
    harness.save_check({ host: "builder" });

    await collect(harness);

    expect(harness.deployment.evaluation().evaluated_on).toBe("builder");
  });

  it("keeps its last target when the cache's evaluation of it fails, saying so", async () => {
    const harness = fed();
    harness.save_check({});
    await collect(harness);
    harness.save_check({ target: null, eval_error: "error: attribute 'host' missing" }, clock.now - 30);

    await collect(harness);

    expect(harness.deployment.evaluation()).toMatchObject({ target: target_closure, eval_error: "Fleet cache: error: attribute 'host' missing" });
  });

  it("takes a check that ends while a job runs, without arming an automatic switch", async () => {
    const harness = fed({ auto_switch: true, auto_switch_after: "0" });
    harness.save_check({ target: null, eval_error: "error: attribute 'tag' missing" }, clock.now - 600);
    await collect(harness);
    expect(status_of(harness)).toBe("failed");
    const outcome = await harness.deployment.act("build");
    harness.save_check({}, clock.now - 30);

    await harness.deployment.cycle();

    expect(harness.deployment.running_job()?.id).toBe(outcome.job_id);
    expect(harness.deployment.evaluation()).toMatchObject({ target: target_closure, eval_error: null, evaluated_epoch: clock.now - 30 });
    const texts = harness.deployment.reading()!.messages.map((message) => message.text);
    expect(texts.some((text) => text.startsWith("Flake evaluation failed"))).toBe(false);
    expect(texts.some((text) => text.includes("switching automatically"))).toBe(false);
  });

  it("takes the target of a row saved before rows carried an evaluation error", async () => {
    const harness = fed();
    harness.save_check({ eval_error: undefined });

    await collect(harness);

    expect(harness.deployment.evaluation()).toMatchObject({ target: target_closure, eval_error: null });
  });

  it("asks the cache to check when asked to evaluate, and evaluates on its own once pinned", async () => {
    const harness = fed();
    harness.deployment.request_evaluation();
    expect(harness.checked).toEqual(["fleet"]);
    expect(harness.deployment.due_for_evaluation()).toBe(false);

    const pinned = fed({ pin: "v1" });
    expect(await cycle(pinned)).toBeDefined();
  });
});

// ── The evaluated revision ───────────────────────────────────────────────────

describe("the evaluated revision", () => {
  const evaluated_revision = "a".repeat(40);
  const read_revision = "b".repeat(40);
  const flake_epoch = clock.now - 7200;

  // A deployment of a flake that the host named reader reads, built on another host, evaluated on its own host at a revision.
  function followed(values: Record<string, unknown> = {}, reading: Record<string, unknown> | null = { revision: evaluated_revision, host: "reader" }) {
    const asked: string[] = [];
    const flakes = new Map([["config", flake_settings({ id: "config", url: "github:owner/config", host: "reader" })]]);
    const harness = make_deployment({ flake: "config", configuration: "host", build_agent: "builder", cache_url: "https://cache.example/fleet", ...values }, {
      flakes, read_flake: (flake_id) => asked.push(flake_id),
    });
    const builder = new FakeAgent();
    harness.agents.add("builder", builder);
    if (reading !== null) harness.store.save_reading("config", { last_modified_epoch: flake_epoch, metadata_error: null, ...reading });
    evaluated(harness.store, harness.deployment.id, target_closure, { flake_revision: evaluated_revision, flake_last_modified_epoch: flake_epoch, evaluated_on: null });
    return { ...harness, builder, asked };
  }

  it("switches when the flake's own reading on another host agrees with the evaluation", async () => {
    const harness = followed();

    expect((await harness.deployment.act("switch")).ok).toBe(true);
    expect(harness.builder.last_run('"kind":"build"')).toBeDefined();
    expect(harness.asked).toEqual([]);
  });

  it("refuses a switch when the evaluating host names another revision than the flake's own reading, reading and evaluating again", async () => {
    const harness = followed({}, { revision: read_revision, host: "reader" });

    const outcome = await harness.deployment.act("switch");

    expect(outcome).toEqual({
      ok: false, job_id: null, message: "host evaluated revision aaaaaaaaaaaa, but reader reads the flake at bbbbbbbbbbbb; evaluating again before switching",
    });
    expect(harness.asked).toEqual(["config"]);
    expect(harness.deployment.due_for_evaluation()).toBe(true);
    expect(harness.builder.long_runs).toHaveLength(0);
    expect(harness.agent.long_runs).toHaveLength(0);
    expect(harness.store.events(harness.deployment.id)[0].message).toBe("Not switching: host evaluated revision aaaaaaaaaaaa, but reader reads the flake at bbbbbbbbbbbb; evaluating again");
    expect(harness.deployment.action_refusal("switch")).toContain("reader reads the flake at");
    expect(harness.deployment.action_refusal("build")).toBeNull();

    await harness.deployment.act("switch");
    expect(harness.asked).toEqual(["config"]);
  });

  it("refuses a switch when the evaluation's date of the revision differs from the flake's own reading", async () => {
    const harness = followed({}, { revision: evaluated_revision, host: "reader", last_modified_epoch: flake_epoch - 60 });

    expect((await harness.deployment.act("switch")).message).toContain(`reports revision aaaaaaaaaaaa last changed at ${flake_epoch}, but reader reads ${flake_epoch - 60}`);
  });

  it("trusts the evaluation as before when no other host read the flake", async () => {
    for (const reading of [null, { revision: read_revision }, { revision: read_revision, host: "host" }]) {
      const harness = followed({}, reading);
      expect((await harness.deployment.act("switch")).ok).toBe(true);
    }
    const unknown = followed({}, { revision: read_revision, host: "reader" });
    evaluated(unknown.store, unknown.deployment.id, target_closure, { evaluated_on: undefined });
    expect((await unknown.deployment.act("switch")).ok).toBe(true);
  });

  it("refuses a switch whose evaluation names another commit than the commit it is pinned at", async () => {
    const harness = followed({ pin: "c".repeat(40) }, null);

    expect((await harness.deployment.act("switch")).message).toBe("The evaluation reports revision aaaaaaaaaaaa, but the deployment is pinned at cccccccccccc; evaluating again before switching");
    expect(followed({ pin: evaluated_revision }, null).deployment.action_refusal("switch")).toBeNull();
    expect(followed({ pin: "v1" }, null).deployment.action_refusal("switch")).toBeNull();
  });

  it("holds an automatic switch while the flake's own reading disagrees, and switches once it agrees", async () => {
    const asked: string[] = [];
    const flakes = new Map([["config", flake_settings({ id: "config", url: "github:owner/config", host: "reader" })]]);
    const harness = make_deployment({ flake: "config", auto_switch: true, auto_switch_after: "30m" }, { flakes, read_flake: (flake_id) => asked.push(flake_id) });
    harness.store.save_reading("config", { revision: read_revision, host: "reader", last_modified_epoch: clock.now - 3600, metadata_error: null });
    await collect(harness, { metadata: metadata({ revision: evaluated_revision, last_modified_epoch: clock.now - 3600 }) });
    rewind_drift(harness, 1801);
    rewind_evaluation(harness, 60);

    await harness.deployment.cycle();
    await cycle(harness);

    expect(harness.deployment.running_job()).toBeNull();
    expect(messages_of(harness)).toContain("Not switching automatically: host evaluated revision aaaaaaaaaaaa, but reader reads the flake at bbbbbbbbbbbb; evaluating again");
    expect(asked).toEqual(["config"]);

    harness.store.save_reading("config", { revision: evaluated_revision, host: "reader", last_modified_epoch: clock.now - 3600, metadata_error: null });
    await collect(harness, { metadata: metadata({ revision: evaluated_revision, last_modified_epoch: clock.now - 3600 }) });
    await cycle(harness);
    expect(harness.deployment.running_job()?.trigger).toBe("automatic");
  });

  it("never activates what an automatic switch's build made when it is not the evaluated system", async () => {
    const harness = make_deployment({ build_agent: "builder", cache_url: "https://cache.example/fleet", auto_switch: true, auto_switch_after: "30m" });
    const builder = new FakeAgent();
    harness.agents.add("builder", builder);
    await collect(harness, { metadata: metadata({ last_modified_epoch: clock.now - 3600 }) });
    rewind_drift(harness, 1801);
    await collect(harness);
    await cycle(harness);
    const job = harness.store.jobs({ kind: "switch" })[0];
    expect(job).toMatchObject({ trigger: "automatic", state: "running" });

    builder.end(builder.last_run('"kind":"build"')!, `${newer_closure}\n`, 0);
    await harness.deployment.cycle();

    expect(harness.store.job(job.id)!.state).toBe("failed");
    expect(harness.agent.long_runs.some((run) => run.command.includes("switch-to-configuration"))).toBe(false);
    expect(harness.agent.operations.some((operation) => innermost(operation).kind === "switch")).toBe(false);
  });
});
