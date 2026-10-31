// What the server can ask of one host's agent, and the pool of agents deployments name.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { LongRun, LongRunPoll, RunResult } from "../../shared/agent_protocol.ts";

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

  constructor(name: string) {
    this.message = `No agent named '${name}' is connected`;
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

  constructor(own_host: string, own_agent: Agent) {
    this.own_host = own_host;
    this.agents.set(own_host, own_agent);
  }

  add(host: string, agent: Agent): void {
    this.agents.set(host, agent);
  }

  remove(host: string): void {
    if (host !== this.own_host) this.agents.delete(host);
  }

  // The agent for a host, or the server's own when no host is named.
  get(host: string | null): Agent {
    const name = host ?? this.own_host;
    return this.agents.get(name) ?? new MissingAgent(name);
  }
}
