// The operations a deployment's and a flake's jobs ask an agent for: evaluation, build, switch, switch from cache, reboot,
// and the flake's update.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { RunResult } from "../agents/agent.ts";
import type { DeploymentSettings, FlakeSettings } from "../config.ts";
import {
  eval_mark, is_store_path, type Argv, type BuildOperation, type CacheHoldsOperation, type EvaluateOperation, type Operation, type Step,
  type TimedOperation,
} from "../../shared/operations.ts";
import { github_repository, local_path } from "./flake.ts";

export { eval_mark, is_store_path, timed_out_exit_code } from "../../shared/operations.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

// Whether Update can write the flake's lock: a local checkout, or a github: flake it may push to.
export function can_update(settings: FlakeSettings): boolean {
  return local_path(settings.url) !== null || pushes_to_github(settings);
}

export function pushes_to_github(settings: FlakeSettings): boolean {
  return local_path(settings.url) === null && github_repository(settings.url) !== null && settings.push_ssh_key !== null;
}

export function nix(settings: Pick<DeploymentSettings, "nix_bin" | "nix_args">): Argv {
  return [settings.nix_bin, ...settings.nix_args];
}

// A remote ref is only seen freshly with --refresh; a local path is read from disk every time.
function refreshes(flake: string): boolean {
  return local_path(flake) === null;
}

export function sudo(settings: Pick<DeploymentSettings, "require_sudo">): Argv {
  return settings.require_sudo ? ["sudo", "-n"] : [];
}

export function timed(seconds: number, operation: Operation): TimedOperation {
  return { kind: "timed", seconds, operation };
}

// ── Evaluation ───────────────────────────────────────────────────────────────

const eval_parts = ["eval", "metadata"] as const;

// Evaluates the toplevel and reads the flake's metadata, all under eval_timeout.
export function eval_operation(settings: DeploymentSettings, attribute: string | null): TimedOperation {
  const evaluate: EvaluateOperation = { kind: "evaluate", nix: nix(settings), flake: settings.flake, attribute, refresh: refreshes(settings.flake) };
  return timed(settings.eval_timeout, evaluate);
}

// Splits a finished evaluation's output back into one result per command; one never reported on fails with `missing`.
export function split_eval_output(output: string, missing: string): Record<"eval" | "metadata", RunResult> {
  const sections = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith(`${eval_mark} `)) {
      current = [];
      sections.set(line.slice(eval_mark.length + 1), current);
    } else {
      current?.push(line);
    }
  }
  const text = (name: string, stream: string) => (sections.get(`${name} ${stream}`) ?? []).join("\n").trim();
  const results = {} as Record<"eval" | "metadata", RunResult>;
  for (const name of eval_parts) {
    const code = text(name, "exit");
    results[name] = /^-?\d+$/.test(code)
      ? { exit_code: Number(code), stdout: text(name, "stdout"), stderr: text(name, "stderr") }
      : { exit_code: 1, stdout: "", stderr: missing };
  }
  return results;
}

// ── Flake ────────────────────────────────────────────────────────────────────

// Reads the flake's metadata and lock, fetching a remote flake afresh.
export function metadata_operation(settings: FlakeSettings): Operation {
  const refresh = refreshes(settings.url) ? ["--refresh"] : [];
  return { kind: "programs", steps: [{ argv: [...nix(settings), "flake", "metadata", "--json", "--no-write-lock-file", ...refresh, settings.url] }] };
}

// Updates every input of the lock, refetching each branch it follows rather than trusting nix's cached lookup of it,
// which may be up to an hour old.
export function update_operation(settings: FlakeSettings): Operation {
  if (!pushes_to_github(settings)) {
    return { kind: "programs", steps: [{ argv: [...sudo(settings), ...nix(settings), "flake", "update", "--refresh", "--flake", settings.url] }] };
  }
  const repository = github_repository(settings.url)!;
  const [name, email = ""] = settings.commit_author.split("<", 2);
  return {
    kind: "github_update", nix: nix(settings), ssh_url: repository.ssh_url, branch: repository.branch, ssh_key: settings.push_ssh_key!,
    author_name: name.trim(), author_email: email.replace(/>\s*$/, "").trim(), message: settings.commit_message,
  };
}

// ── Build ────────────────────────────────────────────────────────────────────

