import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { run_command } from "../src/agent/commands.ts";
import { AgentPool, type Agent } from "../src/server/agents/agent.ts";
import { build_app } from "../src/server/app.ts";
import { hash_password } from "../src/server/auth.ts";
import { built_store_path, locate_script, parse_products, product_stream, products_script } from "../src/server/builds.ts";
import { Poller } from "../src/server/poller.ts";
import { Store } from "../src/server/store.ts";
import { FakeAgent, make_deployment, result, target_closure } from "./fake_agent.ts";

function run(command: string) {
  return spawnSync("sh", ["-c", command], { encoding: "utf8" });
}

// A folder standing in for a built store path, holding an ISO product, a folder product and one outside it.
function fake_build(): string {
  const out = mkdtempSync(join(tmpdir(), "x-nix-build-"));
  mkdirSync(join(out, "nix-support"));
  mkdirSync(join(out, "iso"));
  writeFileSync(join(out, "iso", "nixos.iso"), "0123456789");
  const outside = join(mkdtempSync(join(tmpdir(), "x-nix-outside-")), "secret");
  writeFileSync(outside, "secret");
  writeFileSync(join(out, "nix-support", "hydra-build-products"), `file iso ${out}/iso/nixos.iso\ndoc manual "${out}/iso"\nfile secret ${outside}\n`);
  return out;
}

// An agent that runs every command on this machine.
const local_agent: Agent = {
  run: (command, timeout_in_seconds) => run_command(command, { timeout_in_seconds }),
  start: async () => { throw new Error("not used"); },
  poll: async () => { throw new Error("not used"); },
  forget: async () => {},
  write_key: async () => { throw new Error("not used"); },
  check_keys: async () => { throw new Error("not used"); },
};

// ── Store paths ──────────────────────────────────────────────────────────────

describe("the store path of a build", () => {
  it("is the last store path printed on its own line, or the one already in the cache", () => {
    expect(built_store_path(`building...\n${target_closure}\n`)).toBe(target_closure);
    expect(built_store_path(`${target_closure} is already in the cache; not building it\n`)).toBe(target_closure);
    expect(built_store_path("error: build failed\n")).toBeNull();
  });
});

// ── Products ─────────────────────────────────────────────────────────────────

describe("products", () => {
  it("are listed with sizes only for regular files inside the store path", () => {
    const out = fake_build();
    const products = parse_products(run(products_script(out)).stdout);
    expect(products.map((product) => [product.type, product.subtype, product.name, product.size_bytes])).toEqual([
      ["file", "iso", "nixos.iso", 10],
      ["doc", "manual", "iso", null],
      ["file", "secret", "secret", null],
    ]);
    expect(parse_products(run(products_script(join(out, "missing"))).stdout)).toEqual([]);
  });

  it("are located again before a download, refusing a path outside the store path", () => {
    const out = fake_build();
    const inside = run(locate_script(out, `${out}/iso/nixos.iso`));
    expect(inside.stdout).toBe(`10\t${out}/iso/nixos.iso\n`);
    expect(run(locate_script(out, "/etc/hostname")).status).toBe(3);
    expect(run(locate_script(out, `${out}/iso`)).status).toBe(4);
  });

  it("stream a file through the agent piece by piece", async () => {
    const folder = mkdtempSync(join(tmpdir(), "x-nix-piece-"));
    const big = Buffer.alloc(9 * 1024 * 1024 + 5, 7);
    big.write("start", 0);
    big.write("end", big.length - 3);
    writeFileSync(join(folder, "big"), big);
    const chunks: Buffer[] = [];
    for await (const chunk of product_stream(local_agent, join(folder, "big"), big.length)) chunks.push(chunk as Buffer);
    expect(chunks).toHaveLength(2);
    expect(Buffer.concat(chunks).equals(big)).toBe(true);
  });
});

// ── Recording ────────────────────────────────────────────────────────────────

