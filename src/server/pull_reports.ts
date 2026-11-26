// Takes the switches an agent ran on its own from Git while X-Nix was unreachable into the job history of every
// deployment on that host, and the revisions it refused into their events, once the agent is back and reports them.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { PullReport } from "../shared/agent_protocol.ts";
import type { Deployment } from "./deployment.ts";
import type { Store } from "./store.ts";

// ── Checking ─────────────────────────────────────────────────────────────────

const output_limit_in_bytes = 256 * 1024;

// The most reports one message is read for, the rest left unacknowledged for the agent to report again, and the longest any other text field may be.
export const max_reports_per_message = 100;
export const max_report_field_length = 16 * 1024;

// A text field of a report cut to its limit; the output keeps its own, longer limit from the end.
function bounded_field(key: string, value: string): string {
  return key === "output" ? value : value.slice(0, max_report_field_length);
}

// The report as sent, or null for one missing a field it needs.
export function read_report(raw: unknown): PullReport | null {
  if (typeof raw !== "object" || raw === null) return null;
  const values = raw as Record<string, unknown>;
  const text = (key: string) => (typeof values[key] === "string" ? bounded_field(key, values[key] as string) : null);
  const number = (key: string) => (typeof values[key] === "number" && Number.isFinite(values[key]) ? Math.floor(values[key] as number) : null);
  const run_id = text("run_id");
  const started_epoch = number("started_epoch");
  if (run_id === null || run_id === "" || started_epoch === null) return null;
  return {
    run_id,
    remote: text("remote") ?? "an unnamed remote",
    branch: text("branch") ?? "an unnamed branch",
    revision: text("revision") ?? "an unknown revision",
    command: text("command") ?? "",
    started_epoch,
    finished_epoch: number("finished_epoch"),
    exit_code: number("exit_code"),
    output: (text("output") ?? "").slice(-output_limit_in_bytes),
    refused: text("refused"),
  };
}

// ── Recording ────────────────────────────────────────────────────────────────

// Adds each switch report as a finished job, and each refusal as an event, to every deployment the host serves, answering with the run ids kept.
export function record_pulls(store: Store, deployments: Iterable<Deployment>, host: string, pulls: unknown[], now: number): string[] {
  const owners = [...deployments].filter((deployment) => deployment.settings.host === host);
  const kept: string[] = [];
  for (const raw of pulls.slice(0, max_reports_per_message)) {
    const report = read_report(raw);
    if (report === null) continue;
    if (report.refused) {
      const what = `${report.revision.slice(0, 12)} of ${report.branch} from ${report.remote}`;
      for (const deployment of owners) store.add_event(deployment.id, report.started_epoch, "error", `While X-Nix was unreachable, the agent refused ${what}: ${report.refused}`);
      kept.push(report.run_id);
      continue;
    }
    for (const deployment of owners) {
      if (store.job_for_run(deployment.id, report.run_id) !== null) continue;
      const job_id = store.create_job({
        deployment_id: deployment.id, kind: "switch", command: report.command, agent: host, run_id: report.run_id, trigger: "agent pull",
        started_epoch: report.started_epoch,
      });
      store.append_output(job_id, report.output);
      const ok = report.exit_code === 0;
      const error = ok ? null : report.exit_code === null ? "The run ended without writing an exit code" : `Exited with status ${report.exit_code}`;
      store.finish_job(job_id, ok ? "succeeded" : "failed", report.exit_code, error, report.finished_epoch ?? now);
      const what = `${report.revision.slice(0, 12)} of ${report.branch} from ${report.remote}`;
      store.add_event(deployment.id, now, ok ? "info" : "error", ok
        ? `While X-Nix was unreachable, the agent switched to ${what}`
        : `While X-Nix was unreachable, the agent's switch to ${what} failed: ${error}`);
      deployment.request_evaluation();
    }
    kept.push(report.run_id);
  }
  return kept;
}
