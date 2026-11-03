// The cheap facts read from a deployment's host every cycle: what is running, what was booted, and its generation.

// ── Imports ──────────────────────────────────────────────────────────────────

import { read_facts, type ProbeFields } from "../../shared/facts.ts";
import type { Operation } from "../../shared/operations.ts";

export { boot_parts, generation_of, type ProbeFields } from "../../shared/facts.ts";

// ── Boot parts ───────────────────────────────────────────────────────────────

// Whether any booted part differs from the current one; null when the comparison could not be made.
export function reboot_required(booted: string[], current: string[]): boolean | null {
  if (booted.length === 0 || booted.length !== current.length || !booted.some(Boolean)) return null;
  return booted.some((path, index) => path !== current[index]);
}

// ── Probe ────────────────────────────────────────────────────────────────────

export function probe_operation(): Operation {
  return { kind: "probe" };
}

// The probe's facts, or null when it printed none.
export function parse_probe(stdout: string): ProbeFields | null {
  return read_facts<ProbeFields>(stdout);
}
