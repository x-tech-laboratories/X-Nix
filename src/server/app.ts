// ── Imports ──────────────────────────────────────────────────────────────────

import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import fastify_static from "@fastify/static";

import type { AgentPool } from "./agents/agent.ts";
import type { AgentHub } from "./agents/hub.ts";
import { register_agent_route } from "./agents/route.ts";
import { register_auth } from "./auth.ts";
import { download_refusal, locate_product, product_stream } from "./builds.ts";
import type { Catalog, CatalogInfo } from "./catalog.ts";
import { simple_kind, type Configurator, type SettingValue, type SimpleKind } from "./configurator.ts";
import { option_path, type OptionEntry, type OptionSource } from "./nixos/options.ts";
import { cache_action_ids, type Cache, type CacheActionId, type CacheReading } from "./cache.ts";
import type { CacheServerReading } from "./cache_server.ts";
import { fleet_settings, type DeploymentSettings, type TimeOfDay } from "./config.ts";
import { action_ids, type ActionId, type Deployment, type Evaluation, type Reading } from "./deployment.ts";
import { Fleet, type FleetRequest, type FleetRun } from "./fleet.ts";
import type { Poller } from "./poller.ts";
import { build_link, targets } from "./nixos/attic.ts";
import { collect_command } from "./nixos/garbage.ts";
import { agent_snippet, media_formats, parse_install_request, type MediaFormat } from "./nixos/provision.ts";
import type { InstallView, MediaView, ProvisionedAgentView, Provisioner } from "./provisioning.ts";
import type { BuildRecord, EventRow, Job, JobKind, Store } from "./store.ts";
import { register_webhook_route, type Webhook } from "./webhook.ts";
import type { Secrets, SecretsReading } from "./secrets.ts";

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
  // The agents build products are downloaded through; none can be without it.
  agents?: AgentPool;
  // Runs actions on many deployments at once; one with the default settings when not given.
  fleet?: Fleet;
  // Takes pushes on /api/webhook; the route answers 404 without it.
  webhook?: Webhook;
  // Uploads each deployment's secrets; the secrets routes answer 404 without it.
  secrets?: Secrets;
  // Each deployment's option and package lists, and the form that commits options; their routes answer 404 without them.
  catalogs?: Map<string, Catalog>;
  configurators?: Map<string, Configurator>;
}

// An option as the page shows it, with how the form sets it, or null when the form leaves it alone.
export interface OptionView extends OptionEntry {
  form: SimpleKind | null;
}

