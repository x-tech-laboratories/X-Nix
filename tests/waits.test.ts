import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { watch_for_stalls } from "../src/agent/stalls.ts";
import { describe_stall, lock_holders, nix_database_lock, read_locks } from "../src/agent/waits.ts";

// ── Setup ────────────────────────────────────────────────────────────────────

const folders: string[] = [];

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

// The database lock's id in the fake /proc/locks.
const database = "00:21:13";

// A /proc with a runner (100) whose switch waits for the Nix store database, held for a day by a nix-daemon worker and a
// language server's evaluator.
function fake_proc(): string {
  const proc = mkdtempSync(join(tmpdir(), "x-nix-proc-"));
  folders.push(proc);
  writeFileSync(join(proc, "uptime"), "100000.00 1.00\n");
  const processes: [number, number, string, number][] = [
    [1, 0, "systemd", 0],
    [100, 1, "node", 9_000_000],
    [101, 100, "sudo", 9_000_000],
    [102, 101, ".switch-to-conf", 9_000_000],
    [103, 102, "nix-env", 9_000_000],
    [200, 1, "nix-daemon", 0],
    [201, 200, "nix-daemon", 1_360_000],
    [300, 1, "nixd-attrset-ev", 1_360_000],
  ];
  for (const [pid, ppid, name, started] of processes) {
    mkdirSync(join(proc, String(pid)));
    const fields = ["S", ppid, ...Array(17).fill(0), started];
    writeFileSync(join(proc, String(pid), "stat"), `${pid} (${name}) ${fields.join(" ")}\n`);
  }
  writeFileSync(join(proc, "locks"), [
    `1: FLOCK  ADVISORY  READ 201 ${database} 0 EOF`,
    `2: FLOCK  ADVISORY  READ 300 ${database} 0 EOF`,
    `2: -> FLOCK  ADVISORY  WRITE 103 ${database} 0 EOF`,
    "3: POSIX  ADVISORY  WRITE 102 00:19:55 0 EOF",
  ].join("\n"));
  return proc;
}

// ── Reading ──────────────────────────────────────────────────────────────────

describe("what a stalled run waits for", () => {
  it("reads who waits for a lock and who holds it", () => {
    const proc = fake_proc();

    expect(read_locks(proc).filter((entry) => entry.waiting)).toEqual([{ pid: 103, waiting: true, mode: "WRITE", file: database }]);
    expect(lock_holders(nix_database_lock, new Set([103]), proc, database).map((info) => info.pid)).toEqual([201, 300]);
  });

  it("names what the run still runs, the lock it waits for and its holders, with how long each has run", () => {
    const lines = describe_stall(100, 600, { proc: fake_proc(), lock_files: { [nix_database_lock]: database } });

    expect(lines[0]).toBe("@@x-nix-stall No output for 10 minutes; still running sudo › .switch-to-conf › nix-env (pid 103)");
    expect(lines[1]).toBe(
      "@@x-nix-stall nix-env (pid 103) waits for the Nix store database (/nix/var/nix/db/big-lock), held by nix-daemon (pid 201, running for 1 day), " +
        "nixd-attrset-ev (pid 300, running for 1 day)",
    );
    expect(lines[2]).toContain("close_nix_lock_holders");
  });

  it("notes a stall once the run has been quiet five minutes, and again half an hour later", () => {
    let clock = 0;
    let written = "";
    const stalls = watch_for_stalls(100, (text) => (written += text), () => clock, { proc: fake_proc(), lock_files: { [nix_database_lock]: database } });

    clock = 299_000;
    stalls.look();
    expect(written).toBe("");
    clock = 300_000;
    stalls.look();
    expect(written.match(/No output/g)).toHaveLength(1);
    stalls.heard();
    clock = 500_000;
    stalls.look();
    expect(written.match(/No output/g)).toHaveLength(1);
    clock = 600_000;
    stalls.look();
    clock = 1_000_000;
    stalls.look();
    expect(written.match(/No output/g)).toHaveLength(2);
    stalls.stop();
  });
});
