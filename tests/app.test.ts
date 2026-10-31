import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { build_app, type DeploymentView, type HealthAnswer } from "../src/server/app.ts";
import { Poller } from "../src/server/poller.ts";
import { make_deployment, type Harness } from "./fake_agent.ts";

// ── Setup ────────────────────────────────────────────────────────────────────

let app: FastifyInstance | null = null;

async function start_app(harness: Harness = make_deployment()): Promise<FastifyInstance> {
  app = await build_app({ serve_web: false, logger: false, server_name: "workstation", store: harness.store, poller: new Poller([harness.deployment]) });
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

// ── Deployments ──────────────────────────────────────────────────────────────

describe("/api/deployments", () => {
  it("lists each deployment with its actions", async () => {
    const server = await start_app(make_deployment({ flake: "github:owner/config" }));

    const [deployment] = (await server.inject({ method: "GET", url: "/api/deployments" })).json<DeploymentView[]>();

    expect(deployment.id).toBe("host-deploy");
    expect(deployment.actions.map((action) => action.id)).toEqual(["update", "build", "switch", "reboot"]);
    expect(deployment.actions[0].refusal).toContain("push_ssh_key");
    expect(deployment.actions[3].confirm).toContain("Reboot");
  });

  it("starts an action, then refuses a second one with 409", async () => {
    const harness = make_deployment();
    const server = await start_app(harness);

    const started = await server.inject({ method: "POST", url: "/api/deployments/host-deploy/actions/switch" });
    const refused = await server.inject({ method: "POST", url: "/api/deployments/host-deploy/actions/build" });

    expect(started.statusCode).toBe(200);
    expect(refused.statusCode).toBe(409);
    const jobs = (await server.inject({ method: "GET", url: "/api/jobs?deployment=host-deploy" })).json<{ id: number; kind: string }[]>();
    expect(jobs.map((job) => job.kind)).toEqual(["switch"]);
    expect((await server.inject({ method: "GET", url: `/api/jobs/${jobs[0].id}` })).json()).toHaveProperty("output");
  });

  it("answers 404 for an unknown deployment or action", async () => {
    const server = await start_app();

    expect((await server.inject({ method: "GET", url: "/api/deployments/nowhere" })).statusCode).toBe(404);
    expect((await server.inject({ method: "POST", url: "/api/deployments/host-deploy/actions/explode" })).statusCode).toBe(404);
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
