// What every view hands the router, and what several views show the same way.

import { api, type ActionOutcome, type ActionView, type Deployment, type EventRow, type Job, type Message } from "../api.ts";
import { age, h, stamp, type Child } from "../dom.ts";
import { link } from "../router.ts";
import { confirm_dialog, data_table, empty, job_badge, level_badge, status_badge, toast } from "../ui.ts";

// ── Views ────────────────────────────────────────────────────────────────────

export interface View {
  root: HTMLElement;
  title: string;
  dispose?: () => void;
}

// How often an open page fetches again, so a running job's progress shows.
export const refresh_interval_in_milliseconds = 10_000;

// ── Deployments ──────────────────────────────────────────────────────────────

// Whether the deployment runs what its flake describes, in words and a tone.
export function drift_state(deployment: Deployment): [text: string, tone: "good" | "warn" | "bad" | "none"] {
  if (deployment.evaluation.eval_error !== null) return deployment.evaluation.eval_unreachable ? ["Evaluation unreachable", "warn"] : ["Evaluation failed", "bad"];
  const up_to_date = deployment.reading?.up_to_date ?? null;
  if (up_to_date === null) return [deployment.evaluating ? "Evaluating" : "Not evaluated yet", "none"];
  return up_to_date ? ["In sync", "good"] : ["Drifting", "warn"];
}

export function deployment_card(deployment: Deployment): HTMLElement {
  const [drift, tone] = drift_state(deployment);
  const reading = deployment.reading;
  const job = deployment.running_job;
  return h("a", { class: `card tone-edge-${tone}`, href: link(["deployments", deployment.id]) },
    h("div", { class: "card-head" }, h("strong", {}, deployment.name), status_badge(reading?.status ?? null)),
    h("div", { class: "muted card-host" }, deployment.host ?? "this server"),
    h("dl", {},
      h("dt", {}, "Flake"), h("dd", { class: tone === "none" ? null : `tone-${tone}` }, drift),
      h("dt", {}, "Generation"), h("dd", {}, reading?.generation ?? "—"),
      h("dt", {}, "Reboot"), h("dd", {}, reading?.reboot_required === true ? "Needed" : reading?.reboot_required === false ? "Not needed" : "—"),
      job && [h("dt", {}, "Running"), h("dd", {}, `${job.kind}${job.progress ? `: ${job.progress}` : ""}`)],
    ));
}

// ── Parts ────────────────────────────────────────────────────────────────────

export function tile(label: string, value: Child, class_name: string | null = null): HTMLElement {
  return h("div", { class: `tile${class_name ? ` ${class_name}` : ""}` }, h("div", { class: "tile-label" }, label), h("div", { class: "tile-value" }, value));
}

// What the last cycle found, each with its level.
export function messages_list(messages: Message[]): HTMLElement {
  if (messages.length === 0) return empty("Not read yet.");
  return h("ul", { class: "events" }, ...messages.map((message) => h("li", {}, level_badge(message.level), " ", h("span", { class: "event-message" }, message.text))));
}

export function events_list(events: EventRow[]): HTMLElement {
  return h("ul", { class: "events" }, ...events.map((event) => h("li", {},
    h("span", { class: "event-time muted small", title: stamp(event.epoch) }, age(event.epoch)), " ",
    level_badge(event.level), " ",
    h("span", { class: "event-message" }, event.message))));
}

// A button that runs one of the deployment's actions, asking first where the action says to, then calls done.
export function action_button(deployment: Deployment, action: ActionView, done: () => Promise<unknown>): HTMLElement {
  const run = async () => {
    try {
      const outcome = await api<ActionOutcome>(`/api/deployments/${encodeURIComponent(deployment.id)}/actions/${action.id}`, "POST");
      toast(outcome.message, "good", outcome.job_id === null ? null : { href: link(["jobs", String(outcome.job_id)]), text: "Follow it" });
    } catch (error) {
      toast((error as Error).message, "bad");
    }
    await done();
  };
  return h("button", {
    class: action.id === "reboot" ? "danger" : action.id === "switch" || action.id === "collect" ? "accent solid" : null,
    disabled: action.refusal !== null,
    title: action.refusal,
    onclick: () => {
      if (action.confirm === null) void run();
      else confirm_dialog(`${action.label} ${deployment.name}`, action.confirm, action.label, run);
    },
  }, action.label);
}

// ── Jobs ─────────────────────────────────────────────────────────────────────

export function jobs_table(jobs: Job[], show_deployment: boolean): HTMLElement {
  return data_table<Job>([
    { label: "Job", cell: (job) => h("a", { href: link(["jobs", String(job.id)]) }, `${job.kind} #${job.id}`) },
    ...(show_deployment ? [{ label: "Deployment", cell: (job: Job) => h("a", { href: link(["deployments", job.deployment_id]) }, job.deployment_id) }] : []),
    { label: "State", cell: (job) => job_badge(job.state) },
    { label: "Started", cell: (job) => h("span", { title: stamp(job.started_epoch) }, age(job.started_epoch)) },
    { label: "By", cell: (job) => job.trigger },
    { label: "Last line", cell: (job) => h("span", { class: "muted small" }, job.error ?? job.progress ?? "") },
  ], jobs, "Jobs");
}
