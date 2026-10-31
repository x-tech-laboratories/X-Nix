// Reads and commits one file X-Nix owns in a flake, so it never rewrites hand-written Nix.
//
// A `github:` flake is cloned fresh with its push key, and the change is committed and pushed back as the commit author,
// just as Update Flake does; a local checkout is written in place and committed when it is a git repository. A write
// carries the hash of the contents it was based on and stops when the file has changed since, rather than overwrite it.

// ── Imports ──────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";

import type { Agent } from "../agents/agent.ts";
import { shell_quote } from "./commands.ts";
import { github_repository, local_path } from "./flake.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

// The flake a file lives in, and how a change to it is committed.
export interface FlakeRepository {
  flake: string;
  push_ssh_key: string | null;
  commit_author: string;
}

export interface FlakeFile {
  present: boolean;
  content: string;
  // The contents' sha256, or "missing" for a file not there yet.
  hash: string;
}

// Starts the line that says whether the file is there, before its contents.
export const file_mark = "@@x-nix-file";

// The exit status a write gives when the file changed since it was read.
export const changed_exit_code = 3;

const file_timeout_in_seconds = 300;

// ── Checks ───────────────────────────────────────────────────────────────────

// Why X-Nix cannot commit to this flake, or null when it can.
export function edit_refusal(repository: FlakeRepository): string | null {
  if (local_path(repository.flake) !== null) return null;
  if (github_repository(repository.flake) === null) return `Cannot write to ${repository.flake}: only a local checkout, or a github: flake with a push_ssh_key, can be committed to`;
  if (repository.push_ssh_key === null) return `Cannot write to ${repository.flake}: a github: flake needs a push_ssh_key`;
  return null;
}

// Whether the path is a plain relative path inside the flake.
export function is_flake_path(path: string): boolean {
  return /^[A-Za-z0-9_.@+-]+(\/[A-Za-z0-9_.@+-]+)*$/.test(path) && !path.split("/").some((step) => step === "." || step === "..");
}

export function content_hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

// ── Commands ─────────────────────────────────────────────────────────────────

// The lines that leave the flake's folder in $d: a fresh clone for github:, the checkout itself for a local path.
function checkout_lines(repository: FlakeRepository): string[] {
  const path = local_path(repository.flake);
  if (path !== null) return [`d=${shell_quote(path.replace(/\/+$/, ""))}`];
  const github = github_repository(repository.flake)!;
  const branch = github.branch ? `--branch ${shell_quote(github.branch)} ` : "";
  const ssh = `ssh -i ${shell_quote(repository.push_ssh_key!)} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes`;
  return [
    "t=$(mktemp -d)",
    `trap 'rm -rf "$t"' EXIT`,
    `export GIT_SSH_COMMAND=${shell_quote(ssh)}`,
    `git clone --quiet --depth 1 ${branch}${shell_quote(github.ssh_url)} "$t/repo"`,
    'd="$t/repo"',
  ];
}

function identity(commit_author: string): string {
  const [name, email = ""] = commit_author.split("<", 2);
  return `-c user.name=${shell_quote(name.trim())} -c user.email=${shell_quote(email.replace(/>\s*$/, "").trim())}`;
}

// Prints whether the file is there with its hash on a marker line, then its contents.
export function read_file_command(repository: FlakeRepository, file: string): string {
  const lines = ["set -e", ...checkout_lines(repository), `f="$d/"${shell_quote(file)}`,
    `if [ -f "$f" ]; then echo "${file_mark} present $(sha256sum < "$f" | cut -d " " -f 1)"; cat "$f"; else echo "${file_mark} missing"; fi`];
  return `(\n${lines.join("\n")}\n)`;
}

// Writes the file when it still has the expected hash, then commits it, and pushes a github: flake's commit.
export function write_file_command(repository: FlakeRepository, file: string, content: string, message: string, expected_hash: string): string {
  const pushes = local_path(repository.flake) === null;
  const git = `git -C "$d" ${identity(repository.commit_author)}`;
  const lines = [
    "set -e",
    ...checkout_lines(repository),
    `f="$d/"${shell_quote(file)}`,
    'current=missing',
    'if [ -f "$f" ]; then current=$(sha256sum < "$f" | cut -d " " -f 1); fi',
    `if [ "$current" != ${shell_quote(expected_hash)} ]; then echo ${shell_quote(`${file} changed since it was read; load it again and redo the change`)} >&2; exit ${changed_exit_code}; fi`,
    'mkdir -p "$(dirname "$f")"',
    `printf '%s' ${shell_quote(Buffer.from(content).toString("base64"))} | base64 -d > "$f.part"`,
    'mv -f "$f.part" "$f"',
  ];
  const commit = [
    `${git} add -- ${shell_quote(file)}`,
    `if ${git} diff --cached --quiet -- ${shell_quote(file)}; then echo "Nothing changed"; exit 0; fi`,
    `${git} commit --quiet -m ${shell_quote(message)} -- ${shell_quote(file)}`,
    ...(pushes ? [`${git} push --quiet origin HEAD`] : []),
    `${git} log --oneline -1`,
  ];
  if (pushes) lines.push(...commit);
  // A local checkout that is no git repository just keeps the written file.
  else lines.push('if git -C "$d" rev-parse --is-inside-work-tree >/dev/null 2>&1; then', ...commit.map((line) => `  ${line}`), 'else echo "Wrote the file; the flake is no git repository, so nothing was committed"; fi');
  return `(\n${lines.join("\n")}\n)`;
}

// ── Running ──────────────────────────────────────────────────────────────────

// Reads the file through the agent, rejecting with what the host printed when it could not.
export async function read_flake_file(agent: Agent, repository: FlakeRepository, file: string): Promise<FlakeFile> {
  const result = await agent.run(read_file_command(repository, file), file_timeout_in_seconds);
  const marker = result.stdout.indexOf(`${file_mark} `);
  if (result.exit_code !== 0 || marker === -1) throw new Error(`Could not read ${file} from ${repository.flake}: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
  const after = result.stdout.slice(marker + file_mark.length + 1);
  if (after.startsWith("missing")) return { present: false, content: "", hash: "missing" };
  const [first_line, ...rest] = after.split("\n");
  const hash = first_line.split(" ")[1] ?? "";
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`Could not read ${file} from ${repository.flake}: no hash came back`);
  return { present: true, content: rest.join("\n"), hash };
}

export function write_flake_file(agent: Agent, repository: FlakeRepository, file: string, content: string, message: string, expected_hash: string) {
  return agent.run(write_file_command(repository, file, content, message, expected_hash), file_timeout_in_seconds);
}
