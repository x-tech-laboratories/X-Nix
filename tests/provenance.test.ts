import { describe, expect, it } from "vitest";

import { provenance_refusal, third_party_changes, type ProvenanceStatement } from "../.github/scripts/check-provenance.ts";

// ── Setup ────────────────────────────────────────────────────────────────────

const integrity = `sha512-${Buffer.from("x-libs tarball").toString("base64")}`;
const digest = Buffer.from("x-libs tarball").toString("hex");

// The statement npm published for @x-tech-laboratories/x-libs@0.74.0, with its own subject digest swapped for the fixture's.
function x_libs_statement(): ProvenanceStatement {
  return {
    subject: [{ name: "pkg:npm/%40x-tech-laboratories/x-libs@0.74.0", digest: { sha512: digest } }],
    predicate: {
      buildDefinition: {
        buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: { workflow: { ref: "refs/heads/main", repository: "https://github.com/x-tech-laboratories/X-Libs", path: ".github/workflows/publish.yml" } },
        internalParameters: { github: { event_name: "push", repository_id: "1446167563", repository_owner_id: "340763521" } },
        resolvedDependencies: [{ uri: "git+https://github.com/x-tech-laboratories/X-Libs@refs/heads/main", digest: { gitCommit: "aab16bd2d3569aff4ab19c7badb2e9a8e2363474" } }],
      },
      runDetails: { builder: { id: "https://github.com/actions/runner/github-hosted" } },
    },
  };
}

function halon_statement(): ProvenanceStatement {
  const statement = x_libs_statement();
  const definition = statement.predicate!.buildDefinition!;
  definition.externalParameters!.workflow = { ref: "refs/heads/main", repository: "https://github.com/x-tech-laboratories/X-Themes", path: ".github/workflows/halon-publish.yml" };
  definition.internalParameters!.github!.repository_id = "1428946674";
  definition.resolvedDependencies = [{ uri: "git+https://github.com/x-tech-laboratories/X-Themes@refs/heads/main", digest: { gitCommit: "176f6d66c857b54046348770decb1bf4a68958bf" } }];
  return statement;
}

// The x-libs statement with one change made to it.
function changed(change: (statement: ProvenanceStatement) => void): ProvenanceStatement {
  const statement = x_libs_statement();
  change(statement);
  return statement;
}

// ── Provenance ───────────────────────────────────────────────────────────────

