// Safer switches: checks before a switch, health checks after it, and a watchdog on the activated host that rolls it
// back, plus the system profile's generations and a rollback to any of them.
//
// A switch activates either with nixos-rebuild or, with switch_from_cache, by fetching the evaluated store path from the
// cache and running its switch-to-configuration; both run plain or guarded alike. A guarded switch is one long run. It
// runs the pre-switch checks where the switch activates and refuses on the first that fails, before anything changes.
// When the mode activates the new system and magic_rollback or a health check is set, it then starts a watchdog on that
// host, detached into its own session so it outlives the run, the agent and any lost connection, and activates. Once
// activated it runs the health commands every health_period until they all pass or health_timeout passes, then prints
// a line asking X-Nix to confirm. X-Nix runs the HTTP checks and confirms by touching a file in the watchdog's folder. The watchdog rolls back to the previous system when told to, when the
// activation outlasts activation_timeout, or, with magic_rollback, when no confirmation arrives within confirm_timeout
// (plus health_timeout when there are health checks). The run ends by printing the watchdog's outcome on a marker line,
// which the server reads to say why a switch was refused or rolled back. With inhibit_sleep, a sleep inhibitor on the
// activated host lasts exactly as long as the run, since it reads a pipe that only the run's own shell holds open.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { DeploymentSettings } from "../config.ts";
import { format_duration } from "../durations.ts";
import { shell_quote, switch_command, switch_from_cache_command, type SwitchMode } from "./commands.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

// Starts each line the guarded switch prints for the server rather than for a person.
export const switch_mark = "@@x-nix-switch";

// What the marker lines of a switch's output say about how it went.
export interface SwitchVerdict {
  // Why a pre-switch check refused the switch, before anything changed.
  refused: string | null;
  activated: boolean;
  awaiting_confirmation: boolean;
  // The watchdog's last word: confirmed, kept, unchanged, rolled-back, rollback-failed or unknown, then its reason.
  outcome: { kind: string; reason: string } | null;
}

// One generation of the system profile.
export interface Generation {
  generation: number;
  created_epoch: number | null;
  path: string;
  version: string | null;
  current: boolean;
  booted: boolean;
  // Whether the system profile points at it, so it is the default boot entry.
  profile: boolean;
}

const system_profile = "/nix/var/nix/profiles/system";

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

// Whether a switch in this mode needs more than nixos-rebuild alone.
export function is_guarded(settings: DeploymentSettings, mode: SwitchMode): boolean {
  if (mode === "dry-activate") return false;
  return settings.pre_switch_checks.length > 0 || watches(settings, mode);
}

// How long the watchdog waits for a confirmation once the new system is active.
export function confirm_window(settings: DeploymentSettings): number {
  return settings.confirm_timeout + (has_health_checks(settings) ? settings.health_timeout : 0);
}

const watch_folder_parent = "/tmp";
const watch_folder_prefix = "x-nix-switch-";

// The folder on the activated host that the watchdog and X-Nix share for one switch.
export function watch_folder(token: string): string {
  return `${watch_folder_parent}/${watch_folder_prefix}${token}`;
}

// The watch token a guarded switch's command names, or null for a plain switch.
export function watch_token(command: string): string | null {
  return /\/tmp\/x-nix-switch-([a-f0-9]+)/.exec(command)?.[1] ?? null;
}

// ── Where it runs ────────────────────────────────────────────────────────────

// A command run where the switch activates: on this machine, or over SSH on target_host, reached as nixos-rebuild does.
export function on_host(settings: DeploymentSettings, command: string): string {
  if (settings.target_host === null) return `sh -c ${shell_quote(command)}`;
  const sudo = settings.require_sudo ? "sudo -n " : "";
  return `${sudo}ssh $NIX_SSHOPTS ${shell_quote(settings.target_host)} ${shell_quote(command)}`;
}

// What raises a command on the activated host: sudo on this machine, nothing over SSH, which logs in as root.
function privileged(settings: DeploymentSettings): string {
  return settings.target_host === null && settings.require_sudo ? "sudo -n " : "";
}

// ── Switch ───────────────────────────────────────────────────────────────────

