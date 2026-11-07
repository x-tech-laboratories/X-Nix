// The build history: every finished build of a deployment or cache target, with its store path and the products it made.
//
// When a Build, a cache target's Build or a Build all ends, each target it built is recorded with the job that holds its
// log. A built store path is read once for Hydra's `nix-support/hydra-build-products`, and each product that is a
// regular file inside that store path is recorded with its size. Such a file can be downloaded through the agent that
// built it, which checks again that it lies inside the store path and sends it in base64 pieces, one `piece` run each.

// ── Imports ──────────────────────────────────────────────────────────────────

import { Readable } from "node:stream";

import type { Agent, AgentPool } from "./agents/agent.ts";
import { read_facts, type LocatedFile } from "../shared/facts.ts";
import { is_store_path, type Operation } from "../shared/operations.ts";
import type { BuildRecord, BuildProduct, Job, Store } from "./store.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

// One target a finished build job built, or tried to.
export interface BuiltTarget {
  target: string;
  store_path: string | null;
  succeeded: boolean;
}

const products_timeout_in_seconds = 60;

// Each download request reads this many blocks of block_size_in_bytes, which stays well under an agent message's limit.
const block_size_in_bytes = 1024 * 1024;
const blocks_per_piece = 8;
const piece_timeout_in_seconds = 120;

// ── Store paths in output ────────────────────────────────────────────────────

// The last store path a build printed on a line of its own, or named as already in the cache.
export function built_store_path(output: string): string | null {
  const lines = output.split("\n").map((line) => line.trim()).reverse();
  for (const line of lines) {
    if (is_store_path(line)) return line;
    const cached = /^(\/nix\/store\/\S+) is already in the cache; not building it$/.exec(line);
    if (cached !== null && is_store_path(cached[1])) return cached[1];
  }
  return null;
}

// ── Products ─────────────────────────────────────────────────────────────────

// Lists the store path's Hydra build products, each with its size when it is a regular file inside the store path.
export function products_operation(store_path: string): Operation {
  return { kind: "products", store_path };
}

export function parse_products(output: string): BuildProduct[] {
  const products = read_facts<BuildProduct[]>(output);
  return Array.isArray(products) ? products : [];
}

// ── Recording ────────────────────────────────────────────────────────────────

// Records each target a finished job built, reading the products of every store path that built.
export async function record_builds(store: Store, agents: AgentPool, job: Job, built: BuiltTarget[], now: number): Promise<void> {
  const agent = agents.get(job.agent);
  for (const entry of built) {
    let products: BuildProduct[] = [];
    if (entry.succeeded && entry.store_path !== null && is_store_path(entry.store_path)) {
      const result = await agent.run(products_operation(entry.store_path), { timeout_in_seconds: products_timeout_in_seconds });
      products = parse_products(result.stdout);
    }
    store.add_build({
      job_id: job.id, owner_id: job.deployment_id, target: entry.target, agent: job.agent, store_path: entry.store_path,
      succeeded: entry.succeeded, started_epoch: job.started_epoch, finished_epoch: job.finished_epoch ?? now, products,
    });
  }
}

// ── Downloads ────────────────────────────────────────────────────────────────

// Why a build's product cannot be downloaded, or null when it can.
export function download_refusal(build: BuildRecord, product: BuildProduct | undefined): string | null {
  if (product === undefined) return "No such product";
  if (build.store_path === null || !is_store_path(build.store_path)) return "The build recorded no store path";
  if (product.size_bytes === null) return `${product.name} is not a file inside ${build.store_path}`;
  return null;
}

// Answers the product's real path and size, after checking it is still a regular file inside the build's store path.
export function locate_operation(store_path: string, path: string): Operation {
  return { kind: "locate", store_path, path };
}

// Reads one piece of a file, as base64 so it travels as text.
export function piece_operation(path: string, block: number): Operation {
  return { kind: "piece", path, offset: block * block_size_in_bytes, length: blocks_per_piece * block_size_in_bytes };
}

// Finds the product on the host that built it, answering its real path and size, or why it cannot be sent.
export async function locate_product(agent: Agent, build: BuildRecord, product: BuildProduct): Promise<{ path: string; size: number } | { error: string }> {
  const result = await agent.run(locate_operation(build.store_path!, product.path), { timeout_in_seconds: products_timeout_in_seconds });
  const located = result.exit_code === 0 ? read_facts<LocatedFile>(result.stdout) : null;
  if (located === null || typeof located.path !== "string" || typeof located.size !== "number") return { error: result.stderr.trim() || `The host answered with status ${result.exit_code}` };
  return { path: located.path, size: located.size };
}

// The file's bytes, read from its host one piece at a time as the reader asks for them.
export function product_stream(agent: Agent, path: string, size: number): Readable {
  let block = 0;
  const blocks = Math.ceil(size / block_size_in_bytes);
  return new Readable({
    read() {
      if (block >= blocks) {
        this.push(null);
        return;
      }
      void agent.run(piece_operation(path, block), { timeout_in_seconds: piece_timeout_in_seconds }).then((result) => {
        if (result.exit_code !== 0) {
          this.destroy(new Error(`Could not read ${path}: ${result.stderr.trim() || `status ${result.exit_code}`}`));
          return;
        }
        block += blocks_per_piece;
        this.push(Buffer.from(result.stdout, "base64"));
      });
    },
  });
}
