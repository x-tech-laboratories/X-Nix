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
import { Poller } from "./poller.ts";
import { Provisioner } from "./provisioning.ts";
import { Store } from "./store.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 7720);
const is_production = process.env.NODE_ENV === "production";
const state_directory = process.env.X_NIX_STATE_DIR ?? "state";
const config_path = process.env.X_NIX_CONFIG;
const server_name = process.env.X_NIX_SERVER_NAME || hostname();
const password_hash = load_password_hash();

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
const deployments = config.deployments.map((settings) => new Deployment(settings, { store, agents }));
const caches = config.caches.map((settings) => new Cache(settings, { store, agents }));
const poller = new Poller(deployments, null, caches, [provisioner]);
const app = await build_app({ serve_web: is_production, logger: true, server_name, password_hash, store, poller, hub, provisioner });

app.addHook("onClose", async () => {
  poller.stop();
  store.close();
});

if (!config_path) app.log.warn("X_NIX_CONFIG is not set, so there are no deployments to watch");
app.log.info(`Watching ${deployments.length} deployments and ${caches.length} caches`);

await app.listen({ host, port });
poller.start();