// The command a switch job runs: the activation alone, or wrapped in the checks and watchdog its settings ask for.
export function switch_job_command(settings: DeploymentSettings, mode: SwitchMode, token: string, store_path: string | null = null): string {
  const command = is_guarded(settings, mode) ? guarded_switch_command(settings, mode, token, store_path) : activation_command(settings, mode, store_path);
  return kept_awake(settings, command);
}

// What activates the new system: nixos-rebuild, or the store path fetched from the cache when one is given.
function activation_command(settings: DeploymentSettings, mode: SwitchMode, store_path: string | null): string {
  return store_path === null ? switch_command(settings, mode) : switch_from_cache_command(settings, store_path, mode);
}

export function guarded_switch_command(settings: DeploymentSettings, mode: SwitchMode, token: string, store_path: string | null = null): string {
  const folder = watch_folder(token);
  const host = (command: string) => on_host(settings, command);
  const lines = [`mark() { echo "${switch_mark} $*"; }`];

  if (settings.pre_switch_checks.length > 0) {
    lines.push("mark phase pre-switch-checks");
    settings.pre_switch_checks.forEach((check, index) => {
      const name = `Pre-switch check ${index + 1} (${clip_line(check)})`;
      lines.push(`echo ${shell_quote(`$ ${check}`)}`);
      lines.push(`${host(check)}; rc=$?`);
      lines.push(`if [ $rc -ne 0 ]; then mark refused ${shell_quote(`${name} failed with status`)} "$rc"; exit 3; fi`);
    });
    lines.push('echo "Every pre-switch check passed"');
  }

  const watching = watches(settings, mode);
  if (watching) {
    lines.push("mark phase watch");
    lines.push(`${host(start_watchdog_script(settings, mode, folder))} || { mark refused "Could not start the rollback watchdog on the host"; exit 3; }`);
    lines.push(`echo "The watchdog in ${folder} rolls this switch back unless it is confirmed"`);
    // Reasons carry any characters, so they travel on stdin rather than inside a command.
    lines.push(`signal_rollback() { printf '%s\\n' "$1" | ${host(`cat > ${folder}/rollback.part && mv -f ${folder}/rollback.part ${folder}/rollback`)}; }`);
  }

  lines.push(`mark phase ${mode}`);
  lines.push(`${activation_command(settings, mode, store_path)}; rc=$?`);
  if (!watching) {
    lines.push("exit $rc");
    return lines.join("\n");
  }

  lines.push("failure=''");
  const activation = store_path === null ? `nixos-rebuild ${mode}` : `The ${mode} from the cache`;
  lines.push(`if [ $rc -ne 0 ]; then failure="${activation} failed with status $rc"; signal_rollback "$failure"; else`);
  lines.push(`  ${host(`touch ${folder}/activated`)} || true`);
  lines.push("  mark activated");
  if (settings.health_commands.length > 0) {
    lines.push("  mark phase health-checks");
    lines.push("  started=$(date +%s)");
    lines.push("  while :; do");
    lines.push("    failure=''");
    settings.health_commands.forEach((check, index) => {
      const name = `Health check ${index + 1} (${clip_line(check)})`;
      lines.push(`    if [ -z "$failure" ]; then out=$(${host(check)} 2>&1); code=$?`);
      lines.push(`      if [ $code -ne 0 ]; then failure="${escape_double(name)} failed with status $code: $(printf '%s' "$out" | tail -n 3 | tr '\\n' ' ' | cut -c1-300)"; fi; fi`);
    });
    lines.push('    if [ -z "$failure" ]; then echo "Every health check passed"; break; fi');
    lines.push(`    if [ $(( $(date +%s) - started )) -ge ${settings.health_timeout} ]; then echo "$failure"; signal_rollback "$failure"; break; fi`);
    lines.push(`    echo "Waiting for the health checks: $failure"; sleep ${settings.health_period}`);
    lines.push("  done");
  }
  lines.push('  if [ -z "$failure" ]; then mark awaiting-confirmation; fi');
  lines.push("fi");

  // The run waits for the watchdog's outcome a little longer than the watchdog itself can take.
  const limit = settings.activation_timeout + confirm_window(settings) + 120;
  lines.push("outcome=''; waited=0");
  lines.push(`while [ -z "$outcome" ] && [ $waited -lt ${limit} ]; do outcome=$(${host(`cat ${folder}/outcome 2>/dev/null`)}); [ -n "$outcome" ] || { sleep 2; waited=$((waited + 2)); }; done`);
  lines.push(`${host(`cat ${folder}/log 2>/dev/null`)}`);
  // A watchdog that never reported may still be running, so its folder is left for the next switch's sweep.
  lines.push(`if [ -n "$outcome" ]; then ${host(`rm -rf ${folder}`)} || true; fi`);
  lines.push('mark outcome "${outcome:-unknown The watchdog never reported an outcome}"');
  lines.push('case "$outcome" in confirmed*|kept*|unchanged*) exit $rc ;; esac');
  lines.push("[ $rc -ne 0 ] && exit $rc");
  lines.push("exit 1");
  return lines.join("\n");
}

