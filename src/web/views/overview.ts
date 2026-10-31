// The Overview: one tile per NixOS deployment with its generation and whether it is in sync, the fleet's status as one
// table, the agents on the other hosts, and the server itself.

import { api, type AgentEntry, type Deployment, type Health } from "../api.ts";
import { age, h, stamp } from "../dom.ts";
import { data_table, empty, facts, load, section } from "../ui.ts";
import { deployment_card, fleet_status_table, refresh_interval_in_milliseconds, type View } from "./shared.ts";

export function overview_view(): View {
  const deployments = h("div");
  const fleet = h("div");
  const server = h("div");
  const agents = h("div");
  const refresh = (quiet: boolean) => load(deployments, async () => {
    const list = await api<Deployment[]>("/api/deployments");
    fleet.replaceChildren(list.length === 0 ? empty("No deployments yet.") : fleet_status_table(list));
    if (list.length === 0) return empty("No deployments yet.", "Name each NixOS host and its flake under deployments in the config file.");
    return h("div", { class: "grid" }, ...list.map(deployment_card));
  }, { quiet });
  void refresh(false);
  const refresh_agents = (quiet: boolean) => load(agents, async () => {
    const list = await api<AgentEntry[]>("/api/agents");
    if (list.length === 0) return empty("No other hosts.", "Declare each host's agent key under agents in the config, and run x-nix-agent there.");
    return data_table<AgentEntry>([
      { label: "Host", cell: (entry) => entry.host },
      { label: "Agent", cell: (entry) => (entry.status === null ? h("span", { class: "tone-warn" }, "Not connected") : h("span", { class: "tone-good" }, "Connected")) },
      { label: "Since", cell: (entry) => (entry.status === null ? "" : h("span", { title: stamp(entry.status.connected_epoch) }, age(entry.status.connected_epoch))) },
      { label: "Version", cell: (entry) => entry.status?.agent_version ?? "" },
    ], list, "Agents");
  }, { quiet });
  void refresh_agents(false);
  void load(server, async () => {
    const health = await api<Health>("/api/health");
    return facts([
      ["Server", health.server_name],
      ["Version", health.version],
      ["Started", h("span", { title: stamp(health.started_epoch) }, age(health.started_epoch))],
    ]);
  });
  const timer = setInterval(() => {
    void refresh(true);
    void refresh_agents(true);
  }, refresh_interval_in_milliseconds);

  return {
    title: "Overview",
    root: h("div", { class: "page" },
      h("h1", {}, "Overview"),
      h("p", { class: "muted" }, "X-Nix watches and deploys NixOS machines from their flake."),
      section("NixOS deployments", deployments),
      section("Fleet status", fleet),
      section("Agents", agents),
      section("Server", server),
    ),
    dispose: () => clearInterval(timer),
  };
}
