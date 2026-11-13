// Reads the config file: the hosts X-Nix reaches, the flakes it updates, and the deployments and caches it watches, each naming a flake.

// ── Imports ──────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { hostname } from "node:os";

import { AgentKeyError, parse_public_key } from "@x-tech-laboratories/x-libs/agent/keys";
import { parse_duration } from "@x-tech-laboratories/x-libs/durations";

import type { WakeSettings } from "./agents/wake.ts";
import { read_channels, type Channel } from "./notifications.ts";
import { is_pin, pinned_flake } from "./nixos/flake.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export type Status = "online" | "info" | "unavailable" | "warning" | "failed";

const status_severity: Record<Status, number> = { online: 0, info: 1, unavailable: 2, warning: 3, failed: 4 };

// The level a message or event raising each status is logged at.
// Where Build and a switch build: on the host it switches, on the server, or on the first of the ranked hosts that is there.
export type DirectOn = "host" | "server" | "ranked";

export const direct_on_values: DirectOn[] = ["host", "server", "ranked"];

export const level_of_status: Record<Status, "info" | "warning" | "error"> = { online: "info", info: "info", unavailable: "warning", warning: "warning", failed: "error" };

// A time of day as hours and minutes, local to the server.
export interface TimeOfDay {
  hour: number;
  minute: number;
}

// How the host's Nix store is watched and collected.
export interface GcSettings {
  unit: string;
  timer: string;
  store: string;
  // How long since the last collection before it reads as stale.
  max_age: number;
  stale_status: Status;
  timer_status: Status;
  // How full the store may be, in percent, before it warns and fails; null turns that level off.
  warning: number | null;
  threshold: number | null;
  max_generations: number | null;
  max_generation_age: number | null;
  gc_bin: string;
  gc_args: string[];
  // When X-Nix runs Collect Garbage each day, instead of the timer; null leaves collecting to the timer.
  collect_at: TimeOfDay | null;
}

// One machine X-Nix reaches through its agent: how it is woken, its Nix store and its boot entries.
export interface HostSettings {
  // The name its agent answers to.
  id: string;
  name: string;
  // Its agent's OpenSSH public key line; null for the server's own host, or a host X-Nix provisioned.
  agent_key: string | null;
  wake: WakeSettings | null;
  // Whether every job on the host, and every switch activating it, holds off idle and sleep until it ends.
  keep_awake: boolean;
  interval: number;
  job_poll: number;
  require_sudo: boolean;
  // Null when the store is not watched.
  gc: GcSettings | null;
  // Whether the boot entries are read, and the next boot may be picked.
  boot: boolean;
}

// One flake whose lock X-Nix keeps up to date, which deployments and caches name instead of repeating its reference.
export interface FlakeSettings {
  id: string;
  name: string;
  url: string;
  // The host whose agent reads and updates the flake; the server's own host when null.
  host: string | null;
  interval: number;
  job_poll: number;
  // The longest one read of the flake's metadata may take.
  timeout: number;
  max_input_age: number | null;
  update_at: TimeOfDay | null;
  // How often the inputs' remotes are asked whether they moved, starting an update when one did; null never asks.
  input_check_interval: number | null;
  // The inputs that check watches; null watches every one.
  watch_inputs: string[] | null;
  // A nix.conf file on the flake's host holding access-tokens, which nix reads when it reads or updates the flake.
  access_tokens_file: string | null;
  push_ssh_key: string | null;
  commit_author: string;
  commit_message: string;
  require_sudo: boolean;
  nix_bin: string;
  nix_args: string[];
}