describe("the provenance check", () => {
  it("accepts X-Libs and Halon built by their own publish workflows on main", () => {
    expect(provenance_refusal("@x-tech-laboratories/x-libs", integrity, x_libs_statement())).toBeNull();
    expect(provenance_refusal("@x-tech-laboratories/halon", integrity, halon_statement())).toBeNull();
  });

  it("refuses a package of the scope that is not in the table, or one without provenance", () => {
    expect(provenance_refusal("@x-tech-laboratories/x-other", integrity, x_libs_statement())).toMatch(/not in the table/);
    expect(provenance_refusal("@x-tech-laboratories/x-libs", integrity, null)).toMatch(/no SLSA provenance/);
  });

  it("refuses provenance for other contents than the lock file's", () => {
    expect(provenance_refusal("@x-tech-laboratories/x-libs", `sha512-${Buffer.from("other").toString("base64")}`, x_libs_statement())).toMatch(/other contents/);
    expect(provenance_refusal("@x-tech-laboratories/x-libs", "sha1-abc", x_libs_statement())).toMatch(/other contents/);
  });

  it("refuses another repository of the organisation, a look-alike name, or a repository with another id", () => {
    expect(provenance_refusal("@x-tech-laboratories/halon", integrity, x_libs_statement())).toMatch(/built from https:\/\/github.com\/x-tech-laboratories\/X-Libs, not/);
    const look_alike = changed((statement) => (statement.predicate!.buildDefinition!.externalParameters!.workflow!.repository = "https://github.com/x-tech-laboratories/X-Libs-fork"));
    expect(provenance_refusal("@x-tech-laboratories/x-libs", integrity, look_alike)).toMatch(/X-Libs-fork/);
    const recreated = changed((statement) => (statement.predicate!.buildDefinition!.internalParameters!.github!.repository_id = "1"));
    expect(provenance_refusal("@x-tech-laboratories/x-libs", integrity, recreated)).toMatch(/another id/);
    const new_owner = changed((statement) => (statement.predicate!.buildDefinition!.internalParameters!.github!.repository_owner_id = "2"));
    expect(provenance_refusal("@x-tech-laboratories/x-libs", integrity, new_owner)).toMatch(/another id/);
  });

  it("refuses another workflow, branch, event, source or builder", () => {
    const workflow = changed((statement) => (statement.predicate!.buildDefinition!.externalParameters!.workflow!.path = ".github/workflows/ci.yml"));
    expect(provenance_refusal("@x-tech-laboratories/x-libs", integrity, workflow)).toMatch(/ci.yml/);
    const branch = changed((statement) => (statement.predicate!.buildDefinition!.externalParameters!.workflow!.ref = "refs/heads/feature"));
    expect(provenance_refusal("@x-tech-laboratories/x-libs", integrity, branch)).toMatch(/refs\/heads\/feature/);
    const event = changed((statement) => (statement.predicate!.buildDefinition!.internalParameters!.github!.event_name = "workflow_dispatch"));
    expect(provenance_refusal("@x-tech-laboratories/x-libs", integrity, event)).toMatch(/workflow_dispatch/);
    const source = changed((statement) => (statement.predicate!.buildDefinition!.resolvedDependencies = [{ uri: "git+https://github.com/x-tech-laboratories/X-Libs@refs/heads/feature" }]));
    expect(provenance_refusal("@x-tech-laboratories/x-libs", integrity, source)).toMatch(/source/);
    const builder = changed((statement) => (statement.predicate!.runDetails!.builder!.id = "https://github.com/actions/runner/self-hosted"));
    expect(provenance_refusal("@x-tech-laboratories/x-libs", integrity, builder)).toMatch(/GitHub-hosted/);
    const build_type = changed((statement) => (statement.predicate!.buildDefinition!.buildType = "https://example.org/build"));
    expect(provenance_refusal("@x-tech-laboratories/x-libs", integrity, build_type)).toMatch(/example.org/);
  });
});

// ── Lock changes ─────────────────────────────────────────────────────────────

describe("the lock change check", () => {
  it("names every package outside the scope that the update adds, removes or moves, and nothing of the scope", () => {
    const base = {
      "": { version: "0.3.0" },
      "node_modules/@x-tech-laboratories/x-libs": { version: "0.74.0", integrity: "sha512-a" },
      "node_modules/left-pad": { version: "1.0.0", integrity: "sha512-b" },
      "node_modules/gone": { version: "2.0.0", integrity: "sha512-c" },
      "node_modules/same": { version: "3.0.0", integrity: "sha512-d" },
    };
    const head = {
      "": { version: "0.3.0" },
      "node_modules/@x-tech-laboratories/x-libs": { version: "0.75.0", integrity: "sha512-e" },
      "node_modules/left-pad": { version: "1.0.1", integrity: "sha512-f" },
      "node_modules/@x-tech-laboratories/x-libs/node_modules/new-dependency": { version: "1.0.0", integrity: "sha512-g" },
      "node_modules/same": { version: "3.0.0", integrity: "sha512-d" },
    };

    expect(third_party_changes(base, head)).toEqual([
      "node_modules/@x-tech-laboratories/x-libs/node_modules/new-dependency absent -> 1.0.0",
      "node_modules/gone 2.0.0 -> absent",
      "node_modules/left-pad 1.0.0 -> 1.0.1",
    ]);
    expect(third_party_changes(base, base)).toEqual([]);
  });
});
