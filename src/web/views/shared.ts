// What every view hands the router, and what several views show the same way.

import {
  api, type ActionOutcome, type ActionView, type ClosureDiff, type Deployment, type DiffOutcome, type EventRow, type FleetHostState, type FleetRunState, type Job,
  type Message, type PackageChange,
} from "../api.ts";
import { age, bytes, h, stamp, type Child } from "../dom.ts";
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

// ── Fleet ────────────────────────────────────────────────────────────────────

// What the deployment waits on before it runs what its flake describes: a rebuild for drift, a sync for a fresh evaluation.
export function waiting_on(deployment: Deployment): HTMLElement {
  const reading = deployment.reading;
  const badges: HTMLElement[] = [];
  if (reading === null) return h("span", { class: "badge tone-none" }, "Not read yet");
  if (reading.status === "unavailable" && reading.current === null) badges.push(h("span", { class: "badge tone-warn" }, "Unreachable"));
  if (deployment.evaluation.eval_error !== null) badges.push(h("span", { class: "badge tone-bad" }, "Evaluation failed"));
  if (reading.up_to_date === false) badges.push(h("span", { class: "badge tone-warn", title: "The flake evaluates to another closure; a switch brings the host there" }, "Rebuild"));
  if (deployment.sync_pending) badges.push(h("span", { class: "badge tone-info", title: "A fresh evaluation is running or due" }, "Sync"));
  if (badges.length === 0 && reading.up_to_date === true) badges.push(h("span", { class: "badge tone-good" }, "Nothing"));
  if (badges.length === 0) badges.push(h("span", { class: "badge tone-none" }, "Not evaluated yet"));
  return h("span", { class: "chips inline-chips" }, ...badges);
}

export function tag_chips(tags: string[]): HTMLElement | string {
  return tags.length === 0 ? "" : h("span", { class: "chips inline-chips" }, ...tags.map((tag) => h("span", { class: "badge tone-none" }, `@${tag}`)));
}

// Every deployment's last update, NixOS version and what it waits on, with a checkbox each when a selection is given.
export function fleet_status_table(deployments: Deployment[], selection: { selected: Set<string>; changed: () => void } | null = null): HTMLElement {
  const pick = (deployment: Deployment) => h("input", {
    type: "checkbox", checked: selection!.selected.has(deployment.id), "aria-label": `Select ${deployment.name}`,
    onchange: (event: Event) => {
      if ((event.target as HTMLInputElement).checked) selection!.selected.add(deployment.id);
      else selection!.selected.delete(deployment.id);
      selection!.changed();
    },
  });
  return data_table<Deployment>([
    ...(selection === null ? [] : [{ label: "Pick", cell: pick }]),
    { label: "Deployment", cell: (deployment) => h("a", { href: link(["deployments", deployment.id]) }, deployment.name) },
    { label: "Tags", cell: (deployment) => tag_chips(deployment.tags) },
    { label: "NixOS", cell: (deployment) => deployment.reading?.version ?? "—" },
    { label: "Updated", cell: (deployment) => (deployment.reading?.switched_epoch ? h("span", { title: stamp(deployment.reading.switched_epoch) }, age(deployment.reading.switched_epoch)) : "—") },
    { label: "Pin", cell: (deployment) => (deployment.pin === null ? h("span", { class: "muted" }, "head") : h("code", {}, short_revision(deployment.pin))) },
    { label: "Waiting on", cell: waiting_on },
    { label: "Running", cell: (deployment) => (deployment.running_job === null ? "" : h("a", { href: link(["jobs", String(deployment.running_job.id)]) }, deployment.running_job.kind)) },
  ], deployments, "Fleet status");
}

const fleet_host_tones: Record<FleetHostState, string> = { queued: "none", running: "info", verifying: "info", succeeded: "good", failed: "bad", skipped: "none" };
const fleet_run_tones: Record<FleetRunState, string> = { running: "info", succeeded: "good", failed: "bad", stopped: "warn" };

export function fleet_host_badge(state: FleetHostState): HTMLElement {
  return h("span", { class: `badge tone-${fleet_host_tones[state]}` }, state);
}

export function fleet_run_badge(state: FleetRunState): HTMLElement {
  return h("span", { class: `badge tone-${fleet_run_tones[state]}` }, state);
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

// The actions that change the running or the booted system, whose confirmation shows what they change.
const diffed_actions = new Set<ActionView["id"]>(["switch", "boot", "test"]);

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
  // A switch's confirmation first compares the running closure with the flake's, so the dialog shows the diff.
  const confirm_with_diff = async (button: HTMLButtonElement) => {
    button.disabled = true;
    let body: Child;
    try {
      const outcome = await api<DiffOutcome>(`/api/deployments/${encodeURIComponent(deployment.id)}/diff`, "POST", {});
      body = outcome.diff === null || !outcome.diff.built
        ? h("p", { class: "muted" }, outcome.message ?? "Nothing to compare.")
        : diff_view(outcome.diff);
    } catch (error) {
      body = h("p", { class: "tone-bad" }, `Could not compare the closures: ${(error as Error).message}`);
    } finally {
      button.disabled = false;
    }
    confirm_dialog(`${action.label} ${deployment.name}`, [h("p", {}, action.confirm), body], action.label, run, true);
  };
  const button: HTMLButtonElement = h("button", {
    class: action.id === "reboot" ? "danger" : action.id === "switch" || action.id === "collect" ? "accent solid" : null,
    disabled: action.refusal !== null,
    title: action.refusal,
    onclick: () => {
      if (action.confirm === null) void run();
      else if (diffed_actions.has(action.id)) void confirm_with_diff(button);
      else confirm_dialog(`${action.label} ${deployment.name}`, action.confirm, action.label, run);
    },
  }, action.label);
  return button;
}