export interface CatalogView {
  id: string;
  name: string;
  host: string | null;
  info: CatalogInfo | null;
  running_job: Job | null;
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

export interface BuildsAnswer {
  builds: BuildRecord[];
  // Every deployment or cache with a build, and the targets each built, for the page's filters.
  targets: { owner_id: string; target: string }[];
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
  tags: string[];
  // The commit or tag evaluation, build and switch use, or null for the branch head.
  pin: string | null;
  // The pin the settings name, which the page's pin replaces until reset.
  configured_pin: string | null;
  pin_overridden: boolean;
  // Whether a fresh evaluation is running or due before the drift can be trusted.
  sync_pending: boolean;
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
  // What guards a switch.
  safety: {
    pre_switch_checks: string[];
    magic_rollback: boolean;
    activation_timeout: number;
    confirm_timeout: number;
    health_commands: string[];
    health_urls: string[];
    health_period: number;
    health_timeout: number;
  };
}

export interface FleetView {
  parallel: number;
  stages: string[];
  sync_timeout: number;
  tags: string[];
  runs: FleetRun[];
}

// A deployment's secrets as the Secrets page lists them, with names, paths and owners but never a value.
export interface SecretsView {
  id: string;
  name: string;
  host: string | null;
  count: number;
  reading: SecretsReading | null;
}

export interface CacheView {
  id: string;
  name: string;
  host: string | null;
  flake: string;
  cache_url: string;
  interval: number;
  can_push: boolean;
  // Why Build all cannot run now, or null when it can.
  build_all_refusal: string | null;
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
  boot: "Rebuild for next boot", test: "Rebuild and test", "dry-activate": "Dry activate",
};

const confirmations: Partial<Record<ActionId, (name: string) => string>> = {
  reboot: (name) => `Reboot ${name}? Everything running on it stops until it is back up.`,
  collect: (name) => `Collect garbage on ${name}? The generations it deletes can no longer be booted or rolled back to.`,
  switch: (name) => `Switch ${name} to the flake's system now, and boot it from now on?`,
  boot: (name) => `Make the flake's system the one ${name} boots next, without activating it now?`,
  test: (name) => `Activate the flake's system on ${name} now, without making it the one it boots?`,
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
    tags: settings.tags,
    pin: deployment.pin(),
    configured_pin: settings.pin,
    pin_overridden: deployment.pin_overridden(),
    sync_pending: deployment.sync_pending(),
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
    safety: {
      pre_switch_checks: settings.pre_switch_checks, magic_rollback: settings.magic_rollback, activation_timeout: settings.activation_timeout,
      confirm_timeout: settings.confirm_timeout, health_commands: settings.health_commands, health_urls: settings.health_urls,
      health_period: settings.health_period, health_timeout: settings.health_timeout,
    },
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
    build_all_refusal: cache.build_all_refusal(),
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
  const fleet = options.fleet ?? new Fleet(poller.deployments, { store, settings: fleet_settings(undefined), poke: (deployment) => poller.soon(deployment) });
  register_auth(app, options.password_hash);
  if (options.hub !== undefined) await register_agent_route(app, options.hub);
  if (options.webhook !== undefined) await register_webhook_route(app, options.webhook);

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

  // Fixes the deployment at a commit or tag, follows the branch head with null, or goes back to the settings' pin with reset.
  app.post<{ Params: { id: string }; Body: { pin?: unknown; reset?: unknown } }>("/api/deployments/:id/pin", async (request, reply) => {
    const deployment = find(request.params.id, reply);
    if (deployment === null) return reply;
    const reset = request.body?.reset === true;
    const pin = request.body?.pin;
    if (!reset && pin !== null && typeof pin !== "string") return reply.code(400).send({ error: "Give the pin as `pin`, null to follow the branch head, or `reset`" });
    const outcome = await deployment.set_pin(typeof pin === "string" && pin.trim() !== "" ? pin.trim() : null, reset);
    if (outcome.ok) void poller.refresh(deployment);
    return reply.code(outcome.ok ? 200 : 409).send(outcome);
  });

  // The packages a switch would add, remove and change, compared on the host unless the last diff compared the same closures.
  app.post<{ Params: { id: string }; Body: { force?: unknown } | undefined }>("/api/deployments/:id/diff", async (request, reply) => {
    const deployment = find(request.params.id, reply);
    if (deployment === null) return reply;
    return deployment.diff(request.body?.force === true);
  });

  app.get<{ Params: { id: string } }>("/api/deployments/:id/generations", async (request, reply) => {
    const deployment = find(request.params.id, reply);
    if (deployment === null) return reply;
    const answer = await deployment.generations();
    return answer.error === null ? answer : reply.code(502).send(answer);
  });

  // Activates an earlier generation of the system profile, with an optional reason kept in the history.
  app.post<{ Params: { id: string }; Body: { generation?: unknown; reason?: unknown } | undefined }>("/api/deployments/:id/rollback", async (request, reply) => {
    const deployment = find(request.params.id, reply);
    if (deployment === null) return reply;
    const generation = request.body?.generation;
    if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 1) return reply.code(400).send({ error: "Name the generation as a whole `generation` number" });
    const given = typeof request.body?.reason === "string" ? request.body.reason.trim().slice(0, 200) : "";
    const outcome = await deployment.roll_back(generation, given || "asked for from the page");
    if (outcome.ok) poller.soon(deployment);
    return reply.code(outcome.ok ? 200 : 409).send(outcome);
  });

  // A closure's dependency graph: the running system's, the flake's, or a generation's.
  app.get<{ Params: { id: string }; Querystring: { which?: string; generation?: string } }>("/api/deployments/:id/closure", async (request, reply) => {
    const deployment = find(request.params.id, reply);
    if (deployment === null) return reply;
    const { which, generation } = request.query;
    if (generation !== undefined && !/^\d+$/.test(generation)) return reply.code(400).send({ error: "`generation` must be a generation number" });
    const answer = await deployment.closure(generation === undefined ? { which: which === "target" ? "target" : "current" } : { generation: Number(generation) });
    return answer.error === null ? answer : reply.code(502).send(answer);
  });

  app.get<{ Params: { id: string } }>("/api/deployments/:id/events", async (request, reply): Promise<EventRow[] | FastifyReply> => {
    const deployment = find(request.params.id, reply);
    return deployment === null ? reply : store.events(deployment.id);
  });

  // ── Fleet ────────────────────────────────────────────────────────────────

  app.get("/api/fleet", async (): Promise<FleetView> => ({
    parallel: fleet.settings.parallel, stages: fleet.settings.stages, sync_timeout: fleet.settings.sync_timeout, tags: fleet.tags(), runs: fleet.runs(),
  }));

