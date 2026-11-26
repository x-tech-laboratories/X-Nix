// Notes a long run's stall in its own output through X-Libs' agent/stalls, naming the Nix locks a stalled switch most
// often waits for and marking each line so the server picks the notes out.

// ── Imports ──────────────────────────────────────────────────────────────────

import { watch_for_stalls as watch, type KnownLock, type StallWatch, type StallWatchOptions } from "@x-tech-laboratories/x-libs/agent/stalls";

import { mark_prefix, stall_mark } from "../shared/operations.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

export const nix_database_lock = "/nix/var/nix/db/big-lock";
export const switch_lock = "/run/nixos/switch-to-configuration.lock";

export const known_locks: Record<string, KnownLock> = {
  [nix_database_lock]: {
    name: "the Nix store database",
    hint:
      "A newer Nix needs the store database to itself to upgrade it; long-lived Nix clients, such as a language server, keep it from getting it. " +
      "close_nix_lock_holders stops them on its own.",
  },
  [switch_lock]: { name: "the switch lock, held by another switch" },
};

// ── Watching ─────────────────────────────────────────────────────────────────

// Marks each note with the run's marker token after the mark, when the server issued one.
export function watch_for_stalls(root: number, write: (text: string) => void, options: StallWatchOptions = {}, marker_token: string | null = null): StallWatch {
  return watch(root, write, { known_locks, mark: mark_prefix(stall_mark, marker_token), ...options });
}
