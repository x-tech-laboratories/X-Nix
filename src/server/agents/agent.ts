// What the server can ask of one host's agent, and the pool of agents deployments name.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { LongRun, LongRunPoll, RunResult } from "../../shared/agent_protocol.ts";
import type { Operation } from "../../shared/operations.ts";
import { format_duration } from "../durations.ts";
import { send_magic_packet, wake_operation, type SendWake, type WakeSettings } from "./wake.ts";

export type { LongRun, LongRunPoll, LongRunState, RunResult } from "../../shared/agent_protocol.ts";

// ── Agent ────────────────────────────────────────────────────────────────────

export class AgentError extends Error {
  // Whether the host never answered, so trying again later may work, rather than answering that it failed.
  readonly unreachable: boolean;

  constructor(message: string, unreachable = false) {
    super(message);
    this.name = "AgentError";
    this.unreachable = unreachable;
  }
}

export interface Agent {
  // Performs an operation to its end; it never rejects, answering a failure to reach the host with exit code -1.
  run(operation: Operation, timeout_in_seconds: number): Promise<RunResult>;
  // Starts a long run, which outlives the connection, the agent and the server; its stdin is piped in and never written
  // down by the agent. Rejects with an AgentError.
  start(run_id: string, operation: Operation, stdin?: string | null): Promise<LongRun>;
  // What a long run has written past an offset in bytes, and whether it has ended; rejects with an AgentError.
  poll(run_id: string, offset: number): Promise<LongRunPoll>;
  // Removes an ended long run's output from the host.
  forget(run_id: string): Promise<void>;
}

const wake_command_timeout_in_seconds = 30;

// ── Pool ─────────────────────────────────────────────────────────────────────

// An agent for a host with none connected, which answers every request as unreachable.
class MissingAgent implements Agent {
  private readonly message: string;

  constructor(name: string, message = `No agent named '${name}' is connected`) {
    this.message = message;
  }

  async run(): Promise<RunResult> {
    return { exit_code: -1, stdout: "", stderr: this.message };
  }

  async start(): Promise<LongRun> {
    throw new AgentError(this.message, true);
  }

  async poll(): Promise<LongRunPoll> {
    throw new AgentError(this.message, true);
  }

  async forget(): Promise<void> {}
}

// The agents by host name; the server's own host is served by its built-in agent.
export class AgentPool {
  private readonly agents = new Map<string, Agent>();
  readonly own_host: string;
  private readonly send_wake: SendWake;
  private wake_settings = new Map<string, WakeSettings>();
  private kept_awake = new Set<string>();
  // Who waits on each host's agent to dial in after waking it.
  private readonly waiting = new Map<string, Set<() => void>>();
  // The long runs waiting on their host to wake before they start.
  private readonly starting = new Set<string>();

  constructor(own_host: string, own_agent: Agent, send_wake: SendWake = send_magic_packet) {
    this.own_host = own_host;
    this.agents.set(own_host, own_agent);
    this.send_wake = send_wake;
  }

  // Takes how each host that sleeps is woken, and which hosts are kept awake through every job.
  set_wake(settings: Map<string, WakeSettings>, kept_awake: Set<string> = new Set(settings.keys())): void {
    this.wake_settings = settings;
    this.kept_awake = kept_awake;
  }

  add(host: string, agent: Agent): void {
    this.agents.set(host, agent);
    for (const arrived of this.waiting.get(host) ?? []) arrived();
  }

  remove(host: string): void {
    if (host !== this.own_host) this.agents.delete(host);
  }

  // The agent for a host, or the server's own when no host is named.
  get(host: string | null): Agent {
    const name = host ?? this.own_host;
    return this.agents.get(name) ?? new MissingAgent(name);
  }

  // The agent for a host, waking the host first when its agent is away and it can be woken; for operations, not reads.
  async awake(host: string | null): Promise<Agent> {
    const name = host ?? this.own_host;
    const settings = this.wake_settings.get(name);
    if (this.agents.has(name) || settings === undefined) return this.get(name);

    let stop_waiting = () => {};
    const arrived = new Promise<boolean>((resolve) => {
      const on_arrival = () => finish(true);
      const timer = setTimeout(() => finish(false), settings.timeout * 1000);
      const finish = (outcome: boolean) => {
        clearTimeout(timer);
        this.waiting.get(name)?.delete(on_arrival);
        resolve(outcome);
      };
      stop_waiting = () => finish(false);
      this.waiting.set(name, (this.waiting.get(name) ?? new Set()).add(on_arrival));
    });
    try {
      await (settings.via === null ? this.send_wake(settings) : this.send_through(settings.via, settings));
    } catch (error) {
      stop_waiting();
      return new MissingAgent(name, `Could not wake ${name}: ${(error as Error).message}`);
    }

    if (!(await arrived)) return new MissingAgent(name, `${name} was sent a wake-on-LAN packet, but its agent did not connect within ${format_duration(settings.timeout)}`);
    return this.get(name);
  }

  // Sends the packet from another host's agent on the sleeping host's network.
  private async send_through(via: string, settings: WakeSettings): Promise<void> {
    const result = await this.get(via).run(wake_operation(settings), wake_command_timeout_in_seconds);
    if (result.exit_code !== 0) throw new Error(`${via} could not send the packet: ${(result.stderr || result.stdout).trim().slice(0, 200)}`);
  }

  // Whether every job on a host holds off idle and sleep until it ends.
  keeps_awake(host: string | null): boolean {
    return this.kept_awake.has(host ?? this.own_host);
  }

  // Whether a host's agent is away and the host can be woken.
  can_wake(host: string | null): boolean {
    const name = host ?? this.own_host;
    return !this.agents.has(name) && this.wake_settings.has(name);
  }

  // Wakes a host and starts a long run on it, counting the run as starting until then; rejects with why it did not start.
  start_when_awake(host: string | null, run_id: string, operation: Operation, stdin: string | null = null): Promise<void> {
    this.starting.add(run_id);
    return this.awake(host)
      .then(async (agent) => void (await agent.start(run_id, operation, stdin)))
      .finally(() => this.starting.delete(run_id));
  }

  // Whether a long run waits on its host to wake before it starts.
  is_starting(run_id: string | null): boolean {
    return run_id !== null && this.starting.has(run_id);
  }
}
