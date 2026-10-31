// ── Imports ──────────────────────────────────────────────────────────────────

import { hostname } from "node:os";
import { join, resolve } from "node:path";

import { AgentPool } from "./agents/agent.ts";
import { Cache } from "./cache.ts";
import { AgentHub } from "./agents/hub.ts";
import { LocalAgent } from "./agents/local.ts";
import { build_app } from "./app.ts";
import { load_password_hash } from "./auth.ts";
import { load_config, parse_config, type Config } from "./config.ts";
import { Deployment } from "./deployment.ts";
import { parse_duration } from "./durations.ts";
import { Fleet } from "./fleet.ts";
import { Poller } from "./poller.ts";
import { Provisioner } from "./provisioning.ts";
import { record_pulls } from "./pull_reports.ts";
import { Secrets } from "./secrets.ts";
import { Store } from "./store.ts";
import { load_webhook_secret, Webhook } from "./webhook.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 7720);
const is_production = process.env.NODE_ENV === "production";
const state_directory = process.env.X_NIX_STATE_DIR ?? "state";
const config_path = process.env.X_NIX_CONFIG;
const server_name = process.env.X_NIX_SERVER_NAME || hostname();
const password_hash = load_password_hash();
// The push webhook is on only when its secret file is named.
const webhook_secret_file = process.env.X_NIX_WEBHOOK_SECRET_FILE;
const webhook_debounce = parse_duration(process.env.X_NIX_WEBHOOK_DEBOUNCE || "10s", "X_NIX_WEBHOOK_DEBOUNCE");

// ── Start ────────────────────────────────────────────────────────────────────

const config: Config = config_path ? load_config(config_path) : parse_config({});
const store = new Store(join(state_directory, "x-nix.sqlite"));
// The server's own host is served by the built-in agent, whose long runs keep their output under the state folder.
const agents = new AgentPool(server_name, new LocalAgent(join(state_directory, "agent")));
// Every other host's agent dials in, and joins the pool once it proves its declared key.
const hub = new AgentHub(agents);
// Hosts X-Nix installed are accepted with the keys it made for them, unless the config declares the host's key itself.
const accept_agent_keys = (provisioned: Map<string, string>) => hub.set_agent_keys(new Map([...provisioned, ...config.agents]));
const provisioner = new Provisioner(config.provisioning, {
  store, agents, default_media_root_dir: resolve(state_directory, "media"),
  declared_hosts: () => new Set(config.agents.keys()), on_agent_keys: accept_agent_keys,
});
accept_agent_keys(provisioner.agent_keys());
const secrets = new Secrets({ store, agents });
// A switch may add the accounts a key belongs to, so each switch uploads what is missing or stale.
const upload_needed = (deployment: Deployment, trigger: string) => {
  if (deployment.settings.secrets.length > 0) void secrets.upload(deployment, trigger, true);
};
const deployments = config.deployments.map((settings) => new Deployment(settings, { store, agents, after_switch: (deployment) => upload_needed(deployment, "switch") }));
// The keys folder is emptied by a reboot, so a host's agent coming back has its secrets uploaded again.
hub.on("connect", (status) => {
  for (const deployment of deployments) if (deployment.settings.host === status.host) upload_needed(deployment, "agent connect");
});
const caches = config.caches.map((settings) => new Cache(settings, { store, agents }));
const poller = new Poller(deployments, null, caches, [provisioner]);
const fleet = new Fleet(poller.deployments, { store, settings: config.fleet, poke: (deployment) => poller.soon(deployment) });
const webhook = webhook_secret_file ? new Webhook({
  secret: load_webhook_secret(webhook_secret_file), debounce_in_seconds: webhook_debounce, deployments: poller.deployments, store,
  evaluate: (deployment) => void poller.refresh(deployment),
}) : undefined;
// Switches an agent ran on its own while the server was away join its deployments' job history once it reconnects.
hub.on_pulls = (host, pulls) => {
  const kept = record_pulls(store, poller.deployments.values(), host, pulls, Math.floor(Date.now() / 1000));
  for (const deployment of poller.deployments.values()) if (deployment.settings.host === host) poller.soon(deployment);
  return kept;
};
const app = await build_app({ serve_web: is_production, logger: true, server_name, password_hash, store, poller, hub, provisioner, agents, fleet, webhook, secrets });

app.addHook("onClose", async () => {
  poller.stop();
  fleet.stop_timer();
  store.close();
});

if (webhook !== undefined) app.log.info("The push webhook takes deliveries at /api/webhook");
if (!config_path) app.log.warn("X_NIX_CONFIG is not set, so there are no deployments to watch");
app.log.info(`Watching ${deployments.length} deployments and ${caches.length} caches`);

await app.listen({ host, port });
poller.start();
fleet.start_timer();
// The server's own host has no agent to connect, so its secrets are seen to on start.
for (const deployment of deployments) {
  if (deployment.settings.host === null || deployment.settings.host === server_name) upload_needed(deployment, "server start");
}
