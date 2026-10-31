import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { build_app } from "../src/server/app.ts";
import { hash_password } from "../src/server/auth.ts";
import type { Deployment } from "../src/server/deployment.ts";
import { normalize_repository, repository_of } from "../src/server/nixos/flake.ts";
import { Poller } from "../src/server/poller.ts";
import { Store } from "../src/server/store.ts";
import { is_signed, load_webhook_secret, push_matches, read_push, Webhook, WebhookError } from "../src/server/webhook.ts";
import { FakeAgent, make_deployment } from "./fake_agent.ts";

// A made-up secret for these tests only.
const secret = "test-webhook-secret";

function sign(body: string, key = secret): string {
  return `sha256=${createHmac("sha256", key).update(body).digest("hex")}`;
}

// A push as GitHub and Forgejo send it.
function push_payload(branch = "main", repository = "owner/config"): string {
  return JSON.stringify({
    ref: `refs/heads/${branch}`,
    repository: {
      clone_url: `https://github.com/${repository}.git`, ssh_url: `git@github.com:${repository}.git`, html_url: `https://github.com/${repository}`,
      default_branch: "main",
    },
  });
}

// ── Repositories ─────────────────────────────────────────────────────────────

describe("a repository", () => {
  it("compares equal in every form a forge or flake gives it", () => {
    const forms = ["https://github.com/Owner/Config.git", "git@github.com:owner/config.git", "ssh://git@github.com:22/owner/config", "git+https://github.com/owner/config/"];
    expect(new Set(forms.map(normalize_repository))).toEqual(new Set(["github.com/owner/config"]));
    expect(normalize_repository("file:///srv/config")).toBeNull();
  });

  it("is read from a forge or git flake with the branch it follows", () => {
    expect(repository_of("github:owner/config")).toEqual({ repository: "github.com/owner/config", branch: null });
    expect(repository_of("github:owner/config/staging")).toEqual({ repository: "github.com/owner/config", branch: "staging" });
    expect(repository_of("gitlab:owner/config?ref=next")).toEqual({ repository: "gitlab.com/owner/config", branch: "next" });
    expect(repository_of("git+https://git.example/owner/config?ref=main")).toEqual({ repository: "git.example/owner/config", branch: "main" });
    expect(repository_of("/etc/nixos")).toBeNull();
  });
});

// ── Signatures ───────────────────────────────────────────────────────────────

describe("a delivery", () => {
  const body = Buffer.from(push_payload());

  it("is signed by GitHub's HMAC, Forgejo's signature, a bearer token or GitLab's token", () => {
    expect(is_signed({ "x-hub-signature-256": sign(body.toString()) }, body, secret)).toBe(true);
    expect(is_signed({ "x-forgejo-signature": sign(body.toString()).slice("sha256=".length) }, body, secret)).toBe(true);
    expect(is_signed({ authorization: `Bearer ${secret}` }, body, secret)).toBe(true);
    expect(is_signed({ "x-gitlab-token": secret }, body, secret)).toBe(true);
  });

  it("is not signed by another key, another body or nothing", () => {
    expect(is_signed({ "x-hub-signature-256": sign(body.toString(), "other") }, body, secret)).toBe(false);
    expect(is_signed({ "x-hub-signature-256": sign("{}") }, body, secret)).toBe(false);
    expect(is_signed({ authorization: "Bearer wrong" }, body, secret)).toBe(false);
    expect(is_signed({}, body, secret)).toBe(false);
  });

  it("names a branch push, and nothing for a tag or a deleted branch", () => {
    expect(read_push(JSON.parse(push_payload("staging")))).toMatchObject({ branch: "staging", default_branch: "main" });
    expect(read_push({ ref: "refs/tags/v1", repository: { clone_url: "https://github.com/owner/config.git" } })).toBeNull();
    expect(read_push({ ref: "refs/heads/main", deleted: true, repository: { clone_url: "https://github.com/owner/config.git" } })).toBeNull();
  });

  it("matches deployments following the pushed branch, or the default one when the flake names none, and never a pinned one", () => {
    const push = read_push(JSON.parse(push_payload()))!;
    const following = (flake: string, values: Record<string, unknown> = {}) => push_matches(push, make_deployment({ flake, ...values }).deployment);
    expect(following("github:owner/config")).toBe(true);
    expect(following("git+ssh://git@github.com/owner/config?ref=main")).toBe(true);
    expect(following("github:owner/config/staging")).toBe(false);
    expect(following("github:owner/other")).toBe(false);
    expect(following("github:owner/config", { pin: "v1" })).toBe(false);
  });

  it("reads its secret from a file, refusing an empty one", () => {
    const folder = mkdtempSync(join(tmpdir(), "x-nix-webhook-"));
    writeFileSync(join(folder, "secret"), `${secret}\n`);
    writeFileSync(join(folder, "empty"), "\n");
    expect(load_webhook_secret(join(folder, "secret"))).toBe(secret);
    expect(() => load_webhook_secret(join(folder, "empty"))).toThrow(WebhookError);
  });
});

