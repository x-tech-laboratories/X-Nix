// The push webhook: a forge such as GitHub or Forgejo posts each push here, and every deployment whose flake follows the
// pushed repository and branch evaluates at once instead of waiting for its `eval_interval`, as every such flake is read again,
// and every flake with a watched input following it updates at once.
//
// The request proves it knows the shared secret, read from a file, as X-Libs' forge_webhook checks. Pushes are debounced
// per deployment and flake, so a burst of pushes starts one evaluation, and an address that keeps failing to sign is
// turned away for a while.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { IncomingHttpHeaders } from "node:http";
import type { FastifyInstance } from "fastify";

import { read_secret_file } from "@x-tech-laboratories/x-libs/server/config";
import {
  AddressLockout, Debouncer, event_of, is_signed, parse_payload, read_push as read_forge_push, register_webhook_route as register_forge_route,
  type Push, type WebhookAnswer,
} from "@x-tech-laboratories/x-libs/server/forge_webhook";

import type { Deployment } from "./deployment.ts";
import type { Flake } from "./flake.ts";
import { can_update } from "./nixos/commands.ts";
import { normalize_repository, repository_of, type InputRemote } from "./nixos/flake.ts";
import type { Store } from "./store.ts";

export { is_signed, type Push, type WebhookAnswer };

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
  flakes?: Map<string, Flake>;
  // Reads the flake again now.
  read?: (flake: Flake) => unknown;
  // Updates the flake now, naming the inputs the push moved.
  update?: (flake: Flake, inputs: string) => unknown;
  now?: () => number;
}

export class WebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookError";
  }
}

// ── Secret ───────────────────────────────────────────────────────────────────

// Reads the shared secret from its file, without its trailing newline.
export function load_webhook_secret(path: string): string {
  try {
    return read_secret_file(path);
  } catch (error) {
    throw new WebhookError((error as Error).message);
  }
}

// ── Checking ─────────────────────────────────────────────────────────────────

// The branch a push payload moved and the repository it belongs to, or null for a tag, a deleted branch or no push at all.
export function read_push(payload: unknown): Push | null {
  return read_forge_push(payload, normalize_repository);
}

// Whether the push moved the branch the deployment's flake follows; a flake naming no branch follows the default one.
export function push_matches(push: Push, deployment: Deployment): boolean {
  return deployment.pin() === null && follows_push(push, deployment.settings.flake);
}

// Whether the push moved the branch a flake reference follows.
export function follows_push(push: Push, flake: string): boolean {
  const followed = repository_of(flake);
  if (followed === null || !push.repositories.has(followed.repository)) return false;
  if (followed.branch !== null) return followed.branch === push.branch;
  return push.default_branch === null || push.default_branch === push.branch;
}

// Whether the push moved the branch a flake input's remote follows.
export function input_follows_push(push: Push, remote: InputRemote): boolean {
  const reference = `git+${remote.url}${remote.ref === null ? "" : `?ref=${encodeURIComponent(remote.ref)}`}`;
  return follows_push(push, reference);
}

// ── Webhook ──────────────────────────────────────────────────────────────────

export class Webhook {
  private readonly options: WebhookOptions;
  private readonly now: () => number;
  private readonly debounce: Debouncer;
  private readonly lockout = new AddressLockout();

  constructor(options: WebhookOptions) {
    this.options = options;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.debounce = new Debouncer(options.debounce_in_seconds);
  }

  // Answers one delivery: checks its signature, then evaluates every deployment the push matches once the debounce ends.
  receive(address: string, headers: IncomingHttpHeaders, body: Buffer): WebhookAnswer {
    if (this.lockout.is_locked(address)) return { status: 429, body: { message: "Too many unsigned deliveries; wait a few minutes" } };
    if (!is_signed(headers, body, this.options.secret)) {
      this.lockout.fail(address);
      return { status: 401, body: { message: "The delivery is not signed with the webhook secret" } };
    }
    this.lockout.succeed(address);
    const event = event_of(headers);
    if (event === "ping") return { status: 200, body: { message: "Pong" } };
    if (event !== "push" && event !== "push hook") return { status: 202, body: { message: `Ignored the ${event} event`, matched: [] } };
    const push = read_push(parse_payload(body, headers["content-type"]));
    if (push === null) return { status: 202, body: { message: "Not a push to a branch", matched: [] } };
    const matched = [...this.options.deployments.values()].filter((deployment) => push_matches(push, deployment));
    for (const deployment of matched) {
      this.options.store.add_event(deployment.id, this.now(), "info", `Push to ${push.branch} received; evaluating the flake`);
      deployment.request_evaluation();
      this.debounce.schedule(deployment.id, () => this.options.evaluate(deployment));
    }
    const flakes = [...(this.options.flakes?.values() ?? [])].filter((flake) => follows_push(push, flake.settings.url));
    for (const flake of flakes) {
      this.options.store.add_event(flake.id, this.now(), "info", `Push to ${push.branch} received; reading the flake again`);
      this.debounce.schedule(flake.id, () => this.options.read?.(flake));
    }
    const updating: string[] = [];
    for (const flake of this.options.flakes?.values() ?? []) {
      if (!can_update(flake.settings)) continue;
      const inputs = flake.watched_inputs().filter((input) => input_follows_push(push, input.remote!)).map((input) => input.name).join(", ");
      if (inputs === "") continue;
      updating.push(flake.id);
      this.options.store.add_event(flake.id, this.now(), "info", `Push to ${inputs} received; updating the flake`);
      this.debounce.schedule(`${flake.id} inputs`, () => this.options.update?.(flake, inputs));
    }
    const names = matched.map((deployment) => deployment.id);
    const doing = [...(names.length === 0 ? [] : [`Evaluating ${names.join(", ")}`]), ...(updating.length === 0 ? [] : [`Updating ${updating.join(", ")}`])];
    return { status: 202, body: { message: doing.length === 0 ? "No deployment follows that branch" : doing.join("; "), matched: names } };
  }

  close(): void {
    this.debounce.close();
  }
}

// ── Route ────────────────────────────────────────────────────────────────────

// Takes deliveries on /api/webhook with the raw body kept, since the signature covers its exact bytes.
export async function register_webhook_route(app: FastifyInstance, webhook: Webhook): Promise<void> {
  await register_forge_route(app, { receive: (address, headers, body) => webhook.receive(address, headers, body), close: () => webhook.close() });
}
