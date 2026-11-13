import { describe, expect, it } from "vitest";

import { derivations, parse_derivation } from "../src/agent/operations/derivations.ts";
import type { Context } from "../src/agent/programs.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

function fake_context(): { context: Context; output: () => string } {
  let output = "";
  const sink = { write: (chunk: Buffer | string) => void (output += chunk.toString()) };
  const context: Context = {
    out: sink, err: sink, signal: new AbortController().signal, own_groups: false, log: false, stdin: null,
    program: async () => ({ exit_code: 0, stdout: "", stderr: "" }),
  };
  return { context, output: () => output };
}

const store = (hash: string, name: string) => `/nix/store/${hash.repeat(32)}-${name}`;

// A derivation file as nix writes it, with only the parts read here filled in.
function derive(outputs: [string, string][], inputs: [string, string[]][], sources: string[] = []): string {
  const quote = (text: string) => JSON.stringify(text);
  const list = (items: string[]) => `[${items.join(",")}]`;
  return `Derive(${list(outputs.map(([name, path]) => `(${quote(name)},${quote(path)},"","")`))},`
    + `${list(inputs.map(([path, names]) => `(${quote(path)},${list(names.map(quote))})`))},${list(sources.map(quote))},`
    + `"x86_64-linux","/bin/sh",["-c","echo \\"hi\\"\\n"],[("name","x")])`;
}

// ── ATerm ────────────────────────────────────────────────────────────────────

describe("a derivation file", () => {
  it("reads its outputs, input derivations and input sources", () => {
    const text = derive([["out", store("a", "app")], ["dev", store("b", "app-dev")]], [[store("c", "zlib.drv"), ["out", "dev"]]], [store("d", "src")]);
    expect(parse_derivation(text)).toEqual({
      outputs: { out: store("a", "app"), dev: store("b", "app-dev") },
      input_derivations: { [store("c", "zlib.drv")]: ["out", "dev"] },
      input_sources: [store("d", "src")],
    });
  });

  it("reads a versioned one, and a dynamic derivation's input output names", () => {
    const text = `DrvWithVersion("xp-dyn-drv",[("out","","r:sha256","")],[("${store("c", "gen.drv")}",(["out"],[]))],[],"x86_64-linux","/bin/sh",[],[])`;
    expect(parse_derivation(text)).toEqual({ outputs: {}, input_derivations: { [store("c", "gen.drv")]: ["out"] }, input_sources: [] });
  });

  it("refuses what is not one", () => {
    expect(() => parse_derivation("Derive([")).toThrow();
    expect(() => parse_derivation('"just a string"')).toThrow();
  });
});

// ── Operation ────────────────────────────────────────────────────────────────

describe("the derivations read", () => {
  it("answers the planned paths each derivation needs: planned builds, and fetched outputs of the rest", async () => {
    const [app, lib, zlib, src] = [store("a", "app.drv"), store("b", "lib.drv"), store("c", "zlib.drv"), store("d", "src")];
    const files: Record<string, string> = {
      [app]: derive([["out", store("e", "app")]], [[lib, ["out"]], [zlib, ["dev"]]], [src]),
      [lib]: derive([["out", store("f", "lib")]], []),
      [zlib]: derive([["out", store("g", "zlib")], ["dev", store("h", "zlib-dev")]], []),
    };
    const { context, output } = fake_context();
    const planned = [app, lib, store("h", "zlib-dev"), store("g", "zlib")];
    const read_file = (path: string) => files[path] ?? (() => { throw new Error("missing"); })();

    expect(await derivations(context, { kind: "derivations", derivations: [app, lib, store("i", "gone.drv"), "/etc/passwd"], planned }, read_file)).toBe(0);

    // Only the output it takes from zlib counts, and a derivation that cannot be read is left out.
    expect(JSON.parse(output())).toEqual({ [app]: [lib, store("h", "zlib-dev")], [lib]: [] });
  });
});
