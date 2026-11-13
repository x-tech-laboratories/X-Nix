// Which of a build's planned paths each planned derivation needs directly, so the job can show the build as a tree. The
// derivation files are read straight from the store, in the ATerm form nix writes them, rather than through
// `nix derivation show`, whose JSON has changed shape between Nix versions.

// ── Imports ──────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";

import { is_store_path, type DerivationsOperation } from "../../shared/operations.ts";
import type { Context } from "../programs.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface Derivation {
  // Each output's store path by its name; a content-addressed output has none until it is built.
  outputs: Record<string, string>;
  // Each derivation it builds on, with the names of the outputs it takes from it.
  input_derivations: Record<string, string[]>;
  input_sources: string[];
}

// Strings stay strings; lists, tuples and a constructor's arguments are all arrays.
type Term = string | Term[];

// ── Reading ──────────────────────────────────────────────────────────────────

export async function derivations(context: Context, operation: DerivationsOperation, read_file: (path: string) => string = (path) => readFileSync(path, "utf8")): Promise<number> {
  const planned = new Set(operation.planned);
  const read = new Map<string, Derivation | null>();
  const derivation_at = (path: string): Derivation | null => {
    if (!read.has(path)) read.set(path, is_store_path(path) && path.endsWith(".drv") ? read_quietly(() => parse_derivation(read_file(path))) : null);
    return read.get(path)!;
  };
  const answer: Record<string, string[]> = {};
  for (const path of operation.derivations) {
    const derivation = derivation_at(path);
    if (derivation === null) continue;
    const needs = new Set<string>();
    for (const [input, names] of Object.entries(derivation.input_derivations)) {
      if (planned.has(input)) {
        needs.add(input);
        continue;
      }
      // An input that is not built may still be fetched, by the path of the output taken from it.
      const outputs = derivation_at(input)?.outputs ?? {};
      for (const name of names) if (planned.has(outputs[name] ?? "")) needs.add(outputs[name]);
    }
    for (const source of derivation.input_sources) if (planned.has(source)) needs.add(source);
    answer[path] = [...needs];
  }
  context.out.write(JSON.stringify(answer));
  return 0;
}

function read_quietly<Value>(read: () => Value): Value | null {
  try {
    return read();
  } catch {
    return null;
  }
}

// ── ATerm ────────────────────────────────────────────────────────────────────

// Reads a derivation file: `Derive(outputs, input derivations, input sources, ...)`, or `DrvWithVersion` with its
// version first.
export function parse_derivation(text: string): Derivation {
  let args = parse_term(text);
  if (!Array.isArray(args)) throw new Error("Not a derivation");
  if (typeof args[0] === "string") args = args.slice(1);
  const [outputs, inputs, sources] = args;
  if (!Array.isArray(outputs) || !Array.isArray(inputs) || !Array.isArray(sources)) throw new Error("Not a derivation");
  const derivation: Derivation = { outputs: {}, input_derivations: {}, input_sources: sources.filter((source) => typeof source === "string") };
  for (const output of outputs) {
    if (Array.isArray(output) && typeof output[0] === "string" && typeof output[1] === "string" && output[1] !== "") derivation.outputs[output[0]] = output[1];
  }
  for (const input of inputs) {
    if (!Array.isArray(input) || typeof input[0] !== "string" || !Array.isArray(input[1])) continue;
    // A dynamic derivation's input pairs the output names with those of the derivations it makes.
    const names = Array.isArray(input[1][0]) ? input[1][0] : input[1];
    derivation.input_derivations[input[0]] = names.filter((name) => typeof name === "string");
  }
  return derivation;
}

function parse_term(text: string): Term {
  let at = 0;
  const fail = (): never => {
    throw new Error(`Unexpected ${text[at] ?? "end"} at ${at}`);
  };
  const term = (): Term => {
    const char = text[at];
    if (char === '"') return string();
    if (char === "[" || char === "(") return items(char === "[" ? "]" : ")");
    // A constructor's name is dropped, leaving its arguments.
    const name = /^[A-Za-z]+\(/.exec(text.slice(at, at + 32));
    if (name === null) return fail();
    at += name[0].length - 1;
    return items(")");
  };
  const items = (close: string): Term[] => {
    at += 1;
    const found: Term[] = [];
    while (text[at] !== close) {
      if (found.length > 0) {
        if (text[at] !== ",") fail();
        at += 1;
      }
      found.push(term());
    }
    at += 1;
    return found;
  };
  const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t" };
  const plain = /[^"\\]*/y;
  const string = (): string => {
    let value = "";
    at += 1;
    for (;;) {
      plain.lastIndex = at;
      plain.exec(text);
      value += text.slice(at, plain.lastIndex);
      at = plain.lastIndex;
      if (at >= text.length) fail();
      if (text[at] === '"') break;
      const escaped = text[at + 1] ?? fail();
      value += escapes[escaped] ?? escaped;
      at += 2;
    }
    at += 1;
    return value;
  };
  return term();
}
