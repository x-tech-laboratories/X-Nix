import { describe, expect, it } from "vitest";

import { other_fetches_path, plan_tree, type PlannedPath, type PlanRow } from "../src/shared/build_plan.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

function path(kind: PlannedPath["kind"], name: string, needs: string[] | null = []): PlannedPath {
  return { kind, name, state: "waiting", phase: null, started_epoch: null, finished_epoch: null, needs };
}

// The tree as nested names, for reading at a glance.
function shape(rows: PlanRow[]): unknown[] {
  return rows.map((row) => (row.children.length === 0 ? row.name : { [row.name]: shape(row.children) }));
}

// ── Tree ─────────────────────────────────────────────────────────────────────

describe("the build plan's tree", () => {
  it("puts what nothing needs at the top, and each path once, under the nearest derivation that needs it", () => {
    const planned = {
      system: path("build", "system", ["etc", "app", "zlib"]),
      etc: path("build", "etc", ["app"]),
      app: path("build", "app", ["zlib", "lib"]),
      lib: path("build", "lib"),
      zlib: path("fetch", "zlib"),
      runtime: path("fetch", "glibc"),
    };

    const rows = plan_tree(planned);

    expect(shape(rows)).toEqual([{ system: [{ app: ["lib"] }, "etc", "zlib"] }, { "Other fetched paths": ["glibc"] }]);
    expect(rows[0].children.find((row) => row.path === "app")!.needed_by).toBe(2);
    expect(rows[1]).toMatchObject({ path: other_fetches_path, planned: null });
  });

  it("lists every path at the top while what they need is unread, and fetches alone with no heading", () => {
    expect(shape(plan_tree({ app: path("build", "app", null), lib: path("build", "lib", null) }))).toEqual(["app", "lib"]);
    expect(shape(plan_tree({ zlib: path("fetch", "zlib"), glibc: path("fetch", "glibc") }))).toEqual(["glibc", "zlib"]);
  });
});
