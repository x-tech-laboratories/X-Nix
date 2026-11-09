// Logging in: a user's name and password, checked against the hashes the server is given, open a session that every API
// route but the health check, the login itself, the agents' socket and the push webhook needs, since the actions
// rebuild and reboot machines. Sessions live in the server, so a restart logs everyone out.

// ── Imports ──────────────────────────────────────────────────────────────────

import { load_accounts as load_accounts_from, type Accounts } from "@x-tech-laboratories/x-libs/server/passwords";
import { register_password_sign_in } from "@x-tech-laboratories/x-libs/server/password_sign_in";
import type { FastifyInstance } from "fastify";

export { hash_password, parse_accounts, verify_password, type Accounts } from "@x-tech-laboratories/x-libs/server/passwords";

// ── Settings ─────────────────────────────────────────────────────────────────

// The environment variable naming the accounts file.
export const accounts_variable = "X_NIX_PASSWORD_HASH_FILE";

// An agent proves its host's key over its own socket, and a webhook its shared secret, rather than with a session.
const open_routes = ["/api/health", "/api/agent", "/api/webhook"];

export function load_accounts(file_path?: string): Accounts {
  return load_accounts_from(accounts_variable, file_path);
}

// ── Registration ─────────────────────────────────────────────────────────────

export async function register_auth(app: FastifyInstance, accounts: Accounts): Promise<void> {
  await register_password_sign_in(app, { accounts, cookie_name: "x_nix_session", open_paths: open_routes });
}
