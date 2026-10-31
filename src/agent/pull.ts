// Pull mode: once the server has been unreachable for `after`, the agent deploys from Git on its own. Every `interval` it
// asks its remotes, in order, for the head of their branch, and switches to a revision it has not deployed yet with
// `nixos-rebuild switch --flake`, as a long run that outlives the agent. The first revision it sees is only noted, so
// starting pull mode never switches by itself. Each switch is logged and kept in `pull.json` until the server, once
// back, has taken its report into the deployment's job history.

// ── Imports ──────────────────────────────────────────────────────────────────

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { PullReport, RunResult } from "../shared/agent_protocol.ts";
import { parse_duration } from "../shared/durations.ts";
import { run_command } from "./commands.ts";
import type { LongRuns } from "./long_runs.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

export interface PullRemote {
  // A Git URL: https://, http://, ssh://, git:// or file://, optionally with nix's git+ in front.
  url: string;
  branch: string;
}

export interface PullSettings {
  // Asked in order; the first that answers gives the revision.
  remotes: PullRemote[];
  // How long the server must have been unreachable before the agent deploys on its own.
  after: number;
  interval: number;
  // The nixosConfigurations attribute to switch to.
  configuration: string;
  rebuild_bin: string;
  rebuild_args: string[];
  require_sudo: boolean;
  git_bin: string;
}

export class PullConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PullConfigError";
  }
}

// What the agent keeps between runs: the revision deployed last and the switches not yet reported.
interface PullRecord {
  run_id: string;
  remote: string;
  branch: string;
  revision: string;
  command: string;
  started_epoch: number;
  finished_epoch: number | null;
  exit_code: number | null;
}

interface PullState {
  revision: string | null;
  records: PullRecord[];
}

export interface PullerOptions {
  // Whether a session with the server is open now.
  connected: () => boolean;
  // Asks the open session to send the reports not yet received.
  report: () => void;
  log: (line: string) => void;
  // Runs a short command, which tests replace.
  run?: (command: string, timeout_in_seconds: number) => Promise<RunResult>;
  // The time in milliseconds, which tests set.
  now?: () => number;
}

const remote_schemes = /^(git\+)?(https?|ssh|git|file):\/\//;
const ls_remote_timeout_in_seconds = 60;
const report_output_limit_in_bytes = 64 * 1024;

// ── Reading settings ─────────────────────────────────────────────────────────

// The pull settings from their JSON, with the host's own name as the default configuration.
export function parse_pull_settings(raw: unknown, host: string): PullSettings {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new PullConfigError("The pull settings must be an object");
  const values = raw as Record<string, unknown>;
  if (!Array.isArray(values.remotes) || values.remotes.length === 0) throw new PullConfigError("The pull settings need `remotes`, a list of { url, branch }");
  const remotes = values.remotes.map((entry, index): PullRemote => {
    const remote = (typeof entry === "string" ? { url: entry } : entry) as Record<string, unknown> | null;
    const url = remote?.url;
    const branch = remote?.branch ?? "main";
    if (typeof url !== "string" || !remote_schemes.test(url)) throw new PullConfigError(`Remote ${index + 1} needs a \`url\` starting with https://, ssh://, git:// or file://`);
    if (typeof branch !== "string" || !/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith("-")) throw new PullConfigError(`The branch of remote ${index + 1} must be a branch name`);
    return { url, branch };
  });
  const text = (key: string, fallback: string) => {
    const value = values[key] ?? fallback;
    if (typeof value !== "string" || value === "") throw new PullConfigError(`\`${key}\` of the pull settings must be text`);
    return value;
  };
  const duration = (key: string, fallback: string) => {
    try {
      return parse_duration(values[key] ?? fallback, key);
    } catch (error) {
      throw new PullConfigError(`${(error as Error).message} in the pull settings`);
    }
  };
  const rebuild_args = values.rebuild_args ?? [];
  if (!Array.isArray(rebuild_args) || !rebuild_args.every((item) => typeof item === "string")) throw new PullConfigError("`rebuild_args` of the pull settings must be a list of text");
  if (values.require_sudo !== undefined && typeof values.require_sudo !== "boolean") throw new PullConfigError("`require_sudo` of the pull settings must be true or false");
  return {
    remotes,
    after: duration("after", "15m"),
    interval: Math.max(30, duration("interval", "5m")),
    configuration: text("configuration", host),
    rebuild_bin: text("rebuild_bin", "nixos-rebuild"),
    rebuild_args,
    require_sudo: (values.require_sudo as boolean | undefined) ?? true,
    git_bin: text("git_bin", "git"),
  };
}

