// One connection to the server: says hello with its signature of the server's challenge, reports the switches pull mode
// ran while the server was away, and answers each request. Closing it leaves long runs going.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { KeyObject } from "node:crypto";

import { sign_challenge } from "../shared/agent_keys.ts";
import { encode_message, parse_server_message, protocol_version, type AgentMessage, type PullReport, type RequestMessage } from "../shared/agent_protocol.ts";
import { run_command } from "./commands.ts";
import { check_keys, write_key } from "./keys.ts";
import type { LongRuns } from "./long_runs.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

export interface SessionOptions {
  host: string;
  agent_version: string;
  // A ping goes out this often, and a server silent for three of them is taken as gone.
  heartbeat_in_milliseconds: number;
  // The host's private key, which signs the server's challenge.
  key: KeyObject;
  // The switches pull mode ran on its own, reported until the server says it has them.
  pulls?: { pending(): Promise<PullReport[]>; acknowledge(run_ids: string[]): void };
}

// The smallest message a socket can send, so a test can stand in for one.
export interface MessageSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

const socket_open = 1;

// ── Session ──────────────────────────────────────────────────────────────────

export class AgentSession {
  private readonly socket: MessageSocket;
  private readonly runs: LongRuns;
  private readonly options: SessionOptions;
  private last_heard = Date.now();
  private readonly heartbeat: NodeJS.Timeout;
  private closed = false;
  private greeted = false;

  constructor(socket: MessageSocket, runs: LongRuns, options: SessionOptions) {
    this.socket = socket;
    this.runs = runs;
    this.options = options;
    this.heartbeat = setInterval(() => this.beat(), options.heartbeat_in_milliseconds);
    this.heartbeat.unref();
  }

  // Handles one text frame from the server; anything this protocol does not know is ignored.
  receive(text: string): void {
    this.last_heard = Date.now();
    const message = parse_server_message(text);
    if (message === null) return;
    switch (message.type) {
      case "ping":
        this.send({ type: "pong", epoch_ms: message.epoch_ms });
        return;
      case "pong":
        return;
      case "challenge":
        if (this.greeted) return;
        this.greeted = true;
        this.send({
          type: "hello", protocol: protocol_version, host: this.options.host, agent_version: this.options.agent_version, runs: this.runs.list(),
          signature: sign_challenge(this.options.key, this.options.host, message.nonce),
        });
        void this.report_pulls();
        return;
      case "pulls_received":
        this.options.pulls?.acknowledge(message.run_ids.filter((run_id) => typeof run_id === "string"));
        return;
      default:
        void this.answer(message);
    }
  }

  // Sends the server every switch pull mode ran that it has not yet received.
  async report_pulls(): Promise<void> {
    if (!this.greeted || this.options.pulls === undefined) return;
    const pulls = await this.options.pulls.pending();
    if (pulls.length > 0) this.send({ type: "pulls", pulls });
  }

  close(): void {
    this.closed = true;
    clearInterval(this.heartbeat);
  }

  send(message: AgentMessage): void {
    if (!this.closed && this.socket.readyState === socket_open) this.socket.send(encode_message(message));
  }

  private async answer(message: RequestMessage): Promise<void> {
    try {
      this.send({ type: "reply", id: message.id, value: await this.value_for(message) });
    } catch (error) {
      this.send({ type: "failed", id: message.id, error: (error as Error).message });
    }
  }

  private async value_for(message: RequestMessage): Promise<unknown> {
    switch (message.type) {
      case "run":
        return run_command(message.command, { timeout_in_seconds: message.timeout_in_seconds, stdin: message.stdin });
      case "start":
        return this.runs.start(message.run_id, message.command, message.stdin);
      case "poll":
        return this.runs.poll(message.run_id, message.offset);
      case "stop":
        return this.runs.stop(message.run_id);
      case "forget":
        this.runs.forget(message.run_id);
        return null;
      case "runs":
        return this.runs.list();
      case "write_key":
        return write_key(message);
      case "check_keys":
        return check_keys(message.destinations, message.salt, message.sudo);
    }
  }

  // Pings the server, or gives up on one that has been silent for three beats.
  private beat(): void {
    if (Date.now() - this.last_heard > 3 * this.options.heartbeat_in_milliseconds) {
      this.socket.close(4008, "The server stopped answering.");
      this.close();
      return;
    }
    this.send({ type: "ping", epoch_ms: Date.now() });
  }
}
