// Wakes a sleeping host with a Wake-on-LAN magic packet, so an operation on it can start once its agent dials in.

// ── Imports ──────────────────────────────────────────────────────────────────

import { createSocket } from "node:dgram";

// ── Settings ─────────────────────────────────────────────────────────────────

export interface WakeSettings {
  // The MAC address of the network card that wakes the host, as six hex pairs.
  mac: string;
  // The address the packet is sent to, usually the LAN's broadcast address.
  broadcast: string;
  port: number;
  // How long to wait for the host's agent to dial in after the packet, in seconds.
  timeout: number;
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
