import { describe, expect, it } from "vitest";

import { AgentError, AgentPool } from "../src/server/agents/agent.ts";
import { deployment_settings } from "../src/server/config.ts";
import { Deployment, latest_slot } from "../src/server/deployment.ts";
import { Store } from "../src/server/store.ts";
import {
  clock, collect, current_closure, cycle, eval_output, FakeAgent, kernel, make_deployment, messages_of, metadata, new_kernel, probe, result, rewind_drift,
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

  it("activates boot and test from the cache too, refusing them before an evaluation", async () => {
    const harness = make_deployment(from_cache);
    expect(harness.deployment.action_refusal("boot")).toContain("successful evaluation");
    await collect(harness);

    await harness.deployment.act("boot");
    const boot = harness.deployment.running_job()!;
    harness.agent.end(harness.agent.last_run("switch-to-configuration")!, "", 0);
    await cycle(harness);
    await harness.deployment.act("test");

    expect(boot.command).toContain(`--set ${target_closure} && sudo -n ${target_closure}/bin/switch-to-configuration boot`);
    expect(harness.deployment.running_job()!.command).toContain(`${target_closure}/bin/switch-to-configuration test`);
    expect(harness.deployment.running_job()!.command).not.toContain("nixos-rebuild");
  });

  it("guards a switch from the cache on the host's own agent, which confirms it, and runs post_switch as root", async () => {
    const harness = make_deployment({ ...from_cache, host: "host", pre_switch_checks: ["true"], magic_rollback: true, post_switch: "systemctl restart greetd" });
    await collect(harness);

    await harness.deployment.act("switch");
    const run = harness.agent.last_run("x-nix-switch")!;
    harness.agent.write(run, "@@x-nix-switch activated\n@@x-nix-switch awaiting-confirmation\n");
    await cycle(harness);

    expect(run.command).toContain("mark phase pre-switch-checks");
    expect(run.command).toContain(`copy --from https://cache.example/fleet ${target_closure}`);
    expect(run.command).toContain(`sudo -n ${target_closure}/bin/switch-to-configuration switch`);
    expect(run.command).toContain("sudo -n /bin/sh -c 'systemctl restart greetd'");
    expect(run.command).toContain("The switch from the cache failed with status");
    expect(run.command).not.toContain("nixos-rebuild");
    expect(harness.agent.commands.some((command) => /^sh -c 'touch \/tmp\/x-nix-switch-[0-9a-f]+\/confirmed'$/.test(command))).toBe(true);
  });

  it("keeps the host awake through the whole switch with inhibit_sleep", async () => {
    const harness = make_deployment({ ...from_cache, inhibit_sleep: true });
    await collect(harness);

    await harness.deployment.act("switch");

    const command = harness.deployment.running_job()!.command;
    expect(command).toContain("sudo -n systemd-inhibit --what=idle:sleep --mode=block --who=X-Nix --why=switching cat");
    expect(command.indexOf("systemd-inhibit")).toBeLessThan(command.indexOf("copy --from"));
  });

  it("rolls back to an earlier generation on the host's own agent", async () => {
    const harness = make_deployment({ ...from_cache, inhibit_sleep: true });
    harness.agent.answers.push(["profiles/system-*-link", result(0, [
      "current\t/nix/store/b-system", "profile\tsystem-2-link",
      "generation\tsystem-1-link\t1700000000\t/nix/store/a-system\t26.05", "generation\tsystem-2-link\t1700100000\t/nix/store/b-system\t26.11",
    ].join("\n"))]);

    expect((await harness.deployment.roll_back(1, "the new kernel panics")).ok).toBe(true);

    const job = harness.deployment.running_job()!;
    expect(job.agent).toBeNull();
    expect(job.command).toContain("sudo -n nix-env -p /nix/var/nix/profiles/system --switch-generation 1 && sudo -n /nix/var/nix/profiles/system/bin/switch-to-configuration switch");
    expect(job.command).toContain("systemd-inhibit");
  });
});

// ── Small host fed by the server ─────────────────────────────────────────────

