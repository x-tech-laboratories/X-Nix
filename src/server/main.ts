// ── Imports ──────────────────────────────────────────────────────────────────

import { rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

import { parse_duration } from "@x-tech-laboratories/x-libs/durations";
import { read_server_config } from "@x-tech-laboratories/x-libs/server/config";
import { LocalAgent } from "@x-tech-laboratories/x-libs/server/agents/local";

import { operation_runner } from "../agent/tasks.ts";
import { AgentPool } from "./agents/agent.ts";
import { create_hub } from "./agents/hub.ts";
import { Cache } from "./cache.ts";
import { build_app } from "./app.ts";
import { load_accounts } from "./auth.ts";
import { load_config, parse_config, type Config } from "./config.ts";
import { Deployment } from "./deployment.ts";
import { Flake } from "./flake.ts";
import { Host } from "./host.ts";
import { Fleet } from "./fleet.ts";
import { Poller } from "./poller.ts";
import { Provisioner } from "./provisioning.ts";
import { record_pulls } from "./pull_reports.ts";
import { Store } from "./store.ts";
import { load_webhook_secret, Webhook } from "./webhook.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

// Users log in by name and password, so there is no server secret, and the page is a Vite build served only in production.
const settings = read_server_config({
  program: "x-nix", summary: "Serves the X-Nix portal and watches its deployments.", env_prefix: "X_NIX", default_port: 7720, secret: false,
  built_in: { host: { variable: "HOST" }, port: { variable: "PORT" } },
  options: {
    config: { variable: "X_NIX_CONFIG", help: "the deployments to watch", placeholder: "<file>" },
    state_dir: { variable: "X_NIX_STATE_DIR", help: "where the database and job output live", placeholder: "<folder>", default: "state" },
    server_name: { variable: "X_NIX_SERVER_NAME", help: "what the page calls this machine", placeholder: "<name>", default: hostname() },
    webhook_secret_file: { variable: "X_NIX_WEBHOOK_SECRET_FILE", help: "the push webhook's shared secret; the webhook is off without it", placeholder: "<file>" },
    webhook_debounce: { variable: "X_NIX_WEBHOOK_DEBOUNCE", help: "how long after the last push an evaluation starts", placeholder: "<duration>", default: "10s" },
  },
});
const { host, port } = settings;
const is_production = process.env.NODE_ENV === "production";
const state_directory = settings.values.state_dir || "state";
const config_path = settings.values.config;
const server_name = settings.values.server_name || hostname();
const accounts = load_accounts();
const webhook_secret_file = settings.values.webhook_secret_file;
const webhook_debounce = parse_duration(settings.values.webhook_debounce || "10s", "X_NIX_WEBHOOK_DEBOUNCE");

// ── Start ────────────────────────────────────────────────────────────────────

const config: Config = config_path ? load_config(config_path, server_name) : parse_config({}, server_name);
const store = new Store(join(state_directory, "x-nix.sqlite"));
// No feature keeps option lists under the state folder, so any left there go.
await rm(join(state_directory, "options"), { recursive: true, force: true });
// The server's own host is served by the built-in agent, whose long runs keep their output under the state folder.
const local_agent = new LocalAgent(join(state_directory, "agent"), { runner: operation_runner });
const agents = new AgentPool(server_name, local_agent);
agents.set_wake(config.wake_on_lan, config.keep_awake);
// Every other host's agent dials in, and joins the pool once it proves its declared key.
const hub = create_hub(agents, local_agent, {
  // Switches an agent ran on its own while the server was away join its deployments' job history once it reconnects.
  on_pulls: (host, pulls) => {
    const kept = record_pulls(store, poller.deployments.values(), host, pulls, Math.floor(Date.now() / 1000));
    for (const deployment of poller.deployments.values()) if (deployment.settings.host === host) poller.soon(deployment);
    return kept;
  },
});
// Hosts X-Nix installed are accepted with the keys it made for them, unless the config declares the host's key itself.
const accept_agent_keys = (provisioned: Map<string, string>) => hub.set_agent_keys(new Map([...provisioned, ...config.agents]));
const provisioner = new Provisioner(config.provisioning, {
  store, agents, default_media_root_dir: resolve(state_directory, "media"),
  declared_hosts: () => new Set(config.agents.keys()), on_agent_keys: accept_agent_keys,
});
accept_agent_keys(provisioner.agent_keys());
const hosts = new Map(config.hosts.map((settings) => [settings.id, new Host(settings, { store, agents })]));
const caches = config.caches.map((settings) => new Cache(settings, { store, agents }));
const deployments = config.deployments.map((settings) => new Deployment(settings, {
  store, agents, caches, host: hosts.get(settings.host ?? server_name), check_cache: (cache) => void poller.refresh(cache),
}));
// An update or a push that changed a flake has every deployment and cache naming the flake evaluate afresh.
const on_updated = (flake: Flake) => {
  for (const deployment of deployments.filter((candidate) => candidate.settings.flake_id === flake.id)) {
    deployment.request_evaluation();
    void poller.refresh(deployment);
  }
  for (const cache of caches.filter((candidate) => candidate.settings.flake_id === flake.id)) void poller.refresh(cache);
};
const flakes = config.flakes.map((settings) => new Flake(settings, { store, agents, on_updated }));
const poller = new Poller(deployments, null, caches, [provisioner], flakes, [...hosts.values()]);
const fleet = new Fleet(poller.deployments, { store, settings: config.fleet, poke: (deployment) => poller.soon(deployment) });
const webhook = webhook_secret_file ? new Webhook({
  secret: load_webhook_secret(webhook_secret_file), debounce_in_seconds: webhook_debounce, deployments: poller.deployments, store,
  evaluate: (deployment) => void poller.refresh(deployment), flakes: poller.flakes, read: (flake) => void poller.refresh(flake),
}) : undefined;
const app = await build_app({ serve_web: is_production, logger: true, server_name, accounts, store, poller, hub, provisioner, agents, fleet, webhook });

app.addHook("onClose", async () => {
  poller.stop();
  fleet.stop_timer();
  store.close();
});

if (webhook !== undefined) app.log.info("The push webhook takes deliveries at /api/webhook");
if (!config_path) app.log.warn("X_NIX_CONFIG is not set, so there are no deployments to watch");
app.log.info(`Watching ${hosts.size} hosts, ${flakes.length} flakes, ${deployments.length} deployments and ${caches.length} caches`);

await app.listen({ host, port });
poller.start();
fleet.start_timer();
