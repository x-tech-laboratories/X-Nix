// What a build plans to build and fetch, as nix lists it before it starts, with how each went; and the tree of those
// paths, each under a derivation that needs it, as the job's page shows it.

// ── Shapes ───────────────────────────────────────────────────────────────────

export type PlannedState = "waiting" | "building" | "built" | "failed" | "dependency-failed" | "fetching" | "fetched" | "stopped";

export interface PlannedPath {
  kind: "build" | "fetch";
  name: string;
  state: PlannedState;
  // The build phase it is in, such as buildPhase, while it builds.
  phase: string | null;
  started_epoch: number | null;
  finished_epoch: number | null;
  // The planned paths it needs directly; null until they are read from the build's host, and empty for a fetch.
  needs: string[] | null;
}

// A row of the tree: one planned path, or the heading over fetched paths no planned derivation needs directly.
export interface PlanRow {
  path: string;
  name: string;
  planned: PlannedPath | null;
  // How many planned derivations need it directly; it shows under only one of them.
  needed_by: number;
  children: PlanRow[];
}

export const other_fetches_path = "other-fetches";

// ── Tree ─────────────────────────────────────────────────────────────────────

// The planned derivations nothing else planned needs, with what each needs beneath it. A path needed by several shows
// once, under the one nearest the top, and fetched paths no planned derivation needs directly, such as what a fetched
// path needs at run time, gather under a heading of their own.
export function plan_tree(planned: Record<string, PlannedPath>): PlanRow[] {
  const needed_by = new Map<string, number>();
  for (const entry of Object.values(planned)) {
    for (const need of entry.needs ?? []) if (planned[need] !== undefined) needed_by.set(need, (needed_by.get(need) ?? 0) + 1);
  }
  const row = (path: string): PlanRow => ({ path, name: planned[path].name, planned: planned[path], needed_by: needed_by.get(path) ?? 0, children: [] });
  const ordered = (paths: string[]) => paths.toSorted((first, second) => kind_order(planned[first]) - kind_order(planned[second]) || planned[first].name.localeCompare(planned[second].name));

  const placed = new Set<string>();
  const roots = ordered(Object.keys(planned).filter((path) => planned[path].kind === "build" && !needed_by.has(path))).map(row);
  for (const root of roots) placed.add(root.path);
  // Breadth first, so each path lands at its shallowest place.
  const queue = [...roots];
  for (let index = 0; index < queue.length; index += 1) {
    const next = queue[index];
    const children = ordered((next.planned!.needs ?? []).filter((path) => planned[path] !== undefined && !placed.has(path))).map(row);
    for (const child of children) placed.add(child.path);
    next.children = children;
    queue.push(...children);
  }

  const left = ordered(Object.keys(planned).filter((path) => !placed.has(path))).map(row);
  if (left.length === 0) return roots;
  if (roots.length === 0) return left;
  return [...roots, { path: other_fetches_path, name: "Other fetched paths", planned: null, needed_by: 0, children: left }];
}

function kind_order(entry: PlannedPath): number {
  return entry.kind === "build" ? 0 : 1;
}
