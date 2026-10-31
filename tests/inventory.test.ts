import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { AgentPool } from "../src/server/agents/agent.ts";
import { LocalAgent } from "../src/server/agents/local.ts";
import { ConfigError, parse_config } from "../src/server/config.ts";
import { Inventory, machines_refusal, parse_inventory, with_machines } from "../src/server/inventory.ts";
import { Store } from "../src/server/store.ts";
import { clock } from "./fake_agent.ts";

// ── Setup ────────────────────────────────────────────────────────────────────

// A git checkout holding an inventory, standing in for the fleet's flake.
function local_flake(inventory: unknown): string {
  const folder = mkdtempSync(join(tmpdir(), "x-nix-inventory-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", folder, "-c", "user.name=Test", "-c", "user.email=test@localhost", ...args], { stdio: "ignore" });
  git("init", "--quiet");
  writeFileSync(join(folder, "inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`);
  git("add", "inventory.json");
  git("commit", "--quiet", "-m", "init");
  return folder;
}

function inventory_for(flake: string) {
  const store = new Store(":memory:");
  const agents = new AgentPool("host", new LocalAgent(mkdtempSync(join(tmpdir(), "x-nix-agent-"))));
  const settings = parse_config({ inventory: { flake } }).inventory!;
  return { store, inventory: new Inventory(settings, { store, agents, suggestions: ["odin"], now: () => clock.now }) };
}

// ── Config ───────────────────────────────────────────────────────────────────

describe("the inventory setting", () => {
  it("is off when absent, and defaults its file and commit when set", () => {
    expect(parse_config({}).inventory).toBeNull();
    expect(parse_config({ inventory: { flake: "github:owner/fleet", push_ssh_key: "/k" } }).inventory).toEqual({
      flake: "github:owner/fleet", file: "inventory.json", host: null, push_ssh_key: "/k", commit_author: "X-Nix <x-nix@localhost>", commit_message: "chore(inventory): update machines",
    });
  });

  it("needs a flake, a plain file inside it, and the inventory id to itself", () => {
    expect(() => parse_config({ inventory: {} })).toThrow(ConfigError);
    expect(() => parse_config({ inventory: { flake: "/srv/fleet", file: "/etc/passwd" } })).toThrow(ConfigError);
    expect(() => parse_config({ inventory: { flake: "/srv/fleet" }, deployments: [{ id: "inventory" }] })).toThrow(/inventory/);
  });
});

// ── File ─────────────────────────────────────────────────────────────────────

describe("the inventory file", () => {
  it("lists each machine's tags and roles, sorted by name", () => {
    const { machines } = parse_inventory(JSON.stringify({ machines: { thor: { roles: ["web"] }, odin: { tags: ["server"], roles: ["backup"] } } }));

    expect(machines).toEqual([{ name: "odin", tags: ["server"], roles: ["backup"] }, { name: "thor", tags: [], roles: ["web"] }]);
  });

  it("keeps every other key when the machines change", () => {
    const { document } = parse_inventory(JSON.stringify({ meta: { name: "fleet" }, machines: { odin: { tags: [], roles: [], description: "the big one" }, gone: {} } }));

    const written = JSON.parse(with_machines(document, [{ name: "odin", tags: ["server", "server"], roles: ["web"] }]));

    expect(written).toEqual({ meta: { name: "fleet" }, machines: { odin: { tags: ["server"], roles: ["web"], description: "the big one" } } });
  });

  it("refuses machines with odd names, repeated names or odd roles", () => {
    expect(machines_refusal([{ name: "odin", tags: [], roles: ["web"] }])).toBeNull();
    expect(machines_refusal([{ name: "a b", tags: [], roles: [] }])).toContain("name");
    expect(machines_refusal([{ name: "odin", tags: [], roles: [] }, { name: "odin", tags: [], roles: [] }])).toContain("Two machines");
    expect(machines_refusal([{ name: "odin", tags: ["$(id)"], roles: [] }])).toContain("tags");
    expect(machines_refusal("odin")).not.toBeNull();
  });
});

// ── Saving ───────────────────────────────────────────────────────────────────

describe("saving the inventory", () => {
  it("reads the file, then commits the edited machines to the flake as one job", async () => {
    const flake = local_flake({ machines: { odin: { tags: ["server"], roles: [] } } });
    const { store, inventory } = inventory_for(flake);

    const view = await inventory.view();
    const outcome = await inventory.save([{ name: "odin", tags: ["server"], roles: ["web"] }, { name: "thor", tags: [], roles: ["backup"] }], view.hash!, "manual");

    expect(view.machines).toEqual([{ name: "odin", tags: ["server"], roles: [] }]);
    expect(view.suggestions).toEqual(["odin"]);
    expect(outcome.ok).toBe(true);
    expect(JSON.parse(readFileSync(join(flake, "inventory.json"), "utf8")).machines.thor).toEqual({ tags: [], roles: ["backup"] });
    expect(execFileSync("git", ["-C", flake, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim()).toBe("chore(inventory): update machines");
    expect(store.job(outcome.job_id!)).toMatchObject({ deployment_id: "inventory", kind: "inventory", state: "succeeded" });
  });

  it("refuses to overwrite a file that changed since it was read", async () => {
    const flake = local_flake({ machines: {} });
    const { inventory } = inventory_for(flake);
    const view = await inventory.view();

    writeFileSync(join(flake, "inventory.json"), JSON.stringify({ machines: { other: {} } }));
    const outcome = await inventory.save([], view.hash!, "manual");

    expect(outcome).toMatchObject({ ok: false, job_id: null });
    expect(outcome.message).toContain("changed since it was read");
  });

  it("reads as unconfigured when no inventory is set", async () => {
    const inventory = new Inventory(null, { store: new Store(":memory:"), agents: new AgentPool("host", new LocalAgent(mkdtempSync(join(tmpdir(), "x-nix-agent-")))) });

    expect(await inventory.view()).toMatchObject({ configured: false, machines: [] });
    expect((await inventory.save([], "missing", "manual")).ok).toBe(false);
  });
});