  // The ids a selector such as "web-* @canary" picks.
  app.get<{ Querystring: { selector?: string } }>("/api/fleet/select", async (request) => fleet.select(request.query.selector ?? "").map((deployment) => deployment.id));

  app.post<{ Body: FleetRequest }>("/api/fleet/runs", async (request, reply) => {
    const outcome = await fleet.start(request.body ?? {});
    return reply.code(outcome.ok ? 200 : 409).send(outcome);
  });

  app.get<{ Params: { id: string } }>("/api/fleet/runs/:id", async (request, reply) => {
    const run = fleet.run(Number(request.params.id));
    return run ?? reply.code(404).send({ error: "No such fleet run" });
  });

  app.post<{ Params: { id: string } }>("/api/fleet/runs/:id/stop", async (request, reply) => {
    const outcome = await fleet.stop(Number(request.params.id));
    return reply.code(outcome.ok ? 200 : outcome.run === null ? 404 : 409).send(outcome);
  });

  // ── Secrets ──────────────────────────────────────────────────────────────

  const secrets_view = (deployment: Deployment): SecretsView => ({
    id: deployment.id, name: deployment.settings.name, host: deployment.settings.host, count: deployment.settings.secrets.length,
    reading: options.secrets?.reading(deployment) ?? null,
  });

  const find_secrets = (id: string, reply: FastifyReply): { deployment: Deployment; secrets: Secrets } | null => {
    const deployment = find(id, reply);
    if (deployment === null) return null;
    if (options.secrets === undefined) {
      void reply.code(404).send({ error: "Secrets are not served here" });
      return null;
    }
    return { deployment, secrets: options.secrets };
  };

  app.get("/api/secrets", async (): Promise<SecretsView[]> => [...poller.deployments.values()].filter((deployment) => deployment.settings.secrets.length > 0).map(secrets_view));

  // The last check of the deployment's secrets, checking now when there has been none.
  app.get<{ Params: { id: string } }>("/api/deployments/:id/secrets", async (request, reply) => {
    const found = find_secrets(request.params.id, reply);
    if (found === null) return reply;
    if (found.secrets.reading(found.deployment) === null && found.deployment.settings.secrets.length > 0) await found.secrets.check(found.deployment);
    return secrets_view(found.deployment);
  });

  app.post<{ Params: { id: string } }>("/api/deployments/:id/secrets/check", async (request, reply) => {
    const found = find_secrets(request.params.id, reply);
    if (found === null) return reply;
    await found.secrets.check(found.deployment);
    return secrets_view(found.deployment);
  });

  // Uploads every secret of the deployment, whether or not the host already holds it.
  app.post<{ Params: { id: string } }>("/api/deployments/:id/secrets/upload", async (request, reply) => {
    const found = find_secrets(request.params.id, reply);
    if (found === null) return reply;
    const outcome = await found.secrets.upload(found.deployment, "manual");
    return reply.code(outcome.ok ? 200 : 409).send(outcome);
  });

  // ── Options ──────────────────────────────────────────────────────────────

  const catalog_view = (catalog: Catalog): CatalogView => ({
    id: catalog.id, name: catalog.deployment.settings.name, host: catalog.deployment.settings.host, info: catalog.info(), running_job: catalog.running_job(),
  });

  const option_view = (entry: OptionEntry): OptionView => ({
    ...entry, form: entry.source !== "nixos" || entry.read_only || option_path(entry.name) === null ? null : simple_kind(entry.type),
  });

  const find_catalog = async (id: string, reply: FastifyReply): Promise<Catalog | null> => {
    const catalog = options.catalogs?.get(id) ?? null;
    if (catalog === null) {
      void reply.code(404).send({ error: `No option list for '${id}'` });
      return null;
    }
    // A generation that has ended is fetched as soon as anyone looks.
    await catalog.follow();
    return catalog;
  };

  const limit_of = (text: string | undefined) => Math.min(200, Math.max(1, Number(text) || 50));

  app.get("/api/options", async (): Promise<CatalogView[]> => {
    const catalogs = [...(options.catalogs?.values() ?? [])];
    await Promise.all(catalogs.map((catalog) => catalog.follow()));
    return catalogs.map(catalog_view);
  });

  app.get<{ Params: { id: string }; Querystring: { query?: string; source?: string; limit?: string } }>("/api/deployments/:id/options", async (request, reply) => {
    const catalog = await find_catalog(request.params.id, reply);
    if (catalog === null) return reply;
    const source: OptionSource = request.query.source === "home-manager" ? "home-manager" : "nixos";
    const found = catalog.search_options(request.query.query ?? "", source, limit_of(request.query.limit));
    return { ...catalog_view(catalog), total: found.total, entries: found.entries.map(option_view) };
  });