export interface DeploymentSettings {
  id: string;
  name: string;
  // The host whose agent reads the running system and reboots it; the server's own host when null.
  host: string | null;
  // The flake's reference, taken from the flake the deployment names when it names one.
  flake: string;
  // The declared flake the deployment names, or null for a plain reference.
  flake_id: string | null;
  // The nixosConfigurations attribute; the host's own hostname when null.
  configuration: string | null;
  interval: number;
  eval_agent: string | null;
  eval_interval: number;
  retry_interval: number;
  eval_timeout: number;
  job_poll: number;
  drift_status: Status;
  reboot_status: Status;
  require_sudo: boolean;
  nix_bin: string;
  rebuild_bin: string;
  nix_args: string[];
  rebuild_args: string[];
  build_host: string | null;
  // The hosts that run Build, most preferred first; the deployment's own host when empty.
  build_agents: string[];
  build_args: string[];
  build_root_dir: string | null;
  // The cache's URL, taken from the cache the deployment names when it names one.
  cache_url: string | null;
  // The declared cache that builds the deployment's system, or null when it builds on its own.
  cache_id: string | null;
  switch_agent: string | null;
  // Where Build and a switch build; elsewhere than the switching host, the build pushes the system to cache_url for the host to fetch.
  direct_on: DirectOn;
  // Hold off idle and sleep on the activated host while a switch or rollback runs, as its host's keep_awake says.
  inhibit_sleep: boolean;
  target_host: string | null;
  auto_switch: boolean;
  auto_switch_after: number;
  build_at: TimeOfDay | null;
  switch_wrapper: string[];
  post_switch: string | null;
  // Commands run on the host before a switch changes anything; the first to fail refuses the switch.
  pre_switch_checks: string[];
  // Whether a switch X-Nix cannot confirm reaching the host after within confirm_timeout is rolled back.
  magic_rollback: boolean;
  // Whether a switch whose activation waits a minute for the Nix store database stops what holds it open.
  close_nix_lock_holders: boolean;
  activation_timeout: number;
  confirm_timeout: number;
  // Commands run on the host and URLs fetched from X-Nix after a switch, until they pass or health_timeout passes.
  health_commands: string[];
  health_urls: string[];
  health_period: number;
  health_timeout: number;
  // Whether Build reads nix's structured log, so its job shows what is building and downloading.
  build_progress: boolean;
  // Names a fleet selector picks the deployment by, as @tag.
  tags: string[];
  // The commit or tag evaluation, build and switch use instead of the branch head; null follows the head.
  pin: string | null;
}

// How fleet runs act on many deployments at once.
export interface FleetSettings {
  // How many deployments a run acts on at once.
  parallel: number;
  // The selectors a staged rollout goes through in order, such as "@canary".
  stages: string[];
  // How long a staged switch may take to read as in sync before the rollout stops.
  sync_timeout: number;
}

// A host that builds the fleet's closures, and the Attic cache they are pushed to.
export interface CacheSettings {
  id: string;
  name: string;
  // The hosts that evaluate, build and push, most preferred first; the server's own host when empty.
  hosts: string[];
  flake: string;
  flake_id: string | null;
  // nixosConfigurations names, tracked by their system toplevel.
  configurations: string[];
  // Any other derivation, as a name and its flake attribute.
  installables: Record<string, string>;
  cache_url: string;
  // Signing keys of upstream caches, whose paths Attic never stores.
  upstream_keys: string[];
  missing_limit: number;
  pending_status: Status;
  interval: number;
  job_poll: number;
  // The longest a check may run before it is killed.
  timeout: number;
  nix_bin: string;
  nix_args: string[];
  build_args: string[];
  build_root_dir: string | null;
  build_links: Record<string, string>;
  // When Build all runs daily, local to the server.
  build_at: TimeOfDay | null;
  push_command: string | null;
  // Whether a check that finds a target built here but not fully pushed pushes it again.
  retry_push: boolean;
  // Targets kept only in the cache once fully pushed.
  drop_pushed: string[];
  // The nix-eval-jobs program Build all evaluates with, and how many workers it evaluates on.
  eval_jobs_bin: string;
  eval_workers: number;
  // The cache server's own endpoints, each read by the X-Nix server; null when not read.
  info_url: string | null;
  health_url: string | null;
  metrics_url: string | null;
  // The metric whose samples add up to the cache's size in bytes.
  size_metric: string | null;
  // The status an unreachable or unhealthy cache server raises.
  server_status: Status;
}

// How new hosts are installed with nixos-anywhere, and where install media is built.
export interface ProvisioningSettings {
  // The private key nixos-anywhere logs in to targets with, as a path on the host that runs it.
  ssh_key: string | null;
  // The host that runs nixos-anywhere unless an install names another; the server's own host when null.
  install_agent: string | null;
  nixos_anywhere_bin: string;
  nixos_anywhere_args: string[];
  // Where a new host's agent key is placed on its disk.
  agent_key_path: string;
  // The server's agent endpoint, as a new host's agent dials it, for the snippets the page shows.
  agent_url: string | null;
  nix_bin: string;
  nix_args: string[];
  // Where each built install medium is linked, so it stays rooted until it is removed; under the state folder when null.
  media_root_dir: string | null;
  job_poll: number;
}

