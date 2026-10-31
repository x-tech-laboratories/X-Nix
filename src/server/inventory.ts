// The fleet's inventory: one JSON file in a flake listing each machine with its tags and the roles it takes, which the
// Inventory page edits and the flake reads to decide what each machine runs.
//
// The file holds {"machines": {"<name>": {"tags": [...], "roles": [...]}}}. Any other key, at the top or in a machine,
// is kept as it is. Each save is one `inventory` job that commits the whole file, refused when it changed since it was
// read, just as the option form commits its file.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { AgentPool } from "./agents/agent.ts";
import { inventory_id, type InventorySettings } from "./config.ts";
import type { ActionOutcome } from "./deployment.ts";
import { edit_refusal, read_flake_file, write_flake_file } from "./nixos/flake_files.ts";
import type { Store } from "./store.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface Machine {
  name: string;
  tags: string[];
  roles: string[];
}

export interface InventoryView {
  configured: boolean;
  flake: string | null;
  file: string | null;
  // Why the file cannot be read or committed, or null when it can.
  refusal: string | null;
  present: boolean;
  machines: Machine[];
  // The hash a save must still find, so a change made elsewhere since is not overwritten.
  hash: string | null;
  error: string | null;
  // Machine names the deployments suggest.
  suggestions: string[];
}

export interface InventoryOptions {
  store: Store;
  agents: AgentPool;
  suggestions?: string[];
  now?: () => number;
}

type Document = Record<string, unknown>;

// ── File ─────────────────────────────────────────────────────────────────────

function words(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

// The document and its machines, sorted by name.
export function parse_inventory(content: string): { document: Document; machines: Machine[] } {
  const document: unknown = content.trim() === "" ? {} : JSON.parse(content);
  if (typeof document !== "object" || document === null || Array.isArray(document)) throw new Error("the inventory does not hold a JSON object");
  const listed = (document as Document).machines;
  const machines = typeof listed === "object" && listed !== null && !Array.isArray(listed)
    ? Object.entries(listed as Record<string, unknown>).map(([name, entry]) => {
      const record = (typeof entry === "object" && entry !== null ? entry : {}) as Document;
      return { name, tags: words(record.tags), roles: words(record.roles) };
    })
    : [];
  return { document: document as Document, machines: machines.sort((first, second) => first.name.localeCompare(second.name)) };
}

// Why these machines cannot be saved, or null when they can.
export function machines_refusal(machines: unknown): string | null {
  if (!Array.isArray(machines)) return "List the machines as `machines`";
  const seen = new Set<string>();
  for (const machine of machines as Partial<Machine>[]) {
    if (typeof machine?.name !== "string" || !/^[A-Za-z0-9_-]+$/.test(machine.name)) return "Each machine needs a name of letters, digits, - and _";
    if (seen.has(machine.name)) return `Two machines are named '${machine.name}'`;
    seen.add(machine.name);
    for (const field of ["tags", "roles"] as const) {
      const list = machine[field];
      if (!Array.isArray(list) || !list.every((item) => typeof item === "string" && /^[A-Za-z0-9_.-]+$/.test(item))) {
        return `The ${field} of '${machine.name}' must be names of letters, digits, ., - and _`;
      }
    }
  }
  return null;
}

// The document with these machines, keeping every other key, and each kept machine's own other keys.
export function with_machines(document: Document, machines: Machine[]): string {
  const previous = (typeof document.machines === "object" && document.machines !== null ? document.machines : {}) as Record<string, Document>;
  const listed: Record<string, Document> = {};
  for (const machine of [...machines].sort((first, second) => first.name.localeCompare(second.name))) {
    const unique = (list: string[]) => [...new Set(list)].sort();
    listed[machine.name] = { ...previous[machine.name], tags: unique(machine.tags), roles: unique(machine.roles) };
  }
  return `${JSON.stringify({ ...document, machines: listed }, null, 2)}\n`;
}

// ── Inventory ────────────────────────────────────────────────────────────────

export class Inventory {
  readonly settings: InventorySettings | null;
  private readonly store: Store;
  private readonly agents: AgentPool;
  private readonly suggestions: string[];
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(settings: InventorySettings | null, options: InventoryOptions) {
    this.settings = settings;
    this.store = options.store;
    this.agents = options.agents;
    this.suggestions = options.suggestions ?? [];
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  private refusal(): string | null {
    if (this.settings === null) return "No inventory is configured; name its flake under inventory in the config file";
    return edit_refusal(this.settings);
  }

  async view(): Promise<InventoryView> {
    const settings = this.settings;
    const view: InventoryView = {
      configured: settings !== null, flake: settings?.flake ?? null, file: settings?.file ?? null, refusal: this.refusal(), present: false, machines: [], hash: null,
      error: null, suggestions: this.suggestions,
    };
    if (settings === null || view.refusal !== null) return view;
    try {
      const found = await read_flake_file(this.agents.get(settings.host), settings, settings.file);
      return { ...view, present: found.present, machines: parse_inventory(found.content).machines, hash: found.hash };
    } catch (error) {
      return { ...view, error: (error as Error).message };
    }
  }

  // Commits the machines, keeping what else the file holds, when it still has the hash the page read it with.
  save(machines: Machine[], expected_hash: string, trigger: string): Promise<ActionOutcome> {
    const next = this.queue.then(() => this.save_now(machines, expected_hash, trigger));
    this.queue = next.catch(() => {});
    return next;
  }

  private async save_now(machines: Machine[], expected_hash: string, trigger: string): Promise<ActionOutcome> {
    const refusal = this.refusal() ?? machines_refusal(machines);
    if (refusal !== null) return { ok: false, message: refusal, job_id: null };
    const settings = this.settings!;
    const agent = this.agents.get(settings.host);
    let document: Document;
    try {
      const found = await read_flake_file(agent, settings, settings.file);
      if (found.hash !== expected_hash) return { ok: false, message: `${settings.file} changed since it was read; load it again and redo the change`, job_id: null };
      document = parse_inventory(found.content).document;
    } catch (error) {
      return { ok: false, message: (error as Error).message, job_id: null };
    }
    const result = await write_flake_file(agent, settings, settings.file, with_machines(document, machines), settings.commit_message, expected_hash);
    const job_id = this.store.create_job({
      deployment_id: inventory_id, kind: "inventory", command: `${settings.commit_message}\n\nin ${settings.file} of ${settings.flake}`, agent: settings.host, run_id: null, trigger,
      started_epoch: this.now(),
    });
    this.store.append_output(job_id, [result.stdout, result.stderr].filter(Boolean).join("\n"));
    const ok = result.exit_code === 0;
    this.store.finish_job(job_id, ok ? "succeeded" : "failed", result.exit_code, ok ? null : `Exited with status ${result.exit_code}`, this.now());
    const message = ok ? `Committed the inventory of ${machines.length} machines` : `Could not commit the inventory: ${(result.stderr || result.stdout).trim().split("\n").pop()?.slice(0, 200)}`;
    this.store.add_event(inventory_id, this.now(), ok ? "info" : "error", message);
    return { ok, message, job_id };
  }
}
