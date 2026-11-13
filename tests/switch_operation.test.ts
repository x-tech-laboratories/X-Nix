import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { perform } from "../src/agent/operations/index.ts";
import { confirm_switch, signal_rollback, switch_system } from "../src/agent/operations/switch.ts";
import { spawn_program, type Context, type ProgramResult, type RunProgram } from "../src/agent/programs.ts";
import { watch_switch } from "../src/agent/watchdog.ts";
import { switch_verdict } from "../src/server/nixos/switch.ts";
import { watch_folder, type SwitchOperation, type SwitchWatch } from "../src/shared/operations.ts";

// ── Setup ────────────────────────────────────────────────────────────────────

const folders: string[] = [];

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

// A context whose programs answer what the test says, keeping every program run and everything printed.
function fake_context(answer: (argv: string[]) => Partial<ProgramResult> = () => ({})) {
  const ran: string[][] = [];
  let output = "";
  const sink = { write: (chunk: Buffer | string) => void (output += chunk.toString()) };
  const program: RunProgram = async (context, argv, options = {}) => {
    ran.push(argv);
    const result = { exit_code: 0, stdout: "", stderr: "", ...answer(argv) };
    if ((options.stdout ?? "show") === "show") context.out.write(result.stdout);
    return result;
  };
  const context: Context = { out: sink, err: sink, signal: new AbortController().signal, own_groups: false, log: true, stdin: null, program };
  return { context, ran, output: () => output };
}

function token(): string {
  const value = randomBytes(6).toString("hex");
  folders.push(watch_folder(value));
  return value;
}

function plain_switch(values: Partial<SwitchOperation> = {}): SwitchOperation {
  return {
    kind: "switch", mode: "switch", activation_name: "nixos-rebuild switch", steps: [{ argv: ["nixos-rebuild", "switch"] }],
    post_switch: null, pre_switch_checks: [], watch: null, ...values,
  };
}

function watch(values: Partial<SwitchWatch> = {}): SwitchWatch {
  return {
    token: "ab12", rollback_mode: "switch", require_sudo: true, activation_timeout: 20, confirm_window: 20, magic_rollback: false,
    health_commands: [], health_period: 1, health_timeout: 0, activation_reason: "The activation did not finish in time",
    unconfirmed_reason: "Nothing confirmed the switch", ...values,
  };
}

// A watchdog's folder, as a switch leaves it, holding the given files.
function watch_dir(settings: SwitchWatch, files: Record<string, string> = {}): string {
  const folder = mkdtempSync(join(tmpdir(), "x-nix-watchdog-test-"));
  folders.push(folder);
  writeFileSync(join(folder, "watch.json"), JSON.stringify(settings));
  // A previous system that is not the running one, so a rollback has something to do.
  writeFileSync(join(folder, "previous_system"), "/nix/store/00000000000000000000000000000000-previous\n");
  writeFileSync(join(folder, "previous_profile"), "system-1-link\n");
  for (const [name, text] of Object.entries(files)) writeFileSync(join(folder, name), text);
  return folder;
}

// ── Switch ───────────────────────────────────────────────────────────────────

