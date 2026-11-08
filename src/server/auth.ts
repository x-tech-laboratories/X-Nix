// Logging in: a user's name and password, checked against the hashes the server is given, open a session that every API
// route but the health check, the login itself, the agents' socket and the push webhook needs, since the actions
// rebuild and reboot machines. Sessions live in the server, so a restart logs everyone out.

// ── Imports ──────────────────────────────────────────────────────────────────

import { randomBytes } from "node:crypto";

import fastify_cookie from "@fastify/cookie";
import fastify_rate_limit from "@fastify/rate-limit";
import fastify_session from "@fastify/session";
import { load_accounts as load_accounts_from, hash_password, verify_password, type Accounts } from "@x-tech-laboratories/x-libs/server/passwords";
import { register_sign_in_guard } from "@x-tech-laboratories/x-libs/server/sign_in";
import type { FastifyInstance } from "fastify";

export { hash_password, parse_accounts, verify_password, type Accounts } from "@x-tech-laboratories/x-libs/server/passwords";

declare module "fastify" {
  interface Session {
    // The user the session is logged in as.
    name?: string;
  }
}

// ── Settings ─────────────────────────────────────────────────────────────────

// The environment variable naming the accounts file.
export const accounts_variable = "X_NIX_PASSWORD_HASH_FILE";

const cookie_name = "x_nix_session";
const session_lifetime_in_milliseconds = 12 * 60 * 60 * 1000;

// An unknown name is checked against this hash, so it takes as long to refuse as a wrong password.
const stand_in_hash = hash_password(randomBytes(16).toString("hex"));

// One address may try to log in this many times in the window, then waits.
const tries_allowed = 5;
const try_window = "5 minutes";

// An agent proves its host's key over its own socket, and a webhook its shared secret, rather than with a session.
const open_routes = new Set(["/api/health", "/api/login", "/api/agent", "/api/webhook"]);

export function load_accounts(file_path?: string): Accounts {
  return load_accounts_from(accounts_variable, file_path);
}

// ── Registration ─────────────────────────────────────────────────────────────

export async function register_auth(app: FastifyInstance, accounts: Accounts): Promise<void> {
  await app.register(fastify_cookie);
  await app.register(fastify_session, {
    secret: randomBytes(32).toString("hex"),
    cookieName: cookie_name,
    saveUninitialized: false,
    cookie: { path: "/", httpOnly: true, sameSite: "strict", secure: "auto", maxAge: session_lifetime_in_milliseconds },
  });
  await app.register(fastify_rate_limit, {
    global: false,
    errorResponseBuilder: () => ({ statusCode: 429, error: "Too many tries; wait a few minutes." }),
  });

  // The page loads without a session and logs in itself, so only API calls are turned away.
  register_sign_in_guard(app, {
    is_signed_in: (request) => request.session.name !== undefined, login_path: null, refusal: "json", refusal_text: "Log in first.", open_paths: open_routes,
  });

  app.post<{ Body: { name?: unknown; password?: unknown } }>("/api/login", {
    config: { rateLimit: { max: tries_allowed, timeWindow: try_window } },
  }, async (request, reply) => {
    const name = typeof request.body?.name === "string" ? request.body.name.trim().toLowerCase() : "";
    const password = request.body?.password;
    const stored = accounts.get(name);
    const matches = typeof password === "string" && verify_password(password, stored ?? stand_in_hash);
    if (stored === undefined || !matches) return reply.code(401).send({ error: "Wrong name or password." });
    // A fresh session id at login, so one handed out before it cannot ride along.
    await request.session.regenerate();
    request.session.name = name;
    return reply.code(204).send();
  });

  app.post("/api/logout", async (request, reply) => {
    await request.session.destroy();
    return reply.code(204).send();
  });

  app.get("/api/me", async (request) => ({ logged_in: true, name: request.session.name }));
}
