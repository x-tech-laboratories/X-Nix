// The push webhook: a forge such as GitHub or Forgejo posts each push here, and every deployment whose flake follows the
// pushed repository and branch evaluates at once instead of waiting for its `eval_interval`.
//
// The request proves it knows the shared secret, read from a file: by GitHub's X-Hub-Signature-256 HMAC of the body,
// Gitea's and Forgejo's own signature headers, an `Authorization: Bearer` token, or GitLab's X-Gitlab-Token. Pushes are
// debounced per deployment, so a burst of pushes starts one evaluation, and an address that keeps failing to sign is
// turned away for a while.

// ── Imports ──────────────────────────────────────────────────────────────────

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import type { FastifyInstance } from "fastify";

import type { Deployment } from "./deployment.ts";
import { normalize_repository, repository_of } from "./nixos/flake.ts";
import type { Store } from "./store.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

export interface WebhookOptions {
  // The shared secret the forge signs with or sends as a bearer token.
  secret: string;
  // How long after the last push to a deployment its evaluation starts.
  debounce_in_seconds: number;
  deployments: Map<string, Deployment>;
  store: Store;
  // Starts the deployment's evaluation now.
  evaluate: (deployment: Deployment) => unknown;
  now?: () => number;
}

// A push payload's facts that pick deployments.
export interface Push {
  // Every URL the payload gives for the repository, normalised.
  repositories: Set<string>;
  branch: string;
  default_branch: string | null;
}

export class WebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookError";
  }
}

// Forge payloads can be large, as a push lists its commits.
const body_limit_in_bytes = 10 * 1024 * 1024;

// After this many unsigned requests from one address, it waits before trying again.
const failures_allowed = 10;
const lockout_in_milliseconds = 5 * 60 * 1000;

// The headers forges name their event in.
const event_headers = ["x-github-event", "x-gitea-event", "x-forgejo-event", "x-gitlab-event"];

// ── Secret ───────────────────────────────────────────────────────────────────

// Reads the shared secret from its file, without its trailing newline.
export function load_webhook_secret(path: string): string {
  let secret: string;
  try {
    secret = readFileSync(path, "utf8").replace(/\r?\n$/, "");
  } catch (error) {
    throw new WebhookError(`Could not read the webhook secret at ${path}: ${(error as Error).message}`);
  }
  if (secret.trim() === "") throw new WebhookError(`The webhook secret at ${path} is empty`);
  return secret;
}

// ── Checking ─────────────────────────────────────────────────────────────────

function same_text(first: string, second: string): boolean {
  // Digests have equal lengths, so the comparison takes the same time whatever the texts are.
  const digest = (text: string) => createHash("sha256").update(text).digest();
  return timingSafeEqual(digest(first), digest(second));
}

// Whether the request carries a signature of its body, or a bearer token, made with the secret.
export function is_signed(headers: IncomingHttpHeaders, body: Buffer, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const github = headers["x-hub-signature-256"];
  if (typeof github === "string" && github.startsWith("sha256=")) return same_text(github.slice("sha256=".length).toLowerCase(), expected);
  for (const name of ["x-forgejo-signature", "x-gitea-signature"]) {
    const signature = headers[name];
    if (typeof signature === "string" && signature !== "") return same_text(signature.toLowerCase(), expected);
  }
  const authorization = headers.authorization;
  if (typeof authorization === "string" && /^bearer /i.test(authorization)) return same_text(authorization.slice("bearer ".length).trim(), secret);
  const gitlab = headers["x-gitlab-token"];
  if (typeof gitlab === "string" && gitlab !== "") return same_text(gitlab, secret);
  return false;
}

// The event the forge names, or "push" when it names none.
export function event_of(headers: IncomingHttpHeaders): string {
  for (const name of event_headers) {
    const value = headers[name];
    if (typeof value === "string" && value !== "") return value.toLowerCase();
  }
  return "push";
}