export interface Config {
  // Every declared host, and every host a deployment names, the server's own included.
  hosts: HostSettings[];
  flakes: FlakeSettings[];
  deployments: DeploymentSettings[];
  caches: CacheSettings[];
  provisioning: ProvisioningSettings;
  // Each other host's agent key, as its OpenSSH public key line, taken from hosts.
  agents: Map<string, string>;
  // How each host that sleeps is woken before an operation on it, taken from hosts.
  wake_on_lan: Map<string, WakeSettings>;
  keep_awake: Set<string>;
  fleet: FleetSettings;
  // Where notifications go, such as of a job running well past its time.
  notifications: Channel[];
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

// ── Statuses ─────────────────────────────────────────────────────────────────

export function worse(first: Status, second: Status): Status {
  return status_severity[second] > status_severity[first] ? second : first;
}

// ── Reading ──────────────────────────────────────────────────────────────────

export function load_config(path: string, own_host = hostname()): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ConfigError(`Could not read the config at ${path}: ${(error as Error).message}`);
  }
  return parse_config(raw, own_host);
}

// Reads the whole config; a deployment naming no host is on own_host, the server's own.
export function parse_config(raw: unknown, own_host = hostname()): Config {
  const values = (raw ?? {}) as Record<string, unknown>;
  const list = (key: "hosts" | "flakes" | "deployments" | "caches"): unknown[] => {
    const entries = values[key] ?? [];
    if (!Array.isArray(entries)) throw new ConfigError(`\`${key}\` must be a list`);
    return entries;
  };
  for (const key of ["agents", "wake_on_lan"]) {
    if (values[key] !== undefined && values[key] !== null) throw new ConfigError(`\`${key}\` belongs to each host: set agent_key and wake_on_lan under hosts`);
  }
  const hosts = new Map(list("hosts").map((entry, index) => host_settings(entry, index)).map((host) => [host.id, host]));
  const host_of = (name: string | null): HostSettings => {
    const id = name ?? own_host;
    if (!hosts.has(id)) hosts.set(id, host_settings({ id }));
    return hosts.get(id)!;
  };
  const flakes = list("flakes").map((entry, index) => flake_settings(entry, index));
  const by_id = new Map(flakes.map((flake) => [flake.id, flake]));
  const parsed_caches = list("caches").map((entry, index) => cache_settings(entry, index, by_id));
  const caches_by_id = new Map(parsed_caches.map((cache) => [cache.id, cache]));
  const parsed = list("deployments").map((entry, index) => deployment_settings(entry, index, by_id, host_of, caches_by_id));
  // Jobs and events are kept by id, so no two flakes, deployments or caches may share one.
  const seen = new Set<string>();
  for (const { id } of [...flakes, ...parsed, ...parsed_caches]) {
    if (seen.has(id)) throw new ConfigError(`Two flakes, deployments or caches are named '${id}'`);
    seen.add(id);
  }
  // A host runs one system, so two deployments switching it would undo each other.
  const deployed = new Map<string, string>();
  for (const { id, host } of parsed) {
    const host_id = host ?? own_host;
    const other = deployed.get(host_id);
    if (other !== undefined) throw new ConfigError(`Deployments '${other}' and '${id}' both run on host '${host_id}'; a host runs one deployment`);
    deployed.set(host_id, id);
  }
  const every_host = [...hosts.values()];
  return {
    hosts: every_host, flakes, deployments: parsed, caches: parsed_caches, provisioning: provisioning_settings(values.provisioning),
    agents: new Map(every_host.filter((host) => host.agent_key !== null).map((host) => [host.id, host.agent_key!])),
    wake_on_lan: new Map(every_host.filter((host) => host.wake !== null).map((host) => [host.id, host.wake!])),
    keep_awake: new Set(every_host.filter((host) => host.keep_awake).map((host) => host.id)),
    fleet: fleet_settings(values.fleet),
    notifications: notification_channels(values.notifications),
  };
}

