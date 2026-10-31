// ── Imports ──────────────────────────────────────────────────────────────────

import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import fastify_static from "@fastify/static";

import type { AgentHub } from "./agents/hub.ts";
import { register_agent_route } from "./agents/route.ts";
import { register_auth } from "./auth.ts";
import { cache_action_ids, type Cache, type CacheActionId, type CacheReading } from "./cache.ts";
import type { CacheServerReading } from "./cache_server.ts";
import type { DeploymentSettings, TimeOfDay } from "./config.ts";
import { action_ids, type ActionId, type Deployment, type Evaluation, type Reading } from "./deployment.ts";
import type { Poller } from "./poller.ts";
import { build_link, targets } from "./nixos/attic.ts";
import { collect_command } from "./nixos/garbage.ts";
import { agent_snippet, media_formats, parse_install_request, type MediaFormat } from "./nixos/provision.ts";
import type { InstallView, MediaView, ProvisionedAgentView, Provisioner } from "./provisioning.ts";
import type { EventRow, Job, JobKind, Store } from "./store.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

export interface app_options {
  serve_web: boolean;
  logger: boolean;
  // What the page calls this machine; the system's hostname unless set.
  server_name?: string;
  // The hash of the one password that logs in.
  password_hash: string;
  store: Store;
  poller: Poller;
  // The other hosts' agents; none dial in without it.
  hub?: AgentHub;
  // Installs new hosts and builds install media; the Provision page's routes are missing without it.
  provisioner?: Provisioner;
}

export interface ProvisioningView {
  own_host: string;
  // Why no install can start, or null when one can.
  install_refusal: string | null;
  install_agent: string | null;
  ssh_key: string | null;
  agent_key_path: string;
  media_root_dir: string;
  // What the new host's configuration needs for its agent, with its name left as a placeholder.
  agent_snippet: string;
  installs: InstallView[];
  media: MediaView[];
  provisioned_agents: ProvisionedAgentView[];
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
  // Whether a switch activates the evaluated closure from the cache rather than rebuilding.
  switch_from_cache: boolean;
  // How the store is watched, or null when it is not.
  gc: { unit: string; timer: string; store: string; max_age: number; warning: number | null; threshold: number | null; command: string } | null;
  reading: Reading | null;
  evaluation: Evaluation;
  evaluating: boolean;
  running_job: Job | null;
  actions: ActionView[];
  // Why the next boot cannot be set now, or null when it can.
  next_boot_refusal: string | null;
}

export interface CacheView {
  id: string;
  name: string;
  host: string | null;
  flake: string;
  cache_url: string;
  interval: number;
  can_push: boolean;
  reading: CacheReading | null;
  // The cache server's endpoints, and what they last answered.
  server_urls: { info: string | null; health: string | null; metrics: string | null };
  server: CacheServerReading | null;
  running_job: Job | null;
  // Each tracked target with where its build is rooted and why each action cannot run on it now.
  targets: { name: string; installable: string; build_link: string | null; kept_only_in_cache: boolean; refusals: Record<CacheActionId, string | null> }[];
}

const action_labels: Record<ActionId, string> = {
  update: "Update flake", build: "Build", switch: "Rebuild and switch", reboot: "Reboot", collect: "Collect garbage",
};

const confirmations: Partial<Record<ActionId, (name: string) => string>> = {
  reboot: (name) => `Reboot ${name}? Everything running on it stops until it is back up.`,
  collect: (name) => `Collect garbage on ${name}? The generations it deletes can no longer be booted or rolled back to.`,
};

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
    switch_from_cache: settings.switch_from_cache,
    gc: settings.gc === null ? null : {
      unit: settings.gc.unit, timer: settings.gc.timer, store: settings.gc.store, max_age: settings.gc.max_age,
      warning: settings.gc.warning, threshold: settings.gc.threshold, command: collect_command(settings.gc, settings.require_sudo),
    },
    reading: deployment.reading(),
    evaluation: deployment.evaluation(),
    evaluating: deployment.running_evaluation() !== null,
    running_job: deployment.running_job(),
    actions: action_ids.map((id) => ({
      id,
      label: id === "switch" && settings.switch_from_cache ? "Switch from cache" : action_labels[id],
      refusal: deployment.action_refusal(id),
      confirm: confirmations[id]?.(settings.name) ?? null,
    })),
    next_boot_refusal: deployment.next_boot_refusal(deployment.reading()?.boot?.entries[0]?.id ?? ""),
  };
}

