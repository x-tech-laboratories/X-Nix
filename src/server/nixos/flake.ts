// Reads flake references and the JSON `nix flake metadata` prints.

// ── References ───────────────────────────────────────────────────────────────

const local_schemes = ["path:", "git+file://", "file://"];

// The flake's filesystem path when it is a local checkout, whose lock file `nix flake update` can write.
export function local_path(flake: string): string | null {
  let reference = flake;
  const scheme = local_schemes.find((prefix) => reference.startsWith(prefix));
  if (scheme !== undefined) reference = reference.slice(scheme.length);
  else if (!reference.startsWith("/") && !reference.startsWith(".")) return null;
  const path = reference.split("?", 1)[0].split("#", 1)[0];
  return path || null;
}

export interface GithubRepository {
  ssh_url: string;
  branch: string | null;
}

// The repository of a `github:owner/repo[/ref]` flake.
export function github_repository(flake: string): GithubRepository | null {
  if (!flake.startsWith("github:")) return null;
  const [path, query = ""] = flake.slice("github:".length).split("?", 2);
  const parts = path.split("/");
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  const ref = new URLSearchParams(query).get("ref") || parts.slice(2).join("/") || null;
  return { ssh_url: `git@github.com:${parts[0]}/${parts[1]}.git`, branch: ref };
}

// A flake revision cut to twelve characters, keeping the -dirty mark of a checkout with uncommitted changes.
export function short_revision(revision: string | null | undefined): string {
  if (!revision) return "—";
  const dash = revision.indexOf("-");
  return dash === -1 ? revision.slice(0, 12) : revision.slice(0, Math.min(dash, 12)) + revision.slice(dash);
}

// ── Metadata ─────────────────────────────────────────────────────────────────

export interface FlakeMetadata {
  revision: string | null;
  last_modified_epoch: number | null;
  oldest_input: string | null;
  inputs_last_modified_epoch: number | null;
}

export function parse_metadata(raw: string): FlakeMetadata | null {
  const data = as_object(parse_json(raw));
  if (data === null || Object.keys(data).length === 0) return null;
  const locked = as_object(data.locked) ?? {};
  const oldest = oldest_input(as_object(data.locks) ?? {});
  return {
    // An uncommitted local checkout has no `rev`, only a `dirtyRev`.
    revision: text(data.revision) ?? text(locked.rev) ?? text(locked.dirtyRev),
    last_modified_epoch: number(data.lastModified) ?? number(locked.lastModified),
    oldest_input: oldest.name,
    inputs_last_modified_epoch: oldest.epoch,
  };
}

// The locked input updated least recently, which `nix flake update` would move furthest.
function oldest_input(locks: Record<string, unknown>): { name: string | null; epoch: number | null } {
  const nodes = as_object(locks.nodes);
  if (nodes === null) return { name: null, epoch: null };
  const root = text(locks.root) ?? "root";
  let oldest: { name: string | null; epoch: number | null } = { name: null, epoch: null };
  for (const [name, node] of Object.entries(nodes)) {
    if (name === root) continue;
    const stamp = number(as_object(as_object(node)?.locked)?.lastModified);
    if (stamp !== null && (oldest.epoch === null || stamp < oldest.epoch)) oldest = { name, epoch: Math.floor(stamp) };
  }
  return oldest;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parse_json(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function as_object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