// Clears the folders of switches whose run died a day or more ago, makes this switch's folder, notes the previous
// system, and starts the watchdog in a session of its own.
function start_watchdog_script(settings: DeploymentSettings, mode: SwitchMode, folder: string): string {
  return [
    "set -e",
    `find ${watch_folder_parent} -maxdepth 1 -name '${watch_folder_prefix}*' -mmin +1440 -exec rm -rf {} + 2>/dev/null || true`,
    `mkdir -m 700 ${folder}`,
    `readlink -f /run/current-system > ${folder}/previous_system`,
    `readlink ${system_profile} > ${folder}/previous_profile`,
    `setsid sh -c ${shell_quote(watchdog_script(settings, mode))} x-nix-watchdog ${folder} < /dev/null > ${folder}/log 2>&1 &`,
  ].join("\n");
}

// The watchdog: waits for the activation, then for a confirmation, and rolls back to the previous system without one.
export function watchdog_script(settings: DeploymentSettings, mode: SwitchMode): string {
  const raise = privileged(settings);
  const window = confirm_window(settings);
  const unconfirmed = settings.magic_rollback
    ? `roll_back "X-Nix did not confirm it could still reach the host within ${format_duration(window)} of the activation"`
    : `finish "kept Nothing confirmed the switch within ${format_duration(window)}, and magic_rollback is off"`;
  return [
    'd="$1"',
    'previous=$(cat "$d/previous_system")',
    'previous_profile=$(cat "$d/previous_profile")',
    'finish() { echo "$1" > "$d/outcome.part"; mv -f "$d/outcome.part" "$d/outcome"; exit 0; }',
    `changed() { [ "$(readlink -f /run/current-system)" != "$previous" ] || [ "$(readlink ${system_profile})" != "$previous_profile" ]; }`,
    "roll_back() {",
    '  if ! changed; then finish "unchanged $1"; fi',
    '  echo "Rolling back to $previous: $1"',
    `  if [ "$(readlink ${system_profile})" != "$previous_profile" ]; then`,
    '    generation=${previous_profile#system-}; generation=${generation%-link}',
    `    ${raise}nix-env -p ${system_profile} --switch-generation "$generation" || finish "rollback-failed $1; the system profile could not be reset"`,
    "  fi",
    `  if ${raise}"$previous/bin/switch-to-configuration" ${mode === "test" ? "test" : "switch"}; then finish "rolled-back $1"; fi`,
    '  finish "rollback-failed $1; the previous system did not activate cleanly"',
    "}",
    `deadline=$(( $(date +%s) + ${settings.activation_timeout} ))`,
    'while [ ! -e "$d/activated" ]; do',
    '  if [ -e "$d/rollback" ]; then roll_back "$(cat "$d/rollback")"; fi',
    `  if [ "$(date +%s)" -ge "$deadline" ]; then roll_back "The activation did not finish within ${format_duration(settings.activation_timeout)}"; fi`,
    "  sleep 1",
    "done",
    `deadline=$(( $(date +%s) + ${window} ))`,
    "while :; do",
    '  if [ -e "$d/confirmed" ]; then finish confirmed; fi',
    '  if [ -e "$d/rollback" ]; then roll_back "$(cat "$d/rollback")"; fi',
    `  if [ "$(date +%s)" -ge "$deadline" ]; then ${unconfirmed}; fi`,
    "  sleep 1",
    "done",
  ].join("\n");
}

