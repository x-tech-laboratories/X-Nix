// Wakes a sleeping host with a Wake-on-LAN magic packet, so an operation on it can start once its agent dials in.

// ── Imports ──────────────────────────────────────────────────────────────────

import { createSocket } from "node:dgram";

import { shell_quote } from "../nixos/commands.ts";

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

// How many copies of the packet go out, as a single one may be dropped.
const copies = 3;

// ── Packet ───────────────────────────────────────────────────────────────────

// Six 0xff bytes, then the MAC address sixteen times.
export function magic_packet(mac: string): Buffer {
  const address = Buffer.from(mac.replace(/[:-]/g, ""), "hex");
  if (address.length !== 6) throw new Error(`'${mac}' is not a MAC address`);
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => address)]);
}

// The command an agent on the sleeping host's network sends the packet with.
export function wake_command(settings: WakeSettings): string {
  return `wakeonlan -i ${shell_quote(settings.broadcast)} -p ${settings.port} ${shell_quote(settings.mac)}`;
}

export async function send_magic_packet(settings: WakeSettings): Promise<void> {
  const packet = magic_packet(settings.mac);
  const socket = createSocket("udp4");
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(() => resolve());
    });
    socket.setBroadcast(true);
    for (let sent = 0; sent < copies; sent++) {
      await new Promise<void>((resolve, reject) => socket.send(packet, settings.port, settings.broadcast, (error) => (error ? reject(error) : resolve())));
    }
  } finally {
    socket.close();
  }
}

// ── Keeping awake ────────────────────────────────────────────────────────────

// The words that hold off idle and sleep on a host that sleeps until the inhibitor's stdin closes.
export const job_inhibitor = "sudo -n systemd-inhibit --what=idle:sleep --mode=block --who=X-Nix --why=job cat";

// Runs a command with an inhibitor held through a pipe only this shell keeps open, so the inhibitor ends with the run.
export function with_inhibitor(inhibitor: string, warning: string, command: string): string {
  return [
    'if hold=$(mktemp -d) && mkfifo "$hold/pipe"; then',
    `  { ${inhibitor} > /dev/null || echo ${shell_quote(warning)}; } < "$hold/pipe" &`,
    '  exec 9> "$hold/pipe"',
    '  rm -rf "$hold"',
    "else",
    `  echo ${shell_quote(warning)}`,
    "fi",
    // The command runs without the pipe, so nothing it leaves running, such as a watchdog, holds the inhibitor.
    `sh -c ${shell_quote(command)} 9>&-`,
  ].join("\n");
}

// Runs a job on a host that sleeps with idle and sleep held off until the job ends.
export function kept_awake_job(command: string): string {
  return with_inhibitor(job_inhibitor, "Could not keep the host awake during the job; running it anyway", command);
}
