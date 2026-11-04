// ── Imports ──────────────────────────────────────────────────────────────────

import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import fastify_static from "@fastify/static";

import type { AgentPool } from "./agents/agent.ts";
import type { AgentHub } from "./agents/hub.ts";
import { register_agent_route } from "./agents/route.ts";
import { register_auth, type Accounts } from "./auth.ts";
import { download_refusal, locate_product, product_stream } from "./builds.ts";
import { cache_action_ids, type Cache, type CacheActionId, type CacheReading } from "./cache.ts";
import type { CacheServerReading } from "./cache_server.ts";
import { fleet_settings, type DeploymentSettings, type TimeOfDay } from "./config.ts";
import { action_ids, type ActionId, type Deployment, type Evaluation, type Reading } from "./deployment.ts";
import type { Flake, FlakeReading, UpdateOutcome } from "./flake.ts";
import { host_action_ids, type Host, type HostActionId, type HostReading, type HostState } from "./host.ts";
import { Fleet, type FleetRequest, type FleetRun } from "./fleet.ts";
import type { Poller } from "./poller.ts";
import { build_link, targets } from "./nixos/attic.ts";
import { pushes_to_github } from "./nixos/commands.ts";
import { github_repository } from "./nixos/flake.ts";
import { collect_command } from "./nixos/garbage.ts";
import { agent_snippet, media_formats, parse_install_request, type MediaFormat } from "./nixos/provision.ts";
import type { InstallView, MediaView, ProvisionedAgentView, Provisioner } from "./provisioning.ts";
import type { BuildRecord, EventRow, Job, JobKind, Store } from "./store.ts";
import { register_webhook_route, type Webhook } from "./webhook.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

export interface app_options {
  serve_web: boolean;
  logger: boolean;
  // What the page calls this machine; the system's hostname unless set.
  server_name?: string;
  // Each user who may log in, with their password's hash.
  accounts: Accounts;
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

// What names a flake: a deployment or a cache.
export interface FlakeUser {
  id: string;
  name: string;
}

export interface FlakeView {
  id: string;
  name: string;
  host: string | null;
  url: string;
  interval: number;
  // When the daily update runs, and the last slot handled.
  update_at: string | null;
  scheduled_update: number | null;
  // Why Update cannot run now, or null when it can.
  update_refusal: string | null;
  // The repository an update pushes to, or null when it writes a local checkout or cannot update.
  pushes_to: string | null;
  commit_author: string;
  commit_message: string;
  max_input_age: number | null;
  reading: FlakeReading | null;
  last_update: UpdateOutcome | null;
  running_job: Job | null;
  deployments: FlakeUser[];
  caches: FlakeUser[];
}

// How the store is watched: its units, path, limits and the collection Collect Garbage runs.
export interface GcView {
  unit: string;
  timer: string;
  store: string;
  max_age: number;
  warning: number | null;
  threshold: number | null;
  command: string;
}

export interface HostView {
  name: string;
  display_name: string;
  // Whether it is the server's own host, which needs no agent.
  own: boolean;
  agent_key: boolean;
  // Its agent's connection, or null when it is not connected.
  agent: { agent_version: string; connected_epoch: number } | null;
  wake: { mac: string; broadcast: string; via: string | null; timeout: number } | null;
  keep_awake: boolean;
  interval: number;
  gc: GcView | null;
  boot: boolean;
  reading: HostReading | null;
  state: HostState;
  running_job: Job | null;
  actions: ActionView[];
  // Why the next boot cannot be set now, or null when it can.
  next_boot_refusal: string | null;
  // The running and booted system, as its first deployment last read them.
  system: { current: string | null; booted: string | null; version: string | null; reboot_required: boolean | null } | null;
  deployments: FlakeUser[];
}

export interface DeploymentView {
  id: string;
  name: string;
  host: string | null;
  flake: string;
  flake_id: string | null;
  // The host it runs on, by its agent's name.
  host_name: string | null;
  // The cache that builds its system, or null when it builds on its own.
  cache_id: string | null;
  // The cache whose check evaluates its system in its place, or null when it evaluates on its own.
  evaluated_by: string | null;
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
  // The hosts Build runs on, most preferred first.
  build_agents: string[];
  schedule: { build: string | null };
  auto_switch: boolean;
  // Whether a switch activates the evaluated closure from the cache rather than rebuilding.
  switch_from_cache: boolean;
  // How the store is watched, or null when it is not.
  reading: Reading | null;
  evaluation: Evaluation;
  evaluating: boolean;
  running_job: Job | null;
  actions: ActionView[];
  // Why the next boot cannot be set now, or null when it can.
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
    inhibit_sleep: boolean;
  };
}

