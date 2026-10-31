// Provisioning: installs NixOS on new hosts with nixos-anywhere, and builds install media, each as a long run that
// outlives a restart of the server and lands in the job history.
//
// An install generates the new host's agent key, hands its private half to the install script on stdin and keeps only
// the public line, in the job's output. Once a full install succeeds the key is accepted beside the config's own, so
// the new agent logs in on its first boot, and the page shows what to add to the config to keep it. The config file is
// never written. Media builds run on the server's own host, so their files can be downloaded from its store.

// ── Imports ──────────────────────────────────────────────────────────────────

import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, readdirSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";

import { AgentError, type AgentPool } from "./agents/agent.ts";
import type { ProvisioningSettings } from "./config.ts";
import {
  install_command, install_snippets, media_command, missing_tool_exit_code, parse_hardware_config, parse_install_record, parse_media_path,
  parse_media_record,
  type InstallRecord, type InstallRequest, type MediaFormat,
} from "./nixos/provision.ts";
import { follow } from "./runs.ts";
import type { Job, JobKind, ProvisionedAgent, Store } from "./store.ts";
import { generate_agent_key, key_fingerprint } from "../shared/agent_keys.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface ProvisionOutcome {
  ok: boolean;
  message: string;
  job_id: number | null;
}

export interface MediaRequest {
  // What the job belongs to: the deployment it was built for, or the configuration's name.
  owner: string;
  flake: string;
  configuration: string;
  format: MediaFormat;
}

export interface MediaFile {
  // The file's path inside the built store path.
  path: string;
  size: number;
}

export interface InstallView {
  job: Job;
  record: InstallRecord | null;
  hardware_config: string | null;
  // Whether the new host's key is accepted now.
  key_accepted: boolean;
  snippets: { config_json: string; module_nix: string; host_nix: string } | null;
}

export interface MediaView {
  job: Job;
  format: MediaFormat | null;
  flake: string | null;
  configuration: string | null;
  store_path: string | null;
  // The files to download, or null when the build is not done or its result is gone.
  files: MediaFile[] | null;
}

export interface ProvisionedAgentView extends ProvisionedAgent {
  fingerprint: string;
  // Whether a key the config declares for the same host overrides this one.
  overridden: boolean;
}

export interface ProvisionerOptions {
  store: Store;
  agents: AgentPool;
  // Where media builds are linked when the settings name no folder.
  default_media_root_dir: string;
  // The hosts the config declares agent keys for, which an install may not take over.
  declared_hosts: () => Set<string>;
  // Called whenever the accepted provisioned keys change.
  on_agent_keys?: (keys: Map<string, string>) => void;
  // The store media must lie in, which tests set.
  store_dir?: string;
  // The time in seconds, which tests set.
  now?: () => number;
}

const provision_kinds: JobKind[] = ["install", "media"];

// A medium lists at most this many files, so a stray link to a large tree stays small.
const media_file_limit = 200;

const media_depth_limit = 4;

// ── Provisioner ──────────────────────────────────────────────────────────────

