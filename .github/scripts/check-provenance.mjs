// Checks every @x-tech-laboratories package the lock file names was built from the organisation's own repository, by
// the npm provenance published with it; `npm audit signatures` checks the provenance is genuinely signed.

import { readFileSync } from "node:fs";

// ── Settings ─────────────────────────────────────────────────────────────────

const scope = "@x-tech-laboratories/";
const repository_prefix = "https://github.com/x-tech-laboratories/";
const slsa_provenance = "https://slsa.dev/provenance/v1";

// ── Checking ─────────────────────────────────────────────────────────────────

// Why the package's provenance does not show it was built from the organisation's repository, or null when it does.
async function refusal(name, version, integrity) {
  const response = await fetch(`https://registry.npmjs.org/-/npm/v1/attestations/${encodeURIComponent(name)}@${version}`);
  if (response.status === 404) return "it was published without provenance";
  if (!response.ok) return `the registry answered ${response.status}`;
  const { attestations } = await response.json();
  const provenance = attestations.find((attestation) => attestation.predicateType === slsa_provenance);
  if (provenance === undefined) return "it has no SLSA provenance";
  const statement = JSON.parse(Buffer.from(provenance.bundle.dsseEnvelope.payload, "base64").toString("utf8"));
  const digest = Buffer.from(integrity.replace(/^sha512-/, ""), "base64").toString("hex");
  if (!statement.subject.some((subject) => subject.digest?.sha512 === digest)) return "its provenance is for other contents than the lock file's";
  const repository = statement.predicate?.buildDefinition?.externalParameters?.workflow?.repository ?? "";
  if (!repository.startsWith(repository_prefix)) return `it was built from ${repository || "an unnamed repository"}`;
  return null;
}

// ── Start ────────────────────────────────────────────────────────────────────

const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const refusals = [];
for (const [path, entry] of Object.entries(lock.packages)) {
  const name = path.replace(/^.*node_modules\//, "");
  if (!name.startsWith(scope) || entry.link) continue;
  const why = await refusal(name, entry.version, entry.integrity);
  console.log(`${name}@${entry.version}: ${why ?? `built from ${repository_prefix}`}`);
  if (why !== null) refusals.push(`${name}@${entry.version}: ${why}`);
}
if (refusals.length > 0) {
  console.error(`Not merging on its own:\n${refusals.join("\n")}`);
  process.exit(1);
}
