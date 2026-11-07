// Safer switches: checks before a switch, health checks after it, and a watchdog on the activated host that rolls it
// back, plus the system profile's generations and a rollback to any of them.
//
// A switch activates either with nixos-rebuild or, with switch_from_cache, by fetching the evaluated store path from the
// cache and running its switch-to-configuration, as one `switch` operation the switch agent performs (see
// agent/operations/switch.ts). A guarded switch activates on the switch agent's own host, so it takes no target_host. It
// runs the pre-switch checks and refuses on the first that fails, before anything changes. When the mode activates the
// new system and magic_rollback or a health check is set, it starts a watchdog in a session of its own, so it outlives
// the run, the agent and any lost connection, and activates. Once activated it runs the health commands every
// health_period until they all pass or health_timeout passes, then prints a line asking X-Nix to confirm. X-Nix runs the
// HTTP checks and confirms through the agent. The watchdog rolls back to the previous system when told to, when the
// activation outlasts activation_timeout, or, with magic_rollback, when no confirmation arrives within confirm_timeout
// (plus health_timeout when there are health checks). The run ends by printing the watchdog's outcome on a marker line,
// which the server reads to say why a switch was refused or rolled back. With inhibit_sleep, a sleep inhibitor on the
// activated host lasts exactly as long as the run.

// ── Imports ──────────────────────────────────────────────────────────────────

import { format_duration } from "@x-tech-laboratories/x-libs/durations";

import type { DeploymentSettings } from "../config.ts";
import { read_facts, type Generation } from "../../shared/facts.ts";
import {
  innermost, operation_of, switch_mark, type ConfirmSwitchOperation, type KeptAwakeOperation, type Operation, type SignalRollbackOperation, type Step,
  type SwitchOperation, type SwitchWatch,
} from "../../shared/operations.ts";
import { cache_fetch_steps, cache_switch_steps, post_switch_argv, rebuild_steps, sudo, system_profile, type SwitchMode } from "./commands.ts";

export type { Generation } from "../../shared/facts.ts";
export { switch_mark } from "../../shared/operations.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

// What the marker lines of a switch's output say about how it went.
export interface SwitchVerdict {
  // Why a pre-switch check refused the switch, before anything changed.
  refused: string | null;
  activated: boolean;
  awaiting_confirmation: boolean;
  // The watchdog's last word: confirmed, kept, unchanged, rolled-back, rollback-failed or unknown, then its reason.
  outcome: { kind: string; reason: string } | null;
}

// ── Deciding ─────────────────────────────────────────────────────────────────

// Whether the mode activates the new system now, so its activation can be checked and rolled back.
export function activates(mode: SwitchMode): boolean {
  return mode === "switch" || mode === "test";
}

export function has_health_checks(settings: DeploymentSettings): boolean {
  return settings.health_commands.length + settings.health_urls.length > 0;
}

// Whether a switch in this mode runs under a watchdog on the host.
export function watches(settings: DeploymentSettings, mode: SwitchMode): boolean {
  return activates(mode) && (settings.magic_rollback || has_health_checks(settings));
}

// How long the watchdog waits for a confirmation once the new system is active.
export function confirm_window(settings: DeploymentSettings): number {
  return settings.confirm_timeout + (has_health_checks(settings) ? settings.health_timeout : 0);
}

// The watch token a guarded switch's job names, or null for a plain switch.
export function watch_token(command: string): string | null {
  const operation = operation_of(command);
  if (operation === null) return null;
  const inner = innermost(operation);
  return inner.kind === "switch" ? inner.watch?.token ?? null : null;
}

// ── Switch ───────────────────────────────────────────────────────────────────

// The operation a switch job runs: the activation, with the checks and watchdog its settings ask for, kept awake with
// inhibit_sleep.
export function switch_job_operation(settings: DeploymentSettings, mode: SwitchMode, token: string, store_path: string | null = null): Operation {
  const steps = store_path === null ? rebuild_steps(settings, mode) : cache_switch_steps(settings, store_path, mode);
  const guarded = mode !== "dry-activate";
  const operation: SwitchOperation = {
    kind: "switch",
    mode,
    activation_name: store_path === null ? `nixos-rebuild ${mode}` : `The ${mode} from the cache`,
    fetch_steps: store_path === null ? [] : cache_fetch_steps(settings, store_path),
    steps,
    post_switch: post_switch_argv(settings),
    pre_switch_checks: guarded ? settings.pre_switch_checks : [],
    watch: guarded && watches(settings, mode) ? switch_watch(settings, mode, token) : null,
  };
  return kept_awake(settings, operation);
}

