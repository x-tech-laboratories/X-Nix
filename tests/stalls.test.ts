import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { nix_database_lock, watch_for_stalls } from "../src/agent/stalls.ts";

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

// ── Notes ────────────────────────────────────────────────────────────────────

describe("stall notes", () => {
  it("name the Nix store database a switch waits for, with how to free it, each line marked", () => {
    let clock = 0;
    let written = "";
    const stalls = watch_for_stalls(100, (text) => (written += text), { now: () => clock, proc: fake_proc(), lock_files: { [nix_database_lock]: database } });

    clock = 300_000;
    stalls.look();
    stalls.stop();

    const lines = written.trimEnd().split("\n");
    expect(lines[0]).toBe("@@x-nix-stall No output for 5 minutes; still running sudo › .switch-to-conf › nix-env (pid 103)");
    expect(lines[1]).toBe(
      "@@x-nix-stall nix-env (pid 103) waits for the Nix store database (/nix/var/nix/db/big-lock), held by nix-daemon (pid 201, running for 1 day), " +
        "nixd-attrset-ev (pid 300, running for 1 day)",
    );
    expect(lines[2]).toMatch(/^@@x-nix-stall .*close_nix_lock_holders/);
  });

  it("carry the run's marker token after the mark when the server issued one", () => {
    let clock = 0;
    let written = "";
    const marker_token = "c".repeat(32);
    const stalls = watch_for_stalls(100, (text) => (written += text), { now: () => clock, proc: fake_proc(), lock_files: { [nix_database_lock]: database } }, marker_token);

    clock = 300_000;
    stalls.look();
    stalls.stop();

    expect(written.trimEnd().split("\n").every((line) => line.startsWith(`@@x-nix-stall ${marker_token} `))).toBe(true);
  });
});
