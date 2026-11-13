// One host: the machine itself, apart from what any deployment runs on it.
//
// Every `interval` its agent reads the Nix store and its garbage collection, unless `gc` is false, and the boot loader's
// entries, unless `boot` is false. Collect Garbage runs the same collection the timer does as a long run, which `gc.collect_at`
// also starts each day in place of the timer, and Reboot and
// Set next boot run at once rather than as long runs, waking a host that sleeps first. Its jobs, events and samples are kept under `host:<name>`, so
// a host may share its name with a deployment.

// ── Imports ──────────────────────────────────────────────────────────────────

import { randomBytes } from "node:crypto";

import { AgentError, type AgentPool, type RunResult } from "./agents/agent.ts";
import { level_of_status, type HostSettings, type Status } from "./config.ts";
import { latest_slot, type Message } from "./deployment.ts";
import { boot_probe_operation, next_boot_operation, parse_boot, type Boot } from "./nixos/boot.ts";
import { reboot_operation } from "./nixos/commands.ts";
import {
  assess_store, collect_operation, finished_collection, fold_collection, observed_collection, parse_gc_probe, store_probe_operation, unread_store,
  type Collection, type StoreReading,
} from "./nixos/garbage.ts";
import { follow, start_run, track_wake } from "./runs.ts";
import type { Job, Store } from "./store.ts";
import type { Operation } from "../shared/operations.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export type HostActionId = "collect" | "reboot";

export const host_action_ids: HostActionId[] = ["collect", "reboot"];

// What the last cycle read from the host.
export interface HostReading {
  // The store's status, or online when the store is not watched.
  status: Status;
  checked_epoch: number;
  // Null when the store is not watched.
  store: StoreReading | null;
  // Null when the boot entries are not read, or never could be.
  boot: Boot | null;
}

// What the host remembers between cycles.
export interface HostState {
  // The last garbage collection seen, kept after the journal has rotated past it.
  last_collection: Collection | null;
  // The last daily collection slot handled.
  scheduled_collection?: number;
}

export interface HostActionOutcome {
  ok: boolean;
  message: string;
  job_id: number | null;
}

export interface HostOptions {
  store: Store;
  agents: AgentPool;
  // The time in seconds, which tests set.
  now?: () => number;
}

const probe_timeout_in_seconds = 60;
const command_timeout_in_seconds = 60;

// ── Host ─────────────────────────────────────────────────────────────────────

export class Host {
  readonly settings: HostSettings;
  private readonly store: Store;
  private readonly agents: AgentPool;
  private readonly now: () => number;
  // Cycles and actions run one at a time.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(settings: HostSettings, options: HostOptions) {
    this.settings = settings;
    this.store = options.store;
    this.agents = options.agents;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  // The owner its jobs and events are kept under, apart from any deployment of the same name.
  get id(): string {
    return `host:${this.settings.id}`;
  }

  // The name its agent answers to.
  get name(): string {
    return this.settings.id;
  }

  reading(): HostReading | null {
    return this.store.reading<HostReading>(this.id);
  }

  state(): HostState {
    return { last_collection: null, ...this.store.evaluation<HostState>(this.id) };
  }

  running_job(): Job | null {
    return this.store.running_job(this.id, ["collect"]);
  }

  // Whether the host is waiting on a long run, so the poller looks again sooner.
  busy(): boolean {
    return this.running_job() !== null;
  }

  // Why an action cannot run now, or null when it can.
  action_refusal(action: HostActionId): string | null {
    if (action === "collect" && this.settings.gc === null) return "The store is not watched on this host; its gc is off";
    if (this.running_job() !== null) return "A collection is already running on this host";
    return null;
  }

  // Why the next boot cannot be set to this entry now, or null when it can.
  next_boot_refusal(entry: string): string | null {
    if (!this.settings.boot) return "Boot entries are not read on this host; its boot is off";
    const boot = this.reading()?.boot ?? null;
    if (boot === null || boot.loader === "none") return "No boot loader X-Nix can set has been read on this host";
    if (!boot.entries.some((candidate) => candidate.id === entry)) return `'${entry}' is not one of the host's boot entries`;
    return null;
  }

  // ── Cycle ────────────────────────────────────────────────────────────────

  // Follows a running collection, or starts a daily collection that is due, or reads the store and the boot entries.
  cycle(): Promise<void> {
    return this.serial(async () => {
      const job = this.running_job();
      if (job !== null) return this.poll_job(job);
      const slot = this.collection_due();
      if (slot !== null) return this.collect_scheduled(slot);
      return this.read();
    });
  }

