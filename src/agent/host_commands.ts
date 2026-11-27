// What the host's own NixOS config declares for the agent: the pre-switch checks, health commands and post_switch
// commands a switch runs, which the server only names, and the fixed units, such as garbage collection, started in
// place of the server's command. The agent module writes them to /etc/x-nix-agent/host.json, read afresh each time, so
// a switch that changes them runs the new system's own once it has activated.

// ── Imports ──────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";

import { host_command_name, type Argv, type HostUnit } from "../shared/operations.ts";
import { person_command, type Context } from "./programs.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

export const host_file_variable = "X_NIX_AGENT_HOST_FILE";
export const default_host_file = "/etc/x-nix-agent/host.json";

export type CommandKind = "pre_switch_checks" | "health_commands" | "post_switch";

// The agent module's option for each kind of command.
const option_of: Record<CommandKind, string> = { pre_switch_checks: "preSwitchChecks", health_commands: "healthCommands", post_switch: "postSwitch" };

// What a person calls each kind of command.
const kind_name: Record<CommandKind, string> = { pre_switch_checks: "pre-switch check", health_commands: "health command", post_switch: "post_switch command" };

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface HostDeclarations {
  // Each kind's commands by name, post_switch's as the store path of its script; null when the host declares none, so the server's text still runs.
  switch_commands: Record<CommandKind, Record<string, string>> | null;
  units: string[];
}

// A command chosen to run, with what a person reads it as.
export interface ChosenCommand {
  label: string;
  argv: Argv;
}

export interface Chosen {
  commands: ChosenCommand[];
  // The names asked for that the host does not declare.
  missing: string[];
  // Lines to show before the commands run.
  notes: string[];
}

// ── Reading ──────────────────────────────────────────────────────────────────

const nothing: HostDeclarations = { switch_commands: null, units: [] };

// The host's declarations; none when the file is missing or unreadable.
export function read_host(environment: NodeJS.ProcessEnv = process.env): HostDeclarations {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(environment[host_file_variable] || default_host_file, "utf8"));
  } catch {
    return nothing;
  }
  if (typeof raw !== "object" || raw === null) return nothing;
  const { switch_commands, units } = raw as Record<string, unknown>;
  return { switch_commands: commands_of(switch_commands), units: Array.isArray(units) ? units.filter((unit): unit is string => typeof unit === "string") : [] };
}

function commands_of(value: unknown): HostDeclarations["switch_commands"] {
  if (typeof value !== "object" || value === null) return null;
  const kinds = value as Record<string, unknown>;
  const read = (kind: CommandKind) => Object.fromEntries(
    Object.entries((typeof kinds[kind] === "object" && kinds[kind] !== null ? kinds[kind] : {}) as Record<string, unknown>)
      .filter((entry): entry is [string, string] => host_command_name.test(entry[0]) && typeof entry[1] === "string"),
  );
  return { pre_switch_checks: read("pre_switch_checks"), health_commands: read("health_commands"), post_switch: read("post_switch") };
}

// ── Choosing ─────────────────────────────────────────────────────────────────

// The commands of one kind a switch runs. A host that declares its own runs only those: the ones the server names, or
// all of them when the server sent text instead. Otherwise the server's text runs, as deprecated, and names are skipped.
export function chosen_commands(kind: CommandKind, sent: ChosenCommand[], names: string[], sudo: boolean, host: HostDeclarations = read_host()): Chosen {
  const notes: string[] = [];
  const declared = host.switch_commands?.[kind] ?? null;
  if (host.switch_commands === null || declared === null) {
    if (sent.length > 0) {
      notes.push(`The server sent this host the text of its ${kind_name[kind]}s, which is deprecated: declare them in services.x-nix-agent.switchCommands.${option_of[kind]} and name them in host_${kind}`);
    }
    if (names.length > 0) notes.push(`This host declares no switch commands, so the ${kind_name[kind]}s ${names.join(", ")} are skipped`);
    return { commands: sent, missing: [], notes };
  }
  if (sent.length > 0) notes.push(`This host declares its own ${kind_name[kind]}s, so it runs those rather than the text the server sent`);
  const wanted = names.length > 0 ? names : sent.length > 0 ? Object.keys(declared) : [];
  const commands: ChosenCommand[] = [];
  const missing: string[] = [];
  for (const name of wanted) {
    const command = declared[name];
    if (command === undefined) missing.push(name);
    else if (kind === "post_switch") commands.push({ label: name, argv: [...(sudo ? ["sudo", "-n"] : []), command] });
    else commands.push({ label: `${name}: ${command}`, argv: person_command(command) });
  }
  return { commands, missing, notes };
}

// The server's text of one kind as commands, each run with /bin/sh as the agent's user.
export function sent_commands(texts: string[]): ChosenCommand[] {
  return texts.map((text) => ({ label: text, argv: person_command(text) }));
}

// ── Units ────────────────────────────────────────────────────────────────────

// Whether the host declares the unit, so the agent starts it in place of the server's command.
export function declares_unit(unit: HostUnit, host: HostDeclarations = read_host()): boolean {
  return host.units.includes(unit.unit);
}

// Starts the host's unit, waiting for it to finish, then shows what that run of it logged.
export async function start_host_unit(context: Context, unit: HostUnit): Promise<number> {
  const started = await context.program(context, [...(unit.sudo ? ["sudo", "-n"] : []), "systemctl", "start", unit.unit], { echo: true });
  const shown = await context.program(context, ["systemctl", "show", "--property=InvocationID", "--value", unit.unit], { stdout: "keep", stderr: "drop" });
  const invocation = shown.stdout.trim();
  if (/^[0-9a-f]{32}$/.test(invocation)) {
    await context.program(context, ["journalctl", "--no-pager", "--output=cat", `_SYSTEMD_INVOCATION_ID=${invocation}`], { stderr: "drop" });
  }
  return started.exit_code;
}
