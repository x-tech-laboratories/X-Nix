// Password hashes: scrypt with a random salt, and the accounts file X-Nix logs in with, one `name:hash` line per user.

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

const key_length = 64;

// Each user's name and password hash.
export type Accounts = Map<string, string>;

export const account_name_pattern = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

// A line holding only a hash logs in as this user.
export const default_account_name = "admin";

// Stored as `scrypt$<salt hex>$<hash hex>`.
export function hash_password(password: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${scryptSync(password, salt, key_length).toString("hex")}`;
}

export function verify_password(password: string, stored: string): boolean {
  const [scheme, salt_hex, hash_hex] = stored.trim().split("$");
  if (scheme !== "scrypt" || !salt_hex || !hash_hex) return false;
  const expected = Buffer.from(hash_hex, "hex");
  const actual = scryptSync(password, Buffer.from(salt_hex, "hex"), expected.length);
  return timingSafeEqual(actual, expected);
}

// Reads `name:hash` lines, skipping blank lines and `#` comments.
export function parse_accounts(text: string, source = "the accounts file"): Accounts {
  const accounts: Accounts = new Map();
  for (const [index, raw_line] of text.split("\n").entries()) {
    const line = raw_line.trim();
    if (line === "" || line.startsWith("#")) continue;
    const separator = line.indexOf(":");
    const name = separator === -1 ? default_account_name : line.slice(0, separator);
    const stored = separator === -1 ? line : line.slice(separator + 1);
    const where = `${source} line ${index + 1}`;
    if (!account_name_pattern.test(name)) throw new Error(`${where}: '${name}' is not a user name of lowercase letters, digits, '.', '_' and '-'.`);
    if (!stored.startsWith("scrypt$")) throw new Error(`${where} does not hold a hash from \`npm run hash-password\`.`);
    if (accounts.has(name)) throw new Error(`${where} names '${name}' a second time.`);
    accounts.set(name, stored);
  }
  return accounts;
}

export function load_accounts(file_path: string | undefined = process.env.X_NIX_PASSWORD_HASH_FILE): Accounts {
  if (!file_path) {
    throw new Error("X_NIX_PASSWORD_HASH_FILE is not set; create one with `npm run hash-password -- <name> <file>`.");
  }
  const accounts = parse_accounts(readFileSync(file_path, "utf8"), file_path);
  if (accounts.size === 0) throw new Error(`${file_path} holds no users; add one with \`npm run hash-password -- <name> ${file_path}\`.`);
  return accounts;
}