function switch_watch(settings: DeploymentSettings, mode: SwitchMode, token: string): SwitchWatch {
  const window = confirm_window(settings);
  return {
    token,
    rollback_mode: mode === "test" ? "test" : "switch",
    require_sudo: settings.require_sudo,
    activation_timeout: settings.activation_timeout,
    confirm_window: window,
    magic_rollback: settings.magic_rollback,
    health_commands: settings.health_commands,
    health_period: settings.health_period,
    health_timeout: settings.health_timeout,
    activation_reason: `The activation did not finish within ${format_duration(settings.activation_timeout)}`,
    unconfirmed_reason: settings.magic_rollback
      ? `X-Nix did not confirm it could still reach the host within ${format_duration(window)} of the activation`
      : `Nothing confirmed the switch within ${format_duration(window)}, and magic_rollback is off`,
  };
}

// What X-Nix asks the switch agent to confirm a guarded switch.
export function confirm_operation(token: string): ConfirmSwitchOperation {
  return { kind: "confirm_switch", token };
}

// What X-Nix asks the switch agent to tell the watchdog to roll back.
export function rollback_signal_operation(token: string, reason: string): SignalRollbackOperation {
  return { kind: "signal_rollback", token, reason };
}

// Reads the marker lines of a switch's output.
export function switch_verdict(output: string): SwitchVerdict {
  const verdict: SwitchVerdict = { refused: null, activated: false, awaiting_confirmation: false, outcome: null };
  for (const line of output.split("\n")) {
    if (!line.startsWith(`${switch_mark} `)) continue;
    const words = line.slice(switch_mark.length + 1).trim();
    const space = words.indexOf(" ");
    const [kind, rest] = space === -1 ? [words, ""] : [words.slice(0, space), words.slice(space + 1)];
    if (kind === "refused") verdict.refused = rest;
    else if (kind === "activated") verdict.activated = true;
    else if (kind === "awaiting-confirmation") verdict.awaiting_confirmation = true;
    else if (kind === "outcome") {
      const split = rest.indexOf(" ");
      verdict.outcome = split === -1 ? { kind: rest, reason: "" } : { kind: rest.slice(0, split), reason: rest.slice(split + 1) };
    }
  }
  return verdict;
}

// ── Generations ──────────────────────────────────────────────────────────────

export function generations_operation(): Operation {
  return { kind: "generations" };
}

export function parse_generations(stdout: string): Generation[] {
  const generations = read_facts<Generation[]>(stdout);
  return Array.isArray(generations) ? generations.sort((first, second) => second.generation - first.generation) : [];
}

// Points the system profile at an earlier generation and activates it, on the host the switch activates, which is
// reached over SSH as nixos-rebuild does when there is a target_host.
export function rollback_operation(settings: DeploymentSettings, generation: number, reason: string): Operation {
  if (!Number.isInteger(generation) || generation < 1) throw new Error(`${generation} is not a generation number`);
  const steps = [
    ["nix-env", "-p", system_profile, "--switch-generation", String(generation)],
    [`${system_profile}/bin/switch-to-configuration`, "switch"],
  ].map((argv) => on_host(settings, argv, true));
  return kept_awake(settings, { kind: "programs", note: `Rolling back to generation ${generation}: ${reason}`, steps });
}

// ── Where it runs ────────────────────────────────────────────────────────────

// A program run where the switch activates: on this machine, under sudo when privileged and required, or over SSH on
// target_host, which logs in as root, under sudo for root's own SSH setup.
function on_host(settings: DeploymentSettings, argv: string[], privileged: boolean): Step {
  if (settings.target_host === null) return { argv: privileged ? [...sudo(settings), ...argv] : argv };
  return { argv, ssh: { host: settings.target_host, sudo: settings.require_sudo } };
}

// ── Keeping the host awake ───────────────────────────────────────────────────

// The program that holds off idle and sleep on the activated host until its stdin closes.
export function inhibitor_step(settings: DeploymentSettings): Step {
  return on_host(settings, ["systemd-inhibit", "--what=idle:sleep", "--mode=block", "--who=X-Nix", "--why=switching", "cat"], true);
}

// Runs the operation with inhibit_sleep's inhibitor held for exactly as long as it runs.
export function kept_awake(settings: DeploymentSettings, operation: Operation): Operation {
  if (!settings.inhibit_sleep) return operation;
  const wrapped: KeptAwakeOperation = {
    kind: "kept_awake", inhibitor: inhibitor_step(settings), warning: "Could not keep the host awake during the switch; switching anyway", operation,
  };
  return wrapped;
}
