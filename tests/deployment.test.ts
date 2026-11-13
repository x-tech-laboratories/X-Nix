import { describe, expect, it } from "vitest";

import { AgentError, AgentPool } from "../src/server/agents/agent.ts";
import { Cache } from "../src/server/cache.ts";
import { cache_settings, deployment_settings, host_settings } from "../src/server/config.ts";
import { Deployment, latest_slot } from "../src/server/deployment.ts";
import { Store } from "../src/server/store.ts";
import {
  clock, collect, current_closure, cycle, eval_output, FakeAgent, generations_result, kernel, make_deployment, messages_of, metadata, new_kernel, probe, result,
  rewind_drift, rewind_evaluation, rewind_schedule, shown_command, status_of, target_closure,
} from "./fake_agent.ts";
import { innermost, type SwitchOperation } from "../src/shared/operations.ts";

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
    expect(shown_command(job.command)).toContain("nixos-rebuild switch --flake /etc/nixos");
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

    agents.set_wake(new Map([["thor", { mac: "aa:bb:cc:dd:ee:ff", broadcast: "127.0.0.1", port: 9, timeout: 60, via: null }]]));
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
    return { ...harness, cache, builder };
  }

  // Starts an action that builds on the builder first, and ends that build with the system it made.
  async function built(harness: ReturnType<typeof with_builder>, action: "switch" | "boot" | "test" = "switch") {
    const outcome = await harness.deployment.act(action);
    harness.builder.end(harness.builder.last_run('"kind":"cache_build"')!, `${target_closure}\n`, 0);
    await harness.deployment.cycle();
    return outcome;
  }

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
    expect(shown_command(switching.command)).toContain(`build --no-link ${target_closure}`);
    expect(shown_command(switching.command)).toContain(`sudo -n nix-env -p /nix/var/nix/profiles/system --set ${target_closure}`);
    expect(shown_command(switching.command)).not.toContain("nixos-rebuild");
    expect(harness.store.job(outcome.job_id!)!.output).toContain("The cache holds the system; switching");
    expect(harness.deployment.evaluation().switch_wait).toBeUndefined();
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
    expect(command).toContain("sudo -n systemd-inhibit --what=idle:sleep --mode=block --who=X-Nix --why=switching cat");
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
    expect(on_host.builder.runs).toHaveLength(0);

    const on_server = with_builder({ direct_on: "server" });
    expect((await on_server.deployment.act("build")).ok).toBe(true);
    expect(on_server.deployment.running_job()?.agent).toBeNull();
    expect(on_server.builder.runs).toHaveLength(0);

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
    expect(harness.builder.runs.filter((run) => run.command.includes('"kind":"cache_build"'))).toHaveLength(1);
    expect(await harness.deployment.act("build")).toMatchObject({ ok: true, message: `Build already running, job #${first_build}`, job_id: first_build });

    harness.builder.end(harness.builder.last_run('"kind":"cache_build"')!, `${target_closure}\n`, 0);
    await harness.deployment.cycle();
    expect(harness.agent.last_run("switch-to-configuration")?.run_id).toBe(harness.store.job(outcome.job_id!)!.run_id);
  });

  it("builds elsewhere first for an automatic switch too, once per target", async () => {
    const harness = with_builder({ cache: undefined, cache_url: "https://cache.example/fleet/", auto_switch: true, auto_switch_after: "30m" });
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
    expect(pi.runs).toHaveLength(0);

    const drifting = deployment.evaluation();
    drifting.drift_since_epoch = clock.now - 1801;
    store.save_evaluation(deployment.id, drifting);
    await deployment.cycle();
    await deployment.cycle();
    const build = server.last_run('"kind":"build"')!;
    expect(build.operation).toMatchObject({ kind: "build", root_link: "/var/lib/x-nix/build-roots/pi", cache_url: "https://attic.example/fleet" });
    expect(pi.runs).toHaveLength(0);
    server.end(build, `${target_closure}\n`, 0);
    await deployment.cycle();

    const switching = pi.last_run("switch-to-configuration")!;
    expect(deployment.running_job()).toMatchObject({ kind: "switch", agent: "pi", trigger: "automatic" });
    expect(shown_command(switching.command)).toContain(`build --no-link ${target_closure}`);
    expect(shown_command(switching.command)).toContain(`sudo -n nix-env -p /nix/var/nix/profiles/system --set ${target_closure}`);
    expect(switching.command).toContain('"magic_rollback":true');
    expect(shown_command(switching.command)).toContain("systemd-inhibit");
    expect(shown_command(switching.command)).toContain("sudo -n /bin/sh -c ");
    expect(shown_command(switching.command)).not.toContain("nixos-rebuild");
    expect(server.runs.some((run) => run.command.includes("switch-to-configuration"))).toBe(false);
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
    expect(shown_command(job.command).split("\n").slice(1)).toEqual(["sudo -n nixos-rebuild dry-activate --flake /etc/nixos"]);
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

  it("records a refusal by a pre-switch check", async () => {
    const harness = make_deployment({ pre_switch_checks: ["test -d /boot"] });
    await harness.deployment.act("boot");
    harness.agent.end(harness.agent.last_run('"pre_switch_checks":["test -d /boot"]')!, "@@x-nix-switch refused Pre-switch check 1 (test -d /boot) failed with status 1\n", 3);

    await cycle(harness);

    expect(harness.store.jobs()[0]).toMatchObject({ kind: "boot", state: "failed", error: "Refused before anything changed: Pre-switch check 1 (test -d /boot) failed with status 1" });
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
});

// ── Sleeping host ────────────────────────────────────────────────────────────

describe("a sleeping host that can be woken", () => {
  const wake = (timeout: number) => new Map([["pi", { mac: "aa:bb:cc:dd:ee:ff", broadcast: "127.0.0.1", port: 9, timeout, via: null }]]);

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
    expect(pi.runs).toHaveLength(1);
    expect(store.job(outcome.job_id!)?.run_id).toBe(pi.runs[0].run_id);
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

    expect(harness.agent.runs.some((run) => run.command.includes("@@x-nix-eval"))).toBe(false);
    expect(harness.deployment.evaluation()).toMatchObject({ target: target_closure, flake_revision: "a".repeat(40), flake_last_modified_epoch: flake_epoch, evaluated_epoch: clock.now - 60 });
    expect(harness.deployment.reading()?.up_to_date).toBe(false);
  });

  it("keeps its last target when the cache's evaluation of it fails, saying so", async () => {
    const harness = fed();
    harness.save_check({});
    await collect(harness);
    harness.save_check({ target: null, eval_error: "error: attribute 'host' missing" }, clock.now - 30);

    await collect(harness);

    expect(harness.deployment.evaluation()).toMatchObject({ target: target_closure, eval_error: "Fleet cache: error: attribute 'host' missing" });
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