// ── Package diff ─────────────────────────────────────────────────────────────

function size_change(delta: number | null): string {
  if (delta === null || delta === 0) return "";
  return `${delta > 0 ? "+" : "−"}${bytes(Math.abs(delta))}`;
}

function versions(list: string[]): string {
  return list.length === 0 ? "∅" : list.map((version) => version || "ε").join(", ");
}

// What a switch would change: counts, the closure's size before and after, every changed package, and nix-diff's account.
export function diff_view(diff: ClosureDiff): HTMLElement {
  if (!diff.built) return empty("The flake's closure is not built on the host yet.", "Build it first to see what a switch changes; a switch builds it anyway.");
  const rows: [kind: string, tone: string, change: PackageChange][] = [
    ...diff.changed.map((change): [string, string, PackageChange] => ["changed", "info", change]),
    ...diff.added.map((change): [string, string, PackageChange] => ["added", "good", change]),
    ...diff.removed.map((change): [string, string, PackageChange] => ["removed", "bad", change]),
  ];
  const before = diff.closure_before_bytes;
  const after = diff.closure_after_bytes;
  const size = before !== null && after !== null ? `Closure ${bytes(before)} → ${bytes(after)} (${size_change(after - before) || "no change"})` : null;
  return h("div", { class: "stack diff" },
    h("div", { class: "change-summary" },
      h("span", { class: "badge tone-info" }, `${diff.changed.length} changed`),
      h("span", { class: "badge tone-good" }, `${diff.added.length} added`),
      h("span", { class: "badge tone-bad" }, `${diff.removed.length} removed`),
      diff.resized.length > 0 && h("span", { class: "badge tone-none" }, `${diff.resized.length} resized`),
      size && h("span", { class: "muted small" }, size),
    ),
    rows.length > 0
      ? data_table<[string, string, PackageChange]>([
        { label: "Package", cell: ([, , change]) => h("code", {}, change.name) },
        { label: "Change", cell: ([kind, tone]) => h("span", { class: `tone-${tone}` }, kind) },
        { label: "Versions", cell: ([, , change]) => `${versions(change.from)} → ${versions(change.to)}` },
        { label: "Size", class: "number", cell: ([, , change]) => size_change(change.size_delta_bytes) },
      ], rows, "Package changes")
      : h("p", { class: "muted" }, "No package changed version."),
    diff.derivation_diff && h("details", { class: "command" }, h("summary", {}, "Derivation differences (nix-diff)"), h("pre", { class: "output" }, diff.derivation_diff)),
    diff.note && h("p", { class: "muted small" }, diff.note),
    diff.error && h("p", { class: "tone-bad" }, diff.error),
    h("p", { class: "muted small" }, "Compared ", h("span", { title: stamp(diff.checked_epoch) }, age(diff.checked_epoch)),
      diff.job_id === null ? null : [" in ", h("a", { href: link(["jobs", String(diff.job_id)]) }, `diff #${diff.job_id}`)]),
  );
}

// A length of time in words, such as "3m 20s".
export function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

// A flake revision cut to fit a tile, keeping the -dirty mark.
export function short_revision(revision: string | null): string {
  if (!revision) return "—";
  const dash = revision.indexOf("-");
  return dash === -1 ? revision.slice(0, 8) : revision.slice(0, Math.min(dash, 8)) + revision.slice(dash);
}

// ── Jobs ─────────────────────────────────────────────────────────────────────

// The jobs a cache runs, whose owner is a cache rather than a deployment.
const cache_job_kinds = new Set<Job["kind"]>(["check", "build-target", "build-all", "push"]);

// The jobs the Provision page starts, whose owner is a host being installed or a configuration's media.
const provision_job_kinds = new Set<Job["kind"]>(["install", "media"]);

// Where a job belongs: the Provision page, the inventory, a cache or a deployment.
export function job_owner_link(job: Job): string {
  if (provision_job_kinds.has(job.kind)) return link(["provision"]);
  if (job.kind === "inventory") return link(["inventory"]);
  return link([cache_job_kinds.has(job.kind) ? "cache" : "deployments", job.deployment_id]);
}

export function owner_link(job: Job): HTMLElement {
  return h("a", { href: job_owner_link(job) }, job.kind === "inventory" ? "inventory" : job.deployment_id);
}

export function jobs_table(jobs: Job[], show_deployment: boolean): HTMLElement {
  return data_table<Job>([
    { label: "Job", cell: (job) => h("a", { href: link(["jobs", String(job.id)]) }, `${job.kind} #${job.id}`) },
    ...(show_deployment ? [{ label: "For", cell: owner_link }] : []),
    { label: "State", cell: (job) => job_badge(job.state) },
    { label: "Started", cell: (job) => h("span", { title: stamp(job.started_epoch) }, age(job.started_epoch)) },
    { label: "By", cell: (job) => job.trigger },
    { label: "Last line", cell: (job) => h("span", { class: "muted small" }, job.error ?? job.progress ?? "") },
  ], jobs, "Jobs");
}
