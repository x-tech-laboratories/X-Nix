// The operations the server asks an agent to perform, as plain data. The agent carries each one out in TypeScript and
// runs only plain programs with their arguments, never a shell script; the only shell left runs a command a person
// wrote into the config, such as a health check, exactly as written.

// ── Programs ─────────────────────────────────────────────────────────────────

// A program and its arguments.
export type Argv = string[];

// One program an operation runs; its stdout is thrown away when quiet.
export interface Step {
  argv: Argv;
  quiet?: boolean;
  // Runs it on another host over SSH, with the agent's NIX_SSHOPTS as nixos-rebuild uses them, under sudo when asked.
  ssh?: { host: string; sudo: boolean };
}

// ── Reads ────────────────────────────────────────────────────────────────────

// What is running, what was booted, and the system profile's generation.
export interface ProbeOperation {
  kind: "probe";
}

// The Nix store's disk, its garbage collection unit and timer, and every profile's generations.
export interface StoreProbeOperation {
  kind: "store_probe";
  unit: string;
  timer: string;
  store: string;
}

// The boot loader and its entries.
export interface BootProbeOperation {
  kind: "boot_probe";
  require_sudo: boolean;
}

// Every generation of the system profile.
export interface GenerationsOperation {
  kind: "generations";
}

// The Hydra build products a store path lists.
export interface ProductsOperation {
  kind: "products";
  store_path: string;
}

// A product's real path and size, once it is checked to be a regular file inside the store path.
export interface LocateOperation {
  kind: "locate";
  store_path: string;
  path: string;
}

// One piece of a file, as base64.
export interface PieceOperation {
  kind: "piece";
  path: string;
  offset: number;
  length: number;
}

// Whether a cache holds a store path and the host can fetch its whole closure.
export interface CacheHoldsOperation {
  kind: "cache_holds";
  nix: Argv;
  cache_url: string;
  store_path: string;
}

// The packages, sizes and derivations that differ between two system closures.
export interface ClosureDiffOperation {
  kind: "closure_diff";
  nix: Argv;
  from: string;
  to: string;
}

// ── Plain programs ───────────────────────────────────────────────────────────

// Runs each program in turn, stopping at the first that fails, after printing an optional note.
export interface ProgramsOperation {
  kind: "programs";
  note?: string;
  steps: Step[];
}

// Sends a Wake-on-LAN magic packet from this host.
export interface WakeOperation {
  kind: "wake";
  mac: string;
  broadcast: string;
  port: number;
}

// ── Wrappers ─────────────────────────────────────────────────────────────────

// Holds an inhibitor, a program that blocks idle and sleep until its stdin closes, for as long as the operation runs.
export interface KeptAwakeOperation {
  kind: "kept_awake";
  inhibitor: Step;
  // Printed when the inhibitor cannot be held, before the operation runs anyway.
  warning: string;
  operation: Operation;
}

// Stops the operation once it runs past its time, ending with the status `timeout` gives.
export interface TimedOperation {
  kind: "timed";
  seconds: number;
  operation: Operation;
}

// ── Deployments ──────────────────────────────────────────────────────────────

// The nix command a deployment or cache runs, with its arguments.
export interface NixSettings {
  nix: Argv;
}

// Evaluates the host's toplevel and reads the flake's metadata, printing each one's result after marker lines.
export interface EvaluateOperation extends NixSettings {
  kind: "evaluate";
  flake: string;
  // The nixosConfigurations attribute; the evaluating host's own hostname when null.
  attribute: string | null;
  refresh: boolean;
}

// Realises the host's closure without activating it, unless the cache already holds it.
export interface BuildOperation extends NixSettings {
  kind: "build";
  flake: string;
  attribute: string | null;
  args: string[];
  refresh: boolean;
  // The link that roots the build, replaced by each build; none keeps no root.
  root_link: string | null;
  cache_url: string | null;
}

// What the watchdog and the guarded switch need to know to roll a switch back.
export interface SwitchWatch {
  token: string;
  // The mode the previous system is activated in when it is rolled back to.
  rollback_mode: "switch" | "test";
  require_sudo: boolean;
  activation_timeout: number;
  confirm_window: number;
  // Whether a switch nobody confirms is rolled back, rather than kept.
  magic_rollback: boolean;
  health_commands: string[];
  health_period: number;
  health_timeout: number;
  // The reasons the watchdog gives, already worded.
  activation_reason: string;
  unconfirmed_reason: string;
}

