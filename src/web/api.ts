// Calls the server's JSON API and names the shapes it answers with.

import { create_api } from "@x-tech-laboratories/x-libs/web/api";
import { create_accounts_client } from "@x-tech-laboratories/x-libs/web/accounts";
import { backup_client } from "@x-tech-laboratories/x-libs/web/backups";
import { LoginNeeded } from "@x-tech-laboratories/x-libs/web/states";
import { create_watch } from "@x-tech-laboratories/x-libs/web/watch";

// The session has lapsed or never began, so the page asks for the password.
export { LoginNeeded };

// ── Answers ──────────────────────────────────────────────────────────────────

export interface Health {
  name: string;
  version: string;
  server_name: string;
  started_epoch: number;
}

export type Status = "online" | "info" | "unavailable" | "warning" | "failed";
export type EventLevel = "info" | "warning" | "error";
export type JobKind =
  | "eval" | "update" | "build" | "switch" | "boot" | "test" | "dry-activate" | "rollback" | "diff" | "reboot" | "collect" | "check" | "build-target"
  | "build-all" | "push" | "next-boot" | "install" | "media";
export type JobState = "running" | "succeeded" | "failed";
export type ActionId = "build" | "switch" | "reboot" | "boot" | "test" | "dry-activate";
export type HostActionId = "collect" | "reboot";

export interface Message {
  level: EventLevel;
  text: string;
}

export interface Reading {
  status: Status;
  checked_epoch: number;
  messages: Message[];
  hostname: string | null;
  current: string | null;
  booted: string | null;
  version: string | null;
  generation: number | null;
  switched_epoch: number | null;
  up_to_date: boolean | null;
  reboot_required: boolean | null;
  flake_reachable: boolean | null;
}

export interface BootEntry {
  id: string;
  title: string;
  default: boolean;
  next: boolean;
}

export interface Boot {
  loader: "systemd-boot" | "grub" | "efi" | "none";
  entries: BootEntry[];
  default: string | null;
  next: string | null;
}

export interface Profile {
  path: string;
  generation: number | null;
  count: number;
  oldest_epoch: number | null;
}

export interface StoreReading {
  status: Status;
  checked_epoch: number;
  messages: Message[];
  store: string;
  size_bytes: number | null;
  used_bytes: number | null;
  avail_bytes: number | null;
  used_percent: number | null;
  paths: number | null;
  roots: number | null;
  profiles: Profile[];
  generations: number | null;
  oldest_generation_epoch: number | null;
  collecting: boolean;
  timer_loaded: boolean;
  timer_active: boolean;
  next_epoch: number | null;
}

export interface Collection {
  epoch: number;
  succeeded: boolean;
  deleted: number | null;
  freed_bytes: number | null;
  error: string | null;
}

export interface Evaluation {
  evaluated_epoch: number | null;
  target: string | null;
  eval_error: string | null;
  eval_unreachable: boolean;
  metadata_error: string | null;
  flake_revision: string | null;
  flake_last_modified_epoch: number | null;
  oldest_input: string | null;
  inputs_last_modified_epoch: number | null;
  drift_since_epoch: number | null;
  scheduled: Partial<Record<"build", number>>;
  last_diff: ClosureDiff | null;
}

export interface PackageChange {
  name: string;
  from: string[];
  to: string[];
  size_delta_bytes: number | null;
}

export interface ClosureDiff {
  from: string;
  to: string;
  checked_epoch: number;
  job_id: number | null;
  built: boolean;
  added: PackageChange[];
  removed: PackageChange[];
  changed: PackageChange[];
  resized: PackageChange[];
  closure_before_bytes: number | null;
  closure_after_bytes: number | null;
  derivation_diff: string | null;
  note: string | null;
  error: string | null;
}

export interface DiffOutcome {
  diff: ClosureDiff | null;
  message: string | null;
}

export interface Generation {
  generation: number;
  created_epoch: number | null;
  path: string;
  version: string | null;
  current: boolean;
  booted: boolean;
  profile: boolean;
}

export interface GenerationSize {
  generation: number;
  closure_size_bytes: number;
}

export interface ClosurePath {
  path: string;
  nar_size: number;
  closure_size: number;
  references: number[];
}

export interface ClosureTree {
  root: string;
  paths: ClosurePath[];
}

