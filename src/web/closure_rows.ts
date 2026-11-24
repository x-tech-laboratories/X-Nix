// The rows of a closure's dependency tree, listed only under the rows that are open, since a closure repeats paths many times over.

import type { ClosureTree } from "./api.ts";

// One place a path shows in the tree, named by the indexes down to it.
export interface PathRow {
  id: string;
  parent_id: string | null;
  position: number;
  index: number;
}

// The rows shown: the root, and the references of each opened row, largest closure first.
export function shown_rows(tree: ClosureTree, opened: ReadonlySet<string>): PathRow[] {
  const rows: PathRow[] = [];
  const add = (row: PathRow) => {
    rows.push(row);
    if (!opened.has(row.id)) return;
    const ordered = [...tree.paths[row.index].references].sort((first, second) => tree.paths[second].closure_size - tree.paths[first].closure_size);
    ordered.forEach((child, position) => add({ id: `${row.id}/${child}`, parent_id: row.id, position, index: child }));
  };
  add({ id: "0", parent_id: null, position: 0, index: 0 });
  return rows;
}

// Which rows are open once the tree reports its folded rows; rows not shown keep how they were.
export function opened_after(opened: ReadonlySet<string>, shown: PathRow[], folded: ReadonlySet<string>, has_references: (row: PathRow) => boolean): Set<string> {
  const next = new Set(opened);
  for (const row of shown.filter(has_references)) {
    if (folded.has(row.id)) next.delete(row.id);
    else next.add(row.id);
  }
  return next;
}