// Activates a new system, after pre-switch checks and under a watchdog when they are set, then runs post_switch.
export interface SwitchOperation {
  kind: "switch";
  mode: "switch" | "boot" | "test" | "dry-activate";
  // What failed activations are called, such as "nixos-rebuild switch".
  activation_name: string;
  // Fetches the closure before the watchdog starts, so a slow download never counts against activation_timeout; absent
  // from an older server's switch. The steps fetch it again for an agent too old to know these, at no cost once fetched.
  fetch_steps?: Step[];
  steps: Step[];
  // Runs after the activation whatever it returned, without changing the switch's status.
  post_switch: Argv | null;
  pre_switch_checks: string[];
  watch: SwitchWatch | null;
}

// Clones a github: flake, updates its lock, and pushes a commit back.
export interface GithubUpdateOperation extends NixSettings {
  kind: "github_update";
  ssh_url: string;
  branch: string | null;
  ssh_key: string;
  author_name: string;
  author_email: string;
  message: string;
}

// Writes the file that confirms a guarded switch to its watchdog.
export interface ConfirmSwitchOperation {
  kind: "confirm_switch";
  token: string;
}

// Writes the file that tells a guarded switch's watchdog to roll back, with why.
export interface SignalRollbackOperation {
  kind: "signal_rollback";
  token: string;
  reason: string;
}

// ── Caches ───────────────────────────────────────────────────────────────────

export interface CacheTarget {
  name: string;
  installable: string;
  // The attribute of the flake, for one evaluation of every target.
  attribute: string;
  // The link that roots its build, when there is a build_root_dir.
  link: string | null;
  // The closure list kept beside the link once the target is kept only in the cache.
  list: string | null;
}

export interface CacheSettings extends NixSettings {
  flake: string;
  cache_url: string;
  // The signing keys of upstream caches, whose paths Attic never stores.
  upstream_keys: string[];
  refresh: boolean;
  build_root_dir: string | null;
  build_args: string[];
  // A command a person wrote, run with a store path appended.
  push_command: string | null;
}

// Evaluates every target, says what the cache lacks of each, then reads the flake's metadata.
export interface CacheCheckOperation {
  kind: "cache_check";
  cache: CacheSettings;
  targets: CacheTarget[];
}

// Builds one target, pushes it, then checks it.
export interface CacheBuildOperation {
  kind: "cache_build";
  cache: CacheSettings;
  target: CacheTarget;
}

// Pushes one target's store path, then checks it.
export interface CachePushOperation {
  kind: "cache_push";
  cache: CacheSettings;
  target: CacheTarget;
  path: string;
}

// Evaluates every target in one pass of nix-eval-jobs, builds each as soon as it is evaluated, then checks them all.
export interface CacheBuildAllOperation {
  kind: "cache_build_all";
  cache: CacheSettings;
  targets: CacheTarget[];
  eval_jobs: string;
  eval_workers: number;
  // The Nix expression of every target's derivation, keyed t0, t1 and so on in the order of the targets.
  expression: string;
}

// ── Provisioning ─────────────────────────────────────────────────────────────

// Installs a flake's configuration on a new host with nixos-anywhere, placing the agent key that arrives on stdin.
export interface InstallOperation {
  kind: "install";
  // What the install installs, kept so the job says so.
  record: Record<string, unknown> & { flake: string; configuration: string; user: string; address: string; port: number };
  tool: string;
  ssh_key: string;
  // Where the key goes on the new system, or null when no key is placed.
  agent_key_path: string | null;
  generate_hardware_config: boolean;
  stop_after_partitioning: boolean;
  extra_args: string[];
}

// Builds install media with a link that roots it, then prints the store path.
export interface MediaOperation extends NixSettings {
  kind: "media";
  // What the build makes, kept so the job says so.
  record: { flake: string; configuration: string; format: string };
  media_root_dir: string;
  link: string;
  expression: string;
}

// ── Operations ───────────────────────────────────────────────────────────────

