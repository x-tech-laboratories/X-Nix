// Reads the config file: the deployments X-Nix watches, each a NixOS host and the flake that describes it.

// ── Imports ──────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";

import { parse_duration } from "./durations.ts";

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
  target_host: string | null;
  auto_switch: boolean;
  auto_switch_after: number;
  update_at: TimeOfDay | null;
  build_at: TimeOfDay | null;
  switch_wrapper: string[];
  post_switch: string | null;
  push_ssh_key: string | null;
  commit_author: string;
  commit_message: string;
  // Null when the store is not watched.
  gc: GcSettings | null;
  // Whether the host's boot entries are read, and its next boot may be picked.
  boot: boolean;
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
}

export interface Config {
  deployments: DeploymentSettings[];
  caches: CacheSettings[];
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
  return { deployments: parsed, caches: parsed_caches };
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
  };
}

export function deployment_settings(entry: unknown, index = 0): DeploymentSettings {
  if (typeof entry !== "object" || entry === null) throw new ConfigError(`Deployment ${index + 1} must be an object`);
  const values = entry as Record<string, unknown>;
  const read = new Reader(values, `deployment ${typeof values.id === "string" ? `'${values.id}'` : index + 1}`);
  const id = read.text("id");
  if (id === null || !/^[A-Za-z0-9_-]+$/.test(id)) throw new ConfigError(`Deployment ${index + 1} needs an \`id\` of letters, digits, - and _`);
  const switch_agent = read.text("switch_agent");
  const eval_interval = read.duration("eval_interval", "1h");
  return {
    id,
    name: read.text("name") ?? id,
    host: read.text("host"),
    flake: read.text("flake") ?? "/etc/nixos",
    configuration: read.text("configuration"),
    interval: read.duration("interval", "5m"),
    eval_agent: read.text("eval_agent"),
    eval_interval,
    retry_interval: Math.min(read.duration("retry_interval", "15m"), eval_interval),
    eval_timeout: read.duration("eval_timeout", "10m"),
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
    cache_url: read.text("cache_url"),
    switch_agent,
    target_host: read.text("target_host"),
    auto_switch: read.flag("auto_switch", false),
    auto_switch_after: read.duration("auto_switch_after", "30m"),
    update_at: read.time_of_day("update_at"),
    build_at: read.time_of_day("build_at"),
    switch_wrapper: read.list("switch_wrapper", []),
    post_switch: read.text("post_switch"),
    push_ssh_key: read.text("push_ssh_key"),
    commit_author: read.text("commit_author") ?? "X-Nix <x-nix@localhost>",
    commit_message: read.text("commit_message") ?? "chore(flake): update inputs",
    gc: gc_settings(values.gc, read.owner),
    boot: read.flag("boot", true),
  };
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
