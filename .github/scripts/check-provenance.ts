// Checks that every @x-tech-laboratories package in the pull request's lock was built by its own publish workflow on main and that nothing else moved.
// `npm audit signatures` checks that the provenance is genuinely signed, and this script checks that what it names is ours.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// ── Settings ─────────────────────────────────────────────────────────────────

const scope = "@x-tech-laboratories/";
const slsa_provenance = "https://slsa.dev/provenance/v1";
const github_actions_build_type = "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1";
const github_hosted_builder = "https://github.com/actions/runner/github-hosted";

export interface ExpectedBuild {
  repository: string;
  repository_id: string;
  workflow_path: string;
  workflow_ref: string;
}

// Where each of our packages is published from; any other package in the scope is refused until it is added here.
export const expected_builds: Record<string, ExpectedBuild> = {
  "@x-tech-laboratories/x-libs": {
    repository: "https://github.com/x-tech-laboratories/X-Libs",
    repository_id: "1446167563",
    workflow_path: ".github/workflows/publish.yml",
    workflow_ref: "refs/heads/main",
  },
  "@x-tech-laboratories/halon": {
    repository: "https://github.com/x-tech-laboratories/X-Themes",
    repository_id: "1428946674",
    workflow_path: ".github/workflows/halon-publish.yml",
    workflow_ref: "refs/heads/main",
  },
};

// The organisation's GitHub id, which a repository of the same name under a new owner would not have.
export const expected_owner_id = "340763521";

// The parts of an in-toto statement the check reads.
export interface ProvenanceStatement {
  subject?: { name?: string; digest?: { sha512?: string } }[];
  predicate?: {
    buildDefinition?: {
      buildType?: string;
      externalParameters?: { workflow?: { repository?: string; path?: string; ref?: string } };
      internalParameters?: { github?: { event_name?: string; repository_id?: string; repository_owner_id?: string } };
      resolvedDependencies?: { uri?: string; digest?: { gitCommit?: string } }[];
    };
    runDetails?: { builder?: { id?: string } };
  };
}

export interface LockEntry {
  version?: string;
  integrity?: string;
  link?: boolean;
}

// ── Checking ─────────────────────────────────────────────────────────────────

// The package name a lock file's path names.
export function package_name(path: string): string {
  return path.replace(/^.*node_modules\//, "");
}

// Why a package's SLSA provenance statement does not show it was built by its expected workflow from the lock's contents, or null when it does.
export function provenance_refusal(name: string, integrity: string, statement: ProvenanceStatement | null): string | null {
  const expected = expected_builds[name];
  if (expected === undefined) return "it is not in the table of packages that may merge on their own";
  if (statement === null) return "it has no SLSA provenance";
  const digest = Buffer.from(integrity.replace(/^sha512-/, ""), "base64").toString("hex");
  if (!integrity.startsWith("sha512-") || !(statement.subject ?? []).some((subject) => subject.digest?.sha512 === digest)) {
    return "its provenance is for other contents than the lock file's";
  }
  const definition = statement.predicate?.buildDefinition;
  const workflow = definition?.externalParameters?.workflow;
  const github = definition?.internalParameters?.github;
  if (definition?.buildType !== github_actions_build_type) return `it was built by ${definition?.buildType ?? "an unnamed build type"}`;
  if (workflow?.repository !== expected.repository) return `it was built from ${workflow?.repository ?? "an unnamed repository"}, not ${expected.repository}`;
  if (github?.repository_id !== expected.repository_id || github?.repository_owner_id !== expected_owner_id) return "it was built from a repository with another id";
  if (workflow?.path !== expected.workflow_path) return `it was built by ${workflow?.path ?? "an unnamed workflow"}, not ${expected.workflow_path}`;
  if (workflow?.ref !== expected.workflow_ref) return `it was built from ${workflow?.ref ?? "an unnamed ref"}, not ${expected.workflow_ref}`;
  if (github?.event_name !== "push") return `it was built on a ${github?.event_name ?? "unnamed"} event, not a push`;
  const source = `git+${expected.repository}@${expected.workflow_ref}`;
  if (!(definition?.resolvedDependencies ?? []).some((dependency) => dependency.uri === source && /^[0-9a-f]{40}$/.test(dependency.digest?.gitCommit ?? ""))) {
    return `its source is not a commit of ${source}`;
  }
  const builder = statement.predicate?.runDetails?.builder?.id;
  if (builder !== github_hosted_builder) return `it was built on ${builder ?? "an unnamed builder"}, not a GitHub-hosted runner`;
  return null;
}

// The packages outside our scope whose lock entry the update adds, removes or changes.
export function third_party_changes(base: Record<string, LockEntry>, head: Record<string, LockEntry>): string[] {
  const paths = new Set([...Object.keys(base), ...Object.keys(head)]);
  const changed: string[] = [];
  for (const path of paths) {
    if (path === "" || package_name(path).startsWith(scope)) continue;
    const before = base[path];
    const after = head[path];
    if (before?.version !== after?.version || before?.integrity !== after?.integrity) changed.push(`${path} ${before?.version ?? "absent"} -> ${after?.version ?? "absent"}`);
  }
  return changed.sort();
}

// ── Registry ─────────────────────────────────────────────────────────────────

// The package's SLSA provenance statement from the registry, or null when it was published without one.
async function fetch_statement(name: string, version: string): Promise<ProvenanceStatement | null> {
  const response = await fetch(`https://registry.npmjs.org/-/npm/v1/attestations/${encodeURIComponent(name)}@${version}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`the registry answered ${response.status}`);
  const { attestations } = (await response.json()) as { attestations: { predicateType: string; bundle: { dsseEnvelope: { payload: string } } }[] };
  const provenance = attestations.find((attestation) => attestation.predicateType === slsa_provenance);
  if (provenance === undefined) return null;
  return JSON.parse(Buffer.from(provenance.bundle.dsseEnvelope.payload, "base64").toString("utf8")) as ProvenanceStatement;
}

// ── Start ────────────────────────────────────────────────────────────────────

// Checks the lock file in the working directory against the base branch's lock file named on the command line.
async function main(base_lock_path: string): Promise<number> {
  const head = (JSON.parse(readFileSync("package-lock.json", "utf8")) as { packages: Record<string, LockEntry> }).packages;
  const base = (JSON.parse(readFileSync(base_lock_path, "utf8")) as { packages: Record<string, LockEntry> }).packages;
  const refusals = third_party_changes(base, head).map((change) => `${change}: a package outside ${scope} changed`);
  for (const [path, entry] of Object.entries(head)) {
    const name = package_name(path);
    if (!name.startsWith(scope) || entry.link) continue;
    let why: string | null;
    try {
      why = provenance_refusal(name, entry.integrity ?? "", await fetch_statement(name, entry.version ?? ""));
    } catch (error) {
      why = (error as Error).message;
    }
    console.log(`${name}@${entry.version}: ${why ?? `built by ${expected_builds[name]!.workflow_path} from ${expected_builds[name]!.repository}`}`);
    if (why !== null) refusals.push(`${name}@${entry.version}: ${why}`);
  }
  if (refusals.length === 0) return 0;
  console.error(`Not merging on its own:\n${refusals.join("\n")}`);
  return 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const base_lock_path = process.argv[2];
  if (base_lock_path === undefined) {
    console.error("Usage: check-provenance.ts <base branch's package-lock.json>");
    process.exit(2);
  }
  process.exit(await main(base_lock_path));
}
