// ── Imports ──────────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import fastify_static from "@fastify/static";

import type { DeploymentSettings, TimeOfDay } from "./config.ts";
import { action_ids, type ActionId, type Deployment, type Evaluation, type Reading } from "./deployment.ts";
import type { Poller } from "./poller.ts";
import type { EventRow, Job, Store } from "./store.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

export interface app_options {
  serve_web: boolean;
  logger: boolean;
  // What the page calls this machine; the system's hostname unless set.
  server_name?: string;
  store: Store;
  poller: Poller;
}

export interface HealthAnswer {
  name: string;
  version: string;
  server_name: string;
  started_epoch: number;
}

export interface ActionView {
  id: ActionId;
  label: string;
  // Why it cannot run now, or null when it can.
  refusal: string | null;
  // The question a person answers before it runs, or null for none.
  confirm: string | null;
}

export interface DeploymentView {
  id: string;
  name: string;
  host: string | null;
  flake: string;
  configuration: string | null;
  // The hosts other than the deployment's own that its jobs run on.
  agents: { eval: string | null; build: string | null; switch: string | null };
  schedule: { update: string | null; build: string | null };
  auto_switch: boolean;
  reading: Reading | null;
  evaluation: Evaluation;
  evaluating: boolean;
  running_job: Job | null;
  actions: ActionView[];
}

const action_labels: Record<ActionId, string> = { update: "Update flake", build: "Build", switch: "Rebuild and switch", reboot: "Reboot" };

const web_build_directory = fileURLToPath(new URL("../../dist", import.meta.url));
const package_file = fileURLToPath(new URL("../../package.json", import.meta.url));

// ── Views ────────────────────────────────────────────────────────────────────

function clock(at: TimeOfDay | null): string | null {
  return at === null ? null : `${String(at.hour).padStart(2, "0")}:${String(at.minute).padStart(2, "0")}`;
}

function deployment_view(deployment: Deployment): DeploymentView {
  const settings: DeploymentSettings = deployment.settings;
  return {
    id: settings.id,
    name: settings.name,
    host: settings.host,
    flake: settings.flake,
    configuration: settings.configuration,
    agents: { eval: deployment.agent_for("eval"), build: deployment.agent_for("build"), switch: deployment.agent_for("switch") },
    schedule: { update: clock(settings.update_at), build: clock(settings.build_at) },
    auto_switch: settings.auto_switch,
    reading: deployment.reading(),
    evaluation: deployment.evaluation(),
    evaluating: deployment.running_evaluation() !== null,
    running_job: deployment.running_job(),
    actions: action_ids.map((id) => ({
      id,
      label: action_labels[id],
      refusal: deployment.action_refusal(id),
      confirm: id === "reboot" ? `Reboot ${settings.name}? Everything running on it stops until it is back up.` : null,
    })),
  };
}

// ── App ──────────────────────────────────────────────────────────────────────

export async function build_app(options: app_options): Promise<FastifyInstance> {
  const app = fastify({ logger: options.logger });
  const version = (JSON.parse(readFileSync(package_file, "utf8")) as { version: string }).version;
  const started_epoch = Math.floor(Date.now() / 1000);
  const server_name = options.server_name ?? hostname();
  const { store, poller } = options;

  const find = (id: string, reply: FastifyReply): Deployment | null => {
    const deployment = poller.deployments.get(id) ?? null;
    if (deployment === null) void reply.code(404).send({ error: `No deployment named '${id}'` });
    return deployment;
  };

  app.get("/api/health", async (): Promise<HealthAnswer> => ({ name: "X-Nix", version, server_name, started_epoch }));

  // ── Deployments ──────────────────────────────────────────────────────────

  app.get("/api/deployments", async (): Promise<DeploymentView[]> => [...poller.deployments.values()].map(deployment_view));

  app.get<{ Params: { id: string } }>("/api/deployments/:id", async (request, reply) => {
    const deployment = find(request.params.id, reply);
    return deployment === null ? reply : deployment_view(deployment);
  });

  // Reads the host and evaluates the flake now, unless an evaluation is already running.
  app.post<{ Params: { id: string } }>("/api/deployments/:id/refresh", async (request, reply) => {
    const deployment = find(request.params.id, reply);
    if (deployment === null) return reply;
    await poller.refresh(deployment);
    return deployment_view(deployment);
  });

  app.post<{ Params: { id: string; action: string } }>("/api/deployments/:id/actions/:action", async (request, reply) => {
    const deployment = find(request.params.id, reply);
    if (deployment === null) return reply;
    const action = request.params.action as ActionId;
    if (!action_ids.includes(action)) return reply.code(404).send({ error: `No action named '${request.params.action}'` });
    const outcome = await deployment.act(action);
    if (outcome.ok) poller.soon(deployment);
    return reply.code(outcome.ok ? 200 : 409).send(outcome);
  });

  app.get<{ Params: { id: string } }>("/api/deployments/:id/events", async (request, reply): Promise<EventRow[] | FastifyReply> => {
    const deployment = find(request.params.id, reply);
    return deployment === null ? reply : store.events(deployment.id);
  });

  // ── Jobs ─────────────────────────────────────────────────────────────────

  app.get<{ Querystring: { deployment?: string; evaluations?: string; limit?: string } }>("/api/jobs", async (request): Promise<Job[]> => store.jobs({
    deployment_id: request.query.deployment || undefined,
    include_evaluations: request.query.evaluations === "1",
    limit: Math.min(500, Math.max(1, Number(request.query.limit) || 100)),
  }));

  app.get<{ Params: { id: string } }>("/api/jobs/:id", async (request, reply) => {
    const job = store.job(Number(request.params.id));
    return job ?? reply.code(404).send({ error: "No such job" });
  });

  // ── Page ─────────────────────────────────────────────────────────────────

  // An API path the server does not know answers as JSON, never with the page.
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/") || !options.serve_web) return reply.code(404).send({ error: "Not found" });
    return reply.sendFile("index.html");
  });

  if (options.serve_web) {
    if (!existsSync(web_build_directory)) throw new Error(`The web page is not built; run npm run build to fill ${web_build_directory}`);
    await app.register(fastify_static, { root: web_build_directory });
  }

  return app;
}
