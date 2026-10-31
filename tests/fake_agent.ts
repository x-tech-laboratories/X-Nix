// A scripted agent and deployment for the tests: the probe answers what a test sets, and long runs end when it says.

import { createHash } from "node:crypto";

import { AgentError, AgentPool, type Agent, type KeyState, type KeyWrite, type LongRun, type LongRunPoll, type RunResult } from "../src/server/agents/agent.ts";
import { deployment_settings } from "../src/server/config.ts";
import { Deployment } from "../src/server/deployment.ts";
import { eval_mark } from "../src/server/nixos/commands.ts";
import { probe_script } from "../src/server/nixos/probe.ts";
import { Store } from "../src/server/store.ts";

// ── Store paths ──────────────────────────────────────────────────────────────

export const current_closure = "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-nixos-system-host-26.11";
export const target_closure = "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-nixos-system-host-26.11";
export const kernel = "/nix/store/cccccccccccccccccccccccccccccccc-linux-6.18.46/bzImage";
export const new_kernel = "/nix/store/dddddddddddddddddddddddddddddddd-linux-6.19.1/bzImage";

// ── Clock ────────────────────────────────────────────────────────────────────

export const clock = { now: 1_800_000_000 };

// ── Results ──────────────────────────────────────────────────────────────────

export function result(exit_code: number, stdout = "", stderr = ""): RunResult {
  return { exit_code, stdout, stderr };
}

interface ProbeOptions {
  current?: string;
  switched_epoch?: number;
  created_epoch?: number;
  generation?: number;
  kernels?: [booted: string, current: string];
}

// What the probe script prints on a NixOS host.
export function probe(options: ProbeOptions = {}): RunResult {
  const current = options.current ?? current_closure;
  const [booted_kernel, current_kernel] = options.kernels ?? [kernel, kernel];
  const lines = [
    "hostname=host",
    `current=${current}`,
    `booted=${current}`,
    `switched=${options.switched_epoch ?? clock.now - 3600}`,
    `profile=system-${options.generation ?? 210}-link`,
    `profile_created=${options.created_epoch ?? clock.now - 3 * 86400}`,
    "version=26.11.20260826.9fbb54b",
    'version_json={"nixosVersion":"26.11.20260826.9fbb54b"}',
  ];
  for (const part of ["initrd", "kernel", "kernel-modules", "systemd"]) {
    lines.push(`booted_part=${booted_kernel}/${part}`, `current_part=${current_kernel}/${part}`);
  }
  return result(0, `${lines.join("\n")}\n`);
}

interface MetadataOptions {
  revision?: string;
  last_modified_epoch?: number;
  inputs?: Record<string, number>;
  dirty?: boolean;
}

// What `nix flake metadata --json` prints.
export function metadata(options: MetadataOptions = {}): RunResult {
  const last_modified = options.last_modified_epoch ?? clock.now - 7200;
  const inputs = options.inputs ?? { nixpkgs: clock.now - 86400 };
  const nodes: Record<string, unknown> = { root: { inputs: Object.fromEntries(Object.keys(inputs).map((name) => [name, name])) } };
  for (const [name, stamp] of Object.entries(inputs)) nodes[name] = { locked: { lastModified: stamp, rev: "0".repeat(40) } };
  return result(0, JSON.stringify({
    lastModified: last_modified,
    locked: { [options.dirty ? "dirtyRev" : "rev"]: options.revision ?? "f".repeat(40), lastModified: last_modified },
    locks: { nodes, root: "root", version: 7 },
  }));
}

// What the evaluation script prints once both of its commands have run.
export function eval_output(evaluation: RunResult, flake_metadata: RunResult): string {
  let output = "";
  for (const [name, part] of [["eval", evaluation], ["metadata", flake_metadata]] as const) {
    output += `${eval_mark} ${name} stderr\n${part.stderr}\n${eval_mark} ${name} stdout\n${part.stdout}\n${eval_mark} ${name} exit\n${part.exit_code}\n`;
  }
  return output;
}

// ── Agent ────────────────────────────────────────────────────────────────────

interface FakeRun {
  run_id: string;
  command: string;
  // What the run was handed on stdin.
  stdin: string | null;
  output: string;
  exit_code: number | null;
  alive: boolean;
}

export class FakeAgent implements Agent {
  probe_result: RunResult = probe();
  // What the store's probe answers; nothing at all unless a test sets it.
  gc_probe_result: RunResult = result(0);
  // What the boot entries' read answers; nothing at all unless a test sets it.
  boot_probe_result: RunResult = result(0);
  // What any command other than the probe answers, such as a reboot.
  command_result: RunResult = result(0);
  start_error: AgentError | null = null;
  poll_error: AgentError | null = null;
  readonly commands: string[] = [];
  readonly runs: FakeRun[] = [];
  // Answers for commands holding some text, looked at before anything else.
  readonly answers: [needle: string, answer: RunResult][] = [];

  async run(command: string): Promise<RunResult> {
    this.commands.push(command);
    const answer = this.answers.find(([needle]) => command.includes(needle));
    if (answer !== undefined) return answer[1];
    if (command === probe_script()) return this.probe_result;
    if (command.includes("bootctl list")) return this.boot_probe_result;
    return command.includes("journalctl") ? this.gc_probe_result : this.command_result;
  }

