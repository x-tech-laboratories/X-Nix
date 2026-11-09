// Performs one operation the server asked for, in TypeScript, running only plain programs; answers its exit status.

// ── Imports ──────────────────────────────────────────────────────────────────

import { spawn } from "node:child_process";

import { timed_out_exit_code, type KeptAwakeOperation, type NixConfigOperation, type Operation, type TimedOperation } from "../../shared/operations.ts";
import { send_magic_packet } from "../../shared/wake.ts";
import { run_steps, step_argv, type Context } from "../programs.ts";
import { boot_probe } from "./boot.ts";
import { cache_build, cache_build_all, cache_check, cache_push } from "./cache.ts";
import { build, cache_holds, closure_diff, evaluate, github_update } from "./deploy.ts";
import { install, media } from "./provision.ts";
import { generations, locate, piece, probe, products, remote_heads, store_probe } from "./reads.ts";
import { confirm_switch, signal_rollback, switch_system } from "./switch.ts";

// ── Performing ───────────────────────────────────────────────────────────────

export async function perform(context: Context, operation: Operation): Promise<number> {
  switch (operation.kind) {
    case "probe": return probe(context);
    case "store_probe": return store_probe(context, operation);
    case "boot_probe": return boot_probe(context, operation);
    case "generations": return generations(context);
    case "products": return products(context, operation);
    case "locate": return locate(context, operation);
    case "piece": return piece(context, operation);
    case "cache_holds": return cache_holds(context, operation);
    case "closure_diff": return closure_diff(context, operation);
    case "remote_heads": return remote_heads(context, operation);
    case "programs":
      if (operation.note !== undefined) context.out.write(`${operation.note}\n`);
      return run_steps(context, operation.steps);
    case "wake":
      await send_magic_packet(operation);
      return 0;
    case "kept_awake": return kept_awake(context, operation);
    case "timed": return timed(context, operation);
    case "nix_config": return nix_config(context, operation);
    case "evaluate": return evaluate(context, operation);
    case "build": return build(context, operation);
    case "switch": return switch_system(context, operation);
    case "github_update": return github_update(context, operation);
    case "confirm_switch": return confirm_switch(context, operation);
    case "signal_rollback": return signal_rollback(context, operation);
    case "cache_check": return cache_check(context, operation);
    case "cache_build": return cache_build(context, operation);
    case "cache_push": return cache_push(context, operation);
    case "cache_build_all": return cache_build_all(context, operation);
    case "install": return install(context, operation);
    case "media": return media(context, operation);
  }
}

// ── Wrappers ─────────────────────────────────────────────────────────────────

// Holds the inhibitor through a pipe only this operation keeps open, so it lets go however the operation ends, and
// nothing the operation leaves running, such as a watchdog, holds it.
async function kept_awake(context: Context, operation: KeptAwakeOperation): Promise<number> {
  const argv = step_argv(operation.inhibitor);
  let ended = false;
  const warn = () => {
    if (!ended) context.out.write(`${operation.warning}\n`);
    ended = true;
  };
  const inhibitor = spawn(argv[0], argv.slice(1), { detached: context.own_groups, stdio: ["pipe", "ignore", "ignore"] });
  inhibitor.stdin.on("error", () => {});
  inhibitor.on("error", warn);
  inhibitor.on("exit", (code) => (code === 0 ? (ended = true) : warn()));
  try {
    return await perform(context, operation.operation);
  } finally {
    ended = true;
    inhibitor.stdin.end();
  }
}

// Stops the operation once it runs past its time, answering the status `timeout` gives.
async function timed(context: Context, operation: TimedOperation): Promise<number> {
  const controller = new AbortController();
  const forward = () => controller.abort();
  context.signal.addEventListener("abort", forward, { once: true });
  let timed_out = false;
  const timer = setTimeout(() => {
    timed_out = true;
    controller.abort();
  }, operation.seconds * 1000);
  try {
    const status = await perform({ ...context, signal: controller.signal }, operation.operation);
    return timed_out ? timed_out_exit_code : status;
  } finally {
    clearTimeout(timer);
    context.signal.removeEventListener("abort", forward);
  }
}

// Adds an include of the file to NIX_CONFIG for every program the operation runs; a missing file fails nix rather than going unnoticed.
function nix_config(context: Context, operation: NixConfigOperation): Promise<number> {
  const program: Context["program"] = (inner, argv, options = {}) => {
    const env = options.env ?? process.env;
    const config = [env.NIX_CONFIG, `include ${operation.file}`].filter(Boolean).join("\n");
    return context.program(inner, argv, { ...options, env: { ...env, NIX_CONFIG: config } });
  };
  return perform({ ...context, program }, operation.operation);
}