function notification_channels(entries: unknown): Channel[] {
  try {
    return read_channels(entries);
  } catch (error) {
    throw new ConfigError((error as Error).message);
  }
}

export function host_settings(entry: unknown, index = 0): HostSettings {
  if (typeof entry !== "object" || entry === null) throw new ConfigError(`Host ${index + 1} must be an object`);
  const values = entry as Record<string, unknown>;
  const read = new Reader(values, `host ${typeof values.id === "string" ? `'${values.id}'` : index + 1}`);
  const id = read.text("id");
  if (id === null || !/^[A-Za-z0-9_.-]+$/.test(id)) throw new ConfigError(`Host ${index + 1} needs an \`id\`, its agent's name, of letters, digits, ., - and _`);
  const wake = wake_settings(values.wake_on_lan, id);
  return {
    id,
    name: read.text("name") ?? id,
    agent_key: agent_key(read.text("agent_key"), id),
    wake,
    keep_awake: read.flag("keep_awake", wake !== null),
    interval: read.duration("interval", "5m"),
    job_poll: read.duration("job_poll", "30s"),
    require_sudo: read.flag("require_sudo", true),
    gc: gc_settings(values.gc, read.owner),
    boot: read.flag("boot", true),
  };
}

// The reference and id of the flake an entry names: a declared flake by its id, or any other text as a reference of its own.
function resolve_flake(named: string, flakes: Map<string, FlakeSettings>): { flake: string; flake_id: string | null } {
  const flake = flakes.get(named);
  return flake === undefined ? { flake: named, flake_id: null } : { flake: flake.url, flake_id: flake.id };
}

export function flake_settings(entry: unknown, index = 0): FlakeSettings {
  if (typeof entry !== "object" || entry === null) throw new ConfigError(`Flake ${index + 1} must be an object`);
  const values = entry as Record<string, unknown>;
  const read = new Reader(values, `flake ${typeof values.id === "string" ? `'${values.id}'` : index + 1}`);
  const id = read.text("id");
  if (id === null || !/^[A-Za-z0-9_-]+$/.test(id)) throw new ConfigError(`Flake ${index + 1} needs an \`id\` of letters, digits, - and _`);
  const url = read.text("url");
  if (url === null) throw new ConfigError(`Flake '${id}' needs the \`url\` of its flake reference`);
  return {
    id,
    name: read.text("name") ?? id,
    url,
    host: read.text("host"),
    interval: read.duration("interval", "1h"),
    job_poll: read.duration("job_poll", "30s"),
    timeout: read.duration("timeout", "2m"),
    max_input_age: read.optional_duration("max_input_age"),
    update_at: read.time_of_day("update_at"),
    input_check_interval: values.input_check_interval === null ? null : read.duration("input_check_interval", "1m"),
    watch_inputs: values.watch_inputs == null ? null : read.list("watch_inputs", []),
    access_tokens_file: read.text("access_tokens_file"),
    push_ssh_key: read.text("push_ssh_key"),
    commit_author: read.text("commit_author") ?? "X-Nix <x-nix@localhost>",
    commit_message: read.text("commit_message") ?? "chore(flake): update inputs",
    require_sudo: read.flag("require_sudo", true),
    nix_bin: read.text("nix_bin") ?? "nix",
    nix_args: read.list("nix_args", ["--extra-experimental-features", "nix-command flakes"]),
  };
}

// The settings that describe the flake rather than the host, which only a flake under flakes takes.
const flake_only_keys = ["update_at", "push_ssh_key", "commit_author", "commit_message", "max_input_age"];

// The settings of a deployment's own build, which its cache takes over when it names one.
const cache_only_keys = ["cache_url", "build_at", "build_agent", "build_root_dir"];

// The settings that describe the machine, which only a host under hosts takes.
const host_only_keys = ["gc", "boot", "require_sudo", "inhibit_sleep"];