describe("a switch on the agent", () => {
  it("refuses before anything changes when a pre-switch check fails", async () => {
    const { context, ran, output } = fake_context((argv) => (argv[2] === "echo disk full; exit 4" ? { exit_code: 4, stdout: "disk full\n" } : {}));

    const status = await switch_system(context, plain_switch({ pre_switch_checks: ["true", "echo disk full; exit 4"] }));

    expect(status).toBe(3);
    expect(output()).toContain("$ echo disk full; exit 4\ndisk full");
    expect(switch_verdict(output()).refused).toBe("Pre-switch check 2 (echo disk full; exit 4) failed with status 4");
    expect(ran.some((argv) => argv[0] === "nixos-rebuild")).toBe(false);
  });

  it("answers the activation's status, which post_switch never changes", async () => {
    const { context, ran } = fake_context((argv) => (argv[0] === "nixos-rebuild" ? { exit_code: 5 } : {}));

    const status = await switch_system(context, plain_switch({ post_switch: ["/bin/sh", "-c", "true"], pre_switch_checks: ["true"] }));

    expect(status).toBe(5);
    expect(ran.map((argv) => argv[0])).toEqual(["/bin/sh", "nixos-rebuild", "/bin/sh"]);
  });

  it("fetches from the cache before its watchdog starts, so a slow download leaves the activation its whole time", async () => {
    const watched = watch({ token: token(), require_sudo: false, activation_timeout: 1, confirm_window: 1 });
    const { context, ran, output } = fake_context();
    const fetch = ["nix", "build", "--no-link", "/nix/store/00000000000000000000000000000000-new"];
    const answer = context.program;
    let fetched = false;
    // Only the first fetch downloads; the steps' own fetch finds the closure there.
    context.program = async (inner, argv, options) => {
      if (argv.join(" ") === fetch.join(" ") && !fetched) {
        fetched = true;
        await new Promise((resolve) => setTimeout(resolve, 2500));
      }
      return answer(inner, argv, options);
    };

    await switch_system(context, plain_switch({ fetch_steps: [{ argv: fetch }], steps: [{ argv: fetch }, { argv: ["switch-to-configuration", "switch"] }], watch: watched }));

    const text = output();
    expect(text.indexOf("phase fetch")).toBeLessThan(text.indexOf("phase watch"));
    expect(ran.map((argv) => argv[0])).toEqual(["nix", "nix", "switch-to-configuration"]);
    expect(switch_verdict(text).outcome?.kind).toBe("kept");
  }, 20_000);

  it("ends unchanged, before any watchdog, when the fetch from the cache fails", async () => {
    const watched = watch({ token: token() });
    const { context, ran, output } = fake_context((argv) => (argv[0] === "nix" ? { exit_code: 1 } : {}));

    const status = await switch_system(context, plain_switch({ fetch_steps: [{ argv: ["nix", "build"] }], watch: watched }));

    expect(status).toBe(1);
    expect(switch_verdict(output()).outcome).toEqual({ kind: "unchanged", reason: "Building or fetching the system failed with status 1" });
    expect(ran).toEqual([["nix", "build"]]);
    expect(existsSync(watch_folder(watched.token))).toBe(false);
  });

  it("asks its watchdog to roll back a failing health check, with the check's output as the reason", async () => {
    const watched = watch({ token: token(), require_sudo: false, health_commands: ["curl -f localhost"], health_timeout: 0 });
    const { context, output } = fake_context((argv) => (argv[2] === "curl -f localhost" ? { exit_code: 1, stdout: "nginx is down\n" } : {}));

    await switch_system(context, plain_switch({ watch: watched }));

    const verdict = switch_verdict(output());
    expect(verdict.activated).toBe(true);
    expect(verdict.awaiting_confirmation).toBe(false);
    // The watchdog only rolls back a system that changed, which a test host's never has.
    expect(["unchanged", "rollback-failed"]).toContain(verdict.outcome?.kind);
    expect(verdict.outcome?.reason).toContain("Health check 1 (curl -f localhost) failed with status 1: nginx is down");
    expect(existsSync(watch_folder(watched.token))).toBe(false);
  }, 20_000);

  it("ends once its watchdog gives an outcome, while the activation still hangs", async () => {
    const watched = watch({ token: token(), require_sudo: false, activation_timeout: 0 });
    const { context, ran, output } = fake_context();
    const hanging: RunProgram = (inner, argv, options) => (argv[0] === "nixos-rebuild" ? new Promise(() => {}) : context.program(inner, argv, options));

    const status = await switch_system({ ...context, program: hanging }, plain_switch({ watch: watched, post_switch: ["true"] }));

    expect(status).toBe(1);
    expect(output()).toContain("nixos-rebuild switch is still running, but its watchdog has given its outcome, so this switch ends here");
    // A test host's system never changed, so the watchdog has nothing to roll back.
    expect(switch_verdict(output()).outcome).toEqual({ kind: "unchanged", reason: "The activation did not finish in time" });
    expect(ran).not.toContainEqual(["true"]);
    expect(existsSync(watch_folder(watched.token))).toBe(false);
  }, 20_000);
});

// ── Watchdog ─────────────────────────────────────────────────────────────────

