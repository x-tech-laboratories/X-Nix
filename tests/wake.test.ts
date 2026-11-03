import { createSocket } from "node:dgram";

import { describe, expect, it } from "vitest";

import { AgentPool, type Agent } from "../src/server/agents/agent.ts";
import { magic_packet, send_magic_packet, type WakeSettings } from "../src/server/agents/wake.ts";
import { ConfigError, parse_config } from "../src/server/config.ts";

const thor: WakeSettings = { mac: "aa:bb:cc:dd:ee:ff", broadcast: "127.0.0.1", port: 9, timeout: 1 };

function fake_agent(name: string): Agent {
  return {
    run: async () => ({ exit_code: 0, stdout: name, stderr: "" }),
    start: async (run_id) => ({ run_id, pid: 1, started_epoch: 0 }) as never,
    poll: async () => ({ alive: false, exit_code: 0, new_output: "", offset: 0 }) as never,
    forget: async () => {},
  };
}

// ── Packet ───────────────────────────────────────────────────────────────────

describe("the magic packet", () => {
  it("is six 0xff bytes and the MAC address sixteen times", () => {
    const packet = magic_packet("aa-bb-cc-dd-ee-ff");

    expect(packet.length).toBe(102);
    expect(packet.subarray(0, 6)).toEqual(Buffer.alloc(6, 0xff));
    expect(packet.subarray(96).toString("hex")).toBe("aabbccddeeff");
  });

  it("reaches a listener on the address and port it is sent to", async () => {
    const listener = createSocket("udp4");
    await new Promise<void>((resolve) => listener.bind(0, "127.0.0.1", () => resolve()));
    const received = new Promise<Buffer>((resolve) => listener.once("message", resolve));

    await send_magic_packet({ ...thor, port: listener.address().port });

    expect(await received).toEqual(magic_packet(thor.mac));
    listener.close();
  });
});

// ── Pool ─────────────────────────────────────────────────────────────────────

describe("waking a host through the pool", () => {
  it("sends the packet and answers with the agent once it dials in", async () => {
    const sent: WakeSettings[] = [];
    const pool = new AgentPool("server", fake_agent("server"), async (settings) => {
      sent.push(settings);
      setTimeout(() => pool.add("thor", fake_agent("thor")), 20);
    });
    pool.set_wake(new Map([["thor", thor]]));

    const agent = await pool.awake("thor");

    expect(sent).toEqual([thor]);
    expect((await agent.run("true", 5)).stdout).toBe("thor");
  });

  it("sends nothing to a host already connected, one it cannot wake, or the server's own", async () => {
    let sent = 0;
    const pool = new AgentPool("server", fake_agent("server"), async () => void sent++);
    pool.set_wake(new Map([["thor", thor]]));
    pool.add("thor", fake_agent("thor"));

    await pool.awake("thor");
    await pool.awake(null);
    const missing = await pool.awake("odin");

    expect(sent).toBe(0);
    expect((await missing.run("true", 5)).stderr).toMatch(/No agent named 'odin'/);
  });

  it("says so when the agent does not dial in in time, or the packet cannot be sent", async () => {
    const quiet = new AgentPool("server", fake_agent("server"), async () => {});
    quiet.set_wake(new Map([["thor", thor]]));
    const failing = new AgentPool("server", fake_agent("server"), async () => {
      throw new Error("no route");
    });
    failing.set_wake(new Map([["thor", thor]]));

    await expect((await quiet.awake("thor")).start("run", "true")).rejects.toMatchObject({ unreachable: true, message: expect.stringMatching(/did not connect within 1 second/) });
    expect((await (await failing.awake("thor")).run("true", 5)).stderr).toBe("Could not wake thor: no route");
  });
});

// ── Config ───────────────────────────────────────────────────────────────────

describe("wake-on-LAN settings", () => {
  it("take a bare MAC address or an object, with defaults", () => {
    const settings = parse_config({ wake_on_lan: { thor: "aa:bb:cc:dd:ee:ff", odin: { mac: "AA-BB-CC-DD-EE-01", broadcast: "192.168.1.255", port: 7, timeout: "5m" } } }).wake_on_lan;

    expect(settings.get("thor")).toEqual({ mac: "aa:bb:cc:dd:ee:ff", broadcast: "255.255.255.255", port: 9, timeout: 180 });
    expect(settings.get("odin")).toEqual({ mac: "AA-BB-CC-DD-EE-01", broadcast: "192.168.1.255", port: 7, timeout: 300 });
  });

  it("refuse a bad MAC address, port or shape", () => {
    expect(() => parse_config({ wake_on_lan: { thor: "aa:bb:cc" } })).toThrow(ConfigError);
    expect(() => parse_config({ wake_on_lan: { thor: { mac: "aa:bb:cc:dd:ee:ff", port: 70000 } } })).toThrow(ConfigError);
    expect(() => parse_config({ wake_on_lan: ["thor"] })).toThrow(ConfigError);
  });
});