// The JSON payload, also from a form whose `payload` field holds it, or null for anything else.
export function parse_payload(body: Buffer, content_type: string | undefined): unknown {
  let text = body.toString("utf8");
  if ((content_type ?? "").startsWith("application/x-www-form-urlencoded")) text = new URLSearchParams(text).get("payload") ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// The branch a push payload moved and the repository it belongs to, or null for a tag, a deleted branch or no push at all.
export function read_push(payload: unknown): Push | null {
  if (typeof payload !== "object" || payload === null) return null;
  const values = payload as Record<string, unknown>;
  if (typeof values.ref !== "string" || !values.ref.startsWith("refs/heads/") || values.deleted === true) return null;
  const repository = (typeof values.repository === "object" && values.repository !== null ? values.repository : {}) as Record<string, unknown>;
  const repositories = new Set<string>();
  for (const key of ["clone_url", "ssh_url", "git_url", "html_url", "url", "git_http_url", "git_ssh_url"]) {
    const url = repository[key];
    const normalized = typeof url === "string" ? normalize_repository(url) : null;
    if (normalized !== null) repositories.add(normalized);
  }
  if (repositories.size === 0) return null;
  const default_branch = typeof repository.default_branch === "string" ? repository.default_branch : null;
  return { repositories, branch: values.ref.slice("refs/heads/".length), default_branch };
}

// Whether the push moved the branch the deployment's flake follows; a flake naming no branch follows the default one.
export function push_matches(push: Push, deployment: Deployment): boolean {
  if (deployment.pin() !== null) return false;
  const followed = repository_of(deployment.settings.flake);
  if (followed === null || !push.repositories.has(followed.repository)) return false;
  if (followed.branch !== null) return followed.branch === push.branch;
  return push.default_branch === null || push.default_branch === push.branch;
}

// ── Webhook ──────────────────────────────────────────────────────────────────

export interface WebhookAnswer {
  status: number;
  body: { message: string; matched?: string[] };
}

export class Webhook {
  private readonly options: WebhookOptions;
  private readonly now: () => number;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly failures = new Map<string, { count: number; until: number }>();

  constructor(options: WebhookOptions) {
    this.options = options;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  // Answers one delivery: checks its signature, then evaluates every deployment the push matches once the debounce ends.
  receive(address: string, headers: IncomingHttpHeaders, body: Buffer): WebhookAnswer {
    const failure = this.failures.get(address);
    if (failure && failure.count >= failures_allowed && failure.until > Date.now()) return { status: 429, body: { message: "Too many unsigned deliveries; wait a few minutes" } };
    if (!is_signed(headers, body, this.options.secret)) {
      const count = (failure && failure.until > Date.now() ? failure.count : 0) + 1;
      this.failures.set(address, { count, until: Date.now() + lockout_in_milliseconds });
      return { status: 401, body: { message: "The delivery is not signed with the webhook secret" } };
    }
    this.failures.delete(address);
    const event = event_of(headers);
    if (event === "ping") return { status: 200, body: { message: "Pong" } };
    if (event !== "push" && event !== "push hook") return { status: 202, body: { message: `Ignored the ${event} event`, matched: [] } };
    const push = read_push(parse_payload(body, headers["content-type"]));
    if (push === null) return { status: 202, body: { message: "Not a push to a branch", matched: [] } };
    const matched = [...this.options.deployments.values()].filter((deployment) => push_matches(push, deployment));
    for (const deployment of matched) this.schedule(deployment, push);
    const names = matched.map((deployment) => deployment.id);
    return { status: 202, body: { message: names.length === 0 ? "No deployment follows that branch" : `Evaluating ${names.join(", ")}`, matched: names } };
  }

  private schedule(deployment: Deployment, push: Push): void {
    this.options.store.add_event(deployment.id, this.now(), "info", `Push to ${push.branch} received; evaluating the flake`);
    deployment.request_evaluation();
    clearTimeout(this.timers.get(deployment.id));
    if (this.options.debounce_in_seconds <= 0) {
      this.options.evaluate(deployment);
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(deployment.id);
      this.options.evaluate(deployment);
    }, this.options.debounce_in_seconds * 1000);
    timer.unref();
    this.timers.set(deployment.id, timer);
  }

  close(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}

// ── Route ────────────────────────────────────────────────────────────────────

// Takes deliveries on /api/webhook with the raw body kept, since the signature covers its exact bytes.
export async function register_webhook_route(app: FastifyInstance, webhook: Webhook): Promise<void> {
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: body_limit_in_bytes }, (_request, body, done) => done(null, body));
    scope.post("/api/webhook", async (request, reply) => {
      const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      const answer = webhook.receive(request.ip, request.headers, body);
      return reply.code(answer.status).send(answer.body);
    });
  });
  app.addHook("onClose", async () => webhook.close());
}
