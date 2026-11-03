// Logging in: a user's name and password, checked against the hashes the server is given, open a session that every API route but the health check,
// the login itself, the agents' socket and the push webhook needs, since the actions rebuild and reboot machines.

// ── Imports ──────────────────────────────────────────────────────────────────

import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { hash_password, verify_password, type Accounts } from "./passwords.ts";

export { hash_password, load_accounts, parse_accounts, verify_password, type Accounts } from "./passwords.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

const cookie_name = "x_nix_session";
const session_lifetime_in_milliseconds = 12 * 60 * 60 * 1000;

// An unknown name is checked against this hash, so it takes as long to refuse as a wrong password.
const stand_in_hash = hash_password(randomBytes(16).toString("hex"));

// After this many wrong passwords from one address, it waits before trying again.
const failures_allowed = 5;
const lockout_in_milliseconds = 5 * 60 * 1000;

// An agent proves its host's key over its own socket, and a webhook its shared secret, rather than with a session.
const open_routes = new Set(["/api/health", "/api/login", "/api/agent", "/api/webhook"]);

// ── Sessions ─────────────────────────────────────────────────────────────────

// Session tokens, whose user each is and when it expires; a restart logs everyone out.
class Sessions {
  private readonly sessions = new Map<string, { name: string; expires: number }>();

  open(name: string): string {
    const token = randomBytes(32).toString("hex");
    this.sessions.set(token, { name, expires: Date.now() + session_lifetime_in_milliseconds });
    return token;
  }

  // The user a token is logged in as, or undefined once it has lapsed.
  user(token: string | undefined): string | undefined {
    if (token === undefined) return undefined;
    const session = this.sessions.get(token);
    if (session === undefined) return undefined;
    if (session.expires < Date.now()) {
      this.sessions.delete(token);
      return undefined;
    }
    return session.name;
  }

  close(token: string | undefined): void {
    if (token !== undefined) this.sessions.delete(token);
  }
}

function read_cookie(request: FastifyRequest): string | undefined {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === cookie_name) return value.join("=");
  }
  return undefined;
}

function session_cookie(request: FastifyRequest, value: string, max_age_in_seconds: number): string {
  const secure = request.protocol === "https" ? "; Secure" : "";
  return `${cookie_name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${max_age_in_seconds}${secure}`;
}

// ── Registration ─────────────────────────────────────────────────────────────

export function register_auth(app: FastifyInstance, accounts: Accounts): void {
  const sessions = new Sessions();
  const failures = new Map<string, { count: number; until: number }>();

  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0];
    if (!path.startsWith("/api/") || open_routes.has(path)) return;
    if (sessions.user(read_cookie(request)) === undefined) return reply.code(401).send({ error: "Log in first." });
  });

  app.post<{ Body: { name?: unknown; password?: unknown } }>("/api/login", async (request, reply) => {
    const failure = failures.get(request.ip);
    if (failure && failure.count >= failures_allowed && failure.until > Date.now()) {
      return reply.code(429).send({ error: "Too many wrong tries; wait a few minutes." });
    }
    const name = typeof request.body?.name === "string" ? request.body.name.trim().toLowerCase() : "";
    const password = request.body?.password;
    const stored = accounts.get(name);
    const matches = typeof password === "string" && verify_password(password, stored ?? stand_in_hash);
    if (stored === undefined || !matches) {
      const count = (failure && failure.until > Date.now() ? failure.count : 0) + 1;
      failures.set(request.ip, { count, until: Date.now() + lockout_in_milliseconds });
      return reply.code(401).send({ error: "Wrong name or password." });
    }
    failures.delete(request.ip);
    reply.header("set-cookie", session_cookie(request, sessions.open(name), session_lifetime_in_milliseconds / 1000));
    return reply.code(204).send();
  });

  app.post("/api/logout", async (request, reply) => {
    sessions.close(read_cookie(request));
    reply.header("set-cookie", session_cookie(request, "", 0));
    return reply.code(204).send();
  });

  app.get("/api/me", async (request) => ({ logged_in: true, name: sessions.user(read_cookie(request)) }));
}
