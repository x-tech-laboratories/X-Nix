// The process that carries out one long run, started by the agent in a process group of its own so it outlives the
// agent. It reads the operation from the run's folder, writes everything the operation prints into the folder's `out`,
// and ends by writing its exit status there in one rename. Stdin, which may carry a key, is read from a pipe only.

// ── Imports ──────────────────────────────────────────────────────────────────

import { openSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { text } from "node:stream/consumers";

import { perform } from "./operations/index.ts";
import { spawn_program, type Context } from "./programs.ts";
import { watch_for_stalls } from "./stalls.ts";
import { plan_file, type RunPlan } from "./tasks.ts";

// ── Run ──────────────────────────────────────────────────────────────────────

const folder = process.argv[2];
const plan = JSON.parse(readFileSync(join(folder, plan_file), "utf8")) as RunPlan;
const stdin = plan.stdin ? await text(process.stdin) : null;
const out = openSync(join(folder, "out"), "a");
const write = (chunk: Buffer | string) => void writeSync(out, typeof chunk === "string" ? Buffer.from(chunk) : chunk);
const stalls = watch_for_stalls(process.pid, write);
const sink = {
  write: (chunk: Buffer | string) => {
    stalls.heard();
    write(chunk);
  },
};
const context: Context = { out: sink, err: sink, signal: new AbortController().signal, own_groups: false, log: true, stdin, program: spawn_program };

let status: number;
try {
  status = await perform(context, plan.operation);
} catch (error) {
  sink.write(`${(error as Error).message}\n`);
  status = 1;
}
stalls.stop();
writeFileSync(join(folder, "exit.part"), `${status}\n`);
renameSync(join(folder, "exit.part"), join(folder, "exit"));
process.exit(status < 0 || status > 255 ? 1 : status);