// A build's live progress, as the server reads it from nix's structured log.
export interface BuildProgress {
  builds_done: number;
  builds_failed: number;
  builds_expected: number | null;
  downloads_done: number;
  downloads_expected: number | null;
  activities: Record<string, { type: number; name: string; phase: string | null }>;
}

export interface Job {
  id: number;
  deployment_id: string;
  kind: JobKind;
  command: string;
  agent: string | null;
  state: JobState;
  exit_code: number | null;
  error: string | null;
  progress: string | null;
  live: string | null;
  trigger: string;
  started_epoch: number;
  finished_epoch: number | null;
}

export interface JobWithOutput extends Job {
  output: string;
}

export interface ActionView {
  id: ActionId;
  label: string;
  refusal: string | null;
  confirm: string | null;
}

export interface Deployment {
  id: string;
  name: string;
  host: string | null;
  flake: string;
  flake_id: string | null;
  host_name: string | null;
  cache_id: string | null;
  evaluated_by: string | null;
  configuration: string | null;
  tags: string[];
  pin: string | null;
  configured_pin: string | null;
  pin_overridden: boolean;
  sync_pending: boolean;
  agents: { eval: string | null; build: string | null; switch: string | null };
  // The hosts Build runs on, most preferred first.
  build_agents: string[];
  schedule: { build: string | null };
  auto_switch: boolean;
  direct_on: "host" | "server" | "ranked";
  reading: Reading | null;
  evaluation: Evaluation;
  evaluating: boolean;
  running_job: Job | null;
  actions: ActionView[];
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
    close_nix_lock_holders: boolean;
  };
}

export interface HostReading {
  status: Status;
  checked_epoch: number;
  store: StoreReading | null;
  boot: Boot | null;
}

export interface Host {
  name: string;
  display_name: string;
  own: boolean;
  agent_key: boolean;
  agent: { agent_version: string; connected_epoch: number } | null;
  wake: { mac: string; broadcast: string; via: string | null; timeout: number } | null;
  keep_awake: boolean;
  interval: number;
  gc: { unit: string; timer: string; store: string; max_age: number; warning: number | null; threshold: number | null; command: string; collect_at: string | null } | null;
  boot: boolean;
  reading: HostReading | null;
  state: { last_collection: Collection | null };
  running_job: Job | null;
  actions: { id: HostActionId; label: string; refusal: string | null; confirm: string | null }[];
  next_boot_refusal: string | null;
  system: { current: string | null; booted: string | null; version: string | null; reboot_required: boolean | null } | null;
  deployments: { id: string; name: string }[];
}

export type FleetActionId = "build" | "switch" | "reboot";
export type FleetHostState = "queued" | "running" | "verifying" | "succeeded" | "failed" | "skipped";
export type FleetRunState = "running" | "succeeded" | "failed" | "stopped";

export interface FleetHost {
  deployment_id: string;
  name: string;
  stage: number;
  state: FleetHostState;
  job_id: number | null;
  message: string | null;
  started_epoch: number | null;
  finished_epoch: number | null;
}

export interface FleetRun {
  id: number;
  // Runs kept in the history may be updates.
  action: FleetActionId | "update";
  selector: string;
  staged: boolean;
  stages: string[];
  parallel: number;
  state: FleetRunState;
  current_stage: number;
  stop_requested: boolean;
  started_epoch: number;
  finished_epoch: number | null;
  message: string | null;
  hosts: FleetHost[];
}

export interface Fleet {
  parallel: number;
  stages: string[];
  sync_timeout: number;
  tags: string[];
  runs: FleetRun[];
}

export interface FleetOutcome {
  ok: boolean;
  message: string;
  run: FleetRun | null;
}

export type CacheActionId = "build" | "push";

export interface TargetRow {
  name: string;
  target: string | null;
  built: boolean | null;
  local: boolean;
  own: number | null;
  missing_count: number;
  missing: string[];
  pushed_ok: boolean;
  pushed: string;
  status: Status;
  summary: string;
}

export interface BuildAllOutcome {
  job_id: number;
  finished_epoch: number;
  results: { name: string; result: string; seconds: number | null }[];
}

export interface CacheReading {
  status: Status;
  checked_epoch: number;
  messages: Message[];
  revision: string | null;
  rows: TargetRow[];
  build_all?: BuildAllOutcome | null;
}

export interface CacheServerReading {
  status: Status;
  checked_epoch: number;
  messages: Message[];
  info: Record<string, string> | null;
  healthy: boolean | null;
  size_bytes: number | null;
  metrics: { name: string; value: number }[];
}