describe("the watchdog", () => {
  it("ends once X-Nix confirms the activated switch", async () => {
    const { context, ran } = fake_context();

    expect(await watch_switch(watch_dir(watch(), { activated: "", confirmed: "" }), context)).toBe("confirmed");
    expect(ran).toEqual([]);
  });

  it("rolls back when asked, resetting the profile and activating the previous system", async () => {
    const { context, ran } = fake_context();

    const outcome = await watch_switch(watch_dir(watch(), { rollback: "asked\n" }), context);

    expect(outcome).toBe("rolled-back asked");
    expect(ran).toEqual([
      ["sudo", "-n", "nix-env", "-p", "/nix/var/nix/profiles/system", "--switch-generation", "1"],
      ["sudo", "-n", "/nix/store/00000000000000000000000000000000-previous/bin/switch-to-configuration", "switch"],
    ]);
  });

  it("says so when the previous system does not activate cleanly, and rolls a test switch back for now only", async () => {
    const { context, ran } = fake_context((argv) => (argv.at(-1) === "test" ? { exit_code: 1 } : {}));

    const outcome = await watch_switch(watch_dir(watch({ rollback_mode: "test", require_sudo: false }), { rollback: "asked" }), context);

    expect(outcome).toBe("rollback-failed asked; the previous system did not activate cleanly");
    expect(ran.at(-1)).toEqual(["/nix/store/00000000000000000000000000000000-previous/bin/switch-to-configuration", "test"]);
  });

  it("changes nothing while the switch lock is still held, and names its holder", async () => {
    const { context, ran } = fake_context();
    const holder = { pid: 2466309, ppid: 2466307, name: ".switch-to-conf", age_in_seconds: 240 };

    const outcome = await watch_switch(watch_dir(watch(), { rollback: "asked\n" }), context, undefined, () => [holder]);

    expect(outcome).toBe("rollback-failed asked; nothing was rolled back, as the switch lock is still held by .switch-to-conf (pid 2466309, running for 4 minutes)");
    expect(ran).toEqual([]);
  });

  it("rolls back an activation that outlasts activation_timeout", async () => {
    const { context } = fake_context();

    expect(await watch_switch(watch_dir(watch({ activation_timeout: 0 })), context)).toBe("rolled-back The activation did not finish in time");
  });

  it("keeps an unconfirmed switch without magic_rollback, and rolls it back with it", async () => {
    const kept = fake_context();
    const rolled = fake_context();

    expect(await watch_switch(watch_dir(watch({ confirm_window: 0 }), { activated: "" }), kept.context)).toBe("kept Nothing confirmed the switch");
    expect(kept.ran).toEqual([]);
    expect(await watch_switch(watch_dir(watch({ confirm_window: 0, magic_rollback: true }), { activated: "" }), rolled.context)).toBe("rolled-back Nothing confirmed the switch");
  });
});

// ── Signals ──────────────────────────────────────────────────────────────────

describe("the files X-Nix writes for the watchdog", () => {
  it("confirm a switch and ask for a rollback with its reason", async () => {
    const value = token();
    mkdirSync(watch_folder(value));
    const { context } = fake_context();

    expect(await confirm_switch(context, { kind: "confirm_switch", token: value })).toBe(0);
    expect(await signal_rollback(context, { kind: "signal_rollback", token: value, reason: "HTTP check failed: 'quoted' $reason" })).toBe(0);

    expect(existsSync(join(watch_folder(value), "confirmed"))).toBe(true);
    expect(readFileSync(join(watch_folder(value), "rollback"), "utf8")).toBe("HTTP check failed: 'quoted' $reason\n");
  });

  it("fail once the switch's folder is gone", async () => {
    const { context } = fake_context();

    expect(await confirm_switch(context, { kind: "confirm_switch", token: token() })).toBe(1);
    expect(await signal_rollback(context, { kind: "signal_rollback", token: token(), reason: "late" })).toBe(1);
  });

  it("refuse a token that is not one", async () => {
    const { context } = fake_context();

    await expect(confirm_switch(context, { kind: "confirm_switch", token: "../etc" })).rejects.toThrow("not a switch token");
  });
});

// ── Wrappers ─────────────────────────────────────────────────────────────────

describe("the wrappers", () => {
  function real_context() {
    let output = "";
    const sink = { write: (chunk: Buffer | string) => void (output += chunk.toString()) };
    const context: Context = { out: sink, err: sink, signal: new AbortController().signal, own_groups: false, log: false, stdin: null, program: spawn_program };
    return { context, output: () => output };
  }

  it("stop an operation that runs past its time with the status timeout gives", async () => {
    const { context } = real_context();

    const status = await perform(context, { kind: "timed", seconds: 1, operation: { kind: "programs", steps: [{ argv: ["/bin/sh", "-c", "sleep 5"] }] } });

    expect(status).toBe(124);
  }, 10_000);

  it("hold an inhibitor quietly while it holds", async () => {
    const { context, output } = real_context();

    const status = await perform(context, { kind: "kept_awake", inhibitor: { argv: ["cat"] }, warning: "No inhibitor", operation: { kind: "programs", steps: [{ argv: ["true"] }] } });

    expect(status).toBe(0);
    expect(output()).not.toContain("No inhibitor");
  });
});
