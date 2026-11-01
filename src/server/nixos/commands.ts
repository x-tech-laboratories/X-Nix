// The shell commands a deployment's jobs run: evaluation, flake update, build, switch, switch from cache and reboot.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { DeploymentSettings } from "../config.ts";
import type { RunResult } from "../agents/agent.ts";
import { github_repository, local_path } from "./flake.ts";

// ── Quoting ──────────────────────────────────────────────────────────────────

// Quotes a word for sh, leaving plain words as they are.
export function shell_quote(word: string): string {
  if (word !== "" && /^[\w@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replaceAll("'", `'"'"'`)}'`;
}

// Escapes a value for use inside a double-quoted shell word.
function escape_double_quoted(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$");
}

// ── Flake ────────────────────────────────────────────────────────────────────

// Whether Update Flake can write the flake's lock: a local checkout, or a github: flake it may push to.
export function can_update(settings: DeploymentSettings): boolean {
  return local_path(settings.flake) !== null || pushes_to_github(settings);
}

export function pushes_to_github(settings: DeploymentSettings): boolean {
  return local_path(settings.flake) === null && github_repository(settings.flake) !== null && settings.push_ssh_key !== null;
}

function nix(settings: DeploymentSettings): string {
  return [settings.nix_bin, ...settings.nix_args.map(shell_quote)].join(" ");
}

// A remote ref is only seen freshly with --refresh; a local path is read from disk every time.
function refresh_args(settings: DeploymentSettings): string[] {
  return local_path(settings.flake) === null ? ["--refresh"] : [];
}

export function sudo(settings: DeploymentSettings): string {
  return settings.require_sudo ? "sudo -n " : "";
}

// The host's system closure in the flake; with no attribute known, the evaluating host's own hostname.
export function installable(settings: DeploymentSettings, attribute: string | null): string {
  const name = attribute ? escape_double_quoted(attribute) : "$(uname -n)";
  return `"${escape_double_quoted(settings.flake)}#nixosConfigurations.\\"${name}\\".config.system.build.toplevel"`;
}

function words(...parts: (string | null | undefined | false)[]): string {
  return parts.filter(Boolean).join(" ");
}

// ── Evaluation ───────────────────────────────────────────────────────────────

// Starts a line naming the command and stream the evaluation script prints next.
export const eval_mark = "@@x-nix-eval";

// The exit status `timeout` gives a run it killed.
export const timed_out_exit_code = 124;

const eval_parts = ["eval", "metadata"] as const;

// Runs `nix eval` of the toplevel and `nix flake metadata`, showing nix's progress live, then prints each one's
// stdout and exit status after marker lines, all under `timeout`.
export function eval_command(settings: DeploymentSettings, attribute: string | null): string {
  const refresh = refresh_args(settings).join(" ");
  const commands: Record<(typeof eval_parts)[number], string> = {
    eval: words(nix(settings), "eval --raw --no-write-lock-file", refresh, installable(settings, attribute)),
    metadata: words(nix(settings), "flake metadata --json --no-write-lock-file", refresh, shell_quote(settings.flake)),
  };
  const lines = ['w=$(mktemp -d)', `trap 'rm -rf "$w"' EXIT`];
  for (const name of eval_parts) {
    lines.push(`echo "${eval_mark} ${name} stderr"`);
    lines.push(`{ ${commands[name]}; } 2>&1 >"$w/${name}.stdout"; echo $? >"$w/${name}.exit"`);
  }
  for (const name of eval_parts) {
    for (const stream of ["stdout", "exit"]) lines.push(`echo "${eval_mark} ${name} ${stream}"; cat "$w/${name}.${stream}"; echo`);
  }
  // The run fails when either command did, so its job shows it.
  lines.push(eval_parts.map((name) => `[ "$(cat "$w/${name}.exit")" = 0 ]`).join(" && "));
  return `timeout ${settings.eval_timeout} sh -c ${shell_quote(lines.join("\n"))}`;
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

// ── Update ───────────────────────────────────────────────────────────────────

export function update_command(settings: DeploymentSettings): string {
  if (!pushes_to_github(settings)) return `${sudo(settings)}${nix(settings)} flake update --flake ${shell_quote(settings.flake)}`;
  return github_update_command(settings);
}

// Clones the flake's repository, updates its lock and pushes a commit back, as the agent's user rather than root.
function github_update_command(settings: DeploymentSettings): string {
  const repository = github_repository(settings.flake)!;
  const [name, email = ""] = settings.commit_author.split("<", 2);
  const identity = `-c user.name=${shell_quote(name.trim())} -c user.email=${shell_quote(email.replace(/>\s*$/, "").trim())}`;
  const branch = repository.branch ? `--branch ${shell_quote(repository.branch)} ` : "";
  const ssh = `ssh -i ${shell_quote(settings.push_ssh_key!)} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes`;
  const lines = [
    "set -e",
    "t=$(mktemp -d)",
    `trap 'rm -rf "$t"' EXIT`,
    // Host keys come from the system known_hosts, so an unpinned github.com fails rather than being trusted.
    `export GIT_SSH_COMMAND=${shell_quote(ssh)}`,
    `git clone --quiet --depth 1 ${branch}${shell_quote(repository.ssh_url)} "$t/repo"`,
    // The update prints as it runs and its log feeds the commit message; set -e ignores an && || list.
    `{ ${nix(settings)} flake update --flake "$t/repo" 2>&1 && echo 0 > "$t/rc" || echo $? > "$t/rc"; } | tee "$t/log"`,
    '[ "$(cat "$t/rc")" = 0 ] || exit 1',
    'if git -C "$t/repo" diff --quiet -- flake.lock; then echo "Every input is already current"; exit 0; fi',
    `printf '%s\\n\\n' ${shell_quote(settings.commit_message)} > "$t/msg"`,
    `sed -n "s/.*Updated input '\\([^']*\\)'.*/- \\1/p" "$t/log" >> "$t/msg"`,
    `git -C "$t/repo" ${identity} commit --quiet -F "$t/msg" -- flake.lock`,
    'git -C "$t/repo" push origin HEAD',
    'git -C "$t/repo" log --oneline -1',
  ];
  // A subshell, so set -e ends the update and not the shell recording its exit status.
  return `(\n${lines.join("\n")}\n)`;
}

// ── Build ────────────────────────────────────────────────────────────────────

// Makes nix print its activities as JSON lines, which the job turns back into log lines and counts of builds.
export const progress_args = ["--log-format", "internal-json", "-v"];

// Realises the host's closure without activating it, so a later switch substitutes instead of building, printing its store
// path for the build history.
export function build_command(settings: DeploymentSettings, attribute: string | null): string {
  const args = [...(settings.build_progress ? progress_args : []), ...settings.build_args, ...refresh_args(settings)].map(shell_quote).join(" ");
  const target = installable(settings, attribute);
  let build: string;
  if (settings.build_root_dir === null) {
    build = words(nix(settings), "build --no-link --print-out-paths", args, target);
  } else {
    // One link per deployment, so each build replaces the garbage-collector root the last one held.
    const link = shell_quote(`${settings.build_root_dir.replace(/\/+$/, "")}/${settings.id}`);
    build = `mkdir -p ${shell_quote(settings.build_root_dir)} && ` + words(nix(settings), `build --out-link ${link} --print-out-paths`, args, target);
  }
  if (settings.cache_url === null) return build;
  // A closure missing here but already in the cache is not downloaded just to be rooted; any failure falls to the build.
  const evaluate = words(nix(settings), "eval --raw --no-write-lock-file", refresh_args(settings).join(" "), target);
  const cached = `out=$(${evaluate} 2>/dev/null) && [ -n "$out" ] && ! ${nix(settings)} path-info "$out" >/dev/null 2>&1 `
    + `&& ${nix(settings)} path-info --store ${shell_quote(settings.cache_url)} "$out" >/dev/null 2>&1`;
  return `if ${cached}; then echo "$out is already in the cache; not building it"; else ${build}; fi`;
}

// ── Switch ───────────────────────────────────────────────────────────────────

// How nixos-rebuild applies the new system: now and at boot, only at boot, only now, or only saying what it would do.
export type SwitchMode = "switch" | "boot" | "test" | "dry-activate";

export const switch_modes: SwitchMode[] = ["switch", "boot", "test", "dry-activate"];

export function switch_command(settings: DeploymentSettings, mode: SwitchMode = "switch"): string {
  const flake_reference = settings.configuration ? `${settings.flake}#${settings.configuration}` : settings.flake;
  const args = [
    ...(settings.build_host ? ["--build-host", settings.build_host] : []),
    ...(settings.target_host ? ["--target-host", settings.target_host] : []),
    ...settings.rebuild_args,
    ...refresh_args(settings),
  ].map(shell_quote).join(" ");
  const wrapper = settings.switch_wrapper.map((word) => `${shell_quote(word)} `).join("");
  const rebuild = `${wrapper}${sudo(settings)}${settings.rebuild_bin} ${mode} --flake ${shell_quote(flake_reference)} ${args}`.trim();
  return with_post_switch(settings, rebuild);
}

// Runs post_switch after the switch, as root under sudo, keeping the switch's own exit status whatever it returns.
export function with_post_switch(settings: DeploymentSettings, switching: string): string {
  if (settings.post_switch === null) return switching;
  const follow_up = settings.require_sudo ? `sudo -n /bin/sh -c ${shell_quote(settings.post_switch)}` : settings.post_switch;
  return `${switching}; rc=$?; ${follow_up}; (exit $rc)`;
}

// ── Switch from cache ────────────────────────────────────────────────────────

// The profile whose newest generation the host boots and runs.
const system_profile = "/nix/var/nix/profiles/system";

// Whether a value is a top-level store path, the only kind put into a command line here.
export function is_store_path(value: string): boolean {
  return /^\/nix\/store\/[0-9a-z]{32}-[A-Za-z0-9+._?=-]+$/.test(value);
}

// Fetches the evaluated closure from the cache and activates it in the mode asked, so the host neither evaluates nor builds.
// Exits 0 only when the cache already holds the store path, so a switch from it can fetch it.
export function cache_holds_command(settings: DeploymentSettings, store_path: string): string {
  if (!is_store_path(store_path)) throw new Error(`'${store_path}' is not a store path`);
  return `${nix(settings)} path-info --store ${shell_quote(settings.cache_url ?? "")} --recursive ${shell_quote(store_path)} >/dev/null`;
}

export function switch_from_cache_command(settings: DeploymentSettings, store_path: string, mode: SwitchMode = "switch"): string {
  if (!is_store_path(store_path)) throw new Error(`'${store_path}' is not a store path`);
  const path = shell_quote(store_path);
  // The copy runs as the agent's user, as the daemon takes signed paths from anyone, so only activation needs sudo.
  const steps = [`${nix(settings)} copy --from ${shell_quote(settings.cache_url ?? "")} ${path}`, `${nix(settings)} path-info --recursive ${path} >/dev/null`];
  // Only switch and boot make the closure the system profile's next generation, which the boot loader lists.
  if (mode === "switch" || mode === "boot") steps.push(`${sudo(settings)}nix-env -p ${system_profile} --set ${path}`);
  steps.push(`${sudo(settings)}${store_path}/bin/switch-to-configuration ${mode}`);
  const joined = steps.join(" && ");
  const switching = settings.switch_wrapper.length === 0 ? joined : `${settings.switch_wrapper.map(shell_quote).join(" ")} sh -c ${shell_quote(joined)}`;
  return with_post_switch(settings, switching);
}

// ── Reboot ───────────────────────────────────────────────────────────────────

export function reboot_command(settings: DeploymentSettings): string {
  return `${sudo(settings)}systemctl reboot`;
}
