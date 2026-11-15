// The Overview's map of what builds what: each flake on the left, the caches built from it in the middle, and the hosts
// whose deployments it describes on the right, reached through their cache or straight from the flake; every box opens
// its page, and hovering one follows its lines.

import { age } from "@x-tech-laboratories/x-libs/web/format";
import { FlowMap, FlowMapZoom, use_flow_map, type FlowColumn, type FlowLink, type FlowNode, type FlowTone } from "@x-tech-laboratories/x-libs/web/react/flow_map";
import { Section } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Empty, Loaded, use_resource } from "@x-tech-laboratories/x-libs/web/react/states";
import { link } from "@x-tech-laboratories/x-libs/web/router";
import { api, type Cache, type Deployment, type Flake, type Host, type Status } from "../api.ts";
import { row_status } from "./hosts.tsx";
import { drift_state, live } from "./shared.tsx";

// ── Building ─────────────────────────────────────────────────────────────────

interface Fleet {
  flakes: Flake[];
  caches: Cache[];
  hosts: Host[];
  deployments: Deployment[];
}

const node_id = { flake: (id: string) => `flake:${id}`, cache: (id: string) => `cache:${id}`, host: (name: string) => `host:${name}` };

// An unreachable reading is a warning here, since the map shows only how bad a part is.
function tone_of(status: Status | null | undefined, running: boolean): FlowTone {
  if (running) return "running";
  if (status === null || status === undefined) return "unknown";
  if (status === "failed") return "critical";
  return status === "warning" || status === "unavailable" ? "warning" : "ok";
}

const drift_tones: Record<ReturnType<typeof drift_state>[1], FlowTone> = { good: "ok", warn: "warning", bad: "critical", none: "unknown" };

export function fleet_map({ flakes, caches, hosts, deployments }: Fleet): { columns: FlowColumn[]; links: FlowLink[] } {
  const links: FlowLink[] = [];
  const flake_tone = new Map(flakes.map((flake) => [flake.id, tone_of(flake.reading?.status, flake.running_job !== null)]));

  const flake_nodes = flakes.map((flake): FlowNode => ({
    id: node_id.flake(flake.id),
    label: flake.name,
    tone: flake_tone.get(flake.id),
    href: link(["flakes", flake.id]),
    details: [
      { text: flake.url, mono: true },
      { text: flake.reading?.last_modified_epoch ? `changed ${age(flake.reading.last_modified_epoch)}` : "not read yet" },
    ],
  }));

  const cache_nodes = caches.map((cache): FlowNode => {
    const rows = cache.reading?.rows ?? [];
    const built = rows.filter((row) => row.built).length;
    const pushed = rows.filter((row) => row.pushed_ok).length;
    if (cache.flake_id !== null) {
      links.push({ from: node_id.flake(cache.flake_id), to: node_id.cache(cache.id), tone: flake_tone.get(cache.flake_id), title: `${cache.flake} builds into ${cache.name}` });
    }
    return {
      id: node_id.cache(cache.id),
      label: cache.name,
      tone: tone_of(cache.reading?.status, cache.running_job !== null),
      href: link(["caches", cache.id]),
      details: [
        { text: cache.cache_url, mono: true },
        { text: cache.reading === null ? "not read yet" : `${built} of ${rows.length} built, ${pushed} pushed · on ${(cache.hosts.length > 0 ? cache.hosts : ["this server"]).join(", ")}` },
      ],
    };
  });

  // A host shows the deployments it runs; one with several shows each under its name.
  const host_nodes = hosts.map((host): FlowNode => {
    const own = deployments.filter((deployment) => deployment.host_name === host.name);
    const status = row_status({ host, deployment: own[0] ?? null });
    const running = host.running_job !== null || own.some((deployment) => deployment.running_job !== null);
    for (const deployment of own) {
      const [drift, drift_tone] = drift_state(deployment);
      const cache = deployment.cache_id === null ? undefined : caches.find((item) => item.id === deployment.cache_id);
      if (cache !== undefined) {
        // A cache names each target by its nixosConfigurations attribute, which defaults to the host's hostname.
        const target = deployment.configuration ?? deployment.reading?.hostname;
        const row = cache.reading?.rows.find((item) => item.name === target);
        links.push({ from: node_id.cache(cache.id), to: node_id.host(host.name), tone: row ? tone_of(row.status, false) : "unknown", title: `${cache.name} → ${deployment.name}${row ? `: ${row.summary}` : ""}` });
      } else if (deployment.flake_id !== null) {
        links.push({ from: node_id.flake(deployment.flake_id), to: node_id.host(host.name), tone: drift_tones[drift_tone], title: `${deployment.flake} → ${deployment.name}: ${drift}` });
      }
    }
    const version = host.system?.version ?? own[0]?.reading?.version ?? null;
    return {
      id: node_id.host(host.name),
      label: host.display_name,
      tone: tone_of(status, running),
      href: link(["hosts", host.name]),
      details: own.length === 0
        ? [{ text: "no deployment" }]
        : [
          { text: own.map((deployment) => `${own.length > 1 ? `${deployment.name}: ` : ""}${drift_state(deployment)[0]}`).join(" · ") },
          ...(version === null ? [] : [{ text: `NixOS ${version}` }]),
        ],
    };
  });

  return {
    columns: [
      { title: "Flakes", width: 280, nodes: flake_nodes },
      { title: "Caches", width: 300, nodes: cache_nodes },
      { title: "Hosts", width: 260, nodes: host_nodes },
    ],
    links,
  };
}

// ── Section ──────────────────────────────────────────────────────────────────

export function MapSection() {
  const fleet = use_resource(async (): Promise<Fleet> => {
    const [flakes, caches, hosts, deployments] = await Promise.all([
      api<Flake[]>("/api/flakes"), api<Cache[]>("/api/caches"), api<Host[]>("/api/hosts"), api<Deployment[]>("/api/deployments"),
    ]);
    return { flakes, caches, hosts, deployments };
  }, [], live);
  const handle = use_flow_map();

  return (
    <Section title="What builds what" tools={<FlowMapZoom handle={handle} />}>
      <div>
        <Loaded resource={fleet} lines={6}>
          {(found) => {
            if (found.flakes.length === 0 && found.hosts.length === 0) return <Empty title="Nothing to map yet." hint="Flakes, caches and hosts appear here once they are configured." />;
            const { columns, links } = fleet_map(found);
            return <FlowMap label="Which flakes build which caches, and the hosts they deploy to" columns={columns} links={links} handle={handle} legend={["ok", "warning", "critical", "running", "unknown"]} />;
          }}
        </Loaded>
      </div>
    </Section>
  );
}
