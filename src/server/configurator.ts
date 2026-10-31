// Sets simple NixOS options of a deployment by committing them to a JSON file X-Nix owns in the flake, which the
// configuration imports with one line, so hand-written Nix is never rewritten.
//
// The file nests each option's value under its path, such as {"services": {"openssh": {"enable": true}}}. Only booleans,
// integers, strings and enums are set here, each checked against the option's type from the generated option list.
// Every change is a `configure` job; once it has committed, the next evaluation picks the change up as drift.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { AgentPool } from "./agents/agent.ts";
import type { ActionOutcome, Deployment } from "./deployment.ts";
import { edit_refusal, read_flake_file, write_flake_file, type FlakeFile } from "./nixos/flake_files.ts";
import { option_path, type OptionEntry } from "./nixos/options.ts";
import type { Store } from "./store.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export type SimpleKind =
  | { kind: "boolean" }
  | { kind: "string" }
  | { kind: "integer"; minimum: number | null; maximum: number | null }
  | { kind: "enum"; choices: string[] };

export type SettingValue = boolean | number | string;

export interface SettingsView {
  file: string | null;
  // Why the file cannot be read or written, or null when it can.
  refusal: string | null;
  present: boolean;
  // Each option the file sets, by name.
  values: Record<string, SettingValue>;
  // The line the configuration imports the file with.
  import_line: string | null;
  error: string | null;
}

export interface ConfiguratorOptions {
  store: Store;
  agents: AgentPool;
  now?: () => number;
}

type Tree = { [name: string]: Tree | SettingValue };

// ── Types ────────────────────────────────────────────────────────────────────

// How an option of this type is set through the form, or null for a type the form leaves alone.
export function simple_kind(type: string): SimpleKind | null {
  const plain = type.replace(/^null or /, "");
  if (plain === "boolean") return { kind: "boolean" };
  const choices = /^one of (.+)$/.exec(plain);
  if (choices !== null) {
    const quoted = [...choices[1].matchAll(/"((?:[^"\\]|\\.)*)"(?:,\s*|$)/g)].map((match) => match[1]);
    const rebuilt = quoted.map((choice) => `"${choice}"`).join(", ");
    return quoted.length > 0 && rebuilt === choices[1].trim() ? { kind: "enum", choices: quoted } : null;
  }
  if (/^(signed |unsigned |positive |\d+ bit (signed |unsigned )?)?integer\b/.test(plain)) {
    const between = /between (-?\d+) and (-?\d+)/.exec(plain);
    let minimum: number | null = between ? Number(between[1]) : null;
    if (minimum === null && /unsigned/.test(plain)) minimum = 0;
    if (minimum === null && /positive/.test(plain)) minimum = 1;
    return { kind: "integer", minimum, maximum: between ? Number(between[2]) : null };
  }
  if (/^(string|non-empty string|strings concatenated with|string matching the pattern|absolute path$|path$)/.test(plain)) return { kind: "string" };
  return null;
}

// Why the value does not fit the option, or null when it does.
export function value_refusal(option: OptionEntry, value: unknown): string | null {
  if (option.read_only) return `${option.name} is read-only`;
  if (option_path(option.name) === null) return `${option.name} names no single value`;
  const kind = simple_kind(option.type);
  if (kind === null) return `${option.name} is ${option.type}, which the form does not set; set it in the flake's Nix`;
  if (kind.kind === "boolean" && typeof value !== "boolean") return `${option.name} takes true or false`;
  if (kind.kind === "string" && typeof value !== "string") return `${option.name} takes text`;
  if (kind.kind === "enum" && (typeof value !== "string" || !kind.choices.includes(value))) return `${option.name} takes one of ${kind.choices.join(", ")}`;
  if (kind.kind === "integer") {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) return `${option.name} takes a whole number`;
    if (kind.minimum !== null && value < kind.minimum) return `${option.name} takes ${kind.minimum} or more`;
    if (kind.maximum !== null && value > kind.maximum) return `${option.name} takes ${kind.maximum} or less`;
  }
  return null;
}

// ── File ─────────────────────────────────────────────────────────────────────

// Each value the tree sets, by its dotted option name.
export function flatten(tree: Tree, prefix: string[] = []): Record<string, SettingValue> {
  const values: Record<string, SettingValue> = {};
  for (const [name, value] of Object.entries(tree)) {
    if (typeof value === "object" && value !== null) Object.assign(values, flatten(value, [...prefix, name]));
    else values[[...prefix, name].join(".")] = value;
  }
  return values;
}

// The tree with the value set at the path, or with it removed and emptied parents pruned when the value is null.
export function set_in_tree(tree: Tree, steps: string[], value: SettingValue | null): Tree {
  const [first, ...rest] = steps;
  const next: Tree = { ...tree };
  if (rest.length === 0) {
    if (value === null) delete next[first];
    else next[first] = value;
    return next;
  }
  const child = next[first];
  const branch = set_in_tree(typeof child === "object" && child !== null ? child : {}, rest, value);
  if (Object.keys(branch).length === 0) delete next[first];
  else next[first] = branch;
  return next;
}

