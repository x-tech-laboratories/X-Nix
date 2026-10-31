// What every view hands the router, and what several views show the same way.

import type { Deployment, Job } from "../api.ts";
import { age, h, stamp } from "../dom.ts";
import { link } from "../router.ts";
import { data_table, job_badge, status_badge } from "../ui.ts";

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
