// Reads the config file: the deployments X-Nix watches, each a NixOS host and the flake that describes it.

// ── Imports ──────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";

import { AgentKeyError, parse_public_key } from "../shared/agent_keys.ts";
import { is_account_name, is_key_destination, is_key_mode, key_folder } from "../shared/keys.ts";
import { parse_duration } from "./durations.ts";
import { is_pin, pinned_flake } from "./nixos/flake.ts";
import { is_flake_path } from "./nixos/flake_files.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export type Status = "online" | "info" | "unavailable" | "warning" | "failed";

const status_severity: Record<Status, number> = { online: 0, info: 1, unavailable: 2, warning: 3, failed: 4 };

// The level a message or event raising each status is logged at.
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
}

// A key uploaded to the host outside the store; its value stays in the source file on this server.
export interface SecretSettings {
  name: string;
  // The file on this server holding the value, read only to upload or check it.
  source: string;
  destination: string;
  owner: string;
  group: string;
  // The permission bits, such as "0400".
  mode: string;
}

export interface DeploymentSettings {
  id: string;
  name: string;
  // The host whose agent reads the running system and reboots it; the server's own host when null.
  host: string | null;
  flake: string;
  // The nixosConfigurations attribute; the host's own hostname when null.
  configuration: string | null;
  interval: number;
  eval_agent: string | null;
  eval_interval: number;
  retry_interval: number;
  eval_timeout: number;
  // How long generating the option and package lists may run.
  options_timeout: number;
  // The JSON file in the flake the option form commits to; x-nix/<configuration>.json when null.
  options_file: string | null;
  job_poll: number;
  max_input_age: number | null;
  drift_status: Status;
  reboot_status: Status;
  require_sudo: boolean;
  nix_bin: string;
  rebuild_bin: string;
  nix_args: string[];
  rebuild_args: string[];
  build_host: string | null;
  build_agent: string | null;
  build_args: string[];
  build_root_dir: string | null;
  cache_url: string | null;
  switch_agent: string | null;
  // Switch by fetching the evaluated closure from cache_url and activating it, rather than rebuilding on the host.
  switch_from_cache: boolean;
  target_host: string | null;
  auto_switch: boolean;
  auto_switch_after: number;
  update_at: TimeOfDay | null;
  build_at: TimeOfDay | null;
  switch_wrapper: string[];
  post_switch: string | null;
  // Commands run on the host before a switch changes anything; the first to fail refuses the switch.
  pre_switch_checks: string[];
  // Whether a switch X-Nix cannot confirm reaching the host after within confirm_timeout is rolled back.
  magic_rollback: boolean;
  activation_timeout: number;
  confirm_timeout: number;
  // Commands run on the host and URLs fetched from X-Nix after a switch, until they pass or health_timeout passes.
  health_commands: string[];
  health_urls: string[];
  health_period: number;
  health_timeout: number;
  // Whether Build reads nix's structured log, so its job shows what is building and downloading.
  build_progress: boolean;
  push_ssh_key: string | null;
  commit_author: string;
  commit_message: string;
  // Null when the store is not watched.
  gc: GcSettings | null;
  // Whether the host's boot entries are read, and its next boot may be picked.
  boot: boolean;
  // Names a fleet selector picks the deployment by, as @tag.
  tags: string[];
  // The commit or tag evaluation, build and switch use instead of the branch head; null follows the head.
  pin: string | null;
  secrets: SecretSettings[];
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
  // The host that evaluates, builds and pushes; the server's own host when null.
  host: string | null;
  flake: string;
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
  push_command: string | null;
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

// The fleet's inventory: one JSON file in a flake listing each machine's tags and roles, which the page edits.
export interface InventorySettings {
  flake: string;
  file: string;
  // The host that clones and commits; the server's own host when null.
  host: string | null;
  push_ssh_key: string | null;
  commit_author: string;
  commit_message: string;
}

export interface Config {
  deployments: DeploymentSettings[];
  caches: CacheSettings[];
  provisioning: ProvisioningSettings;
  // Each other host's agent key, as its OpenSSH public key line.
  agents: Map<string, string>;
  fleet: FleetSettings;
  // Null when no inventory is kept.
  inventory?: InventorySettings | null;
}

// The id the inventory's jobs and events are kept under.
export const inventory_id = "inventory";

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

export function load_config(path: string): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ConfigError(`Could not read the config at ${path}: ${(error as Error).message}`);
  }
  return parse_config(raw);
}