export function provisioning_settings(entry: unknown): ProvisioningSettings {
  if (entry !== undefined && entry !== null && (typeof entry !== "object" || Array.isArray(entry))) throw new ConfigError("`provisioning` must be an object");
  const read = new Reader((entry ?? {}) as Record<string, unknown>, "provisioning");
  const agent_key_path = read.text("agent_key_path") ?? "/etc/x-nix-agent/key";
  // The key's folders are made on the new host's disk, so the path must be plain and absolute.
  if (!/^(\/[A-Za-z0-9._-]+){2,}$/.test(agent_key_path) || agent_key_path.split("/").includes("..")) {
    throw new ConfigError("`agent_key_path` of provisioning must be an absolute path below a folder, such as /etc/x-nix-agent/key");
  }
  return {
    ssh_key: read.text("ssh_key"),
    install_agent: read.text("install_agent"),
    nixos_anywhere_bin: read.text("nixos_anywhere_bin") ?? "nixos-anywhere",
    nixos_anywhere_args: read.list("nixos_anywhere_args", []),
    agent_key_path,
    agent_url: read.text("agent_url"),
    nix_bin: read.text("nix_bin") ?? "nix",
    nix_args: read.list("nix_args", ["--extra-experimental-features", "nix-command flakes"]),
    media_root_dir: read.text("media_root_dir"),
    job_poll: read.duration("job_poll", "30s"),
  };
}

export function fleet_settings(entry: unknown): FleetSettings {
  if (entry !== undefined && entry !== null && (typeof entry !== "object" || Array.isArray(entry))) throw new ConfigError("`fleet` must be an object");
  const read = new Reader((entry ?? {}) as Record<string, unknown>, "the fleet");
  const parallel = read.limit("parallel", 4) ?? 4;
  if (!Number.isInteger(parallel) || parallel < 1) throw new ConfigError("`parallel` of the fleet must be a whole number of at least 1");
  return { parallel, stages: read.list("stages", []), sync_timeout: read.duration("sync_timeout", "30m") };
}

// The host's agent key, checked as an OpenSSH public key line.
function agent_key(line: string | null, host: string): string | null {
  if (line === null) return null;
  try {
    parse_public_key(line);
  } catch (error) {
    if (error instanceof AgentKeyError) throw new ConfigError(`The agent key of '${host}' ${error.message}`);
    throw error;
  }
  return line;
}

// The host's MAC address, or an object of `mac`, `broadcast`, `port`, `timeout` and `via`; null when it is never woken.
function wake_settings(entry: unknown, host: string): WakeSettings | null {
  if (entry === undefined || entry === null) return null;
  const fields = typeof entry === "string" ? { mac: entry } : entry;
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) throw new ConfigError(`The wake-on-LAN settings of '${host}' must be its MAC address or an object`);
  const owner = `the wake-on-LAN settings of '${host}'`;
  const read = new Reader(fields as Record<string, unknown>, owner);
  const mac = read.text("mac");
  if (mac === null || !/^[0-9A-Fa-f]{2}([:-][0-9A-Fa-f]{2}){5}$/.test(mac)) throw new ConfigError(`\`mac\` of ${owner} must be a MAC address such as "aa:bb:cc:dd:ee:ff"`);
  const port = read.limit("port", 9) ?? 9;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError(`\`port\` of ${owner} must be a port number`);
  return { mac, broadcast: read.text("broadcast") ?? "255.255.255.255", port, timeout: read.duration("timeout", "3m"), via: read.text("via") };
}

