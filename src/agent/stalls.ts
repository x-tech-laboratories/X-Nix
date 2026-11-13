// Notes a long run's stall in its own output: once it has printed nothing for a while, what it still runs and what that
// waits for, again each half hour it stays quiet.

// ── Imports ──────────────────────────────────────────────────────────────────

import { describe_stall, type StallOptions } from "./waits.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

export const first_note_in_seconds = 300;
export const later_notes_in_seconds = 1800;
const look_interval_in_milliseconds = 30_000;

// ── Watching ─────────────────────────────────────────────────────────────────

export interface StallWatch {
  // Called on every piece of output the operation prints.
  heard(): void;
  // Looks now rather than on the next tick; the timer calls it too.
  look(): void;
  stop(): void;
}

export function watch_for_stalls(root: number, write: (text: string) => void, now: () => number = () => Date.now(), options: StallOptions = {}): StallWatch {
  let last_heard = now();
  let next_note = last_heard + first_note_in_seconds * 1000;

  const look = () => {
    if (now() < next_note) return;
    const lines = describe_stall(root, (now() - last_heard) / 1000, options);
    write(`${lines.join("\n")}\n`);
    next_note = now() + later_notes_in_seconds * 1000;
  };
  const timer = setInterval(look, look_interval_in_milliseconds);
  timer.unref();

  return {
    heard: () => {
      last_heard = now();
      next_note = last_heard + first_note_in_seconds * 1000;
    },
    look,
    stop: () => clearInterval(timer),
  };
}
