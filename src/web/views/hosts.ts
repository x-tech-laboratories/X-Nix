// The Hosts pages: every machine X-Nix reaches as a card, and one host with its agent, how it is woken, and its deployments.

import { api, type EventRow, type Host, type Status } from "../api.ts";
import { age, bytes, h, nodes, stamp } from "../dom.ts";
import { link } from "../router.ts";
import { crumbs, data_table, empty, facts, load, section, status_badge } from "../ui.ts";
import { duration, events_list, host_action_button, refresh_interval_in_milliseconds, tile, type View } from "./shared.ts";

const status_tones: Record<Status, string> = { online: "good", info: "good", unavailable: "warn", warning: "warn", failed: "bad" };

// ── List ─────────────────────────────────────────────────────────────────────

export function hosts_view(): View {
  const list = h("div");
  const refresh = (quiet: boolean) => load(list, async () => {
    const hosts = await api<Host[]>("/api/hosts");
    if (hosts.length === 0) return empty("No hosts yet.", "Name each machine under hosts in the config file, or name it as a deployment's host.");
    return h("div", { class: "grid" }, ...hosts.map(host_card));
  }, { quiet });
  void refresh(false);
  const timer = setInterval(() => void refresh(true), refresh_interval_in_milliseconds);

  return {
    title: "Hosts",
    root: h("div", { class: "page" },
      h("h1", {}, "Hosts"),
      h("p", { class: "muted" }, "Each machine X-Nix reaches: its agent, how it is woken, its Nix store and its boot entries."),
      list,
    ),
    dispose: () => clearInterval(timer),
  };
}

function host_card(host: Host): HTMLElement {
  const tone = host.reading === null ? "none" : status_tones[host.reading.status];
  return h("a", { class: `card tone-edge-${tone}`, href: link(["hosts", host.name]) },
    h("div", { class: "card-head" }, h("strong", {}, host.display_name), status_badge(host.reading?.status ?? null)),
    h("div", { class: "muted card-host" }, host.own ? "this server" : host.name),
    h("dl", {},
      h("dt", {}, "Agent"), h("dd", { class: agent_tone(host) }, agent_text(host)),
      h("dt", {}, "Store used"), h("dd", {}, host.reading?.store?.used_percent == null ? "—" : `${host.reading.store.used_percent.toFixed(1)}%`),
      h("dt", {}, "Reboot"), h("dd", { class: host.system?.reboot_required ? "tone-warn" : null }, host.system?.reboot_required ? "Needed" : host.system ? "Not needed" : "—"),
      h("dt", {}, "Deployments"), h("dd", {}, String(host.deployments.length)),
    ));
}

// ── One host ─────────────────────────────────────────────────────────────────

export function host_view(name: string): View {
  const body = h("div", { class: "stack" });
  const heading = h("h1", {}, name);
  const badge = h("span");
  const buttons = h("div", { class: "head-actions" });
  const path = `/api/hosts/${encodeURIComponent(name)}`;

  const refresh = (quiet: boolean) => load(body, async () => {
    const [host, events] = await Promise.all([api<Host>(path), api<EventRow[]>(`${path}/events`)]);
    heading.textContent = host.display_name;
    badge.replaceChildren(status_badge(host.reading?.status ?? null));
    buttons.replaceChildren(...host.actions.map((action) => host_action_button(host, action, () => refresh(true))));
    const store = host.reading?.store ?? null;
    return nodes([
      h("div", { class: "tiles" },
        tile("Agent", agent_text(host), host.agent === null && !host.own ? "tone-edge-warn" : null),
        tile("Store used", store?.used_percent == null ? "—" : `${store.used_percent.toFixed(1)}%`),
        tile("Last collection", host.state.last_collection ? age(host.state.last_collection.epoch) : "—"),
        tile("Reboot", host.system?.reboot_required ? "Needed" : host.system ? "Not needed" : "—", host.system?.reboot_required ? "tone-edge-warn" : null),
        tile("NixOS", host.system?.version ?? "—"),
      ),
      section("Deployments", host.deployments.length === 0 ? empty("Nothing is deployed to this host.") : data_table<Host["deployments"][number]>([
        { label: "Deployment", cell: (deployment) => h("a", { href: link(["deployments", deployment.id]) }, deployment.name) },
      ], host.deployments, "Deployments")),
      section("Details", details(host)),
      section("Events", events.length === 0 ? empty("No events yet.") : events_list(events)),
    ]);
  }, { quiet });

  void refresh(false);
  const timer = setInterval(() => void refresh(true), refresh_interval_in_milliseconds);

  return {
    title: `Host · ${name}`,
    root: h("div", { class: "page" },
      crumbs([["Hosts", link(["hosts"])], [name, null]]),
      h("header", { class: "page-head" }, h("div", { class: "card-head" }, heading, badge), buttons),
      body,
    ),
    dispose: () => clearInterval(timer),
  };
}

// ── Parts ────────────────────────────────────────────────────────────────────

function details(host: Host): HTMLElement {
  const store = host.reading?.store ?? null;
  const rows: Parameters<typeof facts>[0] = [
    ["Agent", host.own ? "the server itself" : host.agent === null ? (host.agent_key ? "declared, not connected" : "no key declared here") : h("span", {}, `version ${host.agent.agent_version}, connected `, h("span", { title: stamp(host.agent.connected_epoch) }, age(host.agent.connected_epoch)))],
    ["Woken by", host.wake === null ? "never woken" : h("span", {}, "wake-on-LAN to ", h("code", {}, host.wake.mac), ` via ${host.wake.via ?? "the server"} on ${host.wake.broadcast}, waiting up to ${duration(host.wake.timeout)}`)],
    ["Kept awake", host.keep_awake ? "through every job and switch" : "no"],
    ["Read every", duration(host.interval)],
    ["Store", host.gc === null ? "not watched" : h("a", { href: link(["store", host.name]) }, store?.size_bytes == null ? host.gc.store : `${host.gc.store}, ${bytes(store.used_bytes ?? 0)} of ${bytes(store.size_bytes)}`)],
    ["Boot entries", host.boot ? h("a", { href: link(["boot", host.name]) }, `${host.reading?.boot?.entries.length ?? 0} read`) : "not read"],
  ];
  if (host.system?.current) rows.push(["Running system", h("code", {}, host.system.current)]);
  return facts(rows, "rows");
}

function agent_text(host: Host): string {
  if (host.own) return "This server";
  return host.agent === null ? "Not connected" : "Connected";
}

function agent_tone(host: Host): string | null {
  return host.own || host.agent !== null ? null : "tone-warn";
}