function cache_view(cache: Cache): CacheView {
  const settings = cache.settings;
  return {
    id: settings.id,
    name: settings.name,
    host: settings.host,
    flake: settings.flake,
    cache_url: settings.cache_url,
    interval: settings.interval,
    can_push: settings.push_command !== null,
    reading: cache.reading(),
    server_urls: { info: settings.info_url, health: settings.health_url, metrics: settings.metrics_url },
    server: cache.server_reading(),
    running_job: cache.running_job(),
    targets: targets(settings).map(([name, installable]) => ({
      name, installable, build_link: build_link(settings, name), kept_only_in_cache: settings.drop_pushed.includes(name),
      refusals: { build: cache.action_refusal("build", name), push: cache.action_refusal("push", name) },
    })),
  };
}

// ── App ──────────────────────────────────────────────────────────────────────

export async function build_app(options: app_options): Promise<FastifyInstance> {
  // A reverse proxy on this machine passes on the visitor's address and whether they came over https.
  const app = fastify({ logger: options.logger, trustProxy: ["127.0.0.1", "::1"] });
  const version = (JSON.parse(readFileSync(package_file, "utf8")) as { version: string }).version;
  const started_epoch = Math.floor(Date.now() / 1000);
  const server_name = options.server_name ?? hostname();
  const { store, poller } = options;
  register_auth(app, options.password_hash);
  if (options.hub !== undefined) await register_agent_route(app, options.hub);

  const find = (id: string, reply: FastifyReply): Deployment | null => {
    const deployment = poller.deployments.get(id) ?? null;
    if (deployment === null) void reply.code(404).send({ error: `No deployment named '${id}'` });
    return deployment;
  };

  app.get("/api/health", async (): Promise<HealthAnswer> => ({ name: "X-Nix", version, server_name, started_epoch }));

  // Each host with a declared agent key, and whether its agent is connected.
  app.get("/api/agents", async () => options.hub?.statuses() ?? []);

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

  // Sets the entry the host boots into once, rebooting into it at once when asked.
  app.post<{ Params: { id: string }; Body: { entry?: unknown; reboot?: unknown } }>("/api/deployments/:id/next-boot", async (request, reply) => {
    const deployment = find(request.params.id, reply);
    if (deployment === null) return reply;
    if (typeof request.body?.entry !== "string") return reply.code(400).send({ error: "Name the boot entry as `entry`" });
    const outcome = await deployment.set_next_boot(request.body.entry, request.body.reboot === true);
    return reply.code(outcome.ok ? 200 : 409).send(outcome);
  });

  app.get<{ Params: { id: string } }>("/api/deployments/:id/events", async (request, reply): Promise<EventRow[] | FastifyReply> => {
    const deployment = find(request.params.id, reply);
    return deployment === null ? reply : store.events(deployment.id);
  });

  // ── Caches ───────────────────────────────────────────────────────────────

  const find_cache = (id: string, reply: FastifyReply): Cache | null => {
    const cache = poller.caches.get(id) ?? null;
    if (cache === null) void reply.code(404).send({ error: `No cache named '${id}'` });
    return cache;
  };

  app.get("/api/caches", async (): Promise<CacheView[]> => [...poller.caches.values()].map(cache_view));

  app.get<{ Params: { id: string } }>("/api/caches/:id", async (request, reply) => {
    const cache = find_cache(request.params.id, reply);
    return cache === null ? reply : cache_view(cache);
  });

  // Checks every target now, unless a job is already running.
  app.post<{ Params: { id: string } }>("/api/caches/:id/refresh", async (request, reply) => {
    const cache = find_cache(request.params.id, reply);
    if (cache === null) return reply;
    await poller.refresh(cache);
    return cache_view(cache);
  });

  app.post<{ Params: { id: string; name: string; action: string } }>("/api/caches/:id/targets/:name/:action", async (request, reply) => {
    const cache = find_cache(request.params.id, reply);
    if (cache === null) return reply;
    const action = request.params.action as CacheActionId;
    if (!cache_action_ids.includes(action)) return reply.code(404).send({ error: `No action named '${request.params.action}'` });
    const outcome = await cache.act(action, request.params.name);
    if (outcome.ok) poller.soon(cache);
    return reply.code(outcome.ok ? 200 : 409).send(outcome);
  });

  app.get<{ Params: { id: string } }>("/api/caches/:id/events", async (request, reply): Promise<EventRow[] | FastifyReply> => {
    const cache = find_cache(request.params.id, reply);
    return cache === null ? reply : store.events(cache.id);
  });

  // ── Provisioning ─────────────────────────────────────────────────────────

  const provisioner = options.provisioner;
  if (provisioner !== undefined) {
    app.get("/api/provisioning", async (): Promise<ProvisioningView> => ({
      own_host: provisioner.own_host,
      install_refusal: provisioner.install_refusal(),
      install_agent: provisioner.settings.install_agent,
      ssh_key: provisioner.settings.ssh_key,
      agent_key_path: provisioner.settings.agent_key_path,
      media_root_dir: provisioner.media_root_dir,
      agent_snippet: agent_snippet("<host>", provisioner.settings.agent_key_path, provisioner.settings.agent_url ?? "wss://x-nix.example/api/agent"),
      installs: provisioner.installs(),
      media: provisioner.media(),
      provisioned_agents: provisioner.provisioned_agents(),
    }));

    // Starts an install once the person has typed the target's address to confirm its disks are wiped.
    app.post<{ Body: Record<string, unknown> }>("/api/provisioning/install", async (request, reply) => {
      const parsed = parse_install_request(request.body);
      if (typeof parsed === "string") return reply.code(400).send({ error: parsed });
      if (request.body?.confirm !== parsed.address) return reply.code(400).send({ error: `Type the target's address, ${parsed.address}, to confirm its disks are wiped` });
      const outcome = await provisioner.install(parsed);
      if (outcome.ok) poller.soon(provisioner);
      return reply.code(outcome.ok ? 200 : 409).send(outcome);
    });

    // Builds install media for a deployment's flake and configuration, or for any flake and configuration named.
    app.post<{ Body: { deployment?: unknown; flake?: unknown; configuration?: unknown; format?: unknown } }>("/api/provisioning/media", async (request, reply) => {
      const body = request.body ?? {};
      const format = body.format as MediaFormat;
      if (!media_formats.includes(format)) return reply.code(400).send({ error: `Pick a format: ${media_formats.join(", ")}` });
      let owner: string;
      let flake: unknown = body.flake;
      let configuration: unknown = body.configuration;
      if (typeof body.deployment === "string" && body.deployment !== "") {
        const deployment = poller.deployments.get(body.deployment);
        if (deployment === undefined) return reply.code(404).send({ error: `No deployment named '${body.deployment}'` });
        owner = deployment.id;
        flake = deployment.settings.flake;
        configuration = configuration || deployment.settings.configuration;
      } else {
        owner = typeof configuration === "string" ? configuration.trim() : "";
      }
      for (const [name, value] of [["flake", flake], ["configuration", configuration]] as const) {
        if (typeof value !== "string" || value.trim() === "" || /[\n\r\0]/.test(value)) return reply.code(400).send({ error: `Name the ${name} to build from` });
      }
      const outcome = await provisioner.build_media({ owner, flake: (flake as string).trim(), configuration: (configuration as string).trim(), format });
      if (outcome.ok) poller.soon(provisioner);
      return reply.code(outcome.ok ? 200 : 409).send(outcome);
    });

    // Sends one file of a built medium, only ever from inside its store path.
    app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/provisioning/media/:id/download", async (request, reply) => {
      const found = provisioner.media_download(Number(request.params.id), request.query.path ?? "");
      if ("error" in found) return reply.code(404).send({ error: found.error });
      reply.header("content-type", "application/octet-stream");
      reply.header("content-length", statSync(found.file).size);
      reply.header("content-disposition", `attachment; filename="${found.name.replace(/[^A-Za-z0-9._+-]/g, "_")}"`);
      return reply.send(createReadStream(found.file));
    });

    app.post<{ Params: { id: string } }>("/api/provisioning/media/:id/remove", async (request, reply) => {
      const outcome = provisioner.remove_media(Number(request.params.id));
      return reply.code(outcome.ok ? 200 : 409).send(outcome);
    });

    // Stops accepting the agent key X-Nix made for an installed host.
    app.post<{ Params: { host: string } }>("/api/provisioning/agents/:host/forget", async (request, reply) => {
      if (!provisioner.forget_agent(request.params.host)) return reply.code(404).send({ error: `No key was made for '${request.params.host}'` });
      return { ok: true, message: `Stopped accepting ${request.params.host}'s agent key`, job_id: null };
    });
  }

  // ── Jobs ─────────────────────────────────────────────────────────────────

  app.get<{ Querystring: { deployment?: string; kind?: string; evaluations?: string; limit?: string } }>("/api/jobs", async (request): Promise<Job[]> => store.jobs({
    deployment_id: request.query.deployment || undefined,
    kind: (request.query.kind as JobKind) || undefined,
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