export interface Cache {
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
  build_at: string | null;
  scheduled_build: number | null;
  deployments: { id: string; name: string }[];
  can_push: boolean;
  build_all_refusal: string | null;
  reading: CacheReading | null;
  server_urls: { info: string | null; health: string | null; metrics: string | null };
  server: CacheServerReading | null;
  running_job: Job | null;
  targets: { name: string; installable: string; build_link: string | null; kept_only_in_cache: boolean; refusals: Record<CacheActionId, string | null> }[];
}

export interface LockedInput {
  name: string;
  source: string | null;
  follows: string | null;
  revision: string | null;
  last_modified_epoch: number | null;
}

export interface FlakeReading {
  status: Status;
  checked_epoch: number;
  messages: Message[];
  revision: string | null;
  last_modified_epoch: number | null;
  oldest_input: string | null;
  inputs_last_modified_epoch: number | null;
  inputs: LockedInput[];
  metadata_error: string | null;
}

export interface UpdateOutcome {
  job_id: number;
  succeeded: boolean;
  finished_epoch: number;
  summary: string;
}

export interface Flake {
  id: string;
  name: string;
  host: string | null;
  url: string;
  interval: number;
  update_at: string | null;
  scheduled_update: number | null;
  update_refusal: string | null;
  pushes_to: string | null;
  commit_author: string;
  commit_message: string;
  max_input_age: number | null;
  reading: FlakeReading | null;
  last_update: UpdateOutcome | null;
  running_job: Job | null;
  deployments: { id: string; name: string }[];
  caches: { id: string; name: string }[];
}

export interface BuildProduct {
  type: string;
  subtype: string;
  path: string;
  name: string;
  size_bytes: number | null;
}

export interface BuildRecord {
  id: number;
  job_id: number;
  owner_id: string;
  target: string;
  agent: string | null;
  store_path: string | null;
  succeeded: boolean;
  started_epoch: number;
  finished_epoch: number;
  products: BuildProduct[];
}

export interface BuildsAnswer {
  builds: BuildRecord[];
  targets: { owner_id: string; target: string }[];
}

// A reading taken over time, kept for charts.
export type Metric = "store_used_percent" | "store_used_bytes" | "store_paths" | "collection_freed_bytes" | "cache_size_bytes";

export interface Sample {
  owner_id: string;
  metric: Metric;
  epoch: number;
  value: number;
}

export interface EventRow {
  id: number;
  epoch: number;
  level: EventLevel;
  message: string;
}

// A host with a declared agent key, and its agent when connected.
export interface AgentEntry {
  host: string;
  status: { host: string; agent_version: string; connected_epoch: number } | null;
}

export type MediaFormat = "iso" | "netboot" | "kexec";

// What an install job installs, as its command records it.
export interface InstallRecord {
  host: string;
  address: string;
  user: string;
  port: number;
  flake: string;
  configuration: string;
  agent: string | null;
  stop_after_partitioning: boolean;
  generate_hardware_config: boolean;
  public_line: string | null;
  agent_key_path: string;
}

export interface InstallView {
  job: Job;
  record: InstallRecord | null;
  hardware_config: string | null;
  key_accepted: boolean;
  snippets: { config_json: string; module_nix: string; host_nix: string } | null;
}

export interface MediaView {
  job: Job;
  format: MediaFormat | null;
  flake: string | null;
  configuration: string | null;
  store_path: string | null;
  files: { path: string; size: number }[] | null;
}

export interface ProvisionedAgent {
  host: string;
  public_line: string;
  job_id: number;
  added_epoch: number;
  fingerprint: string;
  overridden: boolean;
}

export interface Provisioning {
  own_host: string;
  install_refusal: string | null;
  install_agent: string | null;
  ssh_key: string | null;
  agent_key_path: string;
  media_root_dir: string;
  agent_snippet: string;
  installs: InstallView[];
  media: MediaView[];
  provisioned_agents: ProvisionedAgent[];
}

export interface ActionOutcome {
  ok: boolean;
  message: string;
  job_id: number | null;
}

// ── Requests ─────────────────────────────────────────────────────────────────

export const api = create_api({ open_paths: ["/api/login"] });

// The state database's backups, for the Backups page.
export const backups = backup_client(api);

// Signing in and out, and the account pages.
export const accounts = create_accounts_client();

// Bumped whenever the server says something changed, so every open view loads again.
export const changes = create_watch();
