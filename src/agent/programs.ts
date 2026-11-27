// Runs one program with its arguments, never through a shell, for an operation: what it prints goes to the operation's
// output, is kept for the operation to read, or both. Both the agent and the server's built-in agent run programs here.

// ── Imports ──────────────────────────────────────────────────────────────────

import { run_program, type ProgramOptions as SharedProgramOptions, type ProgramResult, type Sink, type StreamUse } from "@x-tech-laboratories/x-libs/agent/programs";

import { mark_prefix, markers_mark, show_argv, type Argv, type Step } from "../shared/operations.ts";
import { sudo_refusal } from "./sudo_groups.ts";

export {
  BoundedBuffer, on_path, stderr_limit_in_bytes, stdout_limit_in_bytes, type ProgramResult, type Sink, type StreamUse,
} from "@x-tech-laboratories/x-libs/agent/programs";

// ── Shapes ───────────────────────────────────────────────────────────────────

// Each stream is shown in the operation's output unless set otherwise.
export type ProgramOptions = Pick<SharedProgramOptions, "stdin" | "stdout" | "stderr" | "env" | "cwd"> & {
  // Prints the program as a `$` line before it runs, when the context keeps a log.
  echo?: boolean;
};

export type RunProgram = (context: Context, argv: Argv, options?: ProgramOptions) => Promise<ProgramResult>;

// What an operation runs within.
export interface Context {
  out: Sink;
  // Errors, which a long run writes into the same output.
  err: Sink;
  // Aborted once the operation is to stop.
  signal: AbortSignal;
  // Whether each program gets a process group of its own, so stopping it stops everything it started.
  own_groups: boolean;
  // Whether the output is a log a person reads, which shows each program as it starts, rather than an answer to parse.
  log: boolean;
  // What the operation was handed on stdin.
  stdin: string | null;
  program: RunProgram;
  // The token the server issued for the run, which every marker line carries after its mark; absent or null for none.
  marker_token?: string | null;
}

// ── Running ──────────────────────────────────────────────────────────────────

export const spawn_program: RunProgram = async (context, argv, { echo = false, ...options } = {}) => {
  if (echo && context.log) context.out.write(`$ ${show_argv(argv)}\n`);
  const refusal = sudo_refusal(argv);
  if (refusal !== null) return refused(context, refusal, options.stderr ?? "show");
  return run_program(argv, {
    ...options, stdout: options.stdout ?? "show", stderr: options.stderr ?? "show", out: context.out, err: context.err, signal: context.signal, own_group: context.own_groups,
  });
};

// A program the host's sudo rules leave out, answered with why rather than run.
function refused(context: Context, refusal: string, stderr: StreamUse): ProgramResult {
  if (stderr === "show" || stderr === "both") context.err.write(`${refusal}\n`);
  return { exit_code: 1, stdout: "", stderr: stderr === "keep" || stderr === "both" ? refusal : "" };
}

// ── Markers ──────────────────────────────────────────────────────────────────

// The start of the run's marker lines of one mark, with the run's token when the server issued one.
export function marker(context: Context, mark: string): string {
  return mark_prefix(mark, context.marker_token ?? null);
}

// Prints, before anything else the run prints, the line that shows the server the run puts its token in every marker line.
export function announce_marker_token(context: Context): void {
  if (context.marker_token) context.out.write(`${markers_mark} ${context.marker_token}\n`);
}

// ── Steps ────────────────────────────────────────────────────────────────────

// The program a step runs here: itself, or ssh carrying it to its host as one command line.
export function step_argv(step: Step): Argv {
  if (step.ssh === undefined) return step.argv;
  const options = (process.env.NIX_SSHOPTS ?? "").split(/\s+/).filter(Boolean);
  return [...(step.ssh.sudo ? ["sudo", "-n"] : []), "ssh", ...options, step.ssh.host, show_argv(step.argv)];
}

// Runs each step in turn, showing it as it goes, and answers the first failing status, or 0.
export async function run_steps(context: Context, steps: Step[]): Promise<number> {
  for (const step of steps) {
    const result = await context.program(context, step_argv(step), { echo: true, stdout: step.quiet ? "drop" : "show" });
    if (result.exit_code !== 0) return result.exit_code;
  }
  return 0;
}

// Runs a command a person wrote into the config, exactly as written.
export function person_command(command: string, sudo = false): Argv {
  return sudo ? ["sudo", "-n", "/bin/sh", "-c", command] : ["/bin/sh", "-c", command];
}