  // The latest daily collection slot when it is newer than the one last handled; a schedule seen for the first time starts at its next slot.
  collection_due(): number | null {
    const at = this.settings.gc?.collect_at ?? null;
    if (at === null) return null;
    const slot = latest_slot(at, this.now());
    const state = this.state();
    if (state.scheduled_collection === undefined) {
      this.store.save_evaluation(this.id, { ...state, scheduled_collection: slot });
      return null;
    }
    return slot > state.scheduled_collection ? slot : null;
  }

  private async collect_scheduled(slot: number): Promise<void> {
    const outcome = await this.collect("schedule");
    // A host that never answered started nothing, so a later cycle tries again once it is back.
    if (outcome.unreachable) return;
    this.store.save_evaluation(this.id, { ...this.state(), scheduled_collection: slot });
  }

  private serial<Answer>(work: () => Promise<Answer>): Promise<Answer> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  private async read(): Promise<void> {
    const agent = this.agents.get(this.name);
    const gc = this.settings.gc;
    const [gc_probe, boot_probe] = await Promise.all([
      gc === null ? null : agent.run(store_probe_operation(gc), { timeout_in_seconds: probe_timeout_in_seconds }),
      this.settings.boot ? agent.run(boot_probe_operation(this.settings.require_sudo), { timeout_in_seconds: probe_timeout_in_seconds }) : null,
    ]);
    const store = gc_probe === null ? null : this.read_store(gc_probe);
    // A boot read that reached nothing keeps the entries last seen.
    const boot = boot_probe === null ? null : parse_boot(boot_probe.stdout) ?? this.reading()?.boot ?? null;
    this.save_reading({ status: store?.status ?? "online", checked_epoch: this.now(), store, boot });
  }

  // Reads the store from its probe, folding the last collection it shows into the host's state.
  private read_store(result: RunResult): StoreReading {
    const gc = this.settings.gc!;
    const unavailable = (text: string): StoreReading => ({
      ...(this.reading()?.store ?? unread_store(gc)),
      status: "unavailable",
      checked_epoch: this.now(),
      messages: [{ level: "warning", text }],
    });
    const fields = parse_gc_probe(result.stdout);
    if (fields === null) return unavailable(`Could not read the Nix store: ${clip(result.stderr || result.stdout, 200) || `status ${result.exit_code}`}`);
    if (fields.size_bytes === null) return unavailable(`${gc.store} is unreadable; is Nix installed on this host?`);
    const state = this.state();
    state.last_collection = fold_collection(state.last_collection, observed_collection(fields));
    this.store.save_evaluation(this.id, state);
    this.sample_collection(state.last_collection);
    return assess_store(gc, fields, state.last_collection, this.now());
  }

