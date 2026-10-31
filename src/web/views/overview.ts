// The Overview: one tile per NixOS deployment with its generation and whether it is in sync, and the server itself.

import { api, type Deployment, type Health } from "../api.ts";
import { age, h, stamp } from "../dom.ts";
import { empty, facts, load, section } from "../ui.ts";
import { deployment_card, refresh_interval_in_milliseconds, type View } from "./shared.ts";

export function overview_view(): View {
  const deployments = h("div");
  const server = h("div");
  const refresh = (quiet: boolean) => load(deployments, async () => {
    const list = await api<Deployment[]>("/api/deployments");
    if (list.length === 0) return empty("No deployments yet.", "Name each NixOS host and its flake under deployments in the config file.");
    return h("div", { class: "grid" }, ...list.map(deployment_card));
  }, { quiet });
  void refresh(false);
  void load(server, async () => {
    const health = await api<Health>("/api/health");
    return facts([
      ["Server", health.server_name],
      ["Version", health.version],
      ["Started", h("span", { title: stamp(health.started_epoch) }, age(health.started_epoch))],
    ]);
  });
  const timer = setInterval(() => void refresh(true), refresh_interval_in_milliseconds);

  return {
    title: "Overview",
    root: h("div", { class: "page" },
      h("h1", {}, "Overview"),
      h("p", { class: "muted" }, "X-Nix watches and deploys NixOS machines from their flake."),
      section("NixOS deployments", deployments),
      section("Server", server),
    ),
    dispose: () => clearInterval(timer),
  };
}