// The tree as the file holds it: keys sorted, so each change shows as a small diff.
export function serialise(tree: Tree): string {
  const sorted = (node: Tree): Tree => Object.fromEntries(Object.keys(node).sort().map((name) => {
    const value = node[name];
    return [name, typeof value === "object" && value !== null ? sorted(value) : value];
  }));
  return `${JSON.stringify(sorted(tree), null, 2)}\n`;
}

function parse_tree(file: FlakeFile): Tree {
  if (!file.present || file.content.trim() === "") return {};
  const parsed: unknown = JSON.parse(file.content);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("the file does not hold a JSON object");
  return parsed as Tree;
}

// The module flake.nix adds to the configuration's modules, giving X-Nix's values priority over plain definitions.
export function import_line(file: string): string {
  return `({ lib, ... }: { config = lib.mapAttrsRecursive (_: lib.mkOverride 90) (lib.importJSON ./${file}); })`;
}

// ── Configurator ─────────────────────────────────────────────────────────────

export class Configurator {
  readonly deployment: Deployment;
  private readonly store: Store;
  private readonly agents: AgentPool;
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(deployment: Deployment, options: ConfiguratorOptions) {
    this.deployment = deployment;
    this.store = options.store;
    this.agents = options.agents;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  // The file in the flake, from options_file or the configuration's name.
  file(): string | null {
    const settings = this.deployment.settings;
    if (settings.options_file !== null) return settings.options_file;
    const attribute = this.deployment.attribute();
    return attribute === null ? null : `x-nix/${attribute}.json`;
  }

  refusal(): string | null {
    if (this.file() === null) return "The host's configuration name is not known yet; name its configuration or set options_file";
    return edit_refusal(this.deployment.settings);
  }

  // The host that clones and commits, as for Update Flake.
  private agent_host(): string | null {
    return this.deployment.settings.switch_agent ?? this.deployment.settings.host;
  }

  async view(): Promise<SettingsView> {
    const file = this.file();
    const refusal = this.refusal();
    const view: SettingsView = { file, refusal, present: false, values: {}, import_line: file === null ? null : import_line(file), error: null };
    if (refusal !== null || file === null) return view;
    try {
      const found = await read_flake_file(this.agents.get(this.agent_host()), this.deployment.settings, file);
      return { ...view, present: found.present, values: flatten(parse_tree(found)) };
    } catch (error) {
      return { ...view, error: (error as Error).message };
    }
  }

  // Sets the option to the value, or removes it from the file when the value is null, as one commit.
  set(option: OptionEntry, value: SettingValue | null, trigger: string): Promise<ActionOutcome> {
    return this.queue_work(async () => {
      const refusal = this.refusal() ?? (value === null ? null : value_refusal(option, value));
      if (refusal !== null) return { ok: false, message: refusal, job_id: null };
      const file = this.file()!;
      const host = this.agent_host();
      const agent = this.agents.get(host);
      const settings = this.deployment.settings;
      let current: FlakeFile;
      let tree: Tree;
      try {
        current = await read_flake_file(agent, settings, file);
        tree = parse_tree(current);
      } catch (error) {
        return { ok: false, message: `Could not read ${file}: ${(error as Error).message}`, job_id: null };
      }
      const content = serialise(set_in_tree(tree, option_path(option.name)!, value));
      if (current.present && content.trimEnd() === current.content.trimEnd()) {
        return { ok: true, message: `${option.name} is already ${value === null ? "unset" : JSON.stringify(value)}`, job_id: null };
      }
      const message = value === null ? `chore(x-nix): unset ${option.name}` : `chore(x-nix): set ${option.name} to ${JSON.stringify(value)}`;
      const result = await write_flake_file(agent, settings, file, content, message, current.hash);
      const job_id = this.store.create_job({
        deployment_id: this.deployment.id, kind: "configure", command: `${message}\n\nin ${file} of ${settings.flake}`, agent: host, run_id: null, trigger, started_epoch: this.now(),
      });
      this.store.append_output(job_id, [result.stdout, result.stderr].filter(Boolean).join("\n"));
      const ok = result.exit_code === 0;
      this.store.finish_job(job_id, ok ? "succeeded" : "failed", result.exit_code, ok ? null : `Exited with status ${result.exit_code}`, this.now());
      const outcome = ok ? `Committed: ${message.replace("chore(x-nix): ", "")}` : `Could not commit ${option.name}: ${(result.stderr || result.stdout).trim().split("\n").pop()?.slice(0, 200)}`;
      this.store.add_event(this.deployment.id, this.now(), ok ? "info" : "error", outcome);
      return { ok, message: outcome, job_id };
    });
  }

  private queue_work<Answer>(work: () => Promise<Answer>): Promise<Answer> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }
}
