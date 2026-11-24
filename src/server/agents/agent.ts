// What the server can ask of one host's agent, and the pool of agents deployments name.

// ── Imports ──────────────────────────────────────────────────────────────────

import { format_duration } from "@x-tech-laboratories/x-libs/durations";
import { AgentError, type Agent as XLibsAgent } from "@x-tech-laboratories/x-libs/server/agents/agent";

import type { LongRun, LongRunPoll, RunResult } from "../../shared/agent_protocol.ts";
import type { Operation } from "../../shared/operations.ts";
import { send_magic_packet, wake_operation, type SendWake, type WakeSettings } from "./wake.ts";

export { AgentError } from "@x-tech-laboratories/x-libs/server/agents/agent";
export type { LongRun, LongRunPoll, LongRunState, RunResult } from "../../shared/agent_protocol.ts";

// ── Agent ────────────────────────────────────────────────────────────────────

// The part of an X-Libs agent X-Nix uses: run performs an operation to its end and never rejects, start begins a long
// run that outlives the agent, poll reads its output past an offset, stop ends a long run, and forget removes an ended one.
export type Agent = Pick<XLibsAgent<Operation>, "run" | "start" | "poll" | "stop" | "forget">;

const wake_command_timeout_in_seconds = 30;

// Why a long run waiting on its host to wake never started: someone stopped it first.
export class StoppedBeforeStart extends Error {
  readonly by: string;

  constructor(by: string) {
    super(`Stopped by ${by} before the host woke`);
    this.by = by;
  }
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

  async stop(): Promise<LongRun> {
    throw new AgentError(this.message, true);
  }

  async forget(): Promise<void> {}
}

// The agents by host name; the server's own host is served by its built-in agent, or by its own agent dialling in.
export class AgentPool {
  private readonly agents = new Map<string, Agent>();
  readonly own_host: string;
  // Whether the server works on its own host itself rather than through an agent there.
  readonly has_own_agent: boolean;
  private readonly send_wake: SendWake;
  private wake_settings = new Map<string, WakeSettings>();
  private kept_awake = new Set<string>();
  // Who waits on each host's agent to dial in after waking it.
  private readonly waiting = new Map<string, Set<() => void>>();
  // The long runs waiting on their host to wake before they start, each with how to call it off.
  private readonly starting = new Map<string, (by: string) => void>();
  // Who stopped each long run, until the job following it has finished.
  private readonly stopped = new Map<string, string>();

  constructor(own_host: string, own_agent: Agent | null, send_wake: SendWake = send_magic_packet) {
    this.own_host = own_host;
    this.has_own_agent = own_agent !== null;
    if (own_agent !== null) this.agents.set(own_host, own_agent);
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
    if (host !== this.own_host || !this.has_own_agent) this.agents.delete(host);
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

  // Sends a host's wake packet now, without waiting for its agent to dial in; rejects with why it could not be sent.
  async wake(host: string): Promise<void> {
    const settings = this.wake_settings.get(host);
    if (settings === undefined) throw new Error(`${host} has no wake-on-LAN settings`);
    await (settings.via === null ? this.send_wake(settings) : this.send_through(settings.via, settings));
  }

  // Sends the packet from another host's agent on the sleeping host's network.
  private async send_through(via: string, settings: WakeSettings): Promise<void> {
    const result = await this.get(via).run(wake_operation(settings), { timeout_in_seconds: wake_command_timeout_in_seconds });
    if (result.exit_code !== 0) throw new Error(`${via} could not send the packet: ${(result.stderr || result.stdout).trim().slice(0, 200)}`);
  }

  // Whether every job on a host holds off sleep until it ends.
  keeps_awake(host: string | null): boolean {
    return this.kept_awake.has(host ?? this.own_host);
  }

  // The command a host runs once a job has woken it, or null.
  screen_off(host: string | null): string | null {
    return this.wake_settings.get(host ?? this.own_host)?.screen_off ?? null;
  }

  // Whether a host's agent is away and the host can be woken.
  can_wake(host: string | null): boolean {
    const name = host ?? this.own_host;
    return !this.agents.has(name) && this.wake_settings.has(name);
  }

  // The first host in order of preference whose agent is connected, else the first that can be woken, else the first.
  pick(ranked: (string | null)[], wake = true): string | null {
    const hosts = ranked.length === 0 ? [null] : ranked;
    const connected = hosts.findIndex((host) => this.agents.has(host ?? this.own_host));
    if (connected !== -1) return hosts[connected];
    const wakeable = wake ? hosts.findIndex((host) => this.can_wake(host)) : -1;
    return hosts[wakeable === -1 ? 0 : wakeable];
  }

  // Wakes a host and starts a long run on it, counting the run as starting until then; rejects with why it did not start.
  // A stop while it waits calls it off, rejecting with StoppedBeforeStart; once the host is awake the run starts.
  start_when_awake(host: string | null, run_id: string, operation: Operation, stdin: string | null = null): Promise<void> {
    const called_off = new Promise<never>((_resolve, reject) => {
      this.starting.set(run_id, (by) => reject(new StoppedBeforeStart(by)));
    });
    return Promise.race([this.awake(host), called_off])
      .then(async (agent) => {
        this.starting.delete(run_id);
        await agent.start(run_id, operation, { stdin });
      })
      .finally(() => this.starting.delete(run_id));
  }

  // Calls off a long run still waiting on its host to wake, so it never starts; false when it is not waiting.
  call_off(run_id: string, by: string): boolean {
    const call_off = this.starting.get(run_id);
    if (call_off === undefined) return false;
    this.starting.delete(run_id);
    call_off(by);
    return true;
  }

  // Whether a long run waits on its host to wake before it starts.
  is_starting(run_id: string | null): boolean {
    return run_id !== null && this.starting.has(run_id);
  }

  // Stops a long run on a host, remembering who stopped it for the job that follows it.
  async stop(host: string | null, run_id: string, by: string): Promise<LongRun> {
    this.stopped.set(run_id, by);
    try {
      return await this.get(host).stop(run_id);
    } catch (error) {
      this.stopped.delete(run_id);
      throw error;
    }
  }

  // Who stopped a long run, or null when nobody did; once read for a finished job it is forgotten.
  stopped_by(run_id: string, forget = false): string | null {
    const by = this.stopped.get(run_id) ?? null;
    if (forget) this.stopped.delete(run_id);
    return by;
  }
}
