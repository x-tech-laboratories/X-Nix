// Password hashes: scrypt with a random salt, and the one hash file X-Nix logs in with.

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

const key_length = 64;

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

export function load_password_hash(file_path: string | undefined = process.env.X_NIX_PASSWORD_HASH_FILE): string {
  if (!file_path) {
    throw new Error("X_NIX_PASSWORD_HASH_FILE is not set; create one with `npm run hash-password -- <file>`.");
  }
  const stored = readFileSync(file_path, "utf8").trim();
  if (!stored.startsWith("scrypt$")) throw new Error(`${file_path} does not hold a hash from \`npm run hash-password\`.`);
  return stored;
}