// Makes nix print its activities as JSON lines, which the job turns back into log lines and counts of builds.
export const progress_args = ["--log-format", "internal-json", "-v"];

// Realises the host's closure without activating it, so a later switch substitutes instead of building.
export function build_operation(settings: DeploymentSettings, attribute: string | null): BuildOperation {
  return {
    kind: "build",
    nix: nix(settings),
    flake: settings.flake,
    attribute,
    args: [...(settings.build_progress ? progress_args : []), ...settings.build_args],
    refresh: refreshes(settings.flake),
    // One link per deployment, so each build replaces the garbage-collector root the last one held.
    root_link: settings.build_root_dir === null ? null : `${settings.build_root_dir.replace(/\/+$/, "")}/${settings.id}`,
    cache_url: settings.cache_url,
  };
}

// ── Switch ───────────────────────────────────────────────────────────────────

// How nixos-rebuild applies the new system: now and at boot, only at boot, only now, or only saying what it would do.
export type SwitchMode = "switch" | "boot" | "test" | "dry-activate";

export const switch_modes: SwitchMode[] = ["switch", "boot", "test", "dry-activate"];

// The profile whose newest generation the host boots and runs.
export const system_profile = "/nix/var/nix/profiles/system";

// nixos-rebuild in the mode asked, inside switch_wrapper.
export function rebuild_steps(settings: DeploymentSettings, mode: SwitchMode): Step[] {
  const flake_reference = settings.configuration ? `${settings.flake}#${settings.configuration}` : settings.flake;
  const args = [
    ...(settings.build_host ? ["--build-host", settings.build_host] : []),
    ...(settings.target_host ? ["--target-host", settings.target_host] : []),
    ...settings.rebuild_args,
    ...(refreshes(settings.flake) ? ["--refresh"] : []),
  ];
  return [{ argv: [...settings.switch_wrapper, ...sudo(settings), settings.rebuild_bin, mode, "--flake", flake_reference, ...args] }];
}

// Fetches the evaluated closure and activates it in the mode asked, so the host neither evaluates nor builds. The daemon
// fetches the closure from the host's substituters, the cache among them, taking from upstream what the cache left out;
// it substitutes for anyone, so only activation needs sudo.
export function cache_switch_steps(settings: DeploymentSettings, store_path: string, mode: SwitchMode): Step[] {
  const steps: Step[] = [];
  // Only switch and boot make the closure the system profile's next generation, which the boot loader lists.
  if (mode === "switch" || mode === "boot") steps.push({ argv: [...sudo(settings), "nix-env", "-p", system_profile, "--set", store_path] });
  steps.push({ argv: [...sudo(settings), `${store_path}/bin/switch-to-configuration`, mode] });
  return [...cache_fetch_steps(settings, store_path), ...steps.map((step) => ({ ...step, argv: [...settings.switch_wrapper, ...step.argv] }))];
}

// Fetches the closure and checks the host holds all of it, changing nothing the host runs.
export function cache_fetch_steps(settings: DeploymentSettings, store_path: string): Step[] {
  if (!is_store_path(store_path)) throw new Error(`'${store_path}' is not a store path`);
  const steps: Step[] = [
    { argv: [...nix(settings), "build", "--no-link", store_path] },
    { argv: [...nix(settings), "path-info", "--recursive", store_path], quiet: true },
  ];
  return steps.map((step) => ({ ...step, argv: [...settings.switch_wrapper, ...step.argv] }));
}

// post_switch, run as root under sudo, or null when there is none.
export function post_switch_argv(settings: DeploymentSettings): Argv | null {
  if (settings.post_switch === null) return null;
  return settings.require_sudo ? ["sudo", "-n", "/bin/sh", "-c", settings.post_switch] : ["/bin/sh", "-c", settings.post_switch];
}

// Whether the cache holds the evaluated closure and the host can fetch all of it.
export function cache_holds_operation(settings: DeploymentSettings, store_path: string): CacheHoldsOperation {
  if (!is_store_path(store_path)) throw new Error(`'${store_path}' is not a store path`);
  return { kind: "cache_holds", nix: nix(settings), cache_url: settings.cache_url ?? "", store_path };
}

// ── Reboot ───────────────────────────────────────────────────────────────────

export function reboot_operation(settings: Pick<DeploymentSettings, "require_sudo">): Operation {
  return { kind: "programs", steps: [{ argv: [...sudo(settings), "systemctl", "reboot"] }] };
}
