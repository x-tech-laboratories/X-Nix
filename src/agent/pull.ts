// Pull mode: once the server has been unreachable for `after`, the agent deploys from Git on its own. Every `interval` it
// asks its remotes, in order, for the head of their branch, and switches to a revision it has not deployed yet with
// `nixos-rebuild switch --flake`, as a long run that outlives the agent, once the revision descends from the one deployed
// last and its commit is signed by a key the allowed signers file names, unless unsigned commits are allowed. The first
// revision it sees is only noted, so starting pull mode never switches by itself. Each switch, and each revision refused,
// is logged and kept in `pull.json` until the server, once back, has taken its report.

// ── Imports ──────────────────────────────────────────────────────────────────

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { LongRuns } from "@x-tech-laboratories/x-libs/agent/long_runs";
import { parse_duration } from "@x-tech-laboratories/x-libs/durations";

import type { PullReport, RunResult } from "../shared/agent_protocol.ts";
import type { Operation, ProgramsOperation } from "../shared/operations.ts";
import { run_operation } from "./run.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

export interface PullRemote {
  // A Git URL: https://, ssh:// or file://, optionally with nix's git+ in front.
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
  // The file of keys whose signature a commit needs before it is switched to, in Git's allowed signers format.
  allowed_signers: string | null;
  // Whether a commit is switched to without a signature, when no allowed signers are given.
  allow_unsigned: boolean;
  // Whether a revision that does not descend from the one deployed, such as an older commit or rewritten history, is switched to.
  allow_rewind: boolean;
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
  // Why the revision was refused, for a record of a refusal rather than a switch.
  refused?: string;
}

interface PullState {
  revision: string | null;
  records: PullRecord[];
  // The last revision refused for its signature or its history, so it is not fetched and refused again every interval.
  refused?: string | null;
}

export interface PullerOptions {
  // Whether a session with the server is open now.
  connected: () => boolean;
  // Asks the open session to send the reports not yet received.
  report: () => void;
  log: (line: string) => void;
  // Runs a short operation, which tests replace.
  run?: (operation: Operation, timeout_in_seconds: number) => Promise<RunResult>;
  // The time in milliseconds, which tests set.
  now?: () => number;
}

// Remotes reached over a channel that proves the server, or on this machine; plain http:// and git:// can be tampered with.
const remote_schemes = /^(git\+)?(https|ssh|file):\/\//;
const ls_remote_timeout_in_seconds = 60;
const fetch_timeout_in_seconds = 600;
const verify_timeout_in_seconds = 60;
const report_output_limit_in_bytes = 64 * 1024;
// At most this many refusals wait for the server, so a remote that keeps moving cannot fill the state file.
const refusal_record_limit = 20;
// The ref the fetched revision is kept under, so its history stays in the repository and later fetches bring only what is new.
const pulled_ref = "refs/x-nix/pulled";
const revision_pattern = /^[0-9a-f]{40}$/;

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
    if (typeof url !== "string" || !remote_schemes.test(url)) throw new PullConfigError(`Remote ${index + 1} needs a \`url\` starting with https://, ssh:// or file://`);
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
  const allowed_signers = values.allowed_signers ?? null;
  if (allowed_signers !== null && (typeof allowed_signers !== "string" || !allowed_signers.startsWith("/"))) {
    throw new PullConfigError("`allowed_signers` of the pull settings must be the absolute path of an allowed signers file");
  }
  if (values.allow_unsigned !== undefined && typeof values.allow_unsigned !== "boolean") throw new PullConfigError("`allow_unsigned` of the pull settings must be true or false");
  const allow_unsigned = (values.allow_unsigned as boolean | undefined) ?? false;
  if (values.allow_rewind !== undefined && typeof values.allow_rewind !== "boolean") throw new PullConfigError("`allow_rewind` of the pull settings must be true or false");
  if (allowed_signers === null && !allow_unsigned) {
    throw new PullConfigError("Pull mode needs `allowed_signers`, the keys a commit must be signed with, or `allow_unsigned: true` to switch to unsigned commits");
  }
  return {
    remotes,
    after: duration("after", "15m"),
    interval: Math.max(30, duration("interval", "5m")),
    configuration: text("configuration", host),
    rebuild_bin: text("rebuild_bin", "nixos-rebuild"),
    rebuild_args,
    require_sudo: (values.require_sudo as boolean | undefined) ?? true,
    git_bin: text("git_bin", "git"),
    allowed_signers,
    allow_unsigned,
    allow_rewind: (values.allow_rewind as boolean | undefined) ?? false,
  };
}

// ── Operations ───────────────────────────────────────────────────────────────

