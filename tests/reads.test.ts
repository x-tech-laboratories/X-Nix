import { describe, expect, it } from "vitest";

import { store_probe } from "../src/agent/operations/reads.ts";
import type { Context, ProgramResult } from "../src/agent/programs.ts";
import type { GcFields } from "../src/shared/facts.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

// A context whose programs answer by their first word, printing into one string.
function fake_context(answer: (argv: string[]) => ProgramResult): { context: Context; output: () => string } {
  let output = "";
  const sink = { write: (chunk: Buffer | string) => void (output += chunk.toString()) };
  const context: Context = {
    out: sink, err: sink, signal: new AbortController().signal, own_groups: false, log: false, stdin: null,
    program: async (_context, argv) => answer(argv),
  };
  return { context, output: () => output };
}

const ok = (stdout: string): ProgramResult => ({ exit_code: 0, stdout, stderr: "" });

// ── Store ────────────────────────────────────────────────────────────────────

describe("the store read", () => {
  it("reads the unit, the timer and the journal's last lines", async () => {
    const { context, output } = fake_context((argv) => {
      if (argv[0] === "systemctl" && argv[2] === "nix-gc.service") return ok("ActiveState=inactive\nResult=success\nInactiveEnterTimestamp=@1788757200\n");
      if (argv[0] === "systemctl") return ok("LoadState=loaded\nActiveState=active\nNextElapseUSecRealtime=@1789000000\n");
      if (argv.includes("store paths deleted")) return ok("1788757199.2 host nix-gc-start[1]: 12 store paths deleted, 1.0 GiB freed\n");
      if (argv.includes("error:")) return ok("");
      return ok("1788757200.5 host systemd[1]: Finished Nix Garbage Collector.\n");
    });
    expect(await store_probe(context, { kind: "store_probe", unit: "nix-gc.service", timer: "nix-gc.timer", store: "/" })).toBe(0);
    const fields = JSON.parse(output()) as GcFields;
    expect(fields).toMatchObject({
      svc_state: "inactive", svc_result: "success", svc_exit: "@1788757200", timer_load: "loaded", timer_state: "active", timer_next: "@1789000000",
      error: "",
    });
    expect(fields.summary).toContain("12 store paths deleted");
    expect(fields.outcome).toContain("Finished Nix Garbage Collector");
    expect(fields.size_bytes).toBeGreaterThan(0);
  });

  it("answers empty facts when systemd and the journal say nothing", async () => {
    const { context, output } = fake_context(() => ({ exit_code: 1, stdout: "", stderr: "no such unit" }));
    await store_probe(context, { kind: "store_probe", unit: "nix-gc.service", timer: "nix-gc.timer", store: "/nonexistent-store" });
    expect(JSON.parse(output())).toMatchObject({ svc_state: "", timer_load: "", summary: "", size_bytes: null, paths: null });
  });
});