export class Provisioner {
  // The poller's id for it, which no deployment or cache can take since ids are letters, digits, - and _.
  readonly id = "@provisioning";
  readonly settings: ProvisioningSettings & { interval: number };
  readonly media_root_dir: string;
  private readonly store: Store;
  private readonly agents: AgentPool;
  private readonly options: ProvisionerOptions;
  private readonly store_dir: string;
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(settings: ProvisioningSettings, options: ProvisionerOptions) {
    // With nothing running it only looks for jobs a restart left behind, which the poller's first tick already does.
    this.settings = { ...settings, interval: 3600 };
    this.media_root_dir = settings.media_root_dir ?? options.default_media_root_dir;
    this.store = options.store;
    this.agents = options.agents;
    this.options = options;
    this.store_dir = (options.store_dir ?? "/nix/store").replace(/\/+$/, "");
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  // The server's own host, which runs installs unless one names another.
  get own_host(): string {
    return this.agents.own_host;
  }

  // ── Keys ─────────────────────────────────────────────────────────────────

  // The provisioned keys a declared key does not override, by host.
  agent_keys(): Map<string, string> {
    const declared = this.options.declared_hosts();
    return new Map(this.store.provisioned_agents().filter((agent) => !declared.has(agent.host)).map((agent) => [agent.host, agent.public_line]));
  }

  provisioned_agents(): ProvisionedAgentView[] {
    const declared = this.options.declared_hosts();
    return this.store.provisioned_agents().map((agent) => ({ ...agent, fingerprint: key_fingerprint(agent.public_line), overridden: declared.has(agent.host) }));
  }

  // Stops accepting a provisioned host's key, which hangs up on its agent.
  forget_agent(host: string): boolean {
    const forgotten = this.store.forget_provisioned_agent(host);
    if (forgotten) {
      this.store.add_event(host, this.now(), "info", `Stopped accepting the agent key X-Nix made for ${host}`);
      this.options.on_agent_keys?.(this.agent_keys());
    }
    return forgotten;
  }

  // ── Refusals ─────────────────────────────────────────────────────────────

  // Why no install can start at all, or null when one can.
  install_refusal(): string | null {
    if (this.settings.ssh_key === null) return "Set provisioning.ssh_key in the config to the SSH key nixos-anywhere logs in to targets with";
    return null;
  }

  private request_refusal(request: InstallRequest): string | null {
    const refusal = this.install_refusal();
    if (refusal !== null) return refusal;
    if (request.host === this.agents.own_host) return `'${request.host}' is the server's own host, which needs no agent`;
    if (!request.stop_after_partitioning && this.options.declared_hosts().has(request.host)) {
      return `The config already declares an agent key for '${request.host}'; remove it from agents first, or name the new host differently`;
    }
    for (const job of this.store.running_jobs(["install"])) {
      const record = parse_install_record(job.command);
      if (job.deployment_id === request.host || record?.address === request.address) return `An install to ${request.host} or ${request.address} is already running`;
    }
    return null;
  }

  // ── Starting ─────────────────────────────────────────────────────────────

  install(request: InstallRequest): Promise<ProvisionOutcome> {
    return this.serial(async () => {
      const refusal = this.request_refusal(request);
      if (refusal !== null) return { ok: false, message: refusal, job_id: null };
      // A stop after partitioning installs nothing, so no key is made for it.
      const key = request.stop_after_partitioning ? null : generate_agent_key(`x-nix-agent-${request.host}`);
      const command = install_command(this.settings, request, key?.public_line ?? null);
      const agent = request.agent === this.agents.own_host ? null : request.agent ?? this.settings.install_agent;
      const launched = await this.launch(request.host, "install", agent, command, key?.private_text ?? null);
      if (launched.job_id === null) return { ok: false, message: `Could not start the install: ${launched.error}`, job_id: null };
      const what = request.stop_after_partitioning ? "Partitioning" : "Install";
      this.store.add_event(request.host, this.now(), "info", `${what} of ${request.flake}#${request.configuration} on ${request.address} started`);
      return { ok: true, message: `${what} of ${request.host} started`, job_id: launched.job_id };
    });
  }

  build_media(request: MediaRequest): Promise<ProvisionOutcome> {
    return this.serial(async () => {
      const link_name = `${request.owner.slice(0, 60)}-${request.format}-${this.now()}-${randomBytes(3).toString("hex")}`.replace(/[^A-Za-z0-9._-]/g, "_");
      const command = media_command(this.settings, this.media_root_dir, request.flake, request.configuration, request.format, link_name);
      const launched = await this.launch(request.owner, "media", null, command, null, link_name);
      if (launched.job_id === null) return { ok: false, message: `Could not start the media build: ${launched.error}`, job_id: null };
      return { ok: true, message: `Build of the ${request.format} medium for ${request.configuration} started`, job_id: launched.job_id };
    });
  }

  private async launch(owner: string, kind: JobKind, agent: string | null, command: string, stdin: string | null, run_id?: string): Promise<{ job_id: number | null; error: string }> {
    const id = run_id ?? `${owner}-${kind}-${this.now()}-${randomBytes(3).toString("hex")}`;
    try {
      await this.agents.get(agent).start(id, command, stdin);
    } catch (error) {
      return { job_id: null, error: error instanceof AgentError ? error.message : String(error) };
    }
    return { job_id: this.store.create_job({ deployment_id: owner, kind, command, agent, run_id: id, trigger: "manual", started_epoch: this.now() }), error: "" };
  }

  private serial<Answer>(work: () => Promise<Answer>): Promise<Answer> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  // ── Following ────────────────────────────────────────────────────────────

  // Whether a job is running, so the poller looks again every job_poll.
  busy(): boolean {
    return this.store.running_jobs(provision_kinds).length > 0;
  }

  // Follows every running install and media build, and handles each one that has ended.
  cycle(): Promise<void> {
    return this.serial(async () => {
      for (const job of this.store.running_jobs(provision_kinds)) await this.poll_job(job);
    });
  }

  private async poll_job(job: Job): Promise<void> {
    const tool = job.kind === "install" ? this.settings.nixos_anywhere_bin : this.settings.nix_bin;
    const describe = (exit_code: number) => (exit_code === missing_tool_exit_code ? `${tool} is not installed on ${job.agent ?? "the server's host"}` : null);
    const followed = await follow(this.store, this.agents, job, this.now, describe);
    if (followed.outcome === "unreachable") {
      this.store.add_event(job.deployment_id, this.now(), "warning", `Could not poll the running ${job.kind}: ${followed.error}`);
      return;
    }
    if (followed.outcome === "running") return;
    const finished = this.store.job(job.id)!;
    if (job.kind === "media") {
      const level = finished.state === "succeeded" ? "info" : "error";
      this.store.add_event(job.deployment_id, this.now(), level, finished.state === "succeeded" ? "Install medium built" : `Install medium failed: ${finished.error}`);
      return;
    }
    const record = parse_install_record(finished.command);
    if (finished.state !== "succeeded") {
      this.store.add_event(job.deployment_id, this.now(), "error", `Install failed: ${finished.error}`);
      return;
    }
    if (record === null || record.stop_after_partitioning || record.public_line === null) {
      this.store.add_event(job.deployment_id, this.now(), "info", "Partitioning finished");
      return;
    }
    this.store.save_provisioned_agent({ host: record.host, public_line: record.public_line, job_id: job.id, added_epoch: this.now() });
    this.store.add_event(record.host, this.now(), "info", `Installed NixOS on ${record.address}; its agent key is accepted`);
    this.options.on_agent_keys?.(this.agent_keys());
  }

  // ── Views ────────────────────────────────────────────────────────────────

  installs(limit = 20): InstallView[] {
    const accepted = this.agent_keys();
    return this.store.jobs({ kind: "install", limit }).map((job) => {
      const output = this.store.job(job.id)?.output ?? "";
      const record = parse_install_record(job.command);
      const key_accepted = record?.public_line != null && accepted.get(record.host) === record.public_line;
      const snippets = record !== null && record.public_line !== null && job.state === "succeeded" ? install_snippets(record, this.settings.agent_url) : null;
      return { job, record, hardware_config: parse_hardware_config(output), key_accepted, snippets };
    });
  }

  media(limit = 20): MediaView[] {
    return this.store.jobs({ kind: "media", limit }).map((job) => {
      const record = parse_media_record(job.command);
      const store_path = job.state === "succeeded" ? parse_media_path(this.store.job(job.id)?.output ?? "") : null;
      return {
        job, store_path,
        format: record?.format ?? null,
        flake: record?.flake ?? null,
        configuration: record?.configuration ?? null,
        files: store_path === null ? null : this.media_files(store_path),
      };
    });
  }

  // ── Media files ──────────────────────────────────────────────────────────

  // The regular files inside a built store path, following links that stay in the store; null once it is gone.
  media_files(store_path: string): MediaFile[] | null {
    if (!this.in_store(store_path) || !existsSync(store_path)) return null;
    const root = realpathSync(store_path);
    if (!this.in_store(root)) return null;
    if (statSync(root).isFile()) return [{ path: basename(store_path), size: statSync(root).size }];
    const files: MediaFile[] = [];
    const walk = (folder: string, prefix: string, depth: number) => {
      for (const name of readdirSync(folder).sort()) {
        if (files.length >= media_file_limit) return;
        const shown = prefix === "" ? name : `${prefix}/${name}`;
        let real: string;
        try {
          real = realpathSync(join(folder, name));
        } catch {
          continue;
        }
        if (!this.in_store(real)) continue;
        const stats = statSync(real);
        if (stats.isFile()) files.push({ path: shown, size: stats.size });
        else if (stats.isDirectory() && depth < media_depth_limit) walk(real, shown, depth + 1);
      }
    };
    walk(root, "", 0);
    return files;
  }

  // The real file to send for a path inside a media job's result, or why there is none.
  media_download(job_id: number, path: string): { file: string; name: string } | { error: string } {
    const job = this.store.job(job_id);
    if (job === null || job.kind !== "media") return { error: "No such media build" };
    const store_path = job.state === "succeeded" ? parse_media_path(job.output) : null;
    if (store_path === null) return { error: "That build has no result" };
    const files = this.media_files(store_path);
    if (files === null) return { error: "That build's result is gone from the store" };
    // Only a path the listing holds is sent, so no name can reach outside the built store path.
    if (!files.some((file) => file.path === path)) return { error: "No such file in that build" };
    const root = realpathSync(store_path);
    return { file: statSync(root).isFile() ? root : realpathSync(join(root, ...path.split("/"))), name: basename(path) };
  }

  // Removes a media build's link, so its result can be collected as garbage.
  remove_media(job_id: number): ProvisionOutcome {
    const job = this.store.job(job_id);
    if (job === null || job.kind !== "media" || job.run_id === null) return { ok: false, message: "No such media build", job_id: null };
    if (job.state === "running") return { ok: false, message: "That build is still running", job_id: job_id };
    const link = join(this.media_root_dir, job.run_id);
    let is_link = false;
    try {
      is_link = lstatSync(link).isSymbolicLink();
    } catch {
      // A link already removed is no link.
    }
    if (!is_link) return { ok: false, message: "That build's result is already removed", job_id };
    unlinkSync(link);
    this.store.add_event(job.deployment_id, this.now(), "info", `Removed the link rooting media build #${job_id}`);
    return { ok: true, message: "Removed; the next garbage collection frees its space", job_id };
  }

  private in_store(path: string): boolean {
    return path.startsWith(`${this.store_dir}/`) && !path.split("/").includes("..");
  }
}
