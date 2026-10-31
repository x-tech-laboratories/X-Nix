import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { build_app, type HealthAnswer } from "../src/server/app.ts";

// ── Setup ────────────────────────────────────────────────────────────────────

let app: FastifyInstance | null = null;

async function start_app(): Promise<FastifyInstance> {
  app = await build_app({ serve_web: false, logger: false, server_name: "workstation" });
  return app;
}

afterEach(async () => {
  await app?.close();
  app = null;
});

// ── Health ───────────────────────────────────────────────────────────────────

describe("/api/health", () => {
  it("names the app, its version and the machine it runs on", async () => {
    const server = await start_app();

    const response = await server.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    const answer = response.json<HealthAnswer>();
    expect(answer.name).toBe("X-Nix");
    expect(answer.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(answer.server_name).toBe("workstation");
  });
});

// ── Unknown paths ────────────────────────────────────────────────────────────

describe("an unknown path", () => {
  it("answers 404 as JSON under /api", async () => {
    const server = await start_app();

    const response = await server.inject({ method: "GET", url: "/api/nothing-here" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Not found" });
  });
});
