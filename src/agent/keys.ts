// Writes the keys the server uploads and reads back whether each is there and current, through the key writer: the
// program the NixOS module names in X_NIX_KEY_WRITER, which sudo lets the agent run as root, or else the bundled script.
// A key's contents reach the writer only on its stdin, never in its arguments.

// ── Imports ──────────────────────────────────────────────────────────────────

import { fileURLToPath } from "node:url";

import type { RunResult } from "../shared/agent_protocol.ts";
import { is_account_name, is_key_destination, is_key_mode, type KeyState, type KeyWrite } from "../shared/keys.ts";
import { run_command } from "./commands.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

const bundled_writer = fileURLToPath(new URL("./key-writer.sh", import.meta.url));

const writer_timeout_in_seconds = 30;

export class KeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyError";
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Quotes a word for sh, leaving plain words as they are.
function quote(word: string): string {
  if (word !== "" && /^[\w@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replaceAll("'", `'"'"'`)}'`;
}

// The writer as a command line, run under sudo when asked.
export function writer_command(sudo: boolean, writer: string | undefined = process.env.X_NIX_KEY_WRITER): string {
  const program = writer ? quote(writer) : `sh ${quote(bundled_writer)}`;
  return `${sudo ? "sudo -n " : ""}${program}`;
}

// ── Writing ──────────────────────────────────────────────────────────────────

export async function write_key(request: KeyWrite, writer?: string): Promise<RunResult> {
  if (!is_key_destination(request.destination)) throw new KeyError(`${request.destination} is not a plain path under /run/keys.`);
  if (!is_account_name(request.owner) || !is_account_name(request.group)) throw new KeyError("The owner and group must be account names.");
  if (!is_key_mode(request.mode)) throw new KeyError(`${request.mode} is not a mode such as 0400.`);
  const words = [request.destination, request.owner, request.group, request.mode].map(quote).join(" ");
  const command = `${writer_command(request.sudo, writer)} write ${words}`;
  return run_command(command, { timeout_in_seconds: writer_timeout_in_seconds, stdin: Buffer.from(request.content_base64, "base64") });
}

// ── Checking ─────────────────────────────────────────────────────────────────

export async function check_keys(destinations: string[], salt: string, sudo: boolean, writer?: string): Promise<KeyState[]> {
  if (destinations.length === 0) return [];
  const invalid = destinations.find((destination) => typeof destination !== "string" || !is_key_destination(destination));
  if (invalid !== undefined) throw new KeyError(`${String(invalid)} is not a plain path under /run/keys.`);
  if (!/^[A-Za-z0-9]+$/.test(salt)) throw new KeyError("The salt must be letters and digits.");
  const command = [writer_command(sudo, writer), "check", salt, ...destinations.map(quote)].join(" ");
  const result = await run_command(command, { timeout_in_seconds: writer_timeout_in_seconds });
  if (result.exit_code !== 0) throw new KeyError(`The key writer exited ${result.exit_code}: ${(result.stderr || result.stdout).slice(0, 300)}`);
  return parse_key_states(result.stdout, destinations);
}

// Reads the writer's check lines into one state per destination, in the order asked.
export function parse_key_states(output: string, destinations: string[]): KeyState[] {
  const found = new Map<string, KeyState>();
  for (const line of output.split("\n")) {
    const words = line.trim().split(" ");
    if (words[0] === "present" && words.length === 7) {
      const [, salted_hash, size, owner, group, mode, destination] = words;
      found.set(destination, { destination, present: true, salted_hash, size: Number(size), owner, group, mode });
    }
  }
  const missing = (destination: string): KeyState => ({ destination, present: false, salted_hash: null, size: null, owner: null, group: null, mode: null });
  return destinations.map((destination) => found.get(destination) ?? missing(destination));
}