describe("recording", () => {
  it("keeps a finished deployment build with its store path and products", async () => {
    const harness = make_deployment({ configuration: "host" });
    harness.agent.command_result = result(0, `@@x-nix-product\tfile\tiso\t${target_closure}/iso/a.iso\t42\n`);
    await harness.deployment.act("build");
    expect(harness.agent.last_run("build --no-link --print-out-paths")).toBeDefined();
    harness.agent.end(harness.agent.last_run("build")!, `building\n${target_closure}\n`, 0);

    await harness.deployment.cycle();

    const [build] = harness.store.builds({ owner_id: "host-deploy" });
    expect(build).toMatchObject({ target: "host", store_path: target_closure, succeeded: true });
    expect(build.products).toEqual([{ type: "file", subtype: "iso", path: `${target_closure}/iso/a.iso`, name: "a.iso", size_bytes: 42 }]);
  });

  it("keeps a failed build without reading products", async () => {
    const harness = make_deployment({ configuration: "host" });
    await harness.deployment.act("build");
    harness.agent.end(harness.agent.last_run("build")!, "error: build failed\n", 1);
    const commands_before = harness.agent.commands.length;

    await harness.deployment.cycle();

    expect(harness.store.builds()[0]).toMatchObject({ succeeded: false, store_path: null, products: [] });
    expect(harness.agent.commands.slice(commands_before).some((command) => command.includes("hydra-build-products"))).toBe(false);
  });
});

// ── Downloads ────────────────────────────────────────────────────────────────

describe("/api/builds", () => {
  const password = "correct horse battery staple";
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  // An agent answering the locate script with a path and size, and each piece with base64 of its bytes.
  class ProductAgent extends FakeAgent {
    override async run(command: string) {
      this.commands.push(command);
      if (command.includes("realpath")) return command.includes("outside") ? result(3, "", "It is not inside the build's store path") : result(0, `5\t${target_closure}/iso/a.iso\n`);
      if (command.startsWith("dd ")) return result(0, Buffer.from("hello").toString("base64"));
      return result(0);
    }
  }

  async function start(store: Store, agent: Agent) {
    const harness = make_deployment({}, { store });
    app = await build_app({ serve_web: false, logger: false, password_hash: hash_password(password), store, poller: new Poller([harness.deployment]), agents: new AgentPool("host", agent) });
    const login = await app.inject({ method: "POST", url: "/api/login", payload: { password } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const server = app;
    return (url: string) => server.inject({ method: "GET", url, headers: { cookie } });
  }

  function seed(store: Store): number {
    return store.add_build({
      job_id: 1, owner_id: "host-deploy", target: "host", agent: null, store_path: target_closure, succeeded: true, started_epoch: 1, finished_epoch: 61,
      products: [
        { type: "file", subtype: "iso", path: `${target_closure}/iso/a.iso`, name: "a.iso", size_bytes: 5 },
        { type: "doc", subtype: "manual", path: `${target_closure}/share/doc`, name: "doc", size_bytes: null },
        { type: "file", subtype: "x", path: "/nix/store/outside", name: "outside", size_bytes: 5 },
      ],
    });
  }

  it("lists builds with their targets, filtered by owner", async () => {
    const store = new Store(":memory:");
    seed(store);
    const get = await start(store, new ProductAgent());

    expect((await get("/api/builds")).json()).toMatchObject({ builds: [{ target: "host" }], targets: [{ owner_id: "host-deploy", target: "host" }] });
    expect((await get("/api/builds?owner=other")).json().builds).toEqual([]);
  });

  it("sends a product file, and refuses anything not a file inside the store path", async () => {
    const store = new Store(":memory:");
    const id = seed(store);
    const get = await start(store, new ProductAgent());

    const download = await get(`/api/builds/${id}/products/0`);
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-disposition"]).toBe('attachment; filename="a.iso"');
    expect(download.body).toBe("hello");
    expect((await get(`/api/builds/${id}/products/1`)).statusCode).toBe(404);
    expect((await get(`/api/builds/${id}/products/2`)).statusCode).toBe(410);
    expect((await get(`/api/builds/${id}/products/9`)).statusCode).toBe(404);
    expect((await get("/api/builds/999/products/0")).statusCode).toBe(404);
    expect((await app!.inject({ method: "GET", url: `/api/builds/${id}/products/0` })).statusCode).toBe(401);
  });
});
