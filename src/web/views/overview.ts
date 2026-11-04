// The Overview: the fleet in counts, the hosts that need attention and why, and the jobs running now. Each host's own
// state is on the Hosts page, which every row here links to.

import { api, type Health, type Job, type Status } from "../api.ts";
import { age, h, stamp } from "../dom.ts";
import { link } from "../router.ts";
import { data_table, empty, load, section, status_badge } from "../ui.ts";
import { host_rows, row_status, type Row } from "./hosts.ts";
import { drift_state, jobs_table, refresh_interval_in_milliseconds, tile, type View } from "./shared.ts";
import { last_collection_tone } from "./store.ts";

export function overview_view(): View {
  const summary = h("div", { class: "stack" });
  const jobs = h("div", { class: "stack" });
  const server = h("p", { class: "muted" });

  const refresh = (quiet: boolean) => Promise.all([
    load(summary, async () => {
      const rows = await host_rows();
      if (rows.length === 0) return empty("No hosts yet.", "Name each NixOS host and its flake under deployments in the config file.");
      const attention = rows.filter((row) => reasons(row).length > 0 || troubled.has(row_status(row) ?? "online"));
      return [
        tiles(rows),
        section("Needs attention", attention.length === 0 ? empty("Nothing needs attention.") : attention_table(attention)),
      ];
    }, { quiet }),
    load(jobs, async () => {
      const running = (await api<Job[]>("/api/jobs?limit=100")).filter((job) => job.state === "running");
      return running.length === 0 ? empty("Nothing is running.") : jobs_table(running, true);
    }, { quiet }),
  ]);
  void refresh(false);
  void api<Health>("/api/health").then((health) => server.replaceChildren(
    `X-Nix ${health.version} on ${health.server_name}, started `, h("span", { title: stamp(health.started_epoch) }, age(health.started_epoch)), "."));
  const timer = setInterval(() => void refresh(true), refresh_interval_in_milliseconds);

  return {
    title: "Overview",
    root: h("div", { class: "page" },
      h("h1", {}, "Overview"),
      server,
      summary,
      section("Running now", jobs),
    ),
    dispose: () => clearInterval(timer),
  };
}

// The statuses that put a host on the attention list even when no reason below names why; its page says.
const troubled = new Set<Status>(["unavailable", "warning", "failed"]);

// ── Parts ────────────────────────────────────────────────────────────────────

function tiles(rows: Row[]): HTMLElement {
  const deployed = rows.flatMap((row) => (row.deployment === null ? [] : [row.deployment]));
  const counted = (number: number, tone: "warn" | "bad") => [String(number), number > 0 ? `tone-edge-${tone}` : null] as const;
  const in_sync = deployed.filter((deployment) => drift_state(deployment)[1] === "good").length;
  return h("div", { class: "tiles" },
    tile("Hosts", String(rows.length)),
    tile("In sync", `${in_sync} of ${deployed.length}`, in_sync < deployed.length ? "tone-edge-warn" : null),
    tile("Failing", ...counted(rows.filter((row) => row_status(row) === "failed").length, "bad")),
    tile("Reboot needed", ...counted(deployed.filter((deployment) => deployment.reading?.reboot_required === true).length, "warn")),
    tile("Agents offline", ...counted(rows.filter(({ host }) => agent_offline(host)).length, "warn")),
  );
}

function attention_table(rows: Row[]): HTMLElement {
  return data_table<Row>([
    { label: "Host", cell: ({ host }) => h("a", { href: link(["hosts", host.name]) }, host.display_name) },
    { label: "Status", cell: (row) => status_badge(row_status(row)) },
    { label: "Why", cell: (row) => h("span", { class: "chips inline-chips" }, ...reasons(row).map(([text, tone]) => h("span", { class: `badge tone-${tone}` }, text))) },
  ], rows, "Needs attention");
}

// What is wrong with a host and its deployment, each in a word or two with a tone.
function reasons({ host, deployment }: Row): [text: string, tone: "warn" | "bad"][] {
  const found: [string, "warn" | "bad"][] = [];
  if (agent_offline(host)) found.push(["Agent offline", "warn"]);
  if (deployment !== null) {
    const [drift, tone] = drift_state(deployment);
    if (tone === "warn" || tone === "bad") found.push([drift, tone]);
    if (deployment.reading?.reboot_required === true) found.push(["Reboot needed", "warn"]);
  }
  // A host whose agent is offline has never had a collection read, which says nothing about its store.
  const store = host.gc === null || agent_offline(host) ? "none" : last_collection_tone(host);
  if (store === "warn" || store === "bad") found.push(["Garbage collection", store]);
  return found;
}

function agent_offline(host: Row["host"]): boolean {
  return !host.own && host.agent === null;
}
