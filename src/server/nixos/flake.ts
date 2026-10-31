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

// ── Pins ─────────────────────────────────────────────────────────────────────

// A pin is a full git commit hash or a tag name.
export function is_pin(pin: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,127}$/.test(pin) && !pin.includes("..") && !pin.endsWith("/");
}

function is_commit(pin: string): boolean {
  return /^[0-9a-f]{40}$/.test(pin);
}

// The forge flake types whose path may carry a ref after the owner and repository.
const forge_schemes = ["github:", "gitlab:", "sourcehut:"];

// The flake reference fixed at a commit or tag, or null for a flake that cannot be pinned, such as a path: or a tarball.
export function pinned_flake(flake: string, pin: string): string | null {
  if (!is_pin(pin)) return null;
  const [base, query = ""] = flake.split("?", 2);
  const params = new URLSearchParams(query);
  params.delete("ref");
  params.delete("rev");
  const forge = forge_schemes.find((scheme) => base.startsWith(scheme));
  if (forge !== undefined) {
    const parts = base.slice(forge.length).split("/");
    if (parts.length < 2 || !parts[0] || !parts[1]) return null;
    params.set(is_commit(pin) ? "rev" : "ref", pin);
    return `${forge}${parts[0]}/${parts[1]}?${params.toString()}`;
  }
  let git_base: string | null = null;
  if (base.startsWith("git+")) git_base = base;
  else if (base.startsWith("git://")) git_base = `git+${base}`;
  else if (base.startsWith("/")) git_base = `git+file://${base}`;
  else if (base.startsWith("file://")) git_base = `git+${base}`;
  if (git_base === null) return null;
  if (is_commit(pin)) {
    // A commit off the default branch is only fetched when every ref is.
    params.set("rev", pin);
    if (!params.has("allRefs")) params.set("allRefs", "1");
  } else {
    params.set("ref", pin.startsWith("refs/") ? pin : `refs/tags/${pin}`);
  }
  return `${git_base}?${params.toString()}`;
}

// ── Repositories ─────────────────────────────────────────────────────────────

const forge_hosts: Record<string, string> = { "github:": "github.com", "gitlab:": "gitlab.com", "sourcehut:": "git.sr.ht" };

// A repository URL as host and path, lowercased and without scheme, user, port or .git, so the forms a forge sends compare equal.
export function normalize_repository(url: string): string | null {
  let text = url.trim().replace(/^git\+/, "");
  // An scp-like address such as git@github.com:owner/repo.git.
  const scp = text.includes("://") ? null : /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(text);
  if (scp !== null) text = `ssh://${scp[1]}/${scp[2]}`;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.protocol === "file:" || parsed.hostname === "") return null;
  const path = parsed.pathname.replace(/\/+$/, "").replace(/\.git$/, "").replace(/^\/+/, "");
  if (path === "") return null;
  return `${parsed.hostname}/${path}`.toLowerCase();
}

export interface FlakeRepository {
  // The repository as normalize_repository gives it.
  repository: string;
  // The branch the flake follows, or null for the repository's default branch.
  branch: string | null;
}

// The remote repository and branch a flake follows, or null for a local flake or one that names no repository.
export function repository_of(flake: string): FlakeRepository | null {
  const [base, query = ""] = flake.split("?", 2);
  const params = new URLSearchParams(query);
  const branch_of = (ref: string | null) => (ref === null || ref === "" || is_commit(ref) || ref.startsWith("refs/tags/") ? null : ref.replace(/^refs\/heads\//, ""));
  const forge = forge_schemes.find((scheme) => base.startsWith(scheme));
  if (forge !== undefined) {
    const parts = base.slice(forge.length).split("/");
    if (parts.length < 2 || !parts[0] || !parts[1]) return null;
    const host = params.get("host") ?? forge_hosts[forge];
    return { repository: `${host}/${parts[0]}/${parts[1]}`.toLowerCase(), branch: branch_of(params.get("ref") ?? (parts.slice(2).join("/") || null)) };
  }
  if (!base.startsWith("git+") || base.startsWith("git+file:")) return null;
  const repository = normalize_repository(base);
  return repository === null ? null : { repository, branch: branch_of(params.get("ref")) };
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
