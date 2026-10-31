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
export type JobKind = "eval" | "update" | "build" | "switch" | "reboot" | "collect" | "check" | "build-target" | "push" | "next-boot" | "install" | "media" | "build-all";
export type JobState = "running" | "succeeded" | "failed";
export type ActionId = "update" | "build" | "switch" | "reboot" | "collect";

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
