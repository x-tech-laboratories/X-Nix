// Wake-on-LAN: the magic packet that wakes a sleeping host, sent by the server or by an agent on that host's network.

// ── Imports ──────────────────────────────────────────────────────────────────

import { createSocket } from "node:dgram";

// ── Packet ───────────────────────────────────────────────────────────────────

// Where a packet goes: the MAC address of the card that wakes the host, the address it is sent to, and the port.
export interface WakeTarget {
  mac: string;
  broadcast: string;
  port: number;
}

// How many copies of the packet go out, as a single one may be dropped.
const copies = 3;

// Six 0xff bytes, then the MAC address sixteen times.
export function magic_packet(mac: string): Buffer {
  const address = Buffer.from(mac.replace(/[:-]/g, ""), "hex");
  if (address.length !== 6) throw new Error(`'${mac}' is not a MAC address`);
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => address)]);
}

export async function send_magic_packet(target: WakeTarget): Promise<void> {
  const packet = magic_packet(target.mac);
  const socket = createSocket("udp4");
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(() => resolve());
    });
    socket.setBroadcast(true);
    for (let sent = 0; sent < copies; sent++) {
      await new Promise<void>((resolve, reject) => socket.send(packet, target.port, target.broadcast, (error) => (error ? reject(error) : resolve())));
    }
  } finally {
    socket.close();
  }
}
