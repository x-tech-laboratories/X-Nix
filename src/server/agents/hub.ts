// The agents that have dialled in over /api/agent, copied from X-Backups with key login only. Each host's agent names
// it in the upgrade and proves it holds the key the config declares for that host by signing the server's nonce; once
// in, it joins the pool every deployment and cache reaches its host through.

// ── Imports ──────────────────────────────────────────────────────────────────

import { randomBytes, type KeyObject } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingHttpHeaders } from "node:http";

import { parse_public_key, verify_challenge } from "../../shared/agent_keys.ts";
import { encode_message, key_host_header, parse_agent_message, protocol_version, type LongRun, type PullReport } from "../../shared/agent_protocol.ts";
import type { AgentPool } from "./agent.ts";
import { AgentConnection, type ConnectionOptions, type ServerSocket } from "./connection.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

export interface HubOptions {
  // How long a new socket has to say hello.
  hello_timeout_in_milliseconds?: number;
  connection?: Partial<ConnectionOptions>;
}

// A connected agent as the page shows it.
export interface AgentStatus {
  host: string;
  agent_version: string;
  connected_epoch: number;
  // The long runs the agent knew of when it connected.
  runs: LongRun[];
}

// The host an agent's upgrade names, before any socket opens, or why it is turned away.
export type Admission = { host: string } | { error: string };

interface HubEvents {
  connect: [status: AgentStatus];
  disconnect: [host: string];
}

// Close codes the hub hangs up with.
export const close_codes = {
  protocol: 4002,
  replaced: 4003,
  revoked: 4004,
  no_hello: 4005,
  bad_key: 4006,
} as const;

const default_connection: ConnectionOptions = {
  request_timeout_in_milliseconds: 60_000,
  heartbeat_in_milliseconds: 15_000,
};

// ── Hub ──────────────────────────────────────────────────────────────────────

export class AgentHub extends EventEmitter<HubEvents> {
  private readonly pool: AgentPool;
  private readonly hello_timeout: number;
  private readonly connection_options: ConnectionOptions;
  private readonly connections = new Map<string, AgentConnection>();
  // Each host's declared public key, with the line it was read from.
  private agent_keys = new Map<string, { line: string; key: KeyObject }>();
  // Keeps the switches a host's agent ran on its own while the server was away, answering with the run ids it kept.
  on_pulls: ((host: string, pulls: PullReport[]) => string[]) | null = null;

  constructor(pool: AgentPool, options: HubOptions = {}) {
    super();
    this.pool = pool;
    this.hello_timeout = options.hello_timeout_in_milliseconds ?? 10_000;
    this.connection_options = { ...default_connection, ...options.connection };
  }

  // Takes each host's declared OpenSSH public key line, and hangs up on an agent whose host's key is new, changed or gone.
  set_agent_keys(lines: Map<string, string>): void {
    const next = new Map([...lines].map(([host, line]) => [host, { line, key: parse_public_key(line) }]));
    for (const host of new Set([...this.agent_keys.keys(), ...next.keys()])) {
      if (this.agent_keys.get(host)?.line === next.get(host)?.line) continue;
      this.disconnect(host, close_codes.revoked, "The host's declared agent key changed.");
    }
    this.agent_keys = next;
  }

  // The host an agent's upgrade names, if it has a declared key.
  admit(headers: IncomingHttpHeaders): Admission {
    const named = headers[key_host_header];
    if (typeof named !== "string" || named === "") return { error: `Name the host in the ${key_host_header} header.` };
    if (named === this.pool.own_host) return { error: `'${named}' is the server's own host, which needs no agent.` };
    if (!this.agent_keys.has(named)) return { error: `Host '${named}' has no declared agent key.` };
    return { host: named };
  }

  // Sends the socket a nonce, and takes it as the host's agent once its hello carries the nonce signed.
  accept(socket: ServerSocket, host: string): void {
    let connection: AgentConnection | null = null;
    const hello_timer = setTimeout(() => socket.close(close_codes.no_hello, "No hello came."), this.hello_timeout);
    const nonce = randomBytes(32).toString("base64url");
    socket.send(encode_message({ type: "challenge", nonce }));

    socket.on("message", (raw, is_binary) => {
      const data = as_buffer(raw);
      if (connection !== null) {
        if (!is_binary) connection.receive(data);
        return;
      }
      const hello = is_binary ? null : parse_agent_message(data.toString("utf8"));
      if (hello?.type !== "hello") return;
      clearTimeout(hello_timer);
      if (hello.protocol !== protocol_version) {
        socket.close(close_codes.protocol, `This server speaks agent protocol ${protocol_version}, not ${hello.protocol}.`);
        return;
      }
      if (!this.proves_key(host, nonce, hello.signature)) {
        socket.close(close_codes.bad_key, `The agent's key is not the one declared for ${host}.`);
        return;
      }
      this.connections.get(host)?.close(close_codes.replaced, "A newer connection from the same host replaced this one.");
      connection = new AgentConnection(socket, host, hello, this.connection_options);
      connection.on_pulls = (pulls) => this.on_pulls?.(host, pulls) ?? [];
      this.connections.set(host, connection);
      this.pool.add(host, connection);
      this.emit("connect", status_of(connection));
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(hello_timer);
      if (connection === null) return;
      connection.closed(`The agent on ${host} disconnected.`);
      if (this.connections.get(host) !== connection) return;
      this.connections.delete(host);
      this.pool.remove(host);
      this.emit("disconnect", host);
    });
  }

  private proves_key(host: string, nonce: string, signature: unknown): boolean {
    const declared = this.agent_keys.get(host);
    return declared !== undefined && typeof signature === "string" && verify_challenge(declared.key, host, nonce, signature);
  }

  disconnect(host: string, code = 1000, reason = "The server hung up."): void {
    this.connections.get(host)?.close(code, reason);
  }

  close(): void {
    for (const host of this.connections.keys()) this.disconnect(host, 1001, "The server is stopping.");
  }

  is_connected(host: string): boolean {
    return this.connections.get(host)?.is_open === true;
  }

  // Each host with a declared key, and its agent's status when connected.
  statuses(): { host: string; status: AgentStatus | null }[] {
    return [...this.agent_keys.keys()].sort().map((host) => {
      const connection = this.connections.get(host);
      return { host, status: connection?.is_open ? status_of(connection) : null };
    });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function status_of(connection: AgentConnection): AgentStatus {
  return { host: connection.host, agent_version: connection.hello.agent_version, connected_epoch: connection.connected_epoch, runs: connection.hello.runs };
}

function as_buffer(raw: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
}
