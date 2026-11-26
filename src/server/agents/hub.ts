// The agents that have dialled in over /api/agent, through X-Libs' hub. Each host's agent names it in the upgrade and
// proves it holds the key the config declares for that host by signing the server's nonce; once in, it joins the pool
// every deployment and cache reaches its host through, and its pull reports join the job history. Given the server's own
// key, the hub signs its challenge and every message to each agent that checks the server.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";

import { AgentKeyError, parse_private_key } from "@x-tech-laboratories/x-libs/agent/keys";
import { AgentHub, type AgentStatus, type HubOptions } from "@x-tech-laboratories/x-libs/server/agents/hub";
import type { LocalAgent } from "@x-tech-laboratories/x-libs/server/agents/local";

import { x_nix_app } from "../../shared/agent_protocol.ts";
import type { Operation } from "../../shared/operations.ts";
import type { AgentPool } from "./agent.ts";

export { close_codes, type AgentStatus } from "@x-tech-laboratories/x-libs/server/agents/hub";

// ── Settings ─────────────────────────────────────────────────────────────────

export type Hub = AgentHub<Operation>;

export interface HubSettings extends Pick<HubOptions<Operation>, "hello_timeout_in_milliseconds" | "connection" | "server_key"> {
  // Keeps the switches a host's agent ran on its own while the server was away, answering with the run ids it kept.
  on_pulls?: (host: string, pulls: unknown[]) => string[];
}

// The comment the server's public line carries where the page shows it.
const server_key_comment = "x-nix-server";

// The server's public key as an operator copies it into each agent's serverPublicKeys.
export interface ServerKeyView {
  public_line: string;
  fingerprint: string;
}

export class ServerKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerKeyError";
  }
}

// ── Server key ───────────────────────────────────────────────────────────────

// The server's ed25519 private key from its file, or a ServerKeyError saying why the file cannot be used; no message quotes the key.
export function read_server_key(file: string): KeyObject {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new ServerKeyError(`Could not read the server key file ${file}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
  }
  try {
    return parse_private_key(text);
  } catch (error) {
    if (error instanceof AgentKeyError) throw new ServerKeyError(`The server key file ${file} ${error.message}`);
    throw error;
  }
}

// The server's public line and fingerprint, or null when it signs nothing.
export function server_key_view(hub: Hub | undefined): ServerKeyView | null {
  const public_line = hub?.server_public_line(server_key_comment) ?? null;
  const fingerprint = hub?.server_key_fingerprint() ?? null;
  return public_line === null || fingerprint === null ? null : { public_line, fingerprint };
}

// ── Hub ──────────────────────────────────────────────────────────────────────

// A hub whose agents join the pool as they connect and leave it as they go; the server's own host is the built-in agent
// when there is one, and otherwise dials in like any other.
export function create_hub(pool: AgentPool, local: LocalAgent<Operation> | null, settings: HubSettings = {}): Hub {
  const hub: Hub = new AgentHub({
    app: x_nix_app,
    ...(local === null ? {} : { local: { host: pool.own_host, agent: local } }),
    hello_timeout_in_milliseconds: settings.hello_timeout_in_milliseconds,
    connection: settings.connection,
    server_key: settings.server_key ?? null,
    on_message: (host, message, connection) => {
      if (message.type !== "pulls" || !Array.isArray(message.pulls) || settings.on_pulls === undefined) return;
      const kept = settings.on_pulls(host, message.pulls);
      if (kept.length > 0) connection.send({ type: "pulls_received", run_ids: kept });
    },
  });
  hub.on("connect", (status) => {
    const agent = hub.agent(status.host);
    if (agent !== null) pool.add(status.host, agent);
  });
  hub.on("disconnect", (host) => pool.remove(host));
  return hub;
}

// Each host with a declared key, and its agent's status when connected.
export function agent_statuses(hub: Hub): { host: string; status: AgentStatus | null }[] {
  return hub.declared_hosts().map((host) => ({ host, status: hub.status(host) }));
}
