// The WebSocket agents dial in on. The upgrade names the host, so one with no declared key is refused before any socket
// opens.

// ── Imports ──────────────────────────────────────────────────────────────────

import fastify_websocket from "@fastify/websocket";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { ServerSocket } from "./connection.ts";
import type { AgentHub } from "./hub.ts";

// A run's output can be large, so one message may be up to this size.
const largest_message_in_bytes = 64 * 1024 * 1024;

// ── Route ────────────────────────────────────────────────────────────────────

export async function register_agent_route(app: FastifyInstance, hub: AgentHub): Promise<void> {
  await app.register(fastify_websocket, { options: { maxPayload: largest_message_in_bytes } });
  const admitted = new WeakMap<FastifyRequest, string>();

  app.get("/api/agent", {
    websocket: true,
    preValidation: async (request, reply) => {
      const admission = hub.admit(request.headers);
      if ("error" in admission) return reply.code(401).send({ error: admission.error });
      admitted.set(request, admission.host);
    },
  }, (socket, request) => {
    hub.accept(socket as unknown as ServerSocket, admitted.get(request)!);
  });

  app.addHook("onClose", async () => hub.close());
}
