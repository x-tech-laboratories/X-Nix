import { createSocket } from "node:dgram";

import { describe, expect, it } from "vitest";

import { AgentPool, type Agent } from "../src/server/agents/agent.ts";
import { kept_awake_job, magic_packet, send_magic_packet, type WakeSettings } from "../src/server/agents/wake.ts";
import { start_run } from "../src/server/runs.ts";
import { ConfigError, parse_config } from "../src/server/config.ts";

const thor: WakeSettings = { mac: "aa:bb:cc:dd:ee:ff", broadcast: "127.0.0.1", port: 9, timeout: 1, via: null, keep_awake: true };

function fake_agent(name: string, commands: string[] = [], exit_code = 0): Agent {
  return {
    run: async (command) => {
      commands.push(command);
      return { exit_code, stdout: name, stderr: "" };
    },
    start: async (run_id, command) => {
      commands.push(command);
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

describe("waking through another host's agent", () => {
  it("runs wakeonlan on that agent, and says so when it fails", async () => {
    const sent: string[] = [];
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

    expect(sent).toEqual(["wakeonlan -i 192.168.0.255 -p 9 aa:bb:cc:dd:ee:ff"]);
    expect((await (await failing.awake("thor")).run("true", 5)).stderr).toMatch(/^Could not wake thor: heimdall could not send the packet/);
  });
});

// ── Keeping awake ────────────────────────────────────────────────────────────

describe("a job on a host that sleeps", () => {
  it("holds a sleep inhibitor for as long as the job runs, unless keep_awake is off", async () => {
    const thor_commands: string[] = [];
    const odin_commands: string[] = [];
    const pool = new AgentPool("server", fake_agent("server"));
    pool.add("thor", fake_agent("thor", thor_commands));
    pool.add("odin", fake_agent("odin", odin_commands));
    pool.set_wake(new Map([["thor", thor], ["odin", { ...thor, keep_awake: false }]]));

    await start_run(pool, "thor", "run-1", "nix build");
    await start_run(pool, "odin", "run-2", "nix build");

    expect(thor_commands).toEqual([kept_awake_job("nix build")]);
    expect(thor_commands[0]).toContain("sudo -n systemd-inhibit --what=idle:sleep --mode=block --who=X-Nix --why=job cat");
    expect(thor_commands[0]).toMatch(/sh -c 'nix build' 9>&-$/);
    expect(odin_commands).toEqual(["nix build"]);
  });

  it("still runs the command, and its exit status, when the inhibitor cannot be held", async () => {
    const { execFileSync } = await import("node:child_process");
    const run = (command: string) => {
      try {
        return { output: execFileSync("sh", ["-c", kept_awake_job(command).replace("sudo -n systemd-inhibit", "false")], { encoding: "utf8" }), status: 0 };
      } catch (error) {
        return { output: (error as { stdout: string }).stdout, status: (error as { status: number }).status };
      }
    };

    expect(run("echo built")).toEqual({ output: expect.stringContaining("built\n"), status: 0 });
    expect(run("exit 3").status).toBe(3);
    expect(run("echo built").output).toContain("Could not keep the host awake");
  });
});

// ── Config ───────────────────────────────────────────────────────────────────

describe("wake-on-LAN settings", () => {
  it("take a bare MAC address or an object, with defaults", () => {
    const settings = parse_config({ wake_on_lan: { thor: "aa:bb:cc:dd:ee:ff", odin: { mac: "AA-BB-CC-DD-EE-01", broadcast: "192.168.1.255", port: 7, timeout: "5m" } } }).wake_on_lan;

    expect(settings.get("thor")).toEqual({ mac: "aa:bb:cc:dd:ee:ff", broadcast: "255.255.255.255", port: 9, timeout: 180, via: null, keep_awake: true });
    expect(settings.get("odin")).toEqual({ mac: "AA-BB-CC-DD-EE-01", broadcast: "192.168.1.255", port: 7, timeout: 300, via: null, keep_awake: true });
    expect(parse_config({ wake_on_lan: { thor: { mac: "aa:bb:cc:dd:ee:ff", via: "heimdall", keep_awake: false } } }).wake_on_lan.get("thor")).toMatchObject({ via: "heimdall", keep_awake: false });
  });

  it("refuse a bad MAC address, port or shape", () => {
    expect(() => parse_config({ wake_on_lan: { thor: "aa:bb:cc" } })).toThrow(ConfigError);
    expect(() => parse_config({ wake_on_lan: { thor: { mac: "aa:bb:cc:dd:ee:ff", port: 70000 } } })).toThrow(ConfigError);
    expect(() => parse_config({ wake_on_lan: ["thor"] })).toThrow(ConfigError);
  });
});