export function cache_settings(entry: unknown, index = 0, flakes = new Map<string, FlakeSettings>()): CacheSettings {
  if (typeof entry !== "object" || entry === null) throw new ConfigError(`Cache ${index + 1} must be an object`);
  const values = entry as Record<string, unknown>;
  const read = new Reader(values, `cache ${typeof values.id === "string" ? `'${values.id}'` : index + 1}`);
  const id = read.text("id");
  if (id === null || !/^[A-Za-z0-9_-]+$/.test(id)) throw new ConfigError(`Cache ${index + 1} needs an \`id\` of letters, digits, - and _`);
  const cache_url = read.text("cache_url");
  if (cache_url === null) throw new ConfigError(`Cache '${id}' needs a \`cache_url\``);
  const configurations = read.list("configurations", []);
  const installables = read.names("installables");
  if (configurations.length + Object.keys(installables).length === 0) throw new ConfigError(`Cache '${id}' tracks nothing: name configurations or installables`);
  return {
    id,
    name: read.text("name") ?? id,
    hosts: read.ranked("host"),
    ...resolve_flake(read.text("flake") ?? "/etc/nixos", flakes),
    configurations,
    installables,
    cache_url,
    upstream_keys: read.list("upstream_keys", ["cache.nixos.org-1"]),
    missing_limit: read.limit("missing_limit", 50) ?? 50,
    pending_status: read.status("pending_status", "warning"),
    interval: read.duration("interval", "1h"),
    job_poll: read.duration("job_poll", "30s"),
    timeout: read.duration("timeout", "30m"),
    nix_bin: read.text("nix_bin") ?? "nix",
    nix_args: read.list("nix_args", ["--extra-experimental-features", "nix-command flakes"]),
    build_args: read.list("build_args", ["--keep-going", "--print-build-logs"]),
    build_root_dir: read.text("build_root_dir"),
    build_links: read.names("build_links"),
    build_at: read.time_of_day("build_at"),
    push_command: read.text("push_command"),
    retry_push: read.flag("retry_push", true),
    drop_pushed: read.list("drop_pushed", []),
    eval_jobs_bin: read.text("eval_jobs_bin") ?? "nix-eval-jobs",
    eval_workers: Math.max(1, Math.trunc(read.limit("eval_workers", 4) ?? 4)),
    info_url: values.info_url === false ? null : read.text("info_url") ?? default_info_url(cache_url),
    health_url: read.text("health_url"),
    metrics_url: read.text("metrics_url"),
    size_metric: read.text("size_metric"),
    server_status: read.status("server_status", "warning"),
  };
}

// An http cache answers its nix-cache-info beside its paths; any other store has no URL to read.
function default_info_url(cache_url: string): string | null {
  return /^https?:\/\//.test(cache_url) ? `${cache_url.replace(/\/+$/, "")}/nix-cache-info` : null;
}

