// The agents that have dialled in over /api/agent, through X-Libs' hub. Each host's agent names it in the upgrade and
// proves it holds the key the config declares for that host by signing the server's nonce; once in, it joins the pool
// every deployment and cache reaches its host through, and its pull reports join the job history.

// ── Imports ──────────────────────────────────────────────────────────────────

import { AgentHub, type AgentStatus, type HubOptions } from "@x-tech-laboratories/x-libs/server/agents/hub";
import type { LocalAgent } from "@x-tech-laboratories/x-libs/server/agents/local";

import { x_nix_app } from "../../shared/agent_protocol.ts";
import type { Operation } from "../../shared/operations.ts";
import type { AgentPool } from "./agent.ts";

export { close_codes, type AgentStatus } from "@x-tech-laboratories/x-libs/server/agents/hub";

// ── Settings ─────────────────────────────────────────────────────────────────

export type Hub = AgentHub<Operation>;

export interface HubSettings extends Pick<HubOptions<Operation>, "hello_timeout_in_milliseconds" | "connection"> {
  // Keeps the switches a host's agent ran on its own while the server was away, answering with the run ids it kept.
  on_pulls?: (host: string, pulls: unknown[]) => string[];
}

// ── Hub ──────────────────────────────────────────────────────────────────────

// A hub whose agents join the pool as they connect and leave it as they go; the server's own host is the built-in agent.
export function create_hub(pool: AgentPool, local: LocalAgent<Operation>, settings: HubSettings = {}): Hub {
  const hub: Hub = new AgentHub({
    app: x_nix_app,
    local: { host: pool.own_host, agent: local },
    hello_timeout_in_milliseconds: settings.hello_timeout_in_milliseconds,
    connection: settings.connection,
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