export interface FleetView {
  parallel: number;
  stages: string[];
  sync_timeout: number;
  tags: string[];
  runs: FleetRun[];
}

export interface CacheView {
  id: string;
  name: string;
  // The host its next job runs on, picked from hosts.
  host: string | null;
  // The hosts it builds on, most preferred first; this server when empty.
  hosts: string[];
  flake: string;
  flake_id: string | null;
  cache_url: string;
  interval: number;
  // When Build all runs daily, and the last slot handled.
  build_at: string | null;
  scheduled_build: number | null;
  // The deployments whose systems it builds.
  deployments: FlakeUser[];
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
  build: "Build", switch: "Rebuild and switch", reboot: "Reboot",
  boot: "Rebuild for next boot", test: "Rebuild and test", "dry-activate": "Dry activate",
};

const confirmations: Partial<Record<ActionId, (name: string) => string>> = {
  reboot: (name) => `Reboot ${name}? Everything running on it stops until it is back up.`,
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
    flake_id: settings.flake_id,
    configuration: settings.configuration,
    tags: settings.tags,
    pin: deployment.pin(),
    configured_pin: settings.pin,
    pin_overridden: deployment.pin_overridden(),
    sync_pending: deployment.sync_pending(),
    agents: { eval: deployment.agent_for("eval"), build: deployment.agent_for("build"), switch: deployment.agent_for("switch") },
    build_agents: settings.build_agents,
    schedule: { build: clock(settings.build_at) },
    auto_switch: settings.auto_switch,
    switch_from_cache: settings.switch_from_cache,
    host_name: deployment.host?.name ?? null,
    cache_id: settings.cache_id,
    evaluated_by: deployment.evaluating_cache()?.cache.id ?? null,
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
    safety: {
      pre_switch_checks: settings.pre_switch_checks, magic_rollback: settings.magic_rollback, activation_timeout: settings.activation_timeout,
      confirm_timeout: settings.confirm_timeout, health_commands: settings.health_commands, health_urls: settings.health_urls,
      health_period: settings.health_period, health_timeout: settings.health_timeout, inhibit_sleep: settings.inhibit_sleep,
    },
  };
}

