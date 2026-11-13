import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { build_app } from "../src/server/app.ts";
import { hash_password } from "../src/server/auth.ts";
import { Poller } from "../src/server/poller.ts";
import { make_deployment } from "./fake_agent.ts";

// ── Setup ────────────────────────────────────────────────────────────────────

const password = "correct horse battery staple";
const protocol_version = "2025-06-18";

let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

async function sign_in(name: string, given: string): Promise<string> {
  const login = await app!.inject({ method: "POST", url: "/api/login", payload: { name, password: given } });
  return String(login.headers["set-cookie"]).split(";")[0]!;
}

// The app with an admin and a viewer, and a cookie for each.
async function start_app() {
  const harness = make_deployment();
  app = await build_app({ serve_web: false, logger: false, accounts: new Map([["admin", hash_password(password)]]), store: harness.store, poller: new Poller([harness.deployment]) });
  const admin = await sign_in("admin", password);
  await app.inject({ method: "POST", url: "/api/users", headers: { cookie: admin }, payload: { name: "vera", role: "viewer", access: null, password: "a long viewer password" } });
  const viewer = await sign_in("vera", "a long viewer password");
  const made = await app.inject({ method: "POST", url: "/api/account/tokens", headers: { cookie: admin }, payload: { name: "assistant", read_only: true } });
  const reader = `Bearer ${made.json<{ token: string }>().token}`;
  return { admin: { cookie: admin }, viewer: { cookie: viewer }, reader: { authorization: reader }, id: harness.deployment.id };
}

// Sends one JSON-RPC request with the credential and reads the answer out of the event stream or the JSON body.
async function rpc(credential: Record<string, string>, method: string, params: unknown = {}): Promise<Record<string, unknown>> {
  const reply = await app!.inject({
    method: "POST",
    url: "/api/mcp",
    headers: { ...credential, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": protocol_version },
    payload: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  expect(reply.statusCode).toBe(200);
  const data = reply.headers["content-type"]?.includes("text/event-stream") ? /^data: (.+)$/m.exec(reply.body)![1]! : reply.body;
  return (JSON.parse(data) as { result: Record<string, unknown> }).result;
}

// ── MCP ──────────────────────────────────────────────────────────────────────

describe("/api/mcp", () => {
  it("offers the routes as tools, marking the ones that only read", async () => {
    const { viewer } = await start_app();

    const { tools } = (await rpc(viewer, "tools/list")) as { tools: { name: string; annotations: { readOnlyHint: boolean } }[] };
    const read_only = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations.readOnlyHint]));
    expect(read_only).toMatchObject({ list_deployments: true, get_job: true, run_deployment_action: false, update_flake: false });
    expect(read_only).toMatchObject({ get_health: true, list_backups: true, set_backup_schedule: false, delete_backup: false });
  });

  it("answers the server's own calls, such as who the caller is", async () => {
    const { viewer } = await start_app();

    const me = await rpc(viewer, "tools/call", { name: "get_me", arguments: {} });
    expect(JSON.parse((me.content as { text: string }[])[0]!.text)).toMatchObject({ name: "vera", role: "viewer" });
  });

  it("lets a viewer read, and answers an action with the admin role it needs", async () => {
    const { viewer, id } = await start_app();

    const shown = await rpc(viewer, "tools/call", { name: "get_deployment", arguments: { id } });
    expect(JSON.parse((shown.content as { text: string }[])[0]!.text)).toMatchObject({ id });

    const refused = await rpc(viewer, "tools/call", { name: "run_deployment_action", arguments: { id, action: "build" } });
    expect(refused).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("admin role") }] });
  });

  it("runs an admin's action and answers in the route's own words", async () => {
    const { admin } = await start_app();

    const missing = await rpc(admin, "tools/call", { name: "refresh_deployment", arguments: { id: "nowhere" } });
    expect(missing).toEqual({ isError: true, content: [{ type: "text", text: "No deployment named 'nowhere'" }] });
  });

  it("lets a read-only token read and nothing more, even an admin's", async () => {
    const { reader, id } = await start_app();

    const shown = await rpc(reader, "tools/call", { name: "get_deployment", arguments: { id } });
    expect(JSON.parse((shown.content as { text: string }[])[0]!.text)).toMatchObject({ id });

    const refused = await rpc(reader, "tools/call", { name: "refresh_deployment", arguments: { id } });
    expect(refused).toEqual({ isError: true, content: [{ type: "text", text: "This token can only read." }] });
  });
});
