// ── Imports ──────────────────────────────────────────────────────────────────

import { rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

import { backup_naming, keep_backing_up } from "@x-tech-laboratories/x-libs/backups";
import { parse_duration } from "@x-tech-laboratories/x-libs/durations";
import { json_backup_schedule } from "@x-tech-laboratories/x-libs/server/backup_routes";
import { read_server_config } from "@x-tech-laboratories/x-libs/server/config";
import { Notifier } from "@x-tech-laboratories/x-libs/server/notify/channels";
import { LocalAgent } from "@x-tech-laboratories/x-libs/server/agents/local";
import { sqlite_backups, take_staged_restore } from "@x-tech-laboratories/x-libs/server/sqlite_backups";

import { operation_runner } from "../agent/tasks.ts";
import { AgentPool } from "./agents/agent.ts";
import { create_hub } from "./agents/hub.ts";
import { Cache } from "./cache.ts";
import { build_app } from "./app.ts";
import { load_accounts, type SignInSettings } from "./auth.ts";
import { load_config, parse_config, type Config } from "./config.ts";
import { Deployment } from "./deployment.ts";
import { Flake } from "./flake.ts";
import { Host } from "./host.ts";
import { target_attributes } from "./nixos/attic.ts";
import { OverdueJobs } from "./overdue.ts";
import { Fleet } from "./fleet.ts";
import { Poller } from "./poller.ts";
import { Provisioner } from "./provisioning.ts";
import { record_pulls } from "./pull_reports.ts";
import { keep_pruning } from "./retention.ts";
import { stop_job } from "./runs.ts";
import { Store } from "./store.ts";
import { load_webhook_secret, Webhook } from "./webhook.ts";
import { nix_string, switch_folders_variable } from "../shared/operations.ts";

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
    session_lifetime: { variable: "X_NIX_SESSION_LIFETIME", help: "how long a sign-in lasts without keep me signed in", placeholder: "<duration>", default: "12h" },
    remembered_lifetime: { variable: "X_NIX_REMEMBERED_LIFETIME", help: "how long a kept sign-in lasts", placeholder: "<duration>", default: "30d" },
    token_lifetime: { variable: "X_NIX_TOKEN_LIFETIME", help: "the longest a token lasts, in whole days, or never", placeholder: "<duration|never>", default: "90d" },
    admin_second_factor: { variable: "X_NIX_ADMIN_SECOND_FACTOR", help: "yes to have admins set up a second factor before they change anything", placeholder: "<yes|no>", default: "yes" },
    history_retention: {
      variable: "X_NIX_HISTORY_RETENTION", help: "how long finished jobs, builds, events and fleet runs are kept, or never to keep them all",
      placeholder: "<duration|never>", default: "180d",
    },
    local_agent: {
      variable: "X_NIX_LOCAL_AGENT", help: "yes to work on this machine from the server itself, which needs sudo rules, rather than through its own agent",
      placeholder: "<yes|no>", default: "no",
    },
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
const yes_or_no = (value: string | undefined, fallback: string, variable: string) => {
  const answer = (value || fallback).toLowerCase();
  if (answer !== "yes" && answer !== "no") throw new Error(`${variable} must be yes or no`);
  return answer === "yes";
};
const token_lifetime = settings.values.token_lifetime || "90d";
const sign_in: SignInSettings = {
  session_seconds: parse_duration(settings.values.session_lifetime || "12h", "X_NIX_SESSION_LIFETIME"),
  remembered_seconds: parse_duration(settings.values.remembered_lifetime || "30d", "X_NIX_REMEMBERED_LIFETIME"),
  token_days: token_lifetime === "never" ? null : Math.max(1, Math.round(parse_duration(token_lifetime, "X_NIX_TOKEN_LIFETIME") / 86400)),
  admin_second_factor: yes_or_no(settings.values.admin_second_factor, "yes", "X_NIX_ADMIN_SECOND_FACTOR"),
};
const history_retention = settings.values.history_retention || "180d";
const history_retention_in_seconds = history_retention === "never" ? null : parse_duration(history_retention, "X_NIX_HISTORY_RETENTION");
const local_agent_setting = yes_or_no(settings.values.local_agent, "no", "X_NIX_LOCAL_AGENT") ? "yes" : "no";

// ── Start ────────────────────────────────────────────────────────────────────

const config: Config = config_path ? load_config(config_path, server_name) : parse_config({}, server_name);
const database_path = join(state_directory, "x-nix.sqlite");
// A restore picked on the Backups page waits beside the database and is taken in here, before the database opens.
if (take_staged_restore(database_path)) console.info("Restored the database from the backup picked on the Backups page");
const store = new Store(database_path);
// The state database holds the accounts, so it is backed up daily; a restore stops the server so systemd starts it again.
const backups = sqlite_backups({
  folder: () => join(state_directory, "backups"), naming: backup_naming("x-nix", ".sqlite"), database: () => store.sql, database_path: () => database_path,
  after_staging: () => {
    console.info("Restarting to restore a backup");
    setTimeout(() => process.exit(75), 500);
  },
});
const backup_schedule = json_backup_schedule(join(state_directory, "backup-schedule.json"));
const automatic_backups = keep_backing_up(backups, backup_schedule.get);
// No feature keeps option lists under the state folder, so any left there go.
await rm(join(state_directory, "options"), { recursive: true, force: true });
// The server's own host is served by the built-in agent, whose long runs keep their output under the state folder, or
// by an agent of its own, so the server that answers the web needs no sudo.
if (local_agent_setting === "yes") process.env[switch_folders_variable] ||= join(resolve(state_directory), "agent", "switches");
const local_agent = local_agent_setting === "yes" ? new LocalAgent(join(state_directory, "agent"), { runner: operation_runner }) : null;
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
// A host holds off its reboot and collection while a deployment on it switches, which the deployment refuses in turn while it collects.
const deployments_on = (host_name: string) => () => config.deployments.filter((deployment) => (deployment.host ?? server_name) === host_name);
const hosts = new Map(config.hosts.map((settings) => [settings.id, new Host(settings, { store, agents, deployments: deployments_on(settings.id) })]));
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
// An update checks the system of every deployment naming the flake whose attribute is known, and every target of its caches.
const checked_attributes = (flake: Flake) => [...new Set([
  ...deployments.flatMap((deployment) => {
    const attribute = deployment.settings.flake_id === flake.id ? deployment.attribute() : null;
    return attribute === null ? [] : [`nixosConfigurations.${nix_string(attribute)}.config.system.build.toplevel`];
  }),
  ...caches.filter((cache) => cache.settings.flake_id === flake.id).flatMap((cache) => target_attributes(cache.settings)),
])];
const flakes = config.flakes.map((settings) => new Flake(settings, { store, agents, on_updated, checked_attributes }));
const poller = new Poller(deployments, null, caches, [provisioner], flakes, [...hosts.values()]);
poller.follow_new_jobs(store);
const fleet = new Fleet(poller.deployments, {
  store, settings: config.fleet, poke: (deployment) => poller.soon(deployment),
  stop_job: (job_id, by) => stop_job(store, agents, job_id, by, () => Math.floor(Date.now() / 1000)),
});
// A job running well past its time is noted in its owner's history and sent to the notification channels.
const overdue_jobs = new OverdueJobs(store, new Notifier(config.notifications));
const webhook = webhook_secret_file ? new Webhook({
  secret: load_webhook_secret(webhook_secret_file), debounce_in_seconds: webhook_debounce, deployments: poller.deployments, store,
  evaluate: (deployment) => void poller.refresh(deployment), flakes: poller.flakes, read: (flake) => void poller.refresh(flake),
  update: (flake, inputs) => void flake.update(`push to ${inputs}`).then((outcome) => outcome.ok && poller.soon(flake)),
}) : undefined;
const app = await build_app({
  serve_web: is_production, logger: true, server_name, accounts, sign_in, store, poller, hub, provisioner, agents, fleet, webhook,
  backups: { backups, schedule: backup_schedule, on_schedule_change: () => void automatic_backups.check() },
});

// History older than the retention is pruned now and then, keeping what anything still names.
const stop_pruning = keep_pruning(store, history_retention_in_seconds, (message) => app.log.info(message));

app.addHook("onClose", async () => {
  stop_pruning();
  poller.stop();
  fleet.stop_timer();
  overdue_jobs.stop();
  store.close();
});

if (webhook !== undefined) app.log.info("The push webhook takes deliveries at /api/webhook");
if (!config_path) app.log.warn("X_NIX_CONFIG is not set, so there are no deployments to watch");
app.log.info(`Watching ${hosts.size} hosts, ${flakes.length} flakes, ${deployments.length} deployments and ${caches.length} caches`);

await app.listen({ host, port });
poller.start();
fleet.start_timer();
overdue_jobs.start();
