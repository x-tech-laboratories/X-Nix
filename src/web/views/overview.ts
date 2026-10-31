// The Overview: the server itself, and soon one tile per NixOS deployment.

import { api, type Health } from "../api.ts";
import { age, h, stamp } from "../dom.ts";
import { empty, facts, load, section } from "../ui.ts";
import type { View } from "./shared.ts";

export function overview_view(): View {
  const server = h("div");
  void load(server, async () => {
    const health = await api<Health>("/api/health");
    return facts([
      ["Server", health.server_name],
      ["Version", health.version],
      ["Started", h("span", { title: stamp(health.started_epoch) }, age(health.started_epoch))],
    ]);
  });

  return {
    title: "Overview",
    root: h("div", { class: "page" },
      h("h1", {}, "Overview"),
      h("p", { class: "muted" }, "X-Nix watches and deploys NixOS machines from their flake."),
      section("Server", server),
      section("Deployments", empty("No deployments yet.", "Each deployment shows its generation and whether it is in sync, drifting or failed.")),
    ),
  };
}