export type Operation =
  | ProbeOperation | StoreProbeOperation | BootProbeOperation | GenerationsOperation | ProductsOperation | LocateOperation | PieceOperation
  | CacheHoldsOperation | ClosureDiffOperation | ProgramsOperation | WakeOperation | KeptAwakeOperation | TimedOperation
  | EvaluateOperation | BuildOperation | SwitchOperation | GithubUpdateOperation | ConfirmSwitchOperation | SignalRollbackOperation
  | CacheCheckOperation | CacheBuildOperation | CachePushOperation | CacheBuildAllOperation | InstallOperation | MediaOperation;

export type OperationKind = Operation["kind"];

export const operation_kinds: OperationKind[] = [
  "probe", "store_probe", "boot_probe", "generations", "products", "locate", "piece", "cache_holds", "closure_diff", "programs", "wake",
  "kept_awake", "timed", "evaluate", "build", "switch", "github_update", "confirm_switch", "signal_rollback", "cache_check", "cache_build",
  "cache_push", "cache_build_all", "install", "media",
];

// Whether a value names an operation this protocol knows; the agent checks each field as it reads it.
export function is_operation(value: unknown): value is Operation {
  if (typeof value !== "object" || value === null) return false;
  return (operation_kinds as string[]).includes(String((value as { kind?: unknown }).kind));
}

// The operation a job's command holds, or null for a job from before operations.
export function operation_of(command: string): Operation | null {
  try {
    const value: unknown = JSON.parse(command);
    return is_operation(value) ? value : null;
  } catch {
    return null;
  }
}

// The operation inside any wrappers.
export function innermost(operation: Operation): Operation {
  let current = operation;
  while (current.kind === "kept_awake" || current.kind === "timed") current = current.operation;
  return current;
}

// ── Nix ──────────────────────────────────────────────────────────────────────

// A Nix string literal holding the text as it is.
export function nix_string(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("${", "\\${")}"`;
}

// The host's system closure in the flake.
export function toplevel(flake: string, attribute: string): string {
  return `${flake}#nixosConfigurations.${nix_string(attribute)}.config.system.build.toplevel`;
}

// Whether a value is a top-level store path, the only kind handed to a program as one.
export function is_store_path(value: string): boolean {
  return /^\/nix\/store\/[0-9a-z]{32}-[A-Za-z0-9+._?=-]+$/.test(value);
}

// Asks a cache afresh: nix remembers a path the cache lacked for an hour, so one checked before its push would read as
// missing long after.
export const fresh_lookup = ["--option", "narinfo-cache-negative-ttl", "0"];

// ── Showing ──────────────────────────────────────────────────────────────────

// A program and its arguments as one line a person can read and paste into a shell.
export function show_argv(argv: Argv): string {
  return argv.map((word) => (word !== "" && /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'"'"'`)}'`)).join(" ");
}

// ── Switch folders ───────────────────────────────────────────────────────────

const watch_folder_parent = "/tmp";
export const watch_folder_prefix = "x-nix-switch-";

// The folder the watchdog and X-Nix share for one switch.
export function watch_folder(token: string): string {
  if (!/^[a-f0-9]+$/.test(token)) throw new Error(`'${token}' is not a switch token`);
  return `${watch_folder_parent}/${watch_folder_prefix}${token}`;
}

export function watch_folders_parent(): string {
  return watch_folder_parent;
}

// ── Markers ──────────────────────────────────────────────────────────────────

// Starts each line an evaluation prints for the server, naming the command and stream that follow.
export const eval_mark = "@@x-nix-eval";

// Starts each line a guarded switch prints for the server rather than for a person.
export const switch_mark = "@@x-nix-switch";

// Starts every line a cache operation reports on, so a build's own output is never read as a report.
export const report_mark = "@@x-nix-cache";

// The name the flake's metadata is reported under, never a target's.
export const flake_report_name = "@flake";

// Starts each line a closure diff prints for the server, naming the section that follows.
export const diff_mark = "@@x-nix-diff";

// Surrounds the hardware configuration an install generated.
export const hardware_mark = "@@x-nix-hardware-config";

// Starts the line naming the store path a media build made.
export const media_mark = "@@x-nix-media";

// The exit status `timeout` gives a run it stopped.
export const timed_out_exit_code = 124;

// The exit status sh gives a program it cannot find, which an operation also gives for a missing tool.
export const missing_tool_exit_code = 127;