// The revision a remote's branch is at, from what `git ls-remote` prints.
export function parse_ls_remote(stdout: string, branch: string): string | null {
  for (const line of stdout.split("\n")) {
    const [revision, ref] = line.trim().split(/\s+/);
    if (ref === `refs/heads/${branch}` && revision_pattern.test(revision)) return revision;
  }
  return null;
}

export function ls_remote_operation(settings: PullSettings, remote: PullRemote): Operation {
  return { kind: "programs", steps: [{ argv: [settings.git_bin, "ls-remote", "--exit-code", remote.url.replace(/^git\+/, ""), `refs/heads/${remote.branch}`] }] };
}

// The flake reference of the branch fixed at the revision.
export function pulled_flake(remote: PullRemote, revision: string): string {
  const url = remote.url.startsWith("git+") ? remote.url : `git+${remote.url}`;
  return `${url}${url.includes("?") ? "&" : "?"}ref=${encodeURIComponent(`refs/heads/${remote.branch}`)}&rev=${revision}`;
}

// Fetches the revision with its whole history into the agent's own bare repository, unshallowing one an older agent
// fetched with `--depth 1`; the repository is kept between runs, so later fetches bring only what is new.
export function fetch_operation(settings: PullSettings, remote: PullRemote, revision: string, repository: string, shallow: boolean): ProgramsOperation {
  const git = [settings.git_bin, "-C", repository, "-c", "gc.auto=0", "-c", "maintenance.auto=false"];
  return {
    kind: "programs",
    steps: [
      { argv: [settings.git_bin, "init", "--quiet", "--bare", repository] },
      { argv: [...git, "fetch", "--quiet", "--no-tags", ...(shallow ? ["--unshallow"] : []), "--", remote.url.replace(/^git\+/, ""), `+${revision}:${pulled_ref}`] },
    ],
  };
}

// Exits 0 when the deployed revision is an ancestor of the new one, 1 when it is not, and 128 when the repository lacks it.
export function ancestry_operation(settings: PullSettings, repository: string, deployed: string, revision: string): ProgramsOperation {
  return { kind: "programs", steps: [{ argv: [settings.git_bin, "-C", repository, "merge-base", "--is-ancestor", "--", deployed, revision] }] };
}

// Checks the fetched revision's commit is signed by an allowed signer; only that commit's own signature is checked.
export function verify_operation(settings: PullSettings, repository: string, revision: string, allowed_signers: string): ProgramsOperation {
  return {
    kind: "programs",
    steps: [{ argv: [settings.git_bin, "-C", repository, "-c", `gpg.ssh.allowedSignersFile=${allowed_signers}`, "verify-commit", "--", revision] }],
  };
}

// Switches with the lock file the signed tree holds, so an input missing from it fails rather than being resolved anew.
export function pull_switch_operation(settings: PullSettings, remote: PullRemote, revision: string): Operation {
  const sudo = settings.require_sudo ? ["sudo", "-n"] : [];
  const flake = `${pulled_flake(remote, revision)}#${settings.configuration}`;
  const locked = settings.rebuild_args.includes("--no-update-lock-file") ? [] : ["--no-update-lock-file"];
  return { kind: "programs", steps: [{ argv: [...sudo, settings.rebuild_bin, "switch", "--flake", flake, ...locked, ...settings.rebuild_args] }] };
}

// The end of what a failed program printed, for a log line.
function last_lines(result: RunResult): string {
  return (result.stderr || result.stdout).trim().split("\n").slice(-2).join(" ").slice(0, 300) || `exit ${result.exit_code}`;
}

// ── Puller ───────────────────────────────────────────────────────────────────

export class Puller {
  private readonly settings: PullSettings;
  private readonly runs: LongRuns<Operation>;
  private readonly file: string;
  private readonly repository: string;
  private readonly options: PullerOptions;
  private readonly run: (operation: Operation, timeout_in_seconds: number) => Promise<RunResult>;
  private readonly now: () => number;
  // Since when, in milliseconds, no session has been open; the agent's start counts as the first.
  private disconnected_since: number | null;
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;

