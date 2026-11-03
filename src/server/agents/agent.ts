// What the server can ask of one host's agent, and the pool of agents deployments name.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { LongRun, LongRunPoll, RunResult } from "../../shared/agent_protocol.ts";
import { format_duration } from "../durations.ts";
import { send_magic_packet, type SendWake, type WakeSettings } from "./wake.ts";

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
  // Runs a command to its end; it never rejects, answering a failure to reach the host with exit code -1.
  run(command: string, timeout_in_seconds: number): Promise<RunResult>;
  // Starts a long run, which outlives the connection, the agent and the server; its stdin is piped in and never written
  // down by the agent. Rejects with an AgentError.
  start(run_id: string, command: string, stdin?: string | null): Promise<LongRun>;
  // What a long run has written past an offset in bytes, and whether it has ended; rejects with an AgentError.
  poll(run_id: string, offset: number): Promise<LongRunPoll>;
  // Removes an ended long run's output from the host.
  forget(run_id: string): Promise<void>;
}

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
  // Who waits on each host's agent to dial in after waking it.
  private readonly waiting = new Map<string, Set<() => void>>();

  constructor(own_host: string, own_agent: Agent, send_wake: SendWake = send_magic_packet) {
    this.own_host = own_host;
    this.agents.set(own_host, own_agent);
    this.send_wake = send_wake;
  }

  // Takes how each host that sleeps is woken.
  set_wake(settings: Map<string, WakeSettings>): void {
    this.wake_settings = settings;
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
      await this.send_wake(settings);
    } catch (error) {
      stop_waiting();
      return new MissingAgent(name, `Could not wake ${name}: ${(error as Error).message}`);
    }

    if (!(await arrived)) return new MissingAgent(name, `${name} was sent a wake-on-LAN packet, but its agent did not connect within ${format_duration(settings.timeout)}`);
    return this.get(name);
  }
}