  app.get<{ Params: { id: string }; Querystring: { query?: string; limit?: string } }>("/api/deployments/:id/packages", async (request, reply) => {
    const catalog = await find_catalog(request.params.id, reply);
    if (catalog === null) return reply;
    return { ...catalog_view(catalog), ...catalog.search_packages(request.query.query ?? "", limit_of(request.query.limit)) };
  });

  app.post<{ Params: { id: string } }>("/api/deployments/:id/options/generate", async (request, reply) => {
    const catalog = await find_catalog(request.params.id, reply);
    if (catalog === null) return reply;
    const outcome = await catalog.generate("manual");
    return reply.code(outcome.ok ? 200 : 409).send(outcome);
  });

  // The option's value in the deployment's configuration, evaluated now.
  app.get<{ Params: { id: string }; Querystring: { name?: string } }>("/api/deployments/:id/options/value", async (request, reply) => {
    const catalog = await find_catalog(request.params.id, reply);
    if (catalog === null) return reply;
    if (!request.query.name) return reply.code(400).send({ error: "Name the option as `name`" });
    return catalog.current_value(request.query.name);
  });

  const find_configurator = (id: string, reply: FastifyReply): Configurator | null => {
    const configurator = options.configurators?.get(id) ?? null;
    if (configurator === null) void reply.code(404).send({ error: `No option form for '${id}'` });
    return configurator;
  };

  // The options X-Nix's own file in the flake sets now.
  app.get<{ Params: { id: string } }>("/api/deployments/:id/settings", async (request, reply) => {
    const configurator = find_configurator(request.params.id, reply);
    return configurator === null ? reply : configurator.view();
  });

  // Commits one option's value, or its removal when the value is null, then evaluates the flake again.
  app.post<{ Params: { id: string }; Body: { name?: unknown; value?: unknown } }>("/api/deployments/:id/settings", async (request, reply) => {
    const configurator = find_configurator(request.params.id, reply);
    if (configurator === null) return reply;
    const catalog = options.catalogs?.get(request.params.id);
    const name = request.body?.name;
    if (typeof name !== "string") return reply.code(400).send({ error: "Name the option as `name`" });
    const option = catalog?.option(name) ?? null;
    if (option === null) return reply.code(404).send({ error: `${name} is not in the generated option list; generate it first` });
    const value = request.body?.value;
    if (value !== null && typeof value !== "boolean" && typeof value !== "number" && typeof value !== "string") return reply.code(400).send({ error: "The value must be true, false, a number, text or null" });
    const outcome = await configurator.set(option, value as SettingValue | null, "manual");
    if (outcome.ok && outcome.job_id !== null) void poller.refresh(configurator.deployment);
    return reply.code(outcome.ok ? 200 : 409).send(outcome);
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

  // Builds every target in one job.
  app.post<{ Params: { id: string } }>("/api/caches/:id/build-all", async (request, reply) => {
    const cache = find_cache(request.params.id, reply);
    if (cache === null) return reply;
    const outcome = await cache.build_all();
    if (outcome.ok) poller.soon(cache);
    return reply.code(outcome.ok ? 200 : 409).send(outcome);
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

  // ── Builds ───────────────────────────────────────────────────────────────

  app.get<{ Querystring: { owner?: string; target?: string; limit?: string } }>("/api/builds", async (request): Promise<BuildsAnswer> => ({
    builds: store.builds({
      owner_id: request.query.owner || undefined,
      target: request.query.target || undefined,
      limit: Math.min(500, Math.max(1, Number(request.query.limit) || 100)),
    }),
    targets: store.build_targets(),
  }));

  // Sends a build product that is a regular file inside its build's store path, read through the agent that built it.
  app.get<{ Params: { id: string; index: string } }>("/api/builds/:id/products/:index", async (request, reply) => {
    const build = store.build(Number(request.params.id));
    if (build === null) return reply.code(404).send({ error: "No such build" });
    const product = build.products[Number(request.params.index)];
    const refusal = download_refusal(build, product);
    if (refusal !== null) return reply.code(404).send({ error: refusal });
    if (options.agents === undefined) return reply.code(503).send({ error: "No agents to read the product through" });
    const agent = options.agents.get(build.agent);
    const located = await locate_product(agent, build, product);
    if ("error" in located) return reply.code(410).send({ error: `Cannot send ${product.name}: ${located.error}` });
    const file_name = product.name.replace(/[^\w.+-]/g, "_") || "product";
    return reply
      .header("content-type", "application/octet-stream")
      .header("content-length", String(located.size))
      .header("content-disposition", `attachment; filename="${file_name}"`)
      .send(product_stream(agent, located.path, located.size));
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