// ── Webhook ──────────────────────────────────────────────────────────────────

describe("the webhook", () => {
  function make_webhook(debounce_in_seconds = 0) {
    const store = new Store(":memory:");
    const agent = new FakeAgent();
    const followed = make_deployment({ id: "followed", flake: "github:owner/config" }, { store, agent });
    const other = make_deployment({ id: "other", flake: "github:owner/other" }, { store, agent });
    const evaluated: string[] = [];
    const webhook = new Webhook({
      secret, debounce_in_seconds, store,
      deployments: new Map([[followed.deployment.id, followed.deployment], [other.deployment.id, other.deployment]]),
      evaluate: (deployment: Deployment) => evaluated.push(deployment.id),
    });
    return { webhook, evaluated, followed, store };
  }

  it("evaluates every deployment the push matches, noting why", () => {
    const { webhook, evaluated, followed, store } = make_webhook();
    const body = push_payload();

    const answer = webhook.receive("192.0.2.1", { "x-github-event": "push", "x-hub-signature-256": sign(body) }, Buffer.from(body));

    expect(answer).toMatchObject({ status: 202, body: { matched: ["followed"] } });
    expect(evaluated).toEqual(["followed"]);
    expect(followed.deployment.due_for_evaluation()).toBe(true);
    expect(store.events("followed")[0].message).toContain("Push to main");
  });

  it("answers a ping, ignores other events, and turns away an address after ten unsigned deliveries", () => {
    const { webhook, evaluated } = make_webhook();
    expect(webhook.receive("192.0.2.1", { "x-github-event": "ping", authorization: `Bearer ${secret}` }, Buffer.from("{}")).status).toBe(200);
    expect(webhook.receive("192.0.2.1", { "x-github-event": "issues", authorization: `Bearer ${secret}` }, Buffer.from("{}")).status).toBe(202);
    for (let count = 0; count < 10; count++) expect(webhook.receive("192.0.2.2", {}, Buffer.from(push_payload())).status).toBe(401);
    expect(webhook.receive("192.0.2.2", { authorization: `Bearer ${secret}` }, Buffer.from(push_payload())).status).toBe(429);
    expect(evaluated).toEqual([]);
  });

  it("starts one evaluation for a burst of pushes once the debounce ends", async () => {
    const { webhook, evaluated } = make_webhook(0.05);
    const body = push_payload();
    for (let count = 0; count < 3; count++) webhook.receive("192.0.2.1", { authorization: `Bearer ${secret}` }, Buffer.from(body));
    expect(evaluated).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(evaluated).toEqual(["followed"]);
    webhook.close();
  });
});

// ── Route ────────────────────────────────────────────────────────────────────

describe("/api/webhook", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("takes a signed delivery without a session, checking the signature against the exact body", async () => {
    const harness = make_deployment({ flake: "github:owner/config" });
    const poller = new Poller([harness.deployment]);
    const evaluated: string[] = [];
    const webhook = new Webhook({ secret, debounce_in_seconds: 0, store: harness.store, deployments: poller.deployments, evaluate: (deployment) => evaluated.push(deployment.id) });
    app = await build_app({ serve_web: false, logger: false, password_hash: hash_password("unused"), store: harness.store, poller, webhook });
    // Spacing a JSON parser would drop must still be signed as sent.
    const body = push_payload().replace("{", "{ ");

    const signed = await app.inject({ method: "POST", url: "/api/webhook", headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) }, payload: body });
    const unsigned = await app.inject({ method: "POST", url: "/api/webhook", headers: { "content-type": "application/json" }, payload: body });

    expect(signed.statusCode).toBe(202);
    expect(signed.json()).toMatchObject({ matched: ["host-deploy"] });
    expect(unsigned.statusCode).toBe(401);
    expect(evaluated).toEqual(["host-deploy"]);
    expect((await app.inject({ method: "GET", url: "/api/deployments" })).statusCode).toBe(401);
  });

  it("is not there without a secret", async () => {
    const harness = make_deployment();
    app = await build_app({ serve_web: false, logger: false, password_hash: hash_password("unused"), store: harness.store, poller: new Poller([harness.deployment]) });
    expect((await app.inject({ method: "POST", url: "/api/webhook", payload: {} })).statusCode).toBe(404);
  });
});
