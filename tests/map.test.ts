import { expect, test } from "vitest";

import type { Cache, Deployment, Flake, Host } from "../src/web/api.ts";
import { fleet_map } from "../src/web/views/map.tsx";

const flake = { id: "technet", name: "TechNet", url: "github:me/technet", reading: { status: "online", last_modified_epoch: null }, running_job: null } as unknown as Flake;
const cache = {
  id: "main", name: "Main", flake: "github:me/technet", flake_id: "technet", cache_url: "https://cache.example", hosts: ["odin"], running_job: null,
  reading: { status: "online", rows: [{ name: "Thor", built: true, pushed_ok: false, status: "warning", summary: "Built, not pushed" }] },
} as unknown as Cache;
const host = (name: string) => ({ name, display_name: name.toUpperCase(), running_job: null, reading: null, system: null }) as unknown as Host;
const deployment = (name: string, cache_id: string | null) => ({
  id: name, name: name.charAt(0).toUpperCase() + name.slice(1), host_name: name, flake: "github:me/technet", flake_id: "technet", cache_id,
  evaluation: { eval_error: null }, evaluating: false, reading: { status: "online", up_to_date: true, version: "26.11" }, running_job: null,
}) as unknown as Deployment;

test("a deployment with a cache is reached through it, one without straight from its flake", () => {
  const { columns, links } = fleet_map({ flakes: [flake], caches: [cache], hosts: [host("thor"), host("odin"), host("loki")], deployments: [deployment("thor", "main"), deployment("odin", null)] });

  expect(columns.map((column) => column.title)).toEqual(["Flakes", "Caches", "Hosts"]);
  expect(links.map((link) => `${link.from}>${link.to}:${link.tone}`)).toEqual([
    "flake:technet>cache:main:ok",
    "cache:main>host:thor:warning",
    "flake:technet>host:odin:ok",
  ]);
  const hosts = columns[2].nodes!;
  expect(hosts.find((node) => node.id === "host:thor")!.details!.map((detail) => detail.text)).toEqual(["In sync", "NixOS 26.11"]);
  expect(hosts.find((node) => node.id === "host:loki")!.details![0].text).toBe("no deployment");
  expect(columns[1].nodes![0].details![1].text).toBe("1 of 1 built, 0 pushed · on odin");
});