// What X-Nix runs on the agent that runs the switch to confirm it still reaches the activated host, or that agent itself.
export function confirm_command(settings: DeploymentSettings, token: string): string {
  return on_host(settings, `touch ${watch_folder(token)}/confirmed`);
}

// What X-Nix runs to tell the watchdog to roll back, with the reason on stdin.
export function rollback_signal_command(settings: DeploymentSettings, token: string, reason: string): string {
  const folder = watch_folder(token);
  return `printf '%s\\n' ${shell_quote(reason)} | ${on_host(settings, `cat > ${folder}/rollback.part && mv -f ${folder}/rollback.part ${folder}/rollback`)}`;
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

// Lists every generation of the system profile, one tab-separated line each, after the running and booted systems.
export function generations_script(): string {
  return [
    'echo "current\t$(readlink -f /run/current-system 2>/dev/null)"',
    'echo "booted\t$(readlink -f /run/booted-system 2>/dev/null)"',
    `echo "profile\t$(readlink ${system_profile} 2>/dev/null)"`,
    `for link in ${system_profile}-*-link; do`,
    '  [ -e "$link" ] || continue',
    '  echo "generation\t${link##*/}\t$(stat -c %Y "$link" 2>/dev/null)\t$(readlink -f "$link")\t$(cat "$link/nixos-version" 2>/dev/null)"',
    "done",
  ].join("\n");
}

export function parse_generations(stdout: string): Generation[] {
  const values = new Map<string, string>();
  const rows: string[][] = [];
  for (const line of stdout.split("\n")) {
    const fields = line.split("\t");
    if (fields[0] === "generation") rows.push(fields);
    else if (fields.length >= 2) values.set(fields[0], fields[1].trim());
  }
  const generations: Generation[] = [];
  for (const [, link, created, path, version] of rows) {
    const match = /^system-(\d+)-link$/.exec(link ?? "");
    if (match === null || !path) continue;
    generations.push({
      generation: Number(match[1]),
      created_epoch: /^\d+$/.test(created ?? "") ? Number(created) : null,
      path: path.trim(),
      version: version?.trim() || null,
      current: path.trim() === values.get("current"),
      booted: path.trim() === values.get("booted"),
      profile: link === values.get("profile"),
    });
  }
  return generations.sort((first, second) => second.generation - first.generation);
}

// Points the system profile at an earlier generation and activates it, on the host the switch activates.
export function rollback_command(settings: DeploymentSettings, generation: number, reason: string): string {
  if (!Number.isInteger(generation) || generation < 1) throw new Error(`${generation} is not a generation number`);
  const raise = privileged(settings);
  const inner = `${raise}nix-env -p ${system_profile} --switch-generation ${generation} && ${raise}${system_profile}/bin/switch-to-configuration switch`;
  return kept_awake(settings, `echo ${shell_quote(`Rolling back to generation ${generation}: ${reason}`)}\n${on_host(settings, inner)}`);
}

// ── Keeping the host awake ───────────────────────────────────────────────────

// The words that hold off idle and sleep on the activated host until the inhibitor's stdin closes.
export function inhibitor_words(settings: DeploymentSettings): string {
  return `${privileged(settings)}systemd-inhibit --what=idle:sleep --mode=block --who=X-Nix --why=switching cat`;
}

// Runs the command with inhibit_sleep's inhibitor held through a pipe only this shell keeps open, so it ends with the run.
export function kept_awake(settings: DeploymentSettings, command: string): string {
  if (!settings.inhibit_sleep) return command;
  const warning = shell_quote("Could not keep the host awake during the switch; switching anyway");
  return [
    'if hold=$(mktemp -d) && mkfifo "$hold/pipe"; then',
    `  { ${on_host(settings, inhibitor_words(settings))} > /dev/null || echo ${warning}; } < "$hold/pipe" &`,
    '  exec 9> "$hold/pipe"',
    '  rm -rf "$hold"',
    "else",
    `  echo ${warning}`,
    "fi",
    // The switch runs without the pipe, so nothing it leaves running, such as the watchdog, holds the inhibitor.
    `sh -c ${shell_quote(command)} 9>&-`,
  ].join("\n");
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function clip_line(text: string): string {
  const line = text.split("\n")[0].trim();
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

// Escapes text for use inside a double-quoted shell word.
function escape_double(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$").replaceAll("`", "\\`");
}
