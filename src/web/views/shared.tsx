// What several views show the same way: drift, waiting badges, actions with their confirmations, package diffs and jobs.

import { Badge, Chips } from "@x-tech-laboratories/x-libs/web/react/badges";
import { confirm_dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { Empty } from "@x-tech-laboratories/x-libs/web/react/states";
import { DataTable } from "@x-tech-laboratories/x-libs/web/react/table";
import { toast } from "@x-tech-laboratories/x-libs/web/react/toasts";
import { describe_error } from "@x-tech-laboratories/x-libs/web/errors";
import { age, size, size_change, stamp } from "@x-tech-laboratories/x-libs/web/format";
import { link } from "@x-tech-laboratories/x-libs/web/router";
import { useState, type ReactNode } from "react";
import {
  api, changes, type ActionOutcome, type ActionView, type ClosureDiff, type Deployment, type DiffOutcome, type EventRow, type Host, type Job, type Message, type PackageChange,
} from "../api.ts";
import { Age } from "@x-tech-laboratories/x-libs/web/react/time";
import { JobBadge, LevelBadge } from "../ui.tsx";

// An open page loads again whenever the server says something changed, and each minute for what it does not announce.
export const live = { watch: changes, refresh_in_milliseconds: 60_000 };

// ── Toasts ───────────────────────────────────────────────────────────────────

// Tells what an action started, with a link to follow its job when it has one.
export function job_toast(message: string, job_id: number | null): void {
  toast(message, { tone: "good", link: job_id === null ? null : { href: link(["jobs", String(job_id)]), text: "Follow it" } });
}

export function error_toast(error: unknown): void {
  toast(describe_error(error), { tone: "bad" });
}

// ── Deployments ──────────────────────────────────────────────────────────────

// Whether the deployment runs what its flake describes, in words and a tone.
export function drift_state(deployment: Deployment): [text: string, tone: "good" | "warn" | "bad" | "none"] {
  if (deployment.evaluation.eval_error !== null) return deployment.evaluation.eval_unreachable ? ["Evaluation unreachable", "warn"] : ["Evaluation failed", "bad"];
  const up_to_date = deployment.reading?.up_to_date ?? null;
  if (up_to_date === null) return [deployment.evaluating ? "Evaluating" : "Not evaluated yet", "none"];
  return up_to_date ? ["In sync", "good"] : ["Drifting", "warn"];
}

// ── Fleet ────────────────────────────────────────────────────────────────────

// What the deployment waits on before it runs what its flake describes: a rebuild for drift, a sync for a fresh evaluation.
export function WaitingOn({ deployment }: { deployment: Deployment }) {
  const reading = deployment.reading;
  if (reading === null) return <Badge>Not read yet</Badge>;
  const badges: ReactNode[] = [];
  if (reading.status === "unavailable" && reading.current === null) badges.push(<Badge key="unreachable" tone="warn">Unreachable</Badge>);
  if (deployment.evaluation.eval_error !== null) badges.push(<Badge key="failed" tone="bad">Evaluation failed</Badge>);
  if (reading.up_to_date === false) badges.push(<Badge key="rebuild" tone="warn" title="The flake evaluates to another closure; a switch brings the host there">Rebuild</Badge>);
  if (deployment.sync_pending) badges.push(<Badge key="sync" tone="info" title="A fresh evaluation is running or due">Sync</Badge>);
  if (badges.length === 0 && reading.up_to_date === true) badges.push(<Badge key="nothing" tone="good">Nothing</Badge>);
  if (badges.length === 0) badges.push(<Badge key="unevaluated">Not evaluated yet</Badge>);
  return <Chips inline>{badges}</Chips>;
}

export function TagChips({ tags }: { tags: string[] }) {
  if (tags.length === 0) return null;
  return <Chips inline>{tags.map((tag) => <Badge key={tag}>@{tag}</Badge>)}</Chips>;
}

// ── Parts ────────────────────────────────────────────────────────────────────

// A flake reference, linked to the declared flake's page when it names one.
export function FlakeLink({ flake_id, reference }: { flake_id: string | null; reference: string }) {
  if (flake_id === null) return <code>{reference}</code>;
  return <span><a href={link(["flakes", flake_id])}>{flake_id}</a> <code className="muted small">{reference}</code></span>;
}

// What the last cycle found, each with its level.
export function MessagesList({ messages }: { messages: Message[] }) {
  if (messages.length === 0) return <Empty title="Not read yet." />;
  return <ul className="events">{messages.map((message, index) => <li key={index}><LevelBadge level={message.level} /> <span className="event-message">{message.text}</span></li>)}</ul>;
}

export function EventsList({ events }: { events: EventRow[] }) {
  return (
    <ul className="events">
      {events.map((event, index) => (
        <li key={index}>
          <span className="event-time muted small" title={stamp(event.epoch)}>{age(event.epoch)}</span>{" "}
          <LevelBadge level={event.level} />{" "}
          <span className="event-message">{event.message}</span>
        </li>
      ))}
    </ul>
  );
}

// ── Actions ──────────────────────────────────────────────────────────────────

// The actions that change the running or the booted system, whose confirmation shows what they change.
const diffed_actions = new Set<ActionView["id"]>(["switch", "boot", "test"]);

// A button that runs one of the deployment's actions, asking first where the action says to, then calls done.
export function ActionButton({ deployment, action, done }: { deployment: Deployment; action: ActionView; done: () => unknown }) {
  const [comparing, set_comparing] = useState(false);

  const run = async () => {
    try {
      const outcome = await api<ActionOutcome>(`/api/deployments/${encodeURIComponent(deployment.id)}/actions/${action.id}`, "POST");
      job_toast(outcome.message, outcome.job_id);
    } catch (error) {
      error_toast(error);
    }
    await done();
  };

  // A switch's confirmation first compares the running closure with the flake's, so the dialog shows the diff.
  const confirm_with_diff = async (confirm: string) => {
    set_comparing(true);
    let body: ReactNode;
    try {
      const outcome = await api<DiffOutcome>(`/api/deployments/${encodeURIComponent(deployment.id)}/diff`, "POST", {});
      body = outcome.diff === null || !outcome.diff.built
        ? <p className="muted">{outcome.message ?? "Nothing to compare."}</p>
        : <DiffView diff={outcome.diff} />;
    } catch (error) {
      body = <p className="tone-bad">Could not compare the closures: {describe_error(error)}</p>;
    } finally {
      set_comparing(false);
    }
    confirm_dialog({ title: `${action.label} ${deployment.name}`, message: <><p>{confirm}</p>{body}</>, confirm_label: action.label, danger: true, wide: true, run });
  };

  return (
    <button
      className={action.id === "reboot" ? "danger" : action.id === "switch" ? "accent solid" : undefined}
      disabled={action.refusal !== null || comparing}
      title={action.refusal ?? undefined}
      onClick={() => {
        if (action.confirm === null) void run();
        else if (diffed_actions.has(action.id)) void confirm_with_diff(action.confirm);
        else confirm_dialog({ title: `${action.label} ${deployment.name}`, message: action.confirm, confirm_label: action.label, danger: true, run });
      }}
    >
      {action.label}
    </button>
  );
}

// A button that runs one of the host's actions, asking first, then calls done.
export function HostActionButton({ host, action, done }: { host: Host; action: Host["actions"][number]; done: () => unknown }) {
  const run = async () => {
    try {
      const outcome = await api<ActionOutcome>(`/api/hosts/${encodeURIComponent(host.name)}/actions/${action.id}`, "POST");
      job_toast(outcome.message, outcome.job_id);
    } catch (error) {
      error_toast(error);
    }
    await done();
  };
  return (
    <button
      className={action.id === "reboot" ? "danger" : undefined}
      disabled={action.refusal !== null}
      title={action.refusal ?? undefined}
      onClick={() => (action.confirm === null ? void run() : confirm_dialog({ title: `${action.label} ${host.display_name}`, message: action.confirm, confirm_label: action.label, danger: true, run }))}
    >
      {action.label}
    </button>
  );
}

// ── Package diff ─────────────────────────────────────────────────────────────

function versions(list: string[]): string {
  return list.length === 0 ? "∅" : list.map((version) => version || "ε").join(", ");
}

type ChangeRow = [kind: string, tone: string, change: PackageChange];

// What a switch would change: counts, the closure's size before and after, every changed package, and nix-diff's account.
export function DiffView({ diff }: { diff: ClosureDiff }) {
  if (!diff.built) return <Empty title="The flake's closure is not built on the host yet." hint="Build it first to see what a switch changes; a switch builds it anyway." />;
  const rows: ChangeRow[] = [
    ...diff.changed.map((change): ChangeRow => ["changed", "info", change]),
    ...diff.added.map((change): ChangeRow => ["added", "good", change]),
    ...diff.removed.map((change): ChangeRow => ["removed", "bad", change]),
  ];
  const before = diff.closure_before_bytes;
  const after = diff.closure_after_bytes;
  const closure_change = before !== null && after !== null ? `Closure ${size(before)} → ${size(after)} (${after === before ? "no change" : size_change(after - before)})` : null;
  return (
    <div className="stack diff">
      <div className="change-summary">
        <Badge tone="info">{diff.changed.length} changed</Badge>
        <Badge tone="good">{diff.added.length} added</Badge>
        <Badge tone="bad">{diff.removed.length} removed</Badge>
        {diff.resized.length > 0 && <Badge>{diff.resized.length} resized</Badge>}
        {closure_change && <span className="muted small">{closure_change}</span>}
      </div>
      {rows.length > 0
        ? <DataTable<ChangeRow> caption="Package changes" rows={rows} columns={[
          { label: "Package", cell: ([, , change]) => <code>{change.name}</code> },
          { label: "Change", cell: ([kind, tone]) => <span className={`tone-${tone}`}>{kind}</span> },
          { label: "Versions", cell: ([, , change]) => `${versions(change.from)} → ${versions(change.to)}` },
          { label: "Size", class: "number", cell: ([, , change]) => size_change(change.size_delta_bytes) },
        ]} />
        : <p className="muted">No package changed version.</p>}
      {diff.derivation_diff && <details className="command"><summary>Derivation differences (nix-diff)</summary><pre className="output">{diff.derivation_diff}</pre></details>}
      {diff.note && <p className="muted small">{diff.note}</p>}
      {diff.error && <p className="tone-bad">{diff.error}</p>}
      <p className="muted small">
        Compared <Age epoch={diff.checked_epoch} />
        {diff.job_id !== null && <> in <a href={link(["jobs", String(diff.job_id)])}>diff #{diff.job_id}</a></>}
      </p>
    </div>
  );
}

// ── Wording ──────────────────────────────────────────────────────────────────

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

// The page a job's owner is shown on.
export function job_owner_link(job: Job): string {
  if (provision_job_kinds.has(job.kind)) return link(["provision"]);
  if (job.kind === "update") return link(["flakes", job.deployment_id]);
  if (job.deployment_id.startsWith("host:")) return link(["hosts", job.deployment_id.slice("host:".length)]);
  return link([cache_job_kinds.has(job.kind) ? "cache" : "deployments", job.deployment_id]);
}

export function JobsTable({ jobs, show_deployment }: { jobs: Job[]; show_deployment: boolean }) {
  return (
    <DataTable<Job> caption="Jobs" rows={jobs} row_key={(job) => job.id} columns={[
      { label: "Job", cell: (job) => <a href={link(["jobs", String(job.id)])}>{job.kind} #{job.id}</a> },
      ...(show_deployment ? [{ label: "For", cell: (job: Job) => <a href={job_owner_link(job)}>{job.deployment_id}</a> }] : []),
      { label: "State", cell: (job) => <JobBadge state={job.state} /> },
      { label: "Started", cell: (job) => <Age epoch={job.started_epoch} /> },
      { label: "By", cell: (job) => job.trigger },
      { label: "Last line", cell: (job) => <span className="muted small">{job.error ?? job.progress ?? ""}</span> },
    ]} />
  );
}
