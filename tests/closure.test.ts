import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { deployment_settings } from "../src/server/config.ts";
import { empty_progress, read_build_log, summarise } from "../src/server/nixos/build_log.ts";
import { diff_command, parse_change_line, parse_closure, parse_diff } from "../src/server/nixos/closure.ts";
import { build_command } from "../src/server/nixos/commands.ts";
import { current_closure, target_closure } from "./fake_agent.ts";

// ── Setup ────────────────────────────────────────────────────────────────────

function settings(values: Record<string, unknown> = {}) {
  return deployment_settings({ id: "odin-deploy", flake: "/etc/nixos", ...values });
}

// A folder of stand-in programs, each a shell script.
function fake_programs(programs: Record<string, string>): string {
  const folder = join(mkdtempSync(join(tmpdir(), "x-nix-test-")), "bin");
  mkdirSync(folder);
  for (const [name, script] of Object.entries(programs)) {
    writeFileSync(join(folder, name), `#!/bin/sh\n${script}\n`);
    chmodSync(join(folder, name), 0o755);
  }
  return folder;
}

const sizes = JSON.stringify({ [current_closure]: { closureSize: 4_000_000_000 }, [target_closure]: { closureSize: 4_100_000_000 } });

// ── Package diff ─────────────────────────────────────────────────────────────

describe("the package diff", () => {
  it.each([
    ["firefox: 120.0 → 121.0, +1204.3 KiB", { name: "firefox", from: ["120.0"], to: ["121.0"], size_delta_bytes: 1233203 }],
    ["hello: ∅ → 2.12, +100.0 KiB", { name: "hello", from: [], to: ["2.12"], size_delta_bytes: 102400 }],
    ["zsh: 5.9 → ∅, -8.5 MiB", { name: "zsh", from: ["5.9"], to: [], size_delta_bytes: -8912896 }],
    ["linux: 6.18.46, 6.18.46-modules → 6.19.1, 6.19.1-modules", { name: "linux", from: ["6.18.46", "6.18.46-modules"], to: ["6.19.1", "6.19.1-modules"], size_delta_bytes: null }],
    ["glibc: +3.2 KiB", { name: "glibc", from: [], to: [], size_delta_bytes: 3277 }],
  ])("reads %s", (line, expected) => {
    expect(parse_change_line(line)).toEqual(expected);
  });

  it("ignores lines that are not changes", () => {
    expect(parse_change_line("warning: something")).toBeNull();
    expect(parse_change_line("")).toBeNull();
  });

  it("sorts changes and reads both closure sizes, in nix's newer and older JSON", () => {
    const output = [
      "@@x-nix-diff closures",
      "\u001b[1mfirefox\u001b[0m: 120.0 → 121.0, +1204.3 KiB",
      "hello: ∅ → 2.12, +100.0 KiB",
      "zsh: 5.9 → ∅, -8.5 MiB",
      "glibc: +3.2 KiB",
      "@@x-nix-diff sizes",
      sizes,
      "@@x-nix-diff derivations",
    ].join("\n");

    const diff = parse_diff(output, current_closure, target_closure, 1, 7);

    expect(diff.changed.map((change) => change.name)).toEqual(["firefox"]);
    expect(diff.added.map((change) => change.name)).toEqual(["hello"]);
    expect(diff.removed.map((change) => change.name)).toEqual(["zsh"]);
    expect(diff.resized.map((change) => change.name)).toEqual(["glibc"]);
    expect([diff.closure_before_bytes, diff.closure_after_bytes, diff.derivation_diff, diff.built]).toEqual([4_000_000_000, 4_100_000_000, null, true]);
    const older = JSON.stringify([{ path: current_closure, closureSize: 1 }, { path: target_closure, closureSize: 2 }]);
    expect(parse_diff(`@@x-nix-diff sizes\n${older}\n`, current_closure, target_closure, 1, 7).closure_after_bytes).toBe(2);
  });

  it("says when the new closure is not built, and keeps nix-diff's account", () => {
    expect(parse_diff("@@x-nix-diff missing\n", current_closure, target_closure, 1, null).built).toBe(false);
    const diff = parse_diff("@@x-nix-diff closures\n@@x-nix-diff derivations\n- /nix/store/x.drv:\n+ /nix/store/y.drv:\n", current_closure, target_closure, 1, null);
    expect(diff.derivation_diff).toBe("- /nix/store/x.drv:\n+ /nix/store/y.drv:");
  });

  it("runs nix-diff only when no package changed, and says when it is missing", () => {
    const programs = fake_programs({
      nix: `case "$*" in *diff-closures*) printf '' ;; *-S*) echo '${sizes}' ;; esac\nexit 0`,
      "nix-store": "echo /nonexistent.drv",
    });
    const environment = { ...process.env, PATH: `${programs}:/run/current-system/sw/bin:/usr/bin:/bin` };

    const run = spawnSync("sh", ["-c", diff_command(settings({ nix_bin: join(programs, "nix"), nix_args: [] }), current_closure, target_closure)], { encoding: "utf8", env: environment });

    const diff = parse_diff(run.stdout, current_closure, target_closure, 1, null);
    expect(diff.note).toMatch(/nix-diff is not installed|derivations of both closures/);
    expect(diff.closure_after_bytes).toBe(4_100_000_000);
  });
});

