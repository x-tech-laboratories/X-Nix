// Keeps what X-Nix learns in one SQLite file: each deployment's evaluation and last reading, each cache's last reading,
// the jobs with their output and the events of both, every finished build with its products, and the fleet runs. Jobs and events name their deployment or cache in
// `deployment_id`, as ids are unique across the two.

// ── Imports ──────────────────────────────────────────────────────────────────

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// ── Shapes ───────────────────────────────────────────────────────────────────

export type JobKind = "eval" | "update" | "build" | "switch" | "reboot" | "collect" | "check" | "build-target" | "push" | "next-boot" | "install" | "media" | "build-all";
export type JobState = "running" | "succeeded" | "failed";
export type EventLevel = "info" | "warning" | "error";

export interface Job {
  id: number;
  deployment_id: string;
  kind: JobKind;
  command: string;
  // The host whose agent runs it; the server's own when null.
  agent: string | null;
  run_id: string | null;
  state: JobState;
  exit_code: number | null;
  error: string | null;
  // The last line it printed, shown while it runs.
  progress: string | null;
  // How many bytes of the run's output have been copied into the job.
  output_offset: number;
  // What started it: a person, a schedule, or an automatic switch.
  trigger: string;
  started_epoch: number;
  finished_epoch: number | null;
}

export interface JobWithOutput extends Job {
  output: string;
}

// A file a build made, from its Hydra build products.
export interface BuildProduct {
  type: string;
  subtype: string;
  path: string;
  name: string;
  // Null unless it was a regular file inside the build's store path, which alone may be downloaded.
  size_bytes: number | null;
}

// One target a build job built, or tried to.
export interface BuildRecord {
  id: number;
  job_id: number;
  // The deployment or cache the job ran for.
  owner_id: string;
  target: string;
  agent: string | null;
  store_path: string | null;
  succeeded: boolean;
  started_epoch: number;
  finished_epoch: number;
  products: BuildProduct[];
}

export interface BuildFilter {
  owner_id?: string;
  target?: string;
  limit?: number;
}

export interface EventRow {
  id: number;
  deployment_id: string;
  epoch: number;
  level: EventLevel;
  message: string;
}

// ── Store ────────────────────────────────────────────────────────────────────

const schema = `
  CREATE TABLE IF NOT EXISTS deployment_state (
    deployment_id TEXT PRIMARY KEY,
    evaluation TEXT,
    reading TEXT
  );
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deployment_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    command TEXT NOT NULL,
    agent TEXT,
    run_id TEXT,
    state TEXT NOT NULL,
    exit_code INTEGER,
    error TEXT,
    progress TEXT,
    output_offset INTEGER NOT NULL DEFAULT 0,
    output TEXT NOT NULL DEFAULT '',
    trigger TEXT NOT NULL,
    started_epoch INTEGER NOT NULL,
    finished_epoch INTEGER
  );
  CREATE INDEX IF NOT EXISTS jobs_by_deployment ON jobs (deployment_id, id);
  CREATE INDEX IF NOT EXISTS jobs_running ON jobs (state) WHERE state = 'running';
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deployment_id TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    level TEXT NOT NULL,
    message TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_by_deployment ON events (deployment_id, id);
  CREATE TABLE IF NOT EXISTS cache_state (
    cache_id TEXT PRIMARY KEY,
    reading TEXT
  );
  CREATE TABLE IF NOT EXISTS provisioned_agents (
    host TEXT PRIMARY KEY,
    public_line TEXT NOT NULL,
    job_id INTEGER NOT NULL,
    added_epoch INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS builds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL,
    owner_id TEXT NOT NULL,
    target TEXT NOT NULL,
    agent TEXT,
    store_path TEXT,
    succeeded INTEGER NOT NULL,
    started_epoch INTEGER NOT NULL,
    finished_epoch INTEGER NOT NULL,
    products TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX IF NOT EXISTS builds_by_owner ON builds (owner_id, target, id);
  CREATE TABLE IF NOT EXISTS cache_server_state (
    cache_id TEXT PRIMARY KEY,
    reading TEXT
  );
  CREATE TABLE IF NOT EXISTS fleet_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    state TEXT NOT NULL,
    run TEXT NOT NULL
  );
`;

