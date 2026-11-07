import { createSocket } from "node:dgram";

import { describe, expect, it } from "vitest";

import { perform } from "../src/agent/operations/index.ts";
import { spawn_program, type Context } from "../src/agent/programs.ts";
import { AgentPool, type Agent } from "../src/server/agents/agent.ts";
import { job_inhibitor, kept_awake_job, magic_packet, send_magic_packet, wake_operation, type WakeSettings } from "../src/server/agents/wake.ts";
import { start_run } from "../src/server/runs.ts";
import { ConfigError, parse_config } from "../src/server/config.ts";
import type { Operation } from "../src/shared/operations.ts";

const thor: WakeSettings = { mac: "aa:bb:cc:dd:ee:ff", broadcast: "127.0.0.1", port: 9, timeout: 1, via: null };

const plain: Operation = { kind: "probe" };

function fake_agent(name: string, operations: Operation[] = [], exit_code = 0): Agent {
  return {
    run: async (operation) => {
      operations.push(operation);
      return { exit_code, stdout: name, stderr: "" };
    },
    start: async (run_id, operation) => {
      operations.push(operation);
      return { run_id, pid: 1, started_epoch: 0 } as never;
    },
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
    expect((await agent.run(plain, { timeout_in_seconds: 5 })).stdout).toBe("thor");
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
    expect((await missing.run(plain, { timeout_in_seconds: 5 })).stderr).toMatch(/No agent named 'odin'/);
  });

  it("says so when the agent does not dial in in time, or the packet cannot be sent", async () => {
    const quiet = new AgentPool("server", fake_agent("server"), async () => {});
    quiet.set_wake(new Map([["thor", thor]]));
    const failing = new AgentPool("server", fake_agent("server"), async () => {
      throw new Error("no route");
    });
    failing.set_wake(new Map([["thor", thor]]));

    await expect((await quiet.awake("thor")).start("run", plain)).rejects.toMatchObject({ unreachable: true, message: expect.stringMatching(/did not connect within 1 second/) });
    expect((await (await failing.awake("thor")).run(plain, { timeout_in_seconds: 5 })).stderr).toBe("Could not wake thor: no route");
  });
});

describe("waking through another host's agent", () => {
  it("has that agent send the packet, and says so when it fails", async () => {
    const sent: Operation[] = [];
    const pool = new AgentPool("server", fake_agent("server"), async () => {
      throw new Error("the server sent it");
    });
    pool.add("heimdall", fake_agent("heimdall", sent));
    pool.set_wake(new Map([["thor", { ...thor, broadcast: "192.168.0.255", via: "heimdall" }]]));
    setTimeout(() => pool.add("thor", fake_agent("thor")), 20);

    await pool.awake("thor");
    const failing = new AgentPool("server", fake_agent("server"));
    failing.add("heimdall", fake_agent("heimdall", [], 127));
    failing.set_wake(new Map([["thor", { ...thor, via: "heimdall" }]]));

    expect(sent).toEqual([{ kind: "wake", mac: "aa:bb:cc:dd:ee:ff", broadcast: "192.168.0.255", port: 9 }]);
    expect(wake_operation(thor)).toEqual({ kind: "wake", mac: thor.mac, broadcast: thor.broadcast, port: thor.port });
    expect((await (await failing.awake("thor")).run(plain, { timeout_in_seconds: 5 })).stderr).toMatch(/^Could not wake thor: heimdall could not send the packet/);
  });
});

// ── Keeping awake ────────────────────────────────────────────────────────────

describe("a job on a host that sleeps", () => {
  it("holds a sleep inhibitor for as long as the job runs, unless keep_awake is off", async () => {
    const thor_operations: Operation[] = [];
    const odin_operations: Operation[] = [];
    const pool = new AgentPool("server", fake_agent("server"));
    pool.add("thor", fake_agent("thor", thor_operations));
    pool.add("odin", fake_agent("odin", odin_operations));
    pool.set_wake(new Map([["thor", thor], ["odin", thor]]), new Set(["thor"]));

    await start_run(pool, "thor", "run-1", plain);
    await start_run(pool, "odin", "run-2", plain);

    expect(thor_operations).toEqual([kept_awake_job(plain)]);
    expect(job_inhibitor).toEqual(["sudo", "-n", "systemd-inhibit", "--what=idle:sleep", "--mode=block", "--who=X-Nix", "--why=job", "cat"]);
    expect(odin_operations).toEqual([plain]);
  });

  it("still runs the job, and keeps its exit status, when the inhibitor cannot be held", async () => {
    const run = async (command: string) => {
      let output = "";
      const sink = { write: (chunk: Buffer | string) => void (output += chunk.toString()) };
      const context: Context = { out: sink, err: sink, signal: new AbortController().signal, own_groups: false, log: false, stdin: null, program: spawn_program };
      const job = { ...kept_awake_job({ kind: "programs", steps: [{ argv: ["/bin/sh", "-c", `sleep 0.2; ${command}`] }] }), inhibitor: { argv: ["false"] } };
      return { status: await perform(context, job), output };
    };

    expect(await run("echo built")).toEqual({ output: expect.stringContaining("built\n"), status: 0 });
    expect((await run("exit 3")).status).toBe(3);
    expect((await run("echo built")).output).toContain("Could not keep the host awake");
  });
});

// ── Config ───────────────────────────────────────────────────────────────────

describe("wake-on-LAN settings", () => {
  const hosts = (wake: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    parse_config({ hosts: Object.entries(wake).map(([id, wake_on_lan]) => ({ id, wake_on_lan, ...extra })) });

  it("take a bare MAC address or an object, with defaults, and keep the host awake unless told not to", () => {
    const config = hosts({ thor: "aa:bb:cc:dd:ee:ff", odin: { mac: "AA-BB-CC-DD-EE-01", broadcast: "192.168.1.255", port: 7, timeout: "5m" } });

    expect(config.wake_on_lan.get("thor")).toEqual({ mac: "aa:bb:cc:dd:ee:ff", broadcast: "255.255.255.255", port: 9, timeout: 180, via: null });
    expect(config.wake_on_lan.get("odin")).toEqual({ mac: "AA-BB-CC-DD-EE-01", broadcast: "192.168.1.255", port: 7, timeout: 300, via: null });
    expect([...config.keep_awake].sort()).toEqual(["odin", "thor"]);
    const quiet = hosts({ thor: { mac: "aa:bb:cc:dd:ee:ff", via: "heimdall" } }, { keep_awake: false });
    expect(quiet.wake_on_lan.get("thor")).toMatchObject({ via: "heimdall" });
    expect(quiet.keep_awake.size).toBe(0);
  });

  it("belong to each host, not a top-level map", () => {
    expect(() => parse_config({ wake_on_lan: { thor: "aa:bb:cc:dd:ee:ff" } })).toThrow(/belongs to each host/);
  });

  it("refuse a bad MAC address, port or shape", () => {
    expect(() => hosts({ thor: "aa:bb:cc" })).toThrow(ConfigError);
    expect(() => hosts({ thor: { mac: "aa:bb:cc:dd:ee:ff", port: 70000 } })).toThrow(ConfigError);
    expect(() => hosts({ thor: ["thor"] })).toThrow(ConfigError);
  });
});