// ── Closure graph ────────────────────────────────────────────────────────────

describe("the closure graph", () => {
  it("puts the root first and the rest from the largest closure, with references as indexes", () => {
    const glibc = "/nix/store/gggggggggggggggggggggggggggggggg-glibc-2.40";
    const bash = "/nix/store/hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh-bash-5.2";
    const json = JSON.stringify({
      [glibc]: { narSize: 30, closureSize: 30, references: [glibc] },
      [bash]: { narSize: 10, closureSize: 40, references: [glibc.slice(11), bash] },
      [current_closure]: { narSize: 5, closureSize: 45, references: [bash] },
    });

    const tree = parse_closure(json, current_closure);

    expect(tree.root).toBe(current_closure);
    expect(tree.paths.map((path) => [path.path, path.references])).toEqual([[current_closure, [1]], [bash, [2]], [glibc, []]]);
  });
});

// ── Build progress ───────────────────────────────────────────────────────────

describe("live build progress", () => {
  const nix_line = (entry: object) => `@nix ${JSON.stringify(entry)}`;
  const drv = "/nix/store/dddddddddddddddddddddddddddddddd-hello-2.12.drv";

  it("asks nix for its structured log only when build_progress is on", () => {
    expect(build_command(settings(), "host")).toContain("--log-format internal-json -v");
    expect(build_command(settings({ build_progress: false }), "host")).not.toContain("internal-json");
  });

  it("counts builds and downloads and turns log lines back into text, across pieces cut mid-line", () => {
    const progress = empty_progress();
    const log = [
      nix_line({ action: "start", id: 1, type: 104, text: "" }),
      nix_line({ action: "result", id: 1, type: 105, fields: [0, 2, 0, 0] }),
      nix_line({ action: "start", id: 2, type: 105, text: `building '${drv}'`, fields: [drv, "", 1, 1] }),
      nix_line({ action: "start", id: 3, type: 108, fields: ["/nix/store/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-zlib-1.3", "https://cache.nixos.org"] }),
      nix_line({ action: "result", id: 2, type: 101, fields: ["compiling hello.c"] }),
      nix_line({ action: "msg", level: 0, msg: "\u001b[31;1merror:\u001b[0m something" }),
      nix_line({ action: "msg", level: 5, msg: "evaluating file" }),
      "plain line",
      "",
    ].join("\n");
    const cut = log.indexOf("compiling") - 10;

    const text = read_build_log(progress, log.slice(0, cut), false) + read_build_log(progress, log.slice(cut), false);

    expect(text).toBe("hello-2.12> compiling hello.c\nerror: something\nplain line\n");
    expect(summarise(progress)).toBe("Built 0 of 2, building 1; downloaded 0, downloading 1");
    read_build_log(progress, `${nix_line({ action: "stop", id: 2 })}\n${nix_line({ action: "stop", id: 3 })}\n`, false);
    expect(summarise(progress)).toBe("Built 1 of 2; downloaded 1");
  });

  it("counts a failed builder and forgets running activities once the build ends", () => {
    const progress = empty_progress();
    read_build_log(progress, `${nix_line({ action: "start", id: 2, type: 105, fields: [drv] })}\n`, false);
    read_build_log(progress, nix_line({ action: "msg", level: 0, msg: `error: builder for '${drv}' failed with exit code 1` }), true);

    expect(progress.builds_failed).toBe(1);
    expect(progress.activities).toEqual({});
  });
});