describe("a small host evaluated and built elsewhere", () => {
  it("evaluates and builds on the server, then its own agent switches from the cache by itself", async () => {
    const server = new FakeAgent();
    const pi = new FakeAgent();
    const agents = new AgentPool("server", server);
    agents.add("pi", pi);
    const store = new Store(":memory:");
    const settings = deployment_settings({
      id: "pi", host: "pi", flake: "github:example/nixos-config", configuration: "pi", eval_agent: "server", build_agent: "server",
      build_root_dir: "/var/lib/x-nix/build-roots", cache_url: "https://attic.example/fleet", switch_from_cache: true, auto_switch: true,
      auto_switch_after: "30m", magic_rollback: true, inhibit_sleep: true, post_switch: "systemctl restart greetd",
    });
    const deployment = new Deployment(settings, { store, agents, now: () => clock.now });

    await deployment.cycle();
    const evaluation = server.last_run("@@x-nix-eval")!;
    server.end(evaluation, eval_output(result(0, `${target_closure}\n`), metadata()), 0);
    await deployment.cycle();
    expect(evaluation.command).toContain("nixosConfigurations.\\\"pi\\\".config.system.build.toplevel");
    expect(pi.runs).toHaveLength(0);
    expect(deployment.cached_target()).toBe(target_closure);

    await deployment.act("build");
    const build = server.last_run("build")!;
    expect(build.command).toContain("--out-link /var/lib/x-nix/build-roots/pi");
    expect(build.command).toContain("path-info --store https://attic.example/fleet");
    server.end(build, `${target_closure}\n`, 0);
    await deployment.cycle();
    expect(pi.runs).toHaveLength(0);

    const drifting = deployment.evaluation();
    drifting.drift_since_epoch = clock.now - 1801;
    store.save_evaluation(deployment.id, drifting);
    await deployment.cycle();
    await deployment.cycle();

    const switching = pi.last_run("switch-to-configuration")!;
    expect(deployment.running_job()).toMatchObject({ kind: "switch", agent: "pi", trigger: "automatic" });
    expect(switching.command).toContain(`copy --from https://attic.example/fleet ${target_closure}`);
    expect(switching.command).toContain(`sudo -n nix-env -p /nix/var/nix/profiles/system --set ${target_closure}`);
    expect(switching.command).toContain("x-nix-watchdog");
    expect(switching.command).toContain("systemd-inhibit");
    expect(switching.command).toContain("sudo -n /bin/sh -c ");
    expect(switching.command).not.toContain("nixos-rebuild");
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

  it("take a switch from the cache with the guarded switch's checks, but not with a target_host", () => {
    const from_cache = { switch_from_cache: true, cache_url: "https://cache.example/fleet" };

    expect(() => make_deployment({ ...from_cache, magic_rollback: true, pre_switch_checks: ["true"], health_commands: ["true"] })).not.toThrow();
    expect(() => make_deployment({ ...from_cache, target_host: "root@host" })).toThrow(/target_host/);
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
    const run = harness.agent.last_run("x-nix-switch")!;
    harness.agent.write(run, "@@x-nix-switch activated\n@@x-nix-switch awaiting-confirmation\n");
    return { harness, run };
  }

  it("runs each mode as its own job, and dry activation unguarded", async () => {
    const harness = make_deployment(guarded);

    await harness.deployment.act("dry-activate");

    const job = harness.deployment.running_job()!;
    expect(job.kind).toBe("dry-activate");
    expect(job.command).toBe("sudo -n nixos-rebuild dry-activate --flake /etc/nixos");
  });

  it("confirms a switch once its HTTP checks pass, and only once", async () => {
    const { harness } = await awaiting();

    await cycle(harness);
    await cycle(harness);

    expect(harness.agent.commands.filter((command) => command.includes("/confirmed"))).toHaveLength(1);
    expect(harness.store.job(harness.deployment.running_job()!.id)!.output).toContain("confirmed the switch");
  });

  it("polls a guarded switch every health_period", async () => {
    const { harness } = await awaiting({ ...guarded, health_period: "3s" });

    expect(harness.deployment.poll_interval()).toBe(3);
  });

  it("waits for a failing HTTP check, then tells the watchdog to roll back with why", async () => {
    const { harness } = await awaiting(guarded, async () => "answered 502 Bad Gateway");

    await cycle(harness);
    expect(harness.agent.commands.some((command) => command.includes("rollback.part"))).toBe(false);
    clock.now += 121;
    await cycle(harness);
    clock.now -= 121;

    const signal = harness.agent.commands.find((command) => command.includes("rollback.part"))!;
    expect(signal).toContain("HTTP health check failed: https://host.example/health: answered 502 Bad Gateway");
    expect(harness.agent.commands.some((command) => command.includes("/confirmed"))).toBe(false);
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
    harness.agent.end(harness.agent.last_run("pre-switch")!, "@@x-nix-switch refused Pre-switch check 1 (test -d /boot) failed with status 1\n", 3);

    await cycle(harness);

    expect(harness.store.jobs()[0]).toMatchObject({ kind: "boot", state: "failed", error: "Refused before anything changed: Pre-switch check 1 (test -d /boot) failed with status 1" });
  });
});

// ── Rollback ─────────────────────────────────────────────────────────────────

describe("rollback", () => {
  const generations = result(0, [
    "current\t/nix/store/b-system",
    "booted\t/nix/store/b-system",
    "profile\tsystem-2-link",
    "generation\tsystem-1-link\t1700000000\t/nix/store/a-system\t26.05",
    "generation\tsystem-2-link\t1700100000\t/nix/store/b-system\t26.11",
  ].join("\n"));

  it("activates an earlier generation as a job, recording why", async () => {
    const harness = make_deployment();
    harness.agent.answers.push(["profiles/system-*-link", generations]);

    const outcome = await harness.deployment.roll_back(1, "the new kernel panics");

    expect(outcome.ok).toBe(true);
    const job = harness.deployment.running_job()!;
    expect(job.kind).toBe("rollback");
    expect(job.command).toContain("Rolling back to generation 1: the new kernel panics");
    expect(job.command).toContain("--switch-generation 1");
    expect(harness.store.events(harness.deployment.id)[0].message).toBe("Rolling back to generation 1: the new kernel panics");
  });

  it("refuses the running generation and one that does not exist", async () => {
    const harness = make_deployment();
    harness.agent.answers.push(["profiles/system-*-link", generations]);

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
    harness.agent.answers.push(["diff-closures", diff_output]);

    const first = await harness.deployment.diff(false);
    await harness.deployment.diff(false);

    expect(first.diff?.changed.map((change) => change.name)).toEqual(["hello"]);
    expect(harness.store.jobs({ kind: "diff" })).toHaveLength(1);
    expect(harness.deployment.evaluation().last_diff?.job_id).toBe(first.diff?.job_id);
  });

  it("says the flake's closure is not built yet", async () => {
    const harness = make_deployment();
    await collect(harness);
    harness.agent.answers.push(["diff-closures", result(0, "@@x-nix-diff missing\n")]);

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
