// Starts the X-Nix agent from its environment: the server's URL, the file holding this host's private key, the host it
// logs in as, the folder long runs keep their output in, and the optional pull, run unit and server keys files.

// ── Imports ──────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

import { AgentConfigError, read_server_keys_file, start_agent } from "./agent.ts";
import { parse_pull_settings, PullConfigError, type PullSettings } from "./pull.ts";
import { parse_run_unit_settings, run_unit, RunUnitConfigError, type RunUnitSettings } from "./tasks.ts";
import { switch_folders_variable } from "../shared/operations.ts";

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

// The run unit settings from the JSON file X_NIX_AGENT_RUN_UNIT_FILE names; without it, runs are process groups.
function run_unit_settings(): RunUnitSettings | undefined {
  const file = process.env.X_NIX_AGENT_RUN_UNIT_FILE;
  if (!file) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new RunUnitConfigError(`Could not read the run unit settings at ${file}: ${(error as Error).message}`);
  }
  return parse_run_unit_settings(raw);
}

// The server keys from the JSON list X_NIX_AGENT_SERVER_KEYS_FILE names; without it the agent tells the server by TLS alone.
function server_keys(): string[] | undefined {
  const file = process.env.X_NIX_AGENT_SERVER_KEYS_FILE;
  return file ? read_server_keys_file(file) : undefined;
}

// ── Start ────────────────────────────────────────────────────────────────────

try {
  const host = process.env.X_NIX_AGENT_HOST || hostname();
  const state_directory = process.env.X_NIX_AGENT_STATE_DIR || "state";
  // Switches keep their watchdog's folder in the agent's own state, which its runs and watchdogs inherit.
  process.env[switch_folders_variable] ||= join(resolve(state_directory), "switches");
  const unit = run_unit_settings();
  const agent = start_agent({
    url: required("X_NIX_AGENT_URL"),
    key_file: required("X_NIX_AGENT_KEY_FILE"),
    server_keys: server_keys(),
    state_directory,
    host,
    agent_version: agent_version(),
    pull: pull_settings(host),
    long_runs: unit === undefined ? undefined : { unit: run_unit(unit, process.env) },
  });
  agent.runs.prune(ended_run_retention_in_seconds);

  // Long runs are in units or process groups of their own, so they keep going after the agent exits.
  const stop = () => void agent.stop().then(() => process.exit(0));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
} catch (error) {
  if (!(error instanceof AgentConfigError) && !(error instanceof PullConfigError) && !(error instanceof RunUnitConfigError)) throw error;
  console.error(error.message);
  process.exit(2);
}
