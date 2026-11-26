// Signing in, on the X-Libs accounts: the users in the accounts file are admins, others are added on the Users page,
// and every API route but the health check, the agents' socket and the push webhook needs a session or a token. A
// viewer reads everything but downloads; those and changing anything need an admin, since the actions rebuild and reboot machines.
// Sessions and tokens end on their own, and an admin can be made to set up a second factor before changing anything.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { DatabaseSync } from "node:sqlite";

import { register_accounts, type Need, type Viewer } from "@x-tech-laboratories/x-libs/server/account_sign_in";
import { AccountStore } from "@x-tech-laboratories/x-libs/server/account_store";
import { load_accounts as load_accounts_from, type Accounts } from "@x-tech-laboratories/x-libs/server/passwords";
import type { FastifyInstance } from "fastify";

export { hash_password, parse_accounts, verify_password, type Accounts } from "@x-tech-laboratories/x-libs/server/passwords";

// ── Settings ─────────────────────────────────────────────────────────────────

// The environment variable naming the accounts file.
export const accounts_variable = "X_NIX_PASSWORD_HASH_FILE";

export const roles = ["viewer", "admin"] as const;

// How long sign-ins last, and whether admins must use a second factor; null lifetimes never end.
export interface SignInSettings {
  session_seconds: number | null;
  remembered_seconds: number | null;
  token_days: number | null;
  admin_second_factor: boolean;
}

// What a server started with no settings gets; the server's own defaults are stricter.
export const open_sign_in: SignInSettings = { session_seconds: null, remembered_seconds: null, token_days: null, admin_second_factor: false };

// An agent proves its host's key over its own socket, and a webhook its shared secret, rather than with a session.
const open_routes = ["/api/health", "/api/agent", "/api/webhook"];

export function load_accounts(file_path?: string): Accounts {
  return load_accounts_from(accounts_variable, file_path);
}

// Downloads of build products and install media, which can hold secrets built into a system, and which wake a host.
const download_routes = [/^\/api\/builds\/[^/]+\/products\/[^/]+$/, /^\/api\/provisioning\/media\/[^/]+\/download$/];

// Reading is open to every user, but for downloads; anything else needs an admin. MCP is open to every user too, as
// each tool's route is checked again on its own.
export function needed(method: string, path: string): Need {
  // A path still holding an escape needs an admin, so no spelling of a download reads as an open route.
  if (path.includes("%")) return { role: "admin" };
  if (download_routes.some((route) => route.test(path))) return { role: "admin" };
  return method === "GET" || path === "/api/mcp" ? "any" : { role: "admin" };
}

// Who a job or fleet run was started by, as its history shows it: the signed-in user, marked when they used a token.
export function started_by(viewer: Viewer | null): string {
  if (viewer === null) return "manual";
  return viewer.via === "token" ? `${viewer.name} (token)` : viewer.name;
}

// ── Registration ─────────────────────────────────────────────────────────────

export async function register_auth(app: FastifyInstance, declared: Accounts, database: DatabaseSync, sign_in: SignInSettings = open_sign_in): Promise<void> {
  const accounts = new AccountStore({ database, app_name: "X-Nix", roles, declared, token_prefix: "xn", longest_token_days: sign_in.token_days });
  await register_accounts(app, {
    accounts, cookie_name: "x_nix_session", open_paths: open_routes, needed, read_only_paths: ["/api/mcp"],
    session_seconds: sign_in.session_seconds, remembered_seconds: sign_in.remembered_seconds, second_factor_from: sign_in.admin_second_factor ? "admin" : null,
  });
}