// The settings of one deployment, with the flake and cache it names resolved and its host's sudo and sleep settings.
export function deployment_settings(
  entry: unknown, index = 0, flakes = new Map<string, FlakeSettings>(), host_of: (name: string | null) => HostSettings = (name) => host_settings({ id: name ?? "localhost" }),
  caches = new Map<string, CacheSettings>(),
): DeploymentSettings {
  if (typeof entry !== "object" || entry === null) throw new ConfigError(`Deployment ${index + 1} must be an object`);
  const values = entry as Record<string, unknown>;
  const read = new Reader(values, `deployment ${typeof values.id === "string" ? `'${values.id}'` : index + 1}`);
  const id = read.text("id");
  if (id === null || !/^[A-Za-z0-9_-]+$/.test(id)) throw new ConfigError(`Deployment ${index + 1} needs an \`id\` of letters, digits, - and _`);
  const moved = flake_only_keys.find((key) => values[key] !== undefined && values[key] !== null);
  if (moved !== undefined) throw new ConfigError(`\`${moved}\` of ${read.owner} belongs to its flake: declare the flake under flakes and name its id in \`flake\``);
  const of_host = host_only_keys.find((key) => values[key] !== undefined && values[key] !== null);
  if (of_host !== undefined) throw new ConfigError(`\`${of_host}\` of ${read.owner} belongs to its host: set it under hosts`);
  const host = host_of(read.text("host"));
  const switch_agent = read.text("switch_agent");
  const build_agents = read.ranked("build_agent");
  const eval_interval = read.duration("eval_interval", "1h");
  const cache_id = read.text("cache");
  const cache = cache_id === null ? null : caches.get(cache_id) ?? null;
  if (cache_id !== null && cache === null) throw new ConfigError(`\`cache\` of ${read.owner} names no cache under caches: '${cache_id}'`);
  const builds_alone = cache_only_keys.find((key) => values[key] !== undefined && values[key] !== null);
  if (cache !== null && builds_alone !== undefined) throw new ConfigError(`\`${builds_alone}\` of ${read.owner} belongs to its cache '${cache_id}', which builds its system`);
  const cache_url = cache?.cache_url ?? read.text("cache_url");
  const direct_on = read.text("direct_on") ?? "ranked";
  if (!direct_on_values.includes(direct_on as DirectOn)) throw new ConfigError(`\`direct_on\` of ${read.owner} must be one of ${direct_on_values.join(", ")}`);
  const { flake, flake_id } = resolve_flake(read.text("flake") ?? "/etc/nixos", flakes);
  const tags = read.list("tags", []);
  const bad_tag = tags.find((tag) => !/^[A-Za-z0-9_.-]+$/.test(tag));
  if (bad_tag !== undefined) throw new ConfigError(`Tag ${JSON.stringify(bad_tag)} of ${read.owner} must be letters, digits, ., - and _`);
  const pin = read.text("pin");
  if (pin !== null && !is_pin(pin)) throw new ConfigError(`\`pin\` of ${read.owner} must be a commit hash or a tag name`);
  if (pin !== null && pinned_flake(flake, pin) === null) throw new ConfigError(`\`pin\` of ${read.owner} needs a git or forge flake, not ${flake}`);
  const settings: DeploymentSettings = {
    id,
    name: read.text("name") ?? id,
    host: read.text("host"),
    flake,
    flake_id,
    configuration: read.text("configuration"),
    interval: read.duration("interval", "5m"),
    eval_agent: read.text("eval_agent"),
    eval_interval,
    retry_interval: Math.min(read.duration("retry_interval", "15m"), eval_interval),
    eval_timeout: read.duration("eval_timeout", "10m"),
    job_poll: read.duration("job_poll", "30s"),
    drift_status: read.status("drift_status", "warning"),
    reboot_status: read.status("reboot_status", "warning"),
    require_sudo: host.require_sudo,
    nix_bin: read.text("nix_bin") ?? "nix",
    rebuild_bin: read.text("rebuild_bin") ?? "nixos-rebuild",
    nix_args: read.list("nix_args", ["--extra-experimental-features", "nix-command flakes"]),
    rebuild_args: read.list("rebuild_args", []),
    build_host: read.text("build_host"),
    build_agents: build_agents.length > 0 || switch_agent === null ? build_agents : [switch_agent],
    build_args: read.list("build_args", ["--keep-going", "--print-build-logs"]),
    build_root_dir: read.text("build_root_dir"),
    cache_url,
    cache_id,
    switch_agent,
    direct_on: direct_on as DirectOn,
    inhibit_sleep: host.keep_awake,
    target_host: read.text("target_host"),
    auto_switch: read.flag("auto_switch", false),
    auto_switch_after: read.duration("auto_switch_after", "30m"),
    build_at: read.time_of_day("build_at"),
    switch_wrapper: read.list("switch_wrapper", []),
    post_switch: read.text("post_switch"),
    pre_switch_checks: read.list("pre_switch_checks", []),
    magic_rollback: read.flag("magic_rollback", false),
    close_nix_lock_holders: read.flag("close_nix_lock_holders", false),
    activation_timeout: read.duration("activation_timeout", "4m"),
    confirm_timeout: read.duration("confirm_timeout", "30s"),
    health_commands: read.list("health_commands", []),
    health_urls: read.urls("health_urls"),
    health_period: Math.max(1, read.duration("health_period", "5s")),
    health_timeout: read.duration("health_timeout", "2m"),
    build_progress: read.flag("build_progress", true),
    tags,
    pin,
  };
  // A guarded switch's checks and watchdog run inside the agent on the host it activates, so there is no remote host to name.
  const guarded = settings.pre_switch_checks.length > 0 || settings.health_commands.length > 0 || settings.health_urls.length > 0 || settings.magic_rollback;
  if (guarded && settings.target_host !== null) {
    throw new ConfigError(`Deployment '${id}' guards its switches with pre_switch_checks, health checks or magic_rollback, which run in the agent on the activated host, so it cannot take a \`target_host\`; give that host its own agent and name it in switch_agent`);
  }
  return settings;
}