  async start(run_id: string, command: string, stdin: string | null = null): Promise<LongRun> {
    if (this.start_error !== null) throw this.start_error;
    this.runs.push({ run_id, command, stdin, output: "", exit_code: null, alive: true });
    return { run_id, pid: 4242, started_epoch: clock.now, state: "running", exit_code: null };
  }

  async poll(run_id: string, offset: number): Promise<LongRunPoll> {
    if (this.poll_error !== null) throw this.poll_error;
    const run = this.runs.find((candidate) => candidate.run_id === run_id);
    if (run === undefined) throw new AgentError(`No run named '${run_id}'.`);
    const state = run.alive ? "running" : run.exit_code === null ? "lost" : "exited";
    return { state, exit_code: run.exit_code, alive: run.alive, size: run.output.length, new_output: run.output.slice(offset), next_offset: run.output.length };
  }

  async forget(): Promise<void> {}

  // The keys written, by destination, as the host would hold them.
  readonly keys = new Map<string, { content: Buffer; owner: string; group: string; mode: string }>();
  readonly key_writes: KeyWrite[] = [];
  key_error: AgentError | null = null;

  async write_key(request: KeyWrite): Promise<RunResult> {
    if (this.key_error !== null) throw this.key_error;
    this.key_writes.push(request);
    this.keys.set(request.destination, { content: Buffer.from(request.content_base64, "base64"), owner: request.owner, group: request.group, mode: request.mode.replace(/^0/, "") });
    return result(0);
  }

  async check_keys(destinations: string[], salt: string): Promise<KeyState[]> {
    if (this.key_error !== null) throw this.key_error;
    return destinations.map((destination) => {
      const key = this.keys.get(destination);
      if (key === undefined) return { destination, present: false, salted_hash: null, size: null, owner: null, group: null, mode: null };
      const salted_hash = createHash("sha256").update(salt).update(key.content).digest("hex");
      return { destination, present: true, salted_hash, size: key.content.length, owner: key.owner, group: key.group, mode: key.mode };
    });
  }

  // The newest long run, optionally only those whose command holds some text.
  last_run(containing = ""): FakeRun | undefined {
    return this.runs.filter((run) => run.command.includes(containing)).pop();
  }

  write(run: FakeRun, output: string): void {
    run.output += output;
  }

  end(run: FakeRun, output: string, exit_code: number | null): void {
    run.output += output;
    run.exit_code = exit_code;
    run.alive = false;
  }
}

// ── Deployment ───────────────────────────────────────────────────────────────

export interface Harness {
  deployment: Deployment;
  agent: FakeAgent;
  store: Store;
  agents: AgentPool;
}

export function make_deployment(
  values: Record<string, unknown> = {}, existing: { store?: Store; agent?: FakeAgent; http_check?: (url: string) => Promise<string | null> } = {},
): Harness {
  const store = existing.store ?? new Store(":memory:");
  const agent = existing.agent ?? new FakeAgent();
  const agents = new AgentPool("host", agent);
  const settings = deployment_settings({ id: "host-deploy", flake: "/etc/nixos", ...values });
  const deployment = new Deployment(settings, { store, agents, now: () => clock.now, http_check: existing.http_check });
  return { deployment, agent, store, agents };
}

// The evaluation runs a cycle launched, or undefined when it launched none.
export async function cycle(harness: Harness, options: { force_eval?: boolean } = {}): Promise<FakeRun | undefined> {
  const before = harness.agent.runs.length;
  await harness.deployment.cycle(options);
  return harness.agent.runs.slice(before).find((run) => run.command.includes(eval_mark));
}

interface CollectOptions {
  probe?: RunResult;
  evaluation?: RunResult;
  metadata?: RunResult;
}

// Drives the deployment until this cycle's probe is judged, finishing any evaluation it launches with these results.
export async function collect(harness: Harness, options: CollectOptions = {}): Promise<void> {
  harness.agent.probe_result = options.probe ?? probe();
  const launched = await cycle(harness);
  if (launched === undefined) return;
  const evaluation = options.evaluation ?? result(0, `${target_closure}\n`);
  const flake_metadata = options.metadata ?? metadata();
  const exit_code = evaluation.exit_code === 0 && flake_metadata.exit_code === 0 ? 0 : 1;
  harness.agent.end(launched, eval_output(evaluation, flake_metadata), exit_code);
  await cycle(harness);
}

// Ages the stored evaluation by some seconds, as if that much time had passed since it ran.
export function rewind_evaluation(harness: Harness, seconds: number): void {
  const evaluation = harness.deployment.evaluation();
  evaluation.evaluated_epoch = clock.now - seconds;
  harness.store.save_evaluation(harness.deployment.id, evaluation);
}

export function rewind_drift(harness: Harness, seconds: number): void {
  const evaluation = harness.deployment.evaluation();
  evaluation.drift_since_epoch = clock.now - seconds;
  harness.store.save_evaluation(harness.deployment.id, evaluation);
}

// Moves a daily job's handled slot some days back, as if its slots since had passed unrun.
export function rewind_schedule(harness: Harness, kind: "update" | "build", days = 1): void {
  const evaluation = harness.deployment.evaluation();
  evaluation.scheduled[kind]! -= days * 86400;
  harness.store.save_evaluation(harness.deployment.id, evaluation);
}

export function status_of(harness: Harness): string | undefined {
  return harness.deployment.reading()?.status;
}

export function messages_of(harness: Harness): string[] {
  return harness.deployment.reading()?.messages.map((message) => message.text) ?? [];
}
