// Calls the server's JSON API and names the shapes it answers with.

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
export type JobKind = "eval" | "update" | "build" | "switch" | "reboot";
export type JobState = "running" | "succeeded" | "failed";
export type ActionId = "update" | "build" | "switch" | "reboot";

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
  reading: Reading | null;
  evaluation: Evaluation;
  evaluating: boolean;
  running_job: Job | null;
  actions: ActionView[];
}

export interface EventRow {
  id: number;
  epoch: number;
  level: EventLevel;
  message: string;
}

export interface ActionOutcome {
  ok: boolean;
  message: string;
  job_id: number | null;
}

// ── Requests ─────────────────────────────────────────────────────────────────

export async function api<Answer>(path: string, method: "GET" | "POST" = "GET"): Promise<Answer> {
  const response = await fetch(path, { method, headers: { accept: "application/json" } });
  const answer = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(answer?.message ?? answer?.error ?? `${response.status} ${response.statusText}`, response.status);
  return answer as Answer;
}
