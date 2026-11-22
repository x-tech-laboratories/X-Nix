// Wakes a sleeping host with a Wake-on-LAN magic packet, so an operation on it can start once its agent dials in.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { KeptAwakeOperation, Operation, WakeOperation } from "../../shared/operations.ts";

export { magic_packet, send_magic_packet } from "@x-tech-laboratories/x-libs/agent/wake";

// ── Settings ─────────────────────────────────────────────────────────────────

export interface WakeSettings {
  // The MAC address of the network card that wakes the host, as six hex pairs.
  mac: string;
  // The address the packet is sent to, usually the LAN's broadcast address.
  broadcast: string;
  port: number;
  // How long to wait for the host's agent to dial in after the packet, in seconds.
  timeout: number;
  // The host whose agent sends the packet, for a host on another network; the server sends it itself when null.
  via: string | null;
  // A shell command the agent runs once a job has woken the host, such as one turning its screen back off.
  screen_off: string | null;
}

export type SendWake = (settings: WakeSettings) => Promise<void>;

// ── Packet ───────────────────────────────────────────────────────────────────

// What an agent on the sleeping host's network does to send the packet.
export function wake_operation(settings: WakeSettings): WakeOperation {
  return { kind: "wake", mac: settings.mac, broadcast: settings.broadcast, port: settings.port };
}

// ── Keeping awake ────────────────────────────────────────────────────────────

// The program that holds off sleep on a host that sleeps until its stdin closes; its screen may still go dark.
export const job_inhibitor = ["sudo", "-n", "systemd-inhibit", "--what=sleep", "--mode=block", "--who=X-Nix", "--why=job", "cat"];

// Runs a job on a host that sleeps with sleep held off until the job ends, first running screen_off when the job woke it.
export function kept_awake_job(operation: Operation, screen_off: string | null = null): KeptAwakeOperation {
  return {
    kind: "kept_awake", inhibitor: { argv: job_inhibitor }, warning: "Could not keep the host awake during the job; running it anyway", operation,
    ...(screen_off === null ? {} : { after_wake: { argv: ["/bin/sh", "-c", screen_off] } }),
  };
}
