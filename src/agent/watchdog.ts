// The watchdog of one guarded switch, started in a session of its own so it outlives the switch's run, the agent and
// any lost connection. It waits for the activation, then for a confirmation, and rolls back to the previous system
// without one. Its folder holds what the switch left it: the previous system and profile link, its settings, and the
// files X-Nix writes to confirm or to ask for a rollback; it ends by writing its outcome there.

// ── Imports ──────────────────────────────────────────────────────────────────

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

import type { SwitchWatch } from "../shared/operations.ts";
import { link_target, real } from "./operations/reads.ts";
import { spawn_program, type Context } from "./programs.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

export const system_profile = "/nix/var/nix/profiles/system";

// How often the watchdog looks at its folder.
const look_interval_in_milliseconds = 1000;

// The files of a watchdog's folder.
export const watch_files = {
  settings: "watch.json",
  previous_system: "previous_system",
  previous_profile: "previous_profile",
  activated: "activated",
  confirmed: "confirmed",
  rollback: "rollback",
  outcome: "outcome",
  log: "log",
} as const;

// ── Watching ─────────────────────────────────────────────────────────────────

// Watches the switch and answers its outcome: confirmed, kept, unchanged, rolled-back or rollback-failed, then why.
export async function watch_switch(folder: string, context: Context, now: () => number = () => Date.now()): Promise<string> {
  const watch = JSON.parse(readFileSync(join(folder, watch_files.settings), "utf8")) as SwitchWatch;
  const previous = read(folder, watch_files.previous_system);
  const previous_profile = read(folder, watch_files.previous_profile);
  const raise = watch.require_sudo ? ["sudo", "-n"] : [];
  const has = (name: string) => existsSync(join(folder, name));

  const profile_link = () => link_target(system_profile) ?? "";
  const changed = () => (real("/run/current-system") ?? "") !== previous || profile_link() !== previous_profile;

  const roll_back = async (reason: string): Promise<string> => {
    if (!changed()) return `unchanged ${reason}`;
    context.out.write(`Rolling back to ${previous}: ${reason}\n`);
    if (profile_link() !== previous_profile) {
      const generation = previous_profile.replace(/^system-/, "").replace(/-link$/, "");
      const reset = await context.program(context, [...raise, "nix-env", "-p", system_profile, "--switch-generation", generation], { echo: true });
      if (reset.exit_code !== 0) return `rollback-failed ${reason}; the system profile could not be reset`;
    }
    const activated = await context.program(context, [...raise, `${previous}/bin/switch-to-configuration`, watch.rollback_mode], { echo: true });
    return activated.exit_code === 0 ? `rolled-back ${reason}` : `rollback-failed ${reason}; the previous system did not activate cleanly`;
  };

  let deadline = now() + watch.activation_timeout * 1000;
  while (!has(watch_files.activated)) {
    if (has(watch_files.rollback)) return roll_back(read(folder, watch_files.rollback));
    if (now() >= deadline) return roll_back(watch.activation_reason);
    await sleep(look_interval_in_milliseconds);
  }
  deadline = now() + watch.confirm_window * 1000;
  for (;;) {
    if (has(watch_files.confirmed)) return "confirmed";
    if (has(watch_files.rollback)) return roll_back(read(folder, watch_files.rollback));
    if (now() >= deadline) return watch.magic_rollback ? roll_back(watch.unconfirmed_reason) : `kept ${watch.unconfirmed_reason}`;
    await sleep(look_interval_in_milliseconds);
  }
}

// Writes a file in one rename, so a reader never sees half of it.
export function write_whole(path: string, text: string): void {
  writeFileSync(`${path}.part`, text);
  renameSync(`${path}.part`, path);
}

function read(folder: string, name: string): string {
  try {
    return readFileSync(join(folder, name), "utf8").trim();
  } catch {
    return "";
  }
}

// ── Start ────────────────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const folder = process.argv[2];
  const sink = { write: (chunk: Buffer | string) => void process.stdout.write(chunk) };
  const context: Context = { out: sink, err: sink, signal: new AbortController().signal, own_groups: false, log: true, stdin: null, program: spawn_program };
  const outcome = await watch_switch(folder, context);
  write_whole(join(folder, watch_files.outcome), `${outcome}\n`);
}
