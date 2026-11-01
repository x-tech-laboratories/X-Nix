// One connected agent, as the server sees it, copied from X-Backups without its streams: sends it requests and matches
// each reply by id.

// ── Imports ──────────────────────────────────────────────────────────────────

import {
  encode_message, parse_agent_message, type AgentMessage, type LongRun, type LongRunPoll, type PullReport, type RequestType, type Requests,
  type RunResult, type ServerMessage,
} from "../../shared/agent_protocol.ts";
import { AgentError, type Agent } from "./agent.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

// The server end of an agent's WebSocket, as the ws library hands it over.
export interface ServerSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: Buffer | ArrayBuffer | Buffer[], is_binary: boolean) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export interface ConnectionOptions {
  // How long a request other than a run waits for its reply.
  request_timeout_in_milliseconds: number;
  heartbeat_in_milliseconds: number;
}

export type Hello = Extract<AgentMessage, { type: "hello" }>;

const socket_open = 1;

// A run's reply may come this long after its own timeout, which the agent enforces, before the server gives up.
const run_reply_slack_in_milliseconds = 30_000;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

// ── Connection ───────────────────────────────────────────────────────────────

export class AgentConnection implements Agent {
  readonly host: string;
  readonly hello: Hello;
  readonly connected_epoch = Math.floor(Date.now() / 1000);
  private readonly socket: ServerSocket;
  private readonly options: ConnectionOptions;
  private readonly pending = new Map<string, Pending>();
  private next_id = 1;
  private last_heard = Date.now();
  private readonly heartbeat: NodeJS.Timeout;
  private closed_reason: string | null = null;
  // Keeps the switches the agent ran on its own, answering with the run ids it kept.
  on_pulls: ((pulls: PullReport[]) => string[]) | null = null;

  constructor(socket: ServerSocket, host: string, hello: Hello, options: ConnectionOptions) {
    this.socket = socket;
    this.host = host;
    this.hello = hello;
    this.options = options;
    this.heartbeat = setInterval(() => this.beat(), options.heartbeat_in_milliseconds);
    this.heartbeat.unref();
  }

  get is_open(): boolean {
    return this.closed_reason === null;
  }

  // ── Agent ────────────────────────────────────────────────────────────────

  async run(command: string, timeout_in_seconds: number): Promise<RunResult> {
    try {
      return await this.request("run", { command, stdin: null, timeout_in_seconds }, timeout_in_seconds * 1000 + run_reply_slack_in_milliseconds);
    } catch (error) {
      return { exit_code: -1, stdout: "", stderr: (error as Error).message };
    }
  }

  start(run_id: string, command: string, stdin: string | null = null): Promise<LongRun> {
    return this.request("start", { run_id, command, stdin });
  }

  poll(run_id: string, offset: number): Promise<LongRunPoll> {
    return this.request("poll", { run_id, offset });
  }

  async forget(run_id: string): Promise<void> {
    await this.request("forget", { run_id });
  }

  // ── Socket ───────────────────────────────────────────────────────────────

  send(message: ServerMessage): void {
    if (this.is_open && this.socket.readyState === socket_open) this.socket.send(encode_message(message));
  }

  // Handles one frame from the agent after its hello.
  receive(data: Buffer): void {
    this.last_heard = Date.now();
    const message = parse_agent_message(data.toString("utf8"));
    if (message === null) return;
    if (message.type === "ping") {
      this.send({ type: "pong", epoch_ms: message.epoch_ms });
      return;
    }
    if (message.type === "pulls") {
      const kept = this.on_pulls?.(message.pulls) ?? [];
      if (kept.length > 0) this.send({ type: "pulls_received", run_ids: kept });
      return;
    }
    if (message.type !== "reply" && message.type !== "failed") return;
    const pending = this.pending.get(message.id);
    if (pending === undefined) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    // The agent answered that the request failed, which is not the host being out of reach.
    if (message.type === "reply") pending.resolve(message.value);
    else pending.reject(new AgentError(message.error));
  }

  // Fails what was waiting; the agent's long runs carry on.
  closed(reason: string): void {
    if (this.closed_reason !== null) return;
    this.closed_reason = reason;
    clearInterval(this.heartbeat);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new AgentError(reason, true));
    }
    this.pending.clear();
  }

  close(code: number, reason: string): void {
    this.socket.close(code, reason);
    this.closed(reason);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private request<K extends RequestType>(type: K, body: Requests[K]["body"], timeout = this.options.request_timeout_in_milliseconds): Promise<Requests[K]["reply"]> {
    if (!this.is_open) return Promise.reject(new AgentError(this.closed_reason!, true));
    const id = `r${this.next_id++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AgentError(`The agent on ${this.host} did not answer within ${Math.round(timeout / 1000)}s.`, true));
      }, timeout);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.send({ type, id, ...body } as ServerMessage);
    });
  }

  // Pings the agent, or drops one that has been silent for three beats.
  private beat(): void {
    if (Date.now() - this.last_heard > 3 * this.options.heartbeat_in_milliseconds) {
      this.close(4008, `The agent on ${this.host} stopped answering.`);
      return;
    }
    this.send({ type: "ping", epoch_ms: Date.now() });
  }
}