const job_columns = "id, deployment_id, kind, command, agent, run_id, state, exit_code, error, progress, output_offset, trigger, started_epoch, finished_epoch";

// The agent key of a host X-Nix installed, accepted beside the keys the config declares.
export interface ProvisionedAgent {
  host: string;
  public_line: string;
  job_id: number;
  added_epoch: number;
}

export interface JobFilter {
  deployment_id?: string;
  kind?: JobKind;
  // Evaluations and cache checks run every hour and would push every other job out of the list, so they are left out
  // unless asked for.
  include_evaluations?: boolean;
  limit?: number;
}

export class Store {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.database.exec(schema);
  }

  close(): void {
    this.database.close();
  }

  // ── Deployment state ─────────────────────────────────────────────────────

  evaluation<Shape>(deployment_id: string): Shape | null {
    return this.state_column<Shape>(deployment_id, "evaluation");
  }

  save_evaluation(deployment_id: string, evaluation: unknown): void {
    this.database.prepare(`INSERT INTO deployment_state (deployment_id, evaluation) VALUES (?, ?)
      ON CONFLICT (deployment_id) DO UPDATE SET evaluation = excluded.evaluation`).run(deployment_id, JSON.stringify(evaluation));
  }

  reading<Shape>(deployment_id: string): Shape | null {
    return this.state_column<Shape>(deployment_id, "reading");
  }

  save_reading(deployment_id: string, reading: unknown): void {
    this.database.prepare(`INSERT INTO deployment_state (deployment_id, reading) VALUES (?, ?)
      ON CONFLICT (deployment_id) DO UPDATE SET reading = excluded.reading`).run(deployment_id, JSON.stringify(reading));
  }

  private state_column<Shape>(deployment_id: string, column: "evaluation" | "reading"): Shape | null {
    const row = this.database.prepare(`SELECT ${column} AS value FROM deployment_state WHERE deployment_id = ?`).get(deployment_id) as { value: string | null } | undefined;
    return row?.value ? (JSON.parse(row.value) as Shape) : null;
  }

  // ── Cache state ──────────────────────────────────────────────────────────

  cache_reading<Shape>(cache_id: string): Shape | null {
    const row = this.database.prepare("SELECT reading FROM cache_state WHERE cache_id = ?").get(cache_id) as { reading: string | null } | undefined;
    return row?.reading ? (JSON.parse(row.reading) as Shape) : null;
  }

  save_cache_reading(cache_id: string, reading: unknown): void {
    this.database.prepare(`INSERT INTO cache_state (cache_id, reading) VALUES (?, ?)
      ON CONFLICT (cache_id) DO UPDATE SET reading = excluded.reading`).run(cache_id, JSON.stringify(reading));
  }

  // What the cache server's own endpoints last answered.
  cache_server_reading<Shape>(cache_id: string): Shape | null {
    const row = this.database.prepare("SELECT reading FROM cache_server_state WHERE cache_id = ?").get(cache_id) as { reading: string | null } | undefined;
    return row?.reading ? (JSON.parse(row.reading) as Shape) : null;
  }

  save_cache_server_reading(cache_id: string, reading: unknown): void {
    this.database.prepare(`INSERT INTO cache_server_state (cache_id, reading) VALUES (?, ?)
      ON CONFLICT (cache_id) DO UPDATE SET reading = excluded.reading`).run(cache_id, JSON.stringify(reading));
  }

  // ── Jobs ─────────────────────────────────────────────────────────────────

  create_job(job: Pick<Job, "deployment_id" | "kind" | "command" | "agent" | "run_id" | "trigger" | "started_epoch">): number {
    const result = this.database.prepare(`INSERT INTO jobs (deployment_id, kind, command, agent, run_id, state, trigger, started_epoch)
      VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`).run(job.deployment_id, job.kind, job.command, job.agent, job.run_id, job.trigger, job.started_epoch);
    return Number(result.lastInsertRowid);
  }

  append_output(job_id: number, text: string, output_offset: number | null = null): void {
    if (text === "" && output_offset === null) return;
    const progress = text.split("\n").map((line) => line.trim()).filter(Boolean).pop()?.slice(0, 200) ?? null;
    this.database.prepare(`UPDATE jobs SET output = output || ?, progress = COALESCE(?, progress),
      output_offset = COALESCE(?, output_offset) WHERE id = ?`).run(text, progress, output_offset, job_id);
  }

  set_progress(job_id: number, progress: string): void {
    this.database.prepare("UPDATE jobs SET progress = ? WHERE id = ?").run(progress.slice(0, 200), job_id);
  }

  finish_job(job_id: number, state: Exclude<JobState, "running">, exit_code: number | null, error: string | null, finished_epoch: number): void {
    this.database.prepare("UPDATE jobs SET state = ?, exit_code = ?, error = ?, finished_epoch = ? WHERE id = ?")
      .run(state, exit_code, error, finished_epoch, job_id);
  }

  job(job_id: number): JobWithOutput | null {
    const row = this.database.prepare(`SELECT ${job_columns}, output FROM jobs WHERE id = ?`).get(job_id);
    return (row as unknown as JobWithOutput | undefined) ?? null;
  }

  // The deployment's job for a long run, such as a switch an agent ran on its own and reported later.
  job_for_run(deployment_id: string, run_id: string): Job | null {
    const row = this.database.prepare(`SELECT ${job_columns} FROM jobs WHERE deployment_id = ? AND run_id = ? ORDER BY id DESC LIMIT 1`).get(deployment_id, run_id);
    return (row as unknown as Job | undefined) ?? null;
  }

  // The deployment's running job of these kinds, newest first.
  running_job(deployment_id: string, kinds: JobKind[]): Job | null {
    const row = this.database.prepare(`SELECT ${job_columns} FROM jobs WHERE state = 'running' AND deployment_id = ?
      AND kind IN (${kinds.map(() => "?").join(", ")}) ORDER BY id DESC LIMIT 1`).get(deployment_id, ...kinds);
    return (row as unknown as Job | undefined) ?? null;
  }

  // Every running job of these kinds, oldest first, whoever it belongs to.
  running_jobs(kinds: JobKind[]): Job[] {
    const rows = this.database.prepare(`SELECT ${job_columns} FROM jobs WHERE state = 'running'
      AND kind IN (${kinds.map(() => "?").join(", ")}) ORDER BY id`).all(...kinds);
    return rows as unknown as Job[];
  }

  jobs(filter: JobFilter = {}): Job[] {
    const conditions: string[] = [];
    const values: string[] = [];
    if (filter.deployment_id !== undefined) {
      conditions.push("deployment_id = ?");
      values.push(filter.deployment_id);
    }
    if (filter.kind !== undefined) {
      conditions.push("kind = ?");
      values.push(filter.kind);
    } else if (!filter.include_evaluations) conditions.push("kind NOT IN ('eval', 'check')");
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.database.prepare(`SELECT ${job_columns} FROM jobs ${where} ORDER BY id DESC LIMIT ${Math.trunc(filter.limit ?? 100)}`).all(...values);
    return rows as unknown as Job[];
  }

  // ── Provisioned agents ───────────────────────────────────────────────────

  provisioned_agents(): ProvisionedAgent[] {
    return this.database.prepare("SELECT host, public_line, job_id, added_epoch FROM provisioned_agents ORDER BY host").all() as unknown as ProvisionedAgent[];
  }

  // Keeps a host's new agent key, replacing the key of an earlier install of the same host.
  save_provisioned_agent(agent: ProvisionedAgent): void {
    this.database.prepare(`INSERT INTO provisioned_agents (host, public_line, job_id, added_epoch) VALUES (?, ?, ?, ?)
      ON CONFLICT (host) DO UPDATE SET public_line = excluded.public_line, job_id = excluded.job_id, added_epoch = excluded.added_epoch`)
      .run(agent.host, agent.public_line, agent.job_id, agent.added_epoch);
  }

  forget_provisioned_agent(host: string): boolean {
    return this.database.prepare("DELETE FROM provisioned_agents WHERE host = ?").run(host).changes > 0;
  }

  // ── Builds ───────────────────────────────────────────────────────────────

  add_build(build: Omit<BuildRecord, "id">): number {
    const result = this.database.prepare(`INSERT INTO builds (job_id, owner_id, target, agent, store_path, succeeded, started_epoch, finished_epoch, products)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(build.job_id, build.owner_id, build.target, build.agent, build.store_path, build.succeeded ? 1 : 0,
      build.started_epoch, build.finished_epoch, JSON.stringify(build.products));
    return Number(result.lastInsertRowid);
  }

  build(build_id: number): BuildRecord | null {
    const row = this.database.prepare("SELECT * FROM builds WHERE id = ?").get(build_id);
    return row === undefined ? null : build_of(row as Record<string, unknown>);
  }

  // The builds newest first, of one deployment or cache and one target when named.
  builds(filter: BuildFilter = {}): BuildRecord[] {
    const conditions: string[] = [];
    const values: string[] = [];
    if (filter.owner_id !== undefined) {
      conditions.push("owner_id = ?");
      values.push(filter.owner_id);
    }
    if (filter.target !== undefined) {
      conditions.push("target = ?");
      values.push(filter.target);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.database.prepare(`SELECT * FROM builds ${where} ORDER BY id DESC LIMIT ${Math.trunc(filter.limit ?? 100)}`).all(...values);
    return rows.map((row) => build_of(row as Record<string, unknown>));
  }

  // Every deployment or cache with a build, and the targets each built.
  build_targets(): { owner_id: string; target: string }[] {
    return this.database.prepare("SELECT DISTINCT owner_id, target FROM builds ORDER BY owner_id, target").all() as unknown as { owner_id: string; target: string }[];
  }

  // ── Fleet runs ───────────────────────────────────────────────────────────

  // Keeps a new fleet run, answering with its id; the run is stored whole as JSON beside its state.
  create_fleet_run(state: string, run: unknown): number {
    const result = this.database.prepare("INSERT INTO fleet_runs (state, run) VALUES (?, '{}')").run(state);
    const id = Number(result.lastInsertRowid);
    this.save_fleet_run(id, state, { ...(run as object), id });
    return id;
  }

  save_fleet_run(id: number, state: string, run: unknown): void {
    this.database.prepare("UPDATE fleet_runs SET state = ?, run = ? WHERE id = ?").run(state, JSON.stringify(run), id);
  }

  fleet_run<Shape>(id: number): Shape | null {
    const row = this.database.prepare("SELECT run FROM fleet_runs WHERE id = ?").get(id) as { run: string } | undefined;
    return row === undefined ? null : (JSON.parse(row.run) as Shape);
  }

  // The newest fleet runs first, or only those in one state.
  fleet_runs<Shape>(options: { state?: string; limit?: number } = {}): Shape[] {
    const where = options.state === undefined ? "" : "WHERE state = ?";
    const values = options.state === undefined ? [] : [options.state];
    const rows = this.database.prepare(`SELECT run FROM fleet_runs ${where} ORDER BY id DESC LIMIT ${Math.trunc(options.limit ?? 50)}`).all(...values) as { run: string }[];
    return rows.map((row) => JSON.parse(row.run) as Shape);
  }

  // ── Events ───────────────────────────────────────────────────────────────

  add_event(deployment_id: string, epoch: number, level: EventLevel, message: string): void {
    this.database.prepare("INSERT INTO events (deployment_id, epoch, level, message) VALUES (?, ?, ?, ?)").run(deployment_id, epoch, level, message);
  }

  events(deployment_id: string, limit = 100): EventRow[] {
    return this.database.prepare("SELECT id, deployment_id, epoch, level, message FROM events WHERE deployment_id = ? ORDER BY id DESC LIMIT ?")
      .all(deployment_id, Math.trunc(limit)) as unknown as EventRow[];
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// A build as stored, with its flag and products decoded.
function build_of(row: Record<string, unknown>): BuildRecord {
  return { ...(row as unknown as BuildRecord), succeeded: row.succeeded === 1, products: JSON.parse(String(row.products)) as BuildProduct[] };
}