export function parse_config(raw: unknown): Config {
  const deployments = (raw as { deployments?: unknown } | null)?.deployments ?? [];
  if (!Array.isArray(deployments)) throw new ConfigError("`deployments` must be a list");
  const caches = (raw as { caches?: unknown } | null)?.caches ?? [];
  if (!Array.isArray(caches)) throw new ConfigError("`caches` must be a list");
  const parsed = deployments.map((entry, index) => deployment_settings(entry, index));
  const parsed_caches = caches.map((entry, index) => cache_settings(entry, index));
  // Jobs and events are kept by id, so a cache may not share one with a deployment.
  const seen = new Set<string>();
  for (const { id } of [...parsed, ...parsed_caches]) {
    if (seen.has(id)) throw new ConfigError(`Two deployments or caches are named '${id}'`);
    seen.add(id);
  }
  const inventory = inventory_settings((raw as { inventory?: unknown } | null)?.inventory);
  if (inventory !== null && seen.has(inventory_id)) throw new ConfigError(`'${inventory_id}' names the inventory's jobs, so no deployment or cache may take it`);
  return {
    deployments: parsed, caches: parsed_caches, provisioning: provisioning_settings((raw as { provisioning?: unknown } | null)?.provisioning),
    agents: agent_keys((raw as { agents?: unknown } | null)?.agents),
    fleet: fleet_settings((raw as { fleet?: unknown } | null)?.fleet),
    inventory,
  };
}

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

function inventory_settings(entry: unknown): InventorySettings | null {
  if (entry === undefined || entry === null) return null;
  if (typeof entry !== "object" || Array.isArray(entry)) throw new ConfigError("`inventory` must be an object");
  const read = new Reader(entry as Record<string, unknown>, "the inventory");
  const flake = read.text("flake");
  if (flake === null) throw new ConfigError("The inventory needs a `flake`");
  return {
    flake,
    file: flake_path(read.text("file"), "file", read.owner) ?? "inventory.json",
    host: read.text("host"),
    push_ssh_key: read.text("push_ssh_key"),
    commit_author: read.text("commit_author") ?? "X-Nix <x-nix@localhost>",
    commit_message: read.text("commit_message") ?? "chore(inventory): update machines",
  };
}

function agent_keys(raw: unknown): Map<string, string> {
  if (raw === undefined || raw === null) return new Map();
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError("`agents` must map each host to its agent's public key line");
  const keys = new Map<string, string>();
  for (const [host, line] of Object.entries(raw)) {
    if (typeof line !== "string") throw new ConfigError(`The agent key of '${host}' must be its OpenSSH public key line`);
    try {
      parse_public_key(line);
    } catch (error) {
      if (error instanceof AgentKeyError) throw new ConfigError(`The agent key of '${host}' ${error.message}`);
      throw error;
    }
    keys.set(host, line);
  }
  return keys;
}

