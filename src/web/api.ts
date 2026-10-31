// Calls the server's JSON API and names the shapes it answers with.

// The session has lapsed or never began, so the page asks for the password.
export class LoginNeeded extends Error {}

export class ApiError extends Error {
  status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.status = status;
  }
}

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
  | "build-all" | "push" | "next-boot" | "install" | "media" | "secrets" | "options" | "configure" | "inventory";
export type JobState = "running" | "succeeded" | "failed";
export type ActionId = "update" | "build" | "switch" | "reboot" | "collect" | "boot" | "test" | "dry-activate";

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
  store: StoreReading | null;
  boot: Boot | null;
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
  scheduled: Partial<Record<"update" | "build", number>>;
  last_collection: Collection | null;
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
  configuration: string | null;
  tags: string[];
  pin: string | null;
  configured_pin: string | null;
  pin_overridden: boolean;
  sync_pending: boolean;
  agents: { eval: string | null; build: string | null; switch: string | null };
  schedule: { update: string | null; build: string | null };
  auto_switch: boolean;
  switch_from_cache: boolean;
  gc: { unit: string; timer: string; store: string; max_age: number; warning: number | null; threshold: number | null; command: string } | null;
  reading: Reading | null;
  evaluation: Evaluation;
  evaluating: boolean;
  running_job: Job | null;
  actions: ActionView[];
  next_boot_refusal: string | null;
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

export type FleetActionId = "update" | "build" | "switch" | "reboot";
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
  action: FleetActionId;
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
  host: string | null;
  flake: string;
  cache_url: string;
  interval: number;
  can_push: boolean;
  build_all_refusal: string | null;
  reading: CacheReading | null;
  server_urls: { info: string | null; health: string | null; metrics: string | null };
  server: CacheServerReading | null;
  running_job: Job | null;
  targets: { name: string; installable: string; build_link: string | null; kept_only_in_cache: boolean; refusals: Record<CacheActionId, string | null> }[];
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

export interface EventRow {
  id: number;
  epoch: number;
  level: EventLevel;
  message: string;
}

export interface Machine {
  name: string;
  tags: string[];
  roles: string[];
}

export interface InventoryView {
  configured: boolean;
  flake: string | null;
  file: string | null;
  refusal: string | null;
  present: boolean;
  machines: Machine[];
  hash: string | null;
  error: string | null;
  suggestions: string[];
}

export type OptionSource = "nixos" | "home-manager";

export type SimpleKind =
  | { kind: "boolean" }
  | { kind: "string" }
  | { kind: "integer"; minimum: number | null; maximum: number | null }
  | { kind: "enum"; choices: string[] };

export type SettingValue = boolean | number | string;

export interface OptionView {
  name: string;
  source: OptionSource;
  type: string;
  default: string | null;
  example: string | null;
  description: string;
  declared_in: string[];
  read_only: boolean;
  form: SimpleKind | null;
}

export interface PackageEntry {
  attribute: string;
  name: string;
  version: string;
  description: string;
}

export interface CatalogInfo {
  key: string;
  nixpkgs: string;
  revision: string | null;
  generated_epoch: number;
  counts: { nixos: number; home_manager: number; packages: number };
  errors: string[];
}

export interface CatalogView {
  id: string;
  name: string;
  host: string | null;
  info: CatalogInfo | null;
  running_job: Job | null;
}

export interface SearchAnswer<Entry> extends CatalogView {
  total: number;
  entries: Entry[];
}

export interface SettingsView {
  file: string | null;
  refusal: string | null;
  present: boolean;
  values: Record<string, SettingValue>;
  import_line: string | null;
  error: string | null;
}

export type KeyCondition = "current" | "stale" | "missing" | "unknown";

// One secret with where it goes and whether the host holds it, never its value.
export interface SecretView {
  name: string;
  source: string;
  destination: string;
  owner: string;
  group: string;
  mode: string;
  source_size: number | null;
  source_error: string | null;
  on_host: KeyCondition;
  difference: string | null;
}

export interface SecretsView {
  id: string;
  name: string;
  host: string | null;
  count: number;
  reading: { checked_epoch: number; error: string | null; secrets: SecretView[] } | null;
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
  hardware_config_path: string | null;
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

export async function api<Answer>(path: string, method: "GET" | "POST" = "GET", body: unknown = undefined): Promise<Answer> {
  const init: RequestInit = body === undefined
    ? { method, headers: { accept: "application/json" } }
    : { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body) };
  const response = await fetch(path, init);
  if (response.status === 401 && path !== "/api/login") throw new LoginNeeded("Log in first.");
  if (response.status === 204) return undefined as Answer;
  const answer = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(answer?.message ?? answer?.error ?? `${response.status} ${response.statusText}`, response.status);
  return answer as Answer;
}