function gc_settings(entry: unknown, owner: string): GcSettings | null {
  if (entry === false) return null;
  if (entry !== undefined && entry !== null && (typeof entry !== "object" || Array.isArray(entry))) {
    throw new ConfigError(`\`gc\` of ${owner} must be an object, or false to leave the store alone`);
  }
  const read = new Reader((entry ?? {}) as Record<string, unknown>, `the gc of ${owner}`);
  return {
    unit: read.text("unit") ?? "nix-gc.service",
    timer: read.text("timer") ?? "nix-gc.timer",
    store: read.text("store") ?? "/nix/store",
    max_age: read.duration("max_age", "2w"),
    stale_status: read.status("stale_status", "failed"),
    timer_status: read.status("timer_status", "warning"),
    warning: read.limit("warning", 80),
    threshold: read.limit("threshold", 90),
    max_generations: read.limit("max_generations", null),
    max_generation_age: read.optional_duration("max_generation_age"),
    gc_bin: read.text("gc_bin") ?? "nix-collect-garbage",
    gc_args: read.list("gc_args", ["--delete-older-than", "7d"]),
    collect_at: read.time_of_day("collect_at"),
  };
}

// Reads one entry's values, naming the entry and key in every error.
class Reader {
  private readonly values: Record<string, unknown>;
  readonly owner: string;

  constructor(values: Record<string, unknown>, owner: string) {
    this.values = values;
    this.owner = owner;
  }

  text(key: string): string | null {
    const value = this.values[key];
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string") throw new ConfigError(`\`${key}\` of ${this.owner} must be text`);
    return value;
  }

  flag(key: string, fallback: boolean): boolean {
    const value = this.values[key];
    if (value === undefined || value === null) return fallback;
    if (typeof value !== "boolean") throw new ConfigError(`\`${key}\` of ${this.owner} must be true or false`);
    return value;
  }

  list(key: string, fallback: string[]): string[] {
    const value = this.values[key];
    if (value === undefined || value === null) return fallback;
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new ConfigError(`\`${key}\` of ${this.owner} must be a list of text`);
    return value;
  }

  // One host name, or a list of them in order of preference.
  ranked(key: string): string[] {
    const value = this.values[key];
    if (value === undefined || value === null || value === "") return [];
    if (typeof value === "string") return [value];
    if (Array.isArray(value) && value.every((item) => typeof item === "string" && item !== "")) return value;
    throw new ConfigError(`\`${key}\` of ${this.owner} must be a host name or a list of host names, most preferred first`);
  }

  // A list of http or https URLs.
  urls(key: string): string[] {
    const values = this.list(key, []);
    for (const value of values) {
      let protocol = "";
      try {
        protocol = new URL(value).protocol;
      } catch {
        // Left empty, so the check below names the value.
      }
      if (protocol !== "http:" && protocol !== "https:") throw new ConfigError(`\`${key}\` of ${this.owner} must list http or https URLs, not ${JSON.stringify(value)}`);
    }
    return values;
  }

  // An object of text values, such as names to flake attributes.
  names(key: string): Record<string, string> {
    const value = this.values[key];
    if (value === undefined || value === null) return {};
    if (typeof value !== "object" || Array.isArray(value) || !Object.values(value).every((item) => typeof item === "string")) {
      throw new ConfigError(`\`${key}\` of ${this.owner} must map names to text`);
    }
    return value as Record<string, string>;
  }

  duration(key: string, fallback: string): number {
    try {
      return parse_duration(this.values[key] ?? fallback, key);
    } catch (error) {
      throw new ConfigError(`${(error as Error).message} in ${this.owner}`);
    }
  }

  optional_duration(key: string): number | null {
    return this.values[key] == null ? null : this.duration(key, "0");
  }

  // A number, or null to turn off what it limits.
  limit(key: string, fallback: number | null): number | null {
    const value = this.values[key];
    if (value === undefined) return fallback;
    if (value === null) return null;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new ConfigError(`\`${key}\` of ${this.owner} must be a number, or null to turn it off`);
    return value;
  }

  // An unrecognised status falls back to the default rather than stopping the server.
  status(key: string, fallback: Status): Status {
    const value = this.values[key];
    return typeof value === "string" && value in status_severity ? (value as Status) : fallback;
  }

  time_of_day(key: string): TimeOfDay | null {
    const value = this.values[key];
    if (value === undefined || value === null || value === "") return null;
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(value));
    if (match === null || Number(match[1]) > 23 || Number(match[2]) > 59) {
      throw new ConfigError(`\`${key}\` of ${this.owner} must be a time of day such as "02:30", not ${JSON.stringify(value)}`);
    }
    return { hour: Number(match[1]), minute: Number(match[2]) };
  }
}
