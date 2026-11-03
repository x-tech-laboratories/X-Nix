// Wakes a sleeping host with a Wake-on-LAN magic packet, so an operation on it can start once its agent dials in.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { KeptAwakeOperation, Operation, WakeOperation } from "../../shared/operations.ts";

export { magic_packet, send_magic_packet } from "../../shared/wake.ts";

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
}

export type SendWake = (settings: WakeSettings) => Promise<void>;

// ── Packet ───────────────────────────────────────────────────────────────────

// What an agent on the sleeping host's network does to send the packet.
export function wake_operation(settings: WakeSettings): WakeOperation {
  return { kind: "wake", mac: settings.mac, broadcast: settings.broadcast, port: settings.port };
}

// ── Keeping awake ────────────────────────────────────────────────────────────

// The program that holds off idle and sleep on a host that sleeps until its stdin closes.
export const job_inhibitor = ["sudo", "-n", "systemd-inhibit", "--what=idle:sleep", "--mode=block", "--who=X-Nix", "--why=job", "cat"];

// Runs a job on a host that sleeps with idle and sleep held off until the job ends.
export function kept_awake_job(operation: Operation): KeptAwakeOperation {
  return { kind: "kept_awake", inhibitor: { argv: job_inhibitor }, warning: "Could not keep the host awake during the job; running it anyway", operation };
}