  // Saves the reading, noting a change of the store's status as an event.
  private save_reading(reading: HostReading): void {
    const previous = this.reading()?.store ?? null;
    this.store.save_reading(this.id, reading);
    const store = reading.store;
    if (store !== null && store.status !== "unavailable") this.sample_store(store);
    if (store === null || previous?.status === store.status) return;
    const level = level_of_status[store.status];
    const reason = store.messages.find((message: Message) => message.level === level && level !== "info");
    this.store.add_event(this.id, store.checked_epoch, level, reason ? `Store now ${store.status}: ${reason.text}` : `Store now ${store.status}`);
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  // Runs Collect Garbage or Reboot, naming in the job what started it, such as a person or a fleet run.
  act(action: HostActionId, trigger = "manual"): Promise<HostActionOutcome> {
    return this.serial(async () => {
      const refusal = this.action_refusal(action);
      if (refusal !== null) return { ok: false, message: refusal, job_id: null };
      if (action === "reboot") return this.reboot(trigger);
      const { unreachable: _, ...outcome } = await this.collect(trigger);
      return outcome;
    });
  }

  private async collect(trigger: string): Promise<HostActionOutcome & { unreachable: boolean }> {
    const operation = collect_operation(this.settings.gc!, this.settings.require_sudo);
    const command = JSON.stringify(operation);
    const run_id = `${this.settings.id}-collect-${this.now()}-${randomBytes(3).toString("hex")}`;
    let waking: Promise<void> | null;
    try {
      ({ waking } = await start_run(this.agents, this.name, run_id, operation));
    } catch (error) {
      const message = error instanceof AgentError ? error.message : String(error);
      // A scheduled collection on a host that is away waits for it rather than failing every cycle.
      if (trigger === "schedule" && error instanceof AgentError && error.unreachable) return { ok: false, message, job_id: null, unreachable: true };
      const job_id = this.store.create_job({ deployment_id: this.id, kind: "collect", command, agent: this.name, run_id: null, trigger, started_epoch: this.now() });
      this.store.append_output(job_id, `${message}\n`);
      this.store.finish_job(job_id, "failed", null, "The job could not be started", this.now());
      this.store.add_event(this.id, this.now(), "error", `Could not start the collection: ${message}`);
      return { ok: false, message: `Could not start the collection: ${message}`, job_id, unreachable: false };
    }
    const job_id = this.store.create_job({ deployment_id: this.id, kind: "collect", command, agent: this.name, run_id, trigger, started_epoch: this.now() });
    if (waking !== null) {
      track_wake(this.store, job_id, this.name, waking, this.now, (error) => {
        this.store.add_event(this.id, this.now(), "error", `Could not start the collection: ${error}`);
      });
    }
    const message = trigger === "schedule" ? "Scheduled collection started" : "Collection started";
    this.store.add_event(this.id, this.now(), "info", message);
    return { ok: true, message, job_id, unreachable: false };
  }

  // A reboot runs as a command rather than a job that would die with the host.
  private async reboot(trigger: string): Promise<HostActionOutcome> {
    return this.run_at_once("reboot", reboot_operation(this.settings), trigger, "Reboot requested", "Could not reboot");
  }

  // Sets the entry the host boots into once, then reboots when asked; a command rather than a job, as a reboot ends it.
  set_next_boot(entry: string, reboot: boolean): Promise<HostActionOutcome> {
    return this.serial(async () => {
      const refusal = this.next_boot_refusal(entry);
      if (refusal !== null) return { ok: false, message: refusal, job_id: null };
      const reading = this.reading()!;
      const boot = reading.boot!;
      const title = boot.entries.find((candidate) => candidate.id === entry)!.title;
      const operation = next_boot_operation(boot, entry, reboot, this.settings.require_sudo);
      const outcome = await this.run_at_once("next-boot", operation, "manual", `Next boot set to ${title}${reboot ? "; rebooting" : ""}`, `Could not set the next boot to ${title}`);
      if (outcome.ok) {
        // Shown at once, rather than after the next cycle reads it back.
        this.store.save_reading(this.id, { ...reading, boot: { ...boot, next: entry, entries: boot.entries.map((candidate) => ({ ...candidate, next: candidate.id === entry })) } });
      }
      return outcome;
    });
  }

  // Runs an operation on the woken host and keeps it in the history as a finished job.
  private async run_at_once(kind: "reboot" | "next-boot", operation: Operation, trigger: string, done: string, failed: string): Promise<HostActionOutcome> {
    const result = await (await this.agents.awake(this.name)).run(operation, { timeout_in_seconds: command_timeout_in_seconds });
    const job_id = this.store.create_job({ deployment_id: this.id, kind, command: JSON.stringify(operation), agent: this.name, run_id: null, trigger, started_epoch: this.now() });
    this.store.append_output(job_id, [result.stdout, result.stderr].filter(Boolean).join("\n"));
    const ok = result.exit_code === 0;
    this.store.finish_job(job_id, ok ? "succeeded" : "failed", result.exit_code, ok ? null : `Exited with status ${result.exit_code}`, this.now());
    const message = ok ? done : `${failed}: ${clip(result.stderr || result.stdout, 200)}`;
    this.store.add_event(this.id, this.now(), ok ? "info" : "error", message);
    return { ok, message, job_id };
  }

  // ── Samples ──────────────────────────────────────────────────────────────

  private sample_store(store: StoreReading): void {
    if (store.used_percent !== null) this.store.add_sample(this.id, "store_used_percent", store.checked_epoch, store.used_percent);
    if (store.used_bytes !== null) this.store.add_sample(this.id, "store_used_bytes", store.checked_epoch, store.used_bytes);
    if (store.paths !== null) this.store.add_sample(this.id, "store_paths", store.checked_epoch, store.paths);
  }

  // Each collection is kept once, at the time it ran.
  private sample_collection(collection: Collection | null): void {
    if (collection?.succeeded && collection.freed_bytes !== null) this.store.add_sample(this.id, "collection_freed_bytes", collection.epoch, collection.freed_bytes);
  }

  // ── Jobs ─────────────────────────────────────────────────────────────────

  private async poll_job(job: Job): Promise<void> {
    const followed = await follow(this.store, this.agents, job, this.now);
    if (followed.outcome === "unreachable") {
      this.store.add_event(this.id, this.now(), "warning", `Could not poll the running collection: ${followed.error}`);
      return;
    }
    if (followed.outcome === "running") return;
    const finished = this.store.job(job.id)!;
    // A manual collection is the last collection, just as a timer run would be.
    const last_collection = finished_collection(finished.output, finished.state === "succeeded", finished.error, this.now());
    this.store.save_evaluation(this.id, { ...this.state(), last_collection });
    this.sample_collection(last_collection);
    if (finished.state === "succeeded") this.store.add_event(this.id, this.now(), "info", "Collection finished");
    else this.store.add_event(this.id, this.now(), "error", `Collection failed: ${finished.error}`);
    await this.read();
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function clip(text: string, length: number): string {
  return text.trim().slice(0, length);
}
