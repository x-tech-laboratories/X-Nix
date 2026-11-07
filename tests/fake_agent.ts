// A scripted agent and deployment for the tests: the probe answers what a test sets, and long runs end when it says.

import type { Cache } from "../src/server/cache.ts";
import { AgentError, AgentPool, type Agent, type LongRun, type LongRunPoll, type RunResult } from "../src/server/agents/agent.ts";
import { deployment_settings, host_settings, type FlakeSettings } from "../src/server/config.ts";
import { Deployment } from "../src/server/deployment.ts";
import { Host } from "../src/server/host.ts";
import { eval_mark } from "../src/server/nixos/commands.ts";
import { Store } from "../src/server/store.ts";
import type { GcFields, ProbeFields } from "../src/shared/facts.ts";
import { innermost, operation_of, show_argv, type Operation } from "../src/shared/operations.ts";

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

// What the probe prints on a NixOS host.
export function probe(options: ProbeOptions = {}): RunResult {
  const current = options.current ?? current_closure;
  const [booted_kernel, current_kernel] = options.kernels ?? [kernel, kernel];
  const parts = ["initrd", "kernel", "kernel-modules", "systemd"];
  const fields: ProbeFields = {
    hostname: "host",
    current,
    booted: current,
    switched_epoch: options.switched_epoch ?? clock.now - 3600,
    profile_created_epoch: options.created_epoch ?? clock.now - 3 * 86400,
    generation: options.generation ?? 210,
    version: "26.11.20260826.9fbb54b",
    booted_parts: parts.map((part) => `${booted_kernel}/${part}`),
    current_parts: parts.map((part) => `${current_kernel}/${part}`),
  };
  return result(0, JSON.stringify(fields));
}

// What the store's read prints, with these facts over a healthy default.
export function store_facts(fields: Partial<GcFields> = {}): RunResult {
  const facts: GcFields = {
    hostname: "host", size_bytes: null, used_bytes: null, avail_bytes: null, paths: null, roots: null, svc_state: "", svc_result: "", svc_exit: "",
    timer_load: "", timer_state: "", timer_next: "", summary: "", outcome: "", error: "", profiles: [], ...fields,
  };
  return result(0, JSON.stringify(facts));
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

// What the generations read prints for these generations, the newest the running and profile's one.
export function generations_result(generations: { generation: number; path: string; version?: string; current?: boolean; profile?: boolean }[]): RunResult {
  return result(0, JSON.stringify(generations.map((generation, index) => ({
    generation: generation.generation, created_epoch: 1_700_000_000 + index * 100_000, path: generation.path, version: generation.version ?? null,
    current: generation.current ?? false, booted: false, profile: generation.profile ?? false,
  }))));
}

// ── Agent ────────────────────────────────────────────────────────────────────

// A job's or a fake run's command as `shown` writes it.
export function shown_command(command: string): string {
  const operation = operation_of(command.split("\n")[0]);
  return operation === null ? command : shown(operation);
}

// An operation as JSON, then each program it runs as a command line, so a test can look for either.
export function shown(operation: Operation): string {
  const lines = [JSON.stringify(operation)];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === "object" && value !== null) {
      const record = value as { argv?: unknown; post_switch?: unknown };
      const argv = record.argv ?? record.post_switch;
      if (Array.isArray(argv) && argv.every((word) => typeof word === "string")) lines.push(show_argv(argv));
      Object.values(value).forEach(walk);
    }
  };
  walk(operation);
  return lines.join("\n");
}

interface FakeRun {
  run_id: string;
  operation: Operation;
  // The operation as `shown` writes it, which tests search for words.
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
  // What any operation other than the reads answers, such as a reboot.
  command_result: RunResult = result(0);
  start_error: AgentError | null = null;
  poll_error: AgentError | null = null;
  // Each operation run, as `shown` writes it.
  readonly commands: string[] = [];
  readonly operations: Operation[] = [];
  readonly runs: FakeRun[] = [];
  // Answers for operations whose JSON holds some text, looked at before anything else.
  readonly answers: [needle: string, answer: RunResult][] = [];

  async run(operation: Operation): Promise<RunResult> {
    const command = shown(operation);
    this.commands.push(command);
    this.operations.push(operation);
    const answer = this.answers.find(([needle]) => command.includes(needle));
    if (answer !== undefined) return answer[1];
    if (operation.kind === "probe") return this.probe_result;
    if (operation.kind === "boot_probe") return this.boot_probe_result;
    return operation.kind === "store_probe" ? this.gc_probe_result : this.command_result;
  }

  async start(run_id: string, operation: Operation, options: { stdin?: string | null } = {}): Promise<LongRun> {
    if (this.start_error !== null) throw this.start_error;
    const stdin = options.stdin ?? null;
    this.runs.push({ run_id, operation, command: shown(operation), stdin, output: "", exit_code: null, alive: true });
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

  // Whether any operation run so far ran this program, as a command line.
  ran(line: string): boolean {
    return this.commands.some((command) => command.split("\n").slice(1).includes(line));
  }

  // The newest long run, optionally only those whose operation's JSON holds some text.
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
  host: Host;
  agent: FakeAgent;
  store: Store;
  agents: AgentPool;
}

export function make_deployment(
  values: Record<string, unknown> = {},
  existing: {
    store?: Store; agent?: FakeAgent; http_check?: (url: string) => Promise<string | null>; flakes?: Map<string, FlakeSettings>; caches?: Cache[];
    check_cache?: (cache: Cache) => void;
  } = {},
): Harness {
  const store = existing.store ?? new Store(":memory:");
  const agent = existing.agent ?? new FakeAgent();
  const agents = new AgentPool("host", agent);
  const [own, of_host] = host_values(values);
  const host = new Host(host_settings({ id: "host", ...of_host }), { store, agents, now: () => clock.now });
  const caches = new Map((existing.caches ?? []).map((cache) => [cache.id, cache.settings]));
  const settings = deployment_settings({ id: "host-deploy", flake: "/etc/nixos", ...own }, 0, existing.flakes, () => host.settings, caches);
  const deployment = new Deployment(settings, { store, agents, now: () => clock.now, http_check: existing.http_check, caches: existing.caches, host, check_cache: existing.check_cache });
  return { deployment, host, agent, store, agents };
}

// Splits test values into the deployment's and its host's, as inhibit_sleep is the host's keep_awake.
export function host_values(values: Record<string, unknown>): [deployment: Record<string, unknown>, host: Record<string, unknown>] {
  const deployment: Record<string, unknown> = {};
  const host: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (key === "inhibit_sleep") host.keep_awake = value;
    else if (["gc", "boot", "require_sudo"].includes(key)) host[key] = value;
    else deployment[key] = value;
  }
  return [deployment, host];
}

export interface HostHarness {
  host: Host;
  agent: FakeAgent;
  store: Store;
}

// A host named "host", served as the pool's own, with these host settings.
export function make_host(values: Record<string, unknown> = {}): HostHarness {
  const store = new Store(":memory:");
  const agent = new FakeAgent();
  const host = new Host(host_settings({ id: "host", ...values }), { store, agents: new AgentPool("host", agent), now: () => clock.now });
  return { host, agent, store };
}

// The evaluation runs a cycle launched, or undefined when it launched none.
export async function cycle(harness: Harness, options: { force_eval?: boolean } = {}): Promise<FakeRun | undefined> {
  const before = harness.agent.runs.length;
  await harness.deployment.cycle(options);
  return harness.agent.runs.slice(before).find((run) => innermost(run.operation).kind === "evaluate");
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
export function rewind_schedule(harness: Harness, kind: "build", days = 1): void {
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