function cache_view(cache: Cache, store_state: Store, deployments: Iterable<Deployment>): CacheView {
  const settings = cache.settings;
  return {
    id: settings.id,
    name: settings.name,
    host: cache.host(),
    hosts: settings.hosts,
    flake: settings.flake,
    flake_id: settings.flake_id,
    cache_url: settings.cache_url,
    interval: settings.interval,
    build_at: clock(settings.build_at),
    scheduled_build: store_state.evaluation<{ scheduled_build?: number }>(cache.id)?.scheduled_build ?? null,
    deployments: [...deployments].filter((deployment) => deployment.settings.cache_id === settings.id).map(({ settings: { id, name } }) => ({ id, name })),
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

const host_action_labels: Record<HostActionId, string> = { collect: "Collect garbage", reboot: "Reboot" };

const host_confirmations: Record<HostActionId, (name: string) => string> = {
  collect: (name) => `Collect garbage on ${name}? The generations it deletes can no longer be booted or rolled back to.`,
  reboot: (name) => `Reboot ${name}? Everything running on it stops until it is back up.`,
};

function host_view(host: Host, poller: Poller, hub: AgentHub | undefined, own_host: string): HostView {
  const settings = host.settings;
  const deployments = [...poller.deployments.values()].filter((deployment) => deployment.host === host);
  const reading = deployments.map((deployment) => deployment.reading()).find((candidate) => candidate !== null) ?? null;
  const connection = hub?.statuses().find((entry) => entry.host === host.name)?.status ?? null;
  const gc = settings.gc;
  return {
    name: host.name,
    display_name: settings.name,
    own: host.name === own_host,
    agent_key: settings.agent_key !== null,
    agent: connection === null ? null : { agent_version: connection.agent_version, connected_epoch: connection.connected_epoch },
    wake: settings.wake === null ? null : { mac: settings.wake.mac, broadcast: settings.wake.broadcast, via: settings.wake.via, timeout: settings.wake.timeout },
    keep_awake: settings.keep_awake,
    interval: settings.interval,
    gc: gc === null ? null : {
      unit: gc.unit, timer: gc.timer, store: gc.store, max_age: gc.max_age, warning: gc.warning, threshold: gc.threshold,
      command: collect_command(gc, settings.require_sudo),
    },
    boot: settings.boot,
    reading: host.reading(),
    state: host.state(),
    running_job: host.running_job(),
    actions: host_action_ids.map((id) => ({ id: id as ActionId, label: host_action_labels[id], refusal: host.action_refusal(id), confirm: host_confirmations[id](settings.name) })),
    next_boot_refusal: host.next_boot_refusal(host.reading()?.boot?.entries[0]?.id ?? ""),
    system: reading === null ? null : { current: reading.current, booted: reading.booted, version: reading.version, reboot_required: reading.reboot_required },
    deployments: deployments.map(({ settings: { id, name } }) => ({ id, name })),
  };
}

function flake_view(flake: Flake, poller: Poller): FlakeView {
  const settings = flake.settings;
  const state = flake.state();
  const users = (entries: Iterable<{ settings: { id: string; name: string; flake_id: string | null } }>) =>
    [...entries].filter((entry) => entry.settings.flake_id === settings.id).map(({ settings: { id, name } }) => ({ id, name }));
  return {
    id: settings.id,
    name: settings.name,
    host: settings.host,
    url: settings.url,
    interval: settings.interval,
    update_at: clock(settings.update_at),
    scheduled_update: state.scheduled_update ?? null,
    update_refusal: flake.update_refusal(),
    pushes_to: pushes_to_github(settings) ? github_repository(settings.url)!.ssh_url : null,
    commit_author: settings.commit_author,
    commit_message: settings.commit_message,
    max_input_age: settings.max_input_age,
    reading: flake.reading(),
    last_update: state.last_update ?? null,
    running_job: flake.running_job(),
    deployments: users(poller.deployments.values()),
    caches: users(poller.caches.values()),
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
  register_auth(app, options.accounts);
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

  // ── Hosts ────────────────────────────────────────────────────────────────

  const find_host = (name: string, reply: FastifyReply): Host | null => {
    const host = poller.hosts.get(name) ?? null;
    if (host === null) void reply.code(404).send({ error: `No host named '${name}'` });
    return host;
  };
  const view_of = (host: Host) => host_view(host, poller, options.hub, server_name);

  app.get("/api/hosts", async (): Promise<HostView[]> => [...poller.hosts.values()].map(view_of));

  app.get<{ Params: { name: string } }>("/api/hosts/:name", async (request, reply) => {
    const host = find_host(request.params.name, reply);
    return host === null ? reply : view_of(host);
  });

  // Reads the store and the boot entries now, unless a collection is running.
  app.post<{ Params: { name: string } }>("/api/hosts/:name/refresh", async (request, reply) => {
    const host = find_host(request.params.name, reply);
    if (host === null) return reply;
    await poller.refresh(host);
    return view_of(host);
  });

  app.post<{ Params: { name: string; action: string } }>("/api/hosts/:name/actions/:action", async (request, reply) => {
    const host = find_host(request.params.name, reply);
    if (host === null) return reply;
    const action = request.params.action as HostActionId;
    if (!host_action_ids.includes(action)) return reply.code(404).send({ error: `No action named '${request.params.action}'` });
    const outcome = await host.act(action);
    if (outcome.ok) poller.soon(host);
    return reply.code(outcome.ok ? 200 : 409).send(outcome);
  });

  // Sets the entry the host boots into once, rebooting into it at once when asked.
  app.post<{ Params: { name: string }; Body: { entry?: unknown; reboot?: unknown } }>("/api/hosts/:name/next-boot", async (request, reply) => {
    const host = find_host(request.params.name, reply);
    if (host === null) return reply;
    if (typeof request.body?.entry !== "string") return reply.code(400).send({ error: "Name the boot entry as `entry`" });
    const outcome = await host.set_next_boot(request.body.entry, request.body.reboot === true);
    return reply.code(outcome.ok ? 200 : 409).send(outcome);
  });

  app.get<{ Params: { name: string } }>("/api/hosts/:name/events", async (request, reply): Promise<EventRow[] | FastifyReply> => {
    const host = find_host(request.params.name, reply);
    return host === null ? reply : store.events(host.id);
  });

  // ── Flakes ───────────────────────────────────────────────────────────────

  const find_flake = (id: string, reply: FastifyReply): Flake | null => {
    const flake = poller.flakes.get(id) ?? null;
    if (flake === null) void reply.code(404).send({ error: `No flake named '${id}'` });
    return flake;
  };

  app.get("/api/flakes", async (): Promise<FlakeView[]> => [...poller.flakes.values()].map((flake) => flake_view(flake, poller)));

  app.get<{ Params: { id: string } }>("/api/flakes/:id", async (request, reply) => {
    const flake = find_flake(request.params.id, reply);
    return flake === null ? reply : flake_view(flake, poller);
  });

  // Reads the flake's metadata now, unless an update is running.
  app.post<{ Params: { id: string } }>("/api/flakes/:id/refresh", async (request, reply) => {
    const flake = find_flake(request.params.id, reply);
    if (flake === null) return reply;
    await poller.refresh(flake);
    return flake_view(flake, poller);
  });

  app.post<{ Params: { id: string } }>("/api/flakes/:id/update", async (request, reply) => {
    const flake = find_flake(request.params.id, reply);
    if (flake === null) return reply;
    const outcome = await flake.update();
    if (outcome.ok) poller.soon(flake);
    return reply.code(outcome.ok ? 200 : 409).send(outcome);
  });

  app.get<{ Params: { id: string } }>("/api/flakes/:id/events", async (request, reply): Promise<EventRow[] | FastifyReply> => {
    const flake = find_flake(request.params.id, reply);
    return flake === null ? reply : store.events(flake.id);
  });

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

  // ── Caches ───────────────────────────────────────────────────────────────

  const find_cache = (id: string, reply: FastifyReply): Cache | null => {
    const cache = poller.caches.get(id) ?? null;
    if (cache === null) void reply.code(404).send({ error: `No cache named '${id}'` });
    return cache;
  };

  app.get("/api/caches", async (): Promise<CacheView[]> => [...poller.caches.values()].map((cache) => cache_view(cache, store, poller.deployments.values())));

  app.get<{ Params: { id: string } }>("/api/caches/:id", async (request, reply) => {
    const cache = find_cache(request.params.id, reply);
    return cache === null ? reply : cache_view(cache, store, poller.deployments.values());
  });

  // Checks every target now, unless a job is already running.
  app.post<{ Params: { id: string } }>("/api/caches/:id/refresh", async (request, reply) => {
    const cache = find_cache(request.params.id, reply);
    if (cache === null) return reply;
    await poller.refresh(cache);
    return cache_view(cache, store, poller.deployments.values());
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
    const agent = await options.agents.awake(build.agent);
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
