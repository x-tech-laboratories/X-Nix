import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { build_app, type CacheView, type DeploymentView, type HealthAnswer } from "../src/server/app.ts";
import { hash_password } from "../src/server/auth.ts";
import { Cache } from "../src/server/cache.ts";
import { cache_settings } from "../src/server/config.ts";
import { Poller } from "../src/server/poller.ts";
import { clock, make_deployment, result, type Harness } from "./fake_agent.ts";

// ── Setup ────────────────────────────────────────────────────────────────────

const password = "correct horse battery staple";
const password_hash = hash_password(password);

let app: FastifyInstance | null = null;

// The app, and a request helper carrying a logged-in session.
async function start_app(harness: Harness = make_deployment(), caches: Cache[] = []) {
  app = await build_app({ serve_web: false, logger: false, server_name: "workstation", password_hash, store: harness.store, poller: new Poller([harness.deployment], null, caches) });
  const login = await app.inject({ method: "POST", url: "/api/login", payload: { password } });
  const cookie = String(login.headers["set-cookie"]).split(";")[0];
  const server = app;
  return {
    server,
    inject: (method: "GET" | "POST", url: string) => server.inject({ method, url, headers: { cookie } }),
  };
}

afterEach(async () => {
  await app?.close();
  app = null;
});

// ── Health ───────────────────────────────────────────────────────────────────

describe("/api/health", () => {
  it("names the app, its version and the machine it runs on", async () => {
    const { server } = await start_app();

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
    const { inject } = await start_app(make_deployment({ flake: "github:owner/config" }));

    const [deployment] = (await inject("GET", "/api/deployments")).json<DeploymentView[]>();

    expect(deployment.id).toBe("host-deploy");
    expect(deployment.actions.map((action) => action.id)).toEqual(["update", "build", "switch", "reboot", "collect"]);
    expect(deployment.actions[0].refusal).toContain("push_ssh_key");
    expect(deployment.actions[3].confirm).toContain("Reboot");
    expect(deployment.actions[4].confirm).toContain("Collect garbage");
    expect(deployment.gc?.command).toBe("sudo -n nix-collect-garbage --delete-older-than 7d");
  });

  it("starts an action, then refuses a second one with 409", async () => {
    const harness = make_deployment();
    const { inject } = await start_app(harness);

    const started = await inject("POST", "/api/deployments/host-deploy/actions/switch");
    const refused = await inject("POST", "/api/deployments/host-deploy/actions/build");

    expect(started.statusCode).toBe(200);
    expect(refused.statusCode).toBe(409);
    const jobs = (await inject("GET", "/api/jobs?deployment=host-deploy")).json<{ id: number; kind: string }[]>();
    expect(jobs.map((job) => job.kind)).toEqual(["switch"]);
    expect((await inject("GET", `/api/jobs/${jobs[0].id}`)).json()).toHaveProperty("output");
    expect((await inject("GET", "/api/jobs?kind=collect")).json()).toEqual([]);
  });

  it("answers 404 for an unknown deployment or action", async () => {
    const { inject } = await start_app();

    expect((await inject("GET", "/api/deployments/nowhere")).statusCode).toBe(404);
    expect((await inject("POST", "/api/deployments/host-deploy/actions/explode")).statusCode).toBe(404);
  });
});

// ── Login ────────────────────────────────────────────────────────────────────

describe("logging in", () => {
  it("is needed for every API route but the health check", async () => {
    const { server } = await start_app();

    expect((await server.inject({ method: "GET", url: "/api/deployments" })).statusCode).toBe(401);
    expect((await server.inject({ method: "POST", url: "/api/deployments/host-deploy/actions/reboot" })).statusCode).toBe(401);
    expect((await server.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
  });

  it("refuses a wrong password, then every try after five", async () => {
    const { server } = await start_app();
    const attempt = (guess: string) => server.inject({ method: "POST", url: "/api/login", payload: { password: guess } });

    for (let count = 0; count < 5; count++) expect((await attempt("wrong")).statusCode).toBe(401);

    expect((await attempt(password)).statusCode).toBe(429);
  });

  it("ends the session on logout", async () => {
    const { inject } = await start_app();

    await inject("POST", "/api/logout");

    expect((await inject("GET", "/api/deployments")).statusCode).toBe(401);
  });
});

// ── Unknown paths ────────────────────────────────────────────────────────────

describe("an unknown path", () => {
  it("answers 404 as JSON under /api", async () => {
    const { inject } = await start_app();

    const response = await inject("GET", "/api/nothing-here");

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Not found" });
  });
});

describe("/api/deployments/:id/next-boot", () => {
  it("sets the next boot to a known entry and refuses others", async () => {
    const harness = make_deployment();
    harness.agent.boot_probe_result = result(0, `loader=efi\n@@entries\nBootOrder: 0001\nBoot0001* Linux Boot Manager\tHD(1)\nBoot0003* Windows Boot Manager\tHD(1)\n`);
    await harness.deployment.cycle();
    const { server, inject } = await start_app(harness);
    const cookie = String((await server.inject({ method: "POST", url: "/api/login", payload: { password } })).headers["set-cookie"]).split(";")[0];
    const post = (payload: unknown) => server.inject({ method: "POST", url: "/api/deployments/host-deploy/next-boot", headers: { cookie }, payload: payload as object });

    expect((await inject("GET", "/api/deployments/host-deploy")).json<DeploymentView>().next_boot_refusal).toBeNull();
    expect((await post({ entry: "0003" })).statusCode).toBe(200);
    expect(harness.agent.commands).toContain("sudo -n efibootmgr --bootnext 0003");
    expect((await post({ entry: "9999" })).statusCode).toBe(409);
    expect((await post({})).statusCode).toBe(400);
  });
});

// ── Caches ───────────────────────────────────────────────────────────────────

describe("/api/caches", () => {
  it("lists each cache with its targets, and starts a build on one", async () => {
    const harness = make_deployment();
    const cache = new Cache(cache_settings({ id: "fleet", cache_url: "https://cache.example/fleet", configurations: ["Alpha"] }), { store: harness.store, agents: harness.agents, now: () => clock.now });
    const { inject } = await start_app(harness, [cache]);

    const [view] = (await inject("GET", "/api/caches")).json<CacheView[]>();
    expect(view.targets.map((target) => [target.name, target.refusals.push])).toEqual([["Alpha", "No push_command is set, so X-Nix cannot push"]]);

    const started = await inject("POST", "/api/caches/fleet/targets/Alpha/build");
    expect(started.statusCode).toBe(200);
    expect((await inject("POST", "/api/caches/fleet/targets/Gamma/build")).statusCode).toBe(409);
    expect((await inject("POST", "/api/caches/fleet/targets/Alpha/delete")).statusCode).toBe(404);
    expect((await inject("GET", "/api/caches/nope")).statusCode).toBe(404);
  });
});