  constructor(settings: PullSettings, runs: LongRuns<Operation>, state_directory: string, options: PullerOptions) {
    this.settings = settings;
    this.runs = runs;
    this.file = join(state_directory, "pull.json");
    this.repository = join(state_directory, "pull.git");
    this.options = options;
    this.run = options.run ?? ((operation, timeout_in_seconds) => run_operation(operation, { timeout_in_seconds }));
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
      return { revision: state.revision ?? null, records: Array.isArray(state.records) ? state.records : [], refused: state.refused ?? null };
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
      const result = await this.run(ls_remote_operation(this.settings, remote), ls_remote_timeout_in_seconds);
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
      this.options.log(`Pull mode noted ${revision} of ${remote.branch} from ${remote.url} as deployed; only a revision that descends from it is switched to`);
      return;
    }
    if (state.revision === revision || state.refused === revision) return;
    const verdict = await this.check(state.revision, remote, revision);
    if (verdict === "retry") return;
    if (verdict !== "allowed") {
      this.refuse(state, remote, revision, verdict);
      return;
    }
    const operation = pull_switch_operation(this.settings, remote, revision);
    const command = JSON.stringify(operation);
    const run_id = `pull-${Math.floor(this.now() / 1000)}-${randomBytes(3).toString("hex")}`;
    // The revision counts as deployed once its switch starts, so a failing one is not tried again every interval.
    state.revision = revision;
    try {
      this.runs.start(run_id, operation, null);
    } catch (error) {
      this.options.log(`Could not start the pull switch to ${revision}: ${(error as Error).message}`);
      this.save(state);
      return;
    }
    state.records.push({
      run_id, remote: remote.url, branch: remote.branch, revision, command, started_epoch: Math.floor(this.now() / 1000), finished_epoch: null, exit_code: null,
    });
    this.save(state);
    this.options.log(`The server has been unreachable, so switching to ${revision} of ${remote.branch} from ${remote.url}`);
  }

  // Whether the revision may be switched to: "allowed", "retry" when Git could not be asked, or why it is refused.
  private async check(deployed: string, remote: PullRemote, revision: string): Promise<string> {
    const allowed_signers = this.settings.allowed_signers;
    if (allowed_signers === null && !this.settings.allow_unsigned) return "no allowed signers are set";
    if (allowed_signers === null && this.settings.allow_rewind) return "allowed";
    const shallow = existsSync(join(this.repository, "shallow"));
    const fetched = await this.run(fetch_operation(this.settings, remote, revision, this.repository, shallow), fetch_timeout_in_seconds);
    if (fetched.exit_code !== 0) {
      this.options.log(`Could not fetch ${revision} of ${remote.branch} from ${remote.url}, trying again later: ${last_lines(fetched)}`);
      return "retry";
    }
    if (!this.settings.allow_rewind) {
      if (!revision_pattern.test(deployed)) return `the deployed revision ${deployed} is not a commit name`;
      const ancestry = await this.run(ancestry_operation(this.settings, this.repository, deployed, revision), verify_timeout_in_seconds);
      if (ancestry.exit_code === 1) return `it does not descend from the deployed revision ${deployed}, so it is older or on other history`;
      if (ancestry.exit_code === 128) return `the deployed revision ${deployed} is not in its history, which was rewritten`;
      if (ancestry.exit_code !== 0) {
        this.options.log(`Could not compare ${revision} with the deployed ${deployed}, trying again later: ${last_lines(ancestry)}`);
        return "retry";
      }
    }
    if (allowed_signers === null) return "allowed";
    const verified = await this.run(verify_operation(this.settings, this.repository, revision, allowed_signers), verify_timeout_in_seconds);
    return verified.exit_code === 0 ? "allowed" : `its commit is not signed by an allowed signer (${last_lines(verified)})`;
  }

  // Remembers the refused revision so it is not checked again, and keeps the refusal for the server to see.
  private refuse(state: PullState, remote: PullRemote, revision: string, why: string): void {
    const message = `Not switching to ${revision} of ${remote.branch} from ${remote.url}: ${why}`;
    this.options.log(message);
    const epoch = Math.floor(this.now() / 1000);
    state.refused = revision;
    state.records.push({
      run_id: `pull-refused-${epoch}-${randomBytes(3).toString("hex")}`, remote: remote.url, branch: remote.branch, revision, command: "",
      started_epoch: epoch, finished_epoch: epoch, exit_code: null, refused: why,
    });
    const refusals = state.records.filter((record) => record.refused !== undefined);
    const dropped = new Set(refusals.slice(0, Math.max(0, refusals.length - refusal_record_limit)));
    state.records = state.records.filter((record) => !dropped.has(record));
    this.save(state);
  }

  // ── Reporting ────────────────────────────────────────────────────────────

  // Every ended switch not yet received by the server, with the end of its output.
  async pending(): Promise<PullReport[]> {
    const reports: PullReport[] = [];
    for (const record of this.load().records) {
      if (record.finished_epoch === null) continue;
      if (record.refused !== undefined) {
        reports.push({ ...record, output: `${record.refused}\n` });
        continue;
      }
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
