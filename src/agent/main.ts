// Starts the X-Nix agent from its environment: the server's URL, the file holding this host's private key, the host it
// logs in as, the folder long runs keep their output in, and the optional pull settings file.

// ── Imports ──────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { hostname } from "node:os";

import { AgentConfigError, start_agent } from "./agent.ts";
import { parse_pull_settings, PullConfigError, type PullSettings } from "./pull.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

// Ended runs are kept this long for the server to read, then removed.
const ended_run_retention_in_seconds = 30 * 86400;

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} must be set.`);
    process.exit(2);
  }
  return value;
}

function agent_version(): string {
  try {
    return String(JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version);
  } catch {
    return "unknown";
  }
}

// The pull settings from the JSON file X_NIX_AGENT_PULL_FILE names, or none when it is unset.
function pull_settings(host: string): PullSettings | undefined {
  const file = process.env.X_NIX_AGENT_PULL_FILE;
  if (!file) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new PullConfigError(`Could not read the pull settings at ${file}: ${(error as Error).message}`);
  }
  return parse_pull_settings(raw, host);
}

// ── Start ────────────────────────────────────────────────────────────────────

try {
  const host = process.env.X_NIX_AGENT_HOST || hostname();
  const agent = start_agent({
    url: required("X_NIX_AGENT_URL"),
    key_file: required("X_NIX_AGENT_KEY_FILE"),
    state_directory: process.env.X_NIX_AGENT_STATE_DIR || "state",
    host,
    agent_version: agent_version(),
    pull: pull_settings(host),
  });
  agent.runs.prune(ended_run_retention_in_seconds);

  // Long runs are in their own process groups, so they keep going after the agent exits.
  const stop = () => void agent.stop().then(() => process.exit(0));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
} catch (error) {
  if (!(error instanceof AgentConfigError) && !(error instanceof PullConfigError)) throw error;
  console.error(error.message);
  process.exit(2);
}
