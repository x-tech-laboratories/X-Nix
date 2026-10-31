// Logging in: one password, whose hash the server is given, opens a session that every API route but the health check
// and the login itself needs, since the actions rebuild and reboot machines.

// ── Imports ──────────────────────────────────────────────────────────────────

import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { verify_password } from "./passwords.ts";

export { hash_password, load_password_hash, verify_password } from "./passwords.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

const cookie_name = "x_nix_session";
const session_lifetime_in_milliseconds = 12 * 60 * 60 * 1000;

// After this many wrong passwords from one address, it waits before trying again.
const failures_allowed = 5;
const lockout_in_milliseconds = 5 * 60 * 1000;

const open_routes = new Set(["/api/health", "/api/login"]);

// ── Sessions ─────────────────────────────────────────────────────────────────

// Session tokens and when each expires; a restart logs everyone out.
class Sessions {
  private readonly expiries = new Map<string, number>();

  open(): string {
    const token = randomBytes(32).toString("hex");
    this.expiries.set(token, Date.now() + session_lifetime_in_milliseconds);
    return token;
  }

  valid(token: string | undefined): boolean {
    if (token === undefined) return false;
    const expires = this.expiries.get(token);
    if (expires === undefined) return false;
    if (expires < Date.now()) {
      this.expiries.delete(token);
      return false;
    }
    return true;
  }

  close(token: string | undefined): void {
    if (token !== undefined) this.expiries.delete(token);
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

export function register_auth(app: FastifyInstance, password_hash: string): void {
  const sessions = new Sessions();
  const failures = new Map<string, { count: number; until: number }>();

  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0];
    if (!path.startsWith("/api/") || open_routes.has(path)) return;
    if (!sessions.valid(read_cookie(request))) return reply.code(401).send({ error: "Log in first." });
  });

  app.post<{ Body: { password?: unknown } }>("/api/login", async (request, reply) => {
    const failure = failures.get(request.ip);
    if (failure && failure.count >= failures_allowed && failure.until > Date.now()) {
      return reply.code(429).send({ error: "Too many wrong tries; wait a few minutes." });
    }
    const password = request.body?.password;
    if (typeof password !== "string" || !verify_password(password, password_hash)) {
      const count = (failure && failure.until > Date.now() ? failure.count : 0) + 1;
      failures.set(request.ip, { count, until: Date.now() + lockout_in_milliseconds });
      return reply.code(401).send({ error: "Wrong password." });
    }
    failures.delete(request.ip);
    reply.header("set-cookie", session_cookie(request, sessions.open(), session_lifetime_in_milliseconds / 1000));
    return reply.code(204).send();
  });

  app.post("/api/logout", async (request, reply) => {
    sessions.close(read_cookie(request));
    reply.header("set-cookie", session_cookie(request, "", 0));
    return reply.code(204).send();
  });

  app.get("/api/me", async () => ({ logged_in: true }));
}
