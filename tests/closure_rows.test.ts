import { describe, expect, it } from "vitest";

import type { ClosureTree } from "../src/web/api.ts";
import { opened_after, shown_rows } from "../src/web/closure_rows.ts";

// A system needing glibc and bash, where bash needs glibc too.
const tree: ClosureTree = {
  root: "/nix/store/a-system",
  paths: [
    { path: "/nix/store/a-system", nar_size: 10, closure_size: 100, references: [1, 2] },
    { path: "/nix/store/b-glibc", nar_size: 40, closure_size: 40, references: [] },
    { path: "/nix/store/c-bash", nar_size: 20, closure_size: 60, references: [1] },
  ],
};

const has_references = (row: { index: number }) => tree.paths[row.index].references.length > 0;

describe("closure rows", () => {
  it("list a path's references only once it is open, largest closure first, each place a path shows its own row", () => {
    expect(shown_rows(tree, new Set()).map((row) => row.id)).toEqual(["0"]);
    expect(shown_rows(tree, new Set(["0"])).map((row) => [row.id, row.parent_id, row.position])).toEqual([["0", null, 0], ["0/2", "0", 0], ["0/1", "0", 1]]);
    expect(shown_rows(tree, new Set(["0", "0/2"])).map((row) => row.id)).toEqual(["0", "0/2", "0/2/1", "0/1"]);
  });

  it("open or fold the shown rows the tree reports, keeping hidden rows as they were", () => {
    const shown = shown_rows(tree, new Set(["0"]));

    expect([...opened_after(new Set(["0", "0/2/x"]), shown, new Set(["0/2"]), has_references)].sort()).toEqual(["0", "0/2/x"]);
    expect([...opened_after(new Set(["0"]), shown, new Set(), has_references)].sort()).toEqual(["0", "0/2"]);
    expect([...opened_after(new Set(["0", "0/2"]), shown, new Set(["0"]), has_references)].sort()).toEqual(["0/2"]);
  });
});