// ── Commands ─────────────────────────────────────────────────────────────────

// Quotes a word for sh, leaving plain words as they are.
function shell_quote(word: string): string {
  if (word !== "" && /^[\w@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replaceAll("'", `'"'"'`)}'`;
}

// The revision a remote's branch is at, from what `git ls-remote` prints.
export function parse_ls_remote(stdout: string, branch: string): string | null {
  for (const line of stdout.split("\n")) {
    const [revision, ref] = line.trim().split(/\s+/);
    if (ref === `refs/heads/${branch}` && /^[0-9a-f]{40}$/.test(revision)) return revision;
  }
  return null;
}

export function ls_remote_command(settings: PullSettings, remote: PullRemote): string {
  return `${shell_quote(settings.git_bin)} ls-remote --exit-code ${shell_quote(remote.url.replace(/^git\+/, ""))} ${shell_quote(`refs/heads/${remote.branch}`)}`;
}

// The flake reference of the branch fixed at the revision.
export function pulled_flake(remote: PullRemote, revision: string): string {
  const url = remote.url.startsWith("git+") ? remote.url : `git+${remote.url}`;
  return `${url}${url.includes("?") ? "&" : "?"}ref=${encodeURIComponent(`refs/heads/${remote.branch}`)}&rev=${revision}`;
}

export function pull_switch_command(settings: PullSettings, remote: PullRemote, revision: string): string {
  const sudo = settings.require_sudo ? "sudo -n " : "";
  const flake = `${pulled_flake(remote, revision)}#${settings.configuration}`;
  return [`${sudo}${settings.rebuild_bin} switch --flake ${shell_quote(flake)}`, ...settings.rebuild_args.map(shell_quote)].join(" ");
}

// ── Puller ───────────────────────────────────────────────────────────────────

export class Puller {
  private readonly settings: PullSettings;
  private readonly runs: LongRuns;
  private readonly file: string;
  private readonly options: PullerOptions;
  private readonly run: (command: string, timeout_in_seconds: number) => Promise<RunResult>;
  private readonly now: () => number;
  // Since when, in milliseconds, no session has been open; the agent's start counts as the first.
  private disconnected_since: number | null;
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;

  constructor(settings: PullSettings, runs: LongRuns, state_directory: string, options: PullerOptions) {
    this.settings = settings;
    this.runs = runs;
    this.file = join(state_directory, "pull.json");
    this.options = options;
    this.run = options.run ?? ((command, timeout_in_seconds) => run_command(command, { timeout_in_seconds }));
    this.now = options.now ?? (() => Date.now());
    this.disconnected_since = this.now();
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.settings.interval * 1000);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  // ── State ────────────────────────────────────────────────────────────────

  private load(): PullState {
    if (!existsSync(this.file)) return { revision: null, records: [] };
    try {
      const state = JSON.parse(readFileSync(this.file, "utf8")) as Partial<PullState>;
      return { revision: state.revision ?? null, records: Array.isArray(state.records) ? state.records : [] };
    } catch {
      return { revision: null, records: [] };
    }
  }

  private save(state: PullState): void {
    const part = `${this.file}.part`;
    writeFileSync(part, JSON.stringify(state), { mode: 0o600 });
    renameSync(part, this.file);
  }

  // The revision deployed last, or the first one seen.
  revision(): string | null {
    return this.load().revision;
  }

  // ── Cycle ────────────────────────────────────────────────────────────────

  // Notes switches that have ended, then, once the server has been away long enough, deploys a new revision.
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const state = this.load();
      const ended = this.settle(state);
      if (this.options.connected()) {
        this.disconnected_since = null;
        if (ended) this.options.report();
        return;
      }
      this.disconnected_since ??= this.now();
      if (this.now() - this.disconnected_since < this.settings.after * 1000) return;
      if (state.records.some((record) => record.finished_epoch === null)) return;
      await this.deploy(state);
    } finally {
      this.ticking = false;
    }
  }

  // Marks each switch that has ended with its exit code, answering whether any did.
  private settle(state: PullState): boolean {
    let ended = false;
    for (const record of state.records) {
      if (record.finished_epoch !== null) continue;
      let exit_code: number | null = null;
      try {
        const run = this.runs.get(record.run_id);
        if (run.state === "running") continue;
        exit_code = run.exit_code;
      } catch {
        // A run gone from the state directory has ended without a word.
      }
      record.finished_epoch = Math.floor(this.now() / 1000);
      record.exit_code = exit_code;
      ended = true;
      this.options.log(`Pull switch to ${record.revision} ${exit_code === 0 ? "succeeded" : `failed with status ${exit_code ?? "unknown"}`}`);
    }
    if (ended) this.save(state);
    return ended;
  }

  // Asks each remote in turn for its branch's head, answering with the first that answers.
  private async latest(): Promise<{ remote: PullRemote; revision: string } | null> {
    for (const remote of this.settings.remotes) {
      const result = await this.run(ls_remote_command(this.settings, remote), ls_remote_timeout_in_seconds);
      const revision = result.exit_code === 0 ? parse_ls_remote(result.stdout, remote.branch) : null;
      if (revision !== null) return { remote, revision };
      this.options.log(`Could not read ${remote.branch} from ${remote.url}: ${(result.stderr || result.stdout).trim().slice(0, 200) || `exit ${result.exit_code}`}`);
    }
    return null;
  }

  private async deploy(state: PullState): Promise<void> {
    const latest = await this.latest();
    if (latest === null) return;
    const { remote, revision } = latest;
    if (state.revision === null) {
      state.revision = revision;
      this.save(state);
      this.options.log(`Pull mode noted ${revision} of ${remote.branch} from ${remote.url} as deployed; a later revision is switched to`);
      return;
    }
    if (state.revision === revision) return;
    const command = pull_switch_command(this.settings, remote, revision);
    const run_id = `pull-${Math.floor(this.now() / 1000)}-${randomBytes(3).toString("hex")}`;
    // The revision counts as deployed once its switch starts, so a failing one is not tried again every interval.
    state.revision = revision;
    try {
      this.runs.start(run_id, command, null);
    } catch (error) {
      this.options.log(`Could not start the pull switch to ${revision}: ${(error as Error).message}`);
      this.save(state);
      return;
    }
    state.records.push({
      run_id, remote: remote.url, branch: remote.branch, revision, command, started_epoch: Math.floor(this.now() / 1000), finished_epoch: null, exit_code: null,
    });
    this.save(state);
    this.options.log(`The server has been unreachable, so switching to ${revision} of ${remote.branch} from ${remote.url}: ${command}`);
  }

  // ── Reporting ────────────────────────────────────────────────────────────

  // Every ended switch not yet received by the server, with the end of its output.
  async pending(): Promise<PullReport[]> {
    const reports: PullReport[] = [];
    for (const record of this.load().records) {
      if (record.finished_epoch === null) continue;
      let output = "";
      try {
        const size = (await this.runs.poll(record.run_id, 0, 0)).size;
        output = (await this.runs.poll(record.run_id, Math.max(0, size - report_output_limit_in_bytes))).new_output;
      } catch {
        output = "The switch's output is no longer on the host.";
      }
      reports.push({ ...record, output });
    }
    return reports;
  }

  // Drops the switches the server has received, with their output.
  acknowledge(run_ids: string[]): void {
    const received = new Set(run_ids);
    const state = this.load();
    const kept = state.records.filter((record) => !received.has(record.run_id) || record.finished_epoch === null);
    if (kept.length === state.records.length) return;
    for (const record of state.records) {
      if (kept.includes(record)) continue;
      try {
        this.runs.forget(record.run_id);
      } catch {
        // A run already gone is left as it is.
      }
    }
    this.save({ ...state, records: kept });
  }
}