export function cache_settings(entry: unknown, index = 0): CacheSettings {
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
    host: read.text("host"),
    flake: read.text("flake") ?? "/etc/nixos",
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
    push_command: read.text("push_command"),
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

export function deployment_settings(entry: unknown, index = 0): DeploymentSettings {
  if (typeof entry !== "object" || entry === null) throw new ConfigError(`Deployment ${index + 1} must be an object`);
  const values = entry as Record<string, unknown>;
  const read = new Reader(values, `deployment ${typeof values.id === "string" ? `'${values.id}'` : index + 1}`);
  const id = read.text("id");
  if (id === null || !/^[A-Za-z0-9_-]+$/.test(id)) throw new ConfigError(`Deployment ${index + 1} needs an \`id\` of letters, digits, - and _`);
  const switch_agent = read.text("switch_agent");
  const eval_interval = read.duration("eval_interval", "1h");
  const cache_url = read.text("cache_url");
  const switch_from_cache = read.flag("switch_from_cache", false);
  if (switch_from_cache && cache_url === null) throw new ConfigError(`Deployment '${id}' sets switch_from_cache, which needs a \`cache_url\` to fetch from`);
  const flake = read.text("flake") ?? "/etc/nixos";
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
    configuration: read.text("configuration"),
    interval: read.duration("interval", "5m"),
    eval_agent: read.text("eval_agent"),
    eval_interval,
    retry_interval: Math.min(read.duration("retry_interval", "15m"), eval_interval),
    eval_timeout: read.duration("eval_timeout", "10m"),
    options_timeout: read.duration("options_timeout", "30m"),
    options_file: flake_path(read.text("options_file"), "options_file", read.owner),
    job_poll: read.duration("job_poll", "30s"),
    max_input_age: read.optional_duration("max_input_age"),
    drift_status: read.status("drift_status", "warning"),
    reboot_status: read.status("reboot_status", "warning"),
    require_sudo: read.flag("require_sudo", true),
    nix_bin: read.text("nix_bin") ?? "nix",
    rebuild_bin: read.text("rebuild_bin") ?? "nixos-rebuild",
    nix_args: read.list("nix_args", ["--extra-experimental-features", "nix-command flakes"]),
    rebuild_args: read.list("rebuild_args", []),
    build_host: read.text("build_host"),
    build_agent: read.text("build_agent") ?? switch_agent,
    build_args: read.list("build_args", ["--keep-going", "--print-build-logs"]),
    build_root_dir: read.text("build_root_dir"),
    cache_url,
    switch_agent,
    switch_from_cache,
    target_host: read.text("target_host"),
    auto_switch: read.flag("auto_switch", false),
    auto_switch_after: read.duration("auto_switch_after", "30m"),
    update_at: read.time_of_day("update_at"),
    build_at: read.time_of_day("build_at"),
    switch_wrapper: read.list("switch_wrapper", []),
    post_switch: read.text("post_switch"),
    pre_switch_checks: read.list("pre_switch_checks", []),
    magic_rollback: read.flag("magic_rollback", false),
    activation_timeout: read.duration("activation_timeout", "4m"),
    confirm_timeout: read.duration("confirm_timeout", "30s"),
    health_commands: read.list("health_commands", []),
    health_urls: read.urls("health_urls"),
    health_period: Math.max(1, read.duration("health_period", "5s")),
    health_timeout: read.duration("health_timeout", "2m"),
    build_progress: read.flag("build_progress", true),
    push_ssh_key: read.text("push_ssh_key"),
    commit_author: read.text("commit_author") ?? "X-Nix <x-nix@localhost>",
    commit_message: read.text("commit_message") ?? "chore(flake): update inputs",
    gc: gc_settings(values.gc, read.owner),
    boot: read.flag("boot", true),
    tags,
    pin,
    secrets: secret_settings(values.secrets, read.owner),
  };
  // A switch from the cache activates the store path directly, so it cannot run the guarded switch's checks and watchdog.
  const guarded = settings.pre_switch_checks.length > 0 || settings.magic_rollback || settings.health_commands.length > 0 || settings.health_urls.length > 0;
  if (switch_from_cache && guarded) {
    throw new ConfigError(`Deployment '${id}' sets switch_from_cache, which cannot be combined with pre_switch_checks, magic_rollback or health checks`);
  }
  return settings;
}

// A plain path inside the flake, or null when none is set.
function flake_path(path: string | null, key: string, owner: string): string | null {
  if (path !== null && !is_flake_path(path)) throw new ConfigError(`\`${key}\` of ${owner} must be a plain path inside the flake, such as x-nix/host.json`);
  return path;
}

function secret_settings(entries: unknown, owner: string): SecretSettings[] {
  if (entries === undefined || entries === null) return [];
  if (!Array.isArray(entries)) throw new ConfigError(`\`secrets\` of ${owner} must be a list`);
  const seen = new Set<string>();
  return entries.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new ConfigError(`Secret ${index + 1} of ${owner} must be an object`);
    const read = new Reader(entry as Record<string, unknown>, `secret ${index + 1} of ${owner}`);
    const name = read.text("name");
    if (name === null || !/^[A-Za-z0-9_.-]+$/.test(name)) throw new ConfigError(`Secret ${index + 1} of ${owner} needs a \`name\` of letters, digits, ., - and _`);
    if (seen.has(name)) throw new ConfigError(`Two secrets of ${owner} are named '${name}'`);
    seen.add(name);
    const source = read.text("source");
    if (source === null || !source.startsWith("/")) throw new ConfigError(`Secret '${name}' of ${owner} needs a \`source\` file as an absolute path`);
    const destination = read.text("destination") ?? `${key_folder}/${name}`;
    if (!is_key_destination(destination)) throw new ConfigError(`The \`destination\` of secret '${name}' of ${owner} must be a plain path under ${key_folder}`);
    const file_owner = read.text("owner") ?? "root";
    const group = read.text("group") ?? "root";
    if (!is_account_name(file_owner) || !is_account_name(group)) throw new ConfigError(`The \`owner\` and \`group\` of secret '${name}' of ${owner} must be account names`);
    const mode = read.text("mode") ?? "0400";
    if (!is_key_mode(mode)) throw new ConfigError(`The \`mode\` of secret '${name}' of ${owner} must be permission bits such as "0400"`);
    return { name, source, destination, owner: file_owner, group, mode };
  });
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
  };
}

// Reads one deployment's values, naming the deployment and key in every error.
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
