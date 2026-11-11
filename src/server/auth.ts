// Signing in, on the X-Libs accounts: the users in the accounts file are admins, others are added on the Users page,
// and every API route but the health check, the agents' socket and the push webhook needs a session or a token. A
// viewer reads everything; changing anything needs an admin, since the actions rebuild and reboot machines.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { DatabaseSync } from "node:sqlite";

import { register_accounts, type Need } from "@x-tech-laboratories/x-libs/server/account_sign_in";
import { AccountStore } from "@x-tech-laboratories/x-libs/server/account_store";
import { load_accounts as load_accounts_from, type Accounts } from "@x-tech-laboratories/x-libs/server/passwords";
import type { FastifyInstance } from "fastify";

export { hash_password, parse_accounts, verify_password, type Accounts } from "@x-tech-laboratories/x-libs/server/passwords";

// ── Settings ─────────────────────────────────────────────────────────────────

// The environment variable naming the accounts file.
export const accounts_variable = "X_NIX_PASSWORD_HASH_FILE";

export const roles = ["viewer", "admin"] as const;

// An agent proves its host's key over its own socket, and a webhook its shared secret, rather than with a session.
const open_routes = ["/api/health", "/api/agent", "/api/webhook"];

export function load_accounts(file_path?: string): Accounts {
  return load_accounts_from(accounts_variable, file_path);
}

// Reading is open to every user; anything else needs an admin. MCP is open to every user too, as each tool's route
// is checked again on its own.
export function needed(method: string, path: string): Need {
  return method === "GET" || path === "/api/mcp" ? "any" : { role: "admin" };
}

// ── Registration ─────────────────────────────────────────────────────────────

export async function register_auth(app: FastifyInstance, declared: Accounts, database: DatabaseSync): Promise<void> {
  const accounts = new AccountStore({ database, app_name: "X-Nix", roles, declared, token_prefix: "xn" });
  await register_accounts(app, { accounts, cookie_name: "x_nix_session", open_paths: open_routes, needed });
}
