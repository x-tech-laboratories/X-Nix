// The closure browser: a system closure's dependency tree with each path's own size and closure size, and its largest
// paths, to find what makes a closure large.

import { api, type ClosurePath, type ClosureTree } from "../api.ts";
import { bytes, h } from "../dom.ts";
import { current_route, link } from "../router.ts";
import { crumbs, data_table, load, section } from "../ui.ts";
import { tile, type View } from "./shared.ts";

// How many paths the largest-paths table lists.
const largest_count = 25;

// ── View ─────────────────────────────────────────────────────────────────────

export function closure_view(id: string): View {
  const query = current_route().query;
  const generation = query.get("generation");
  const which = query.get("which") === "target" ? "target" : "current";
  const title = generation !== null ? `Generation ${generation}` : which === "target" ? "The flake's closure" : "The running closure";
  const body = h("div", { class: "stack" });

  void load(body, async () => {
    const search = generation !== null ? `generation=${encodeURIComponent(generation)}` : `which=${which}`;
    const { tree } = await api<{ tree: ClosureTree }>(`/api/deployments/${encodeURIComponent(id)}/closure?${search}`);
    const root = tree.paths[0];
    const largest = [...tree.paths].sort((first, second) => second.nar_size - first.nar_size).slice(0, largest_count);
    return [
      h("div", { class: "tiles" },
        tile("Paths", String(tree.paths.length)),
        tile("Closure size", bytes(root.closure_size)),
        tile("Own size", bytes(root.nar_size))),
      h("p", { class: "muted small path" }, tree.root),
      section("Dependency tree", h("div", { class: "tree" }, open_node(tree_node(tree, 0))),
        h("span", { class: "muted small" }, "Each path's own size, then its closure size; children from the largest closure down.")),
      section(`Largest ${largest.length} paths by own size`, data_table<ClosurePath>([
        { label: "Path", cell: (path) => h("code", { title: path.path }, path_name(path.path)) },
        { label: "Own", class: "number", cell: (path) => bytes(path.nar_size) },
        { label: "Closure", class: "number", cell: (path) => bytes(path.closure_size) },
        { label: "Share", class: "number", cell: (path) => `${((path.nar_size / Math.max(1, root.closure_size)) * 100).toFixed(1)}%` },
      ], largest, "Largest paths")),
    ];
  });

  const choice = (label: string, values: Record<string, string | null>, active: boolean) =>
    h("a", { class: active ? "tab active" : "tab", href: link(["deployments", id, "closure"], values), "aria-current": active ? "page" : null }, label);

  return {
    title: `${title} · ${id}`,
    root: h("div", { class: "page" },
      crumbs([["Deployments", link(["deployments"])], [id, link(["deployments", id])], ["Closure", null]]),
      h("h1", {}, title),
      h("nav", { class: "tabs", "aria-label": "Closure" },
        choice("Running", { which: null }, generation === null && which === "current"),
        choice("The flake's", { which: "target" }, generation === null && which === "target"),
        generation !== null && choice(`Generation ${generation}`, { generation }, true)),
      body,
    ),
  };
}

// ── Tree ─────────────────────────────────────────────────────────────────────

// One path of the tree; its children are drawn the first time it is opened, as a closure repeats paths many times over.
function tree_node(tree: ClosureTree, index: number): HTMLElement {
  const path = tree.paths[index];
  const label = [
    h("span", { class: "tree-name", title: path.path }, path_name(path.path)),
    h("span", { class: "muted small closure-sizes" }, `${bytes(path.nar_size)} · ${bytes(path.closure_size)}`),
  ];
  if (path.references.length === 0) return h("div", { class: "tree-file" }, ...label);
  const children = h("div", { class: "tree-children" });
  const node = h("details", { class: "tree-folder" }, h("summary", {}, ...label, h("span", { class: "muted small" }, ` ${path.references.length} references`)), children);
  node.addEventListener("toggle", () => {
    if (!node.open || children.childElementCount > 0) return;
    const ordered = [...path.references].sort((first, second) => tree.paths[second].closure_size - tree.paths[first].closure_size);
    children.append(...ordered.map((child) => tree_node(tree, child)));
  });
  return node;
}

// Opens the root at once, so its direct references show.
function open_node(node: HTMLElement): HTMLElement {
  if (node instanceof HTMLDetailsElement) node.open = true;
  return node;
}

// A store path's name without its hash, such as `glibc-2.40`.
function path_name(path: string): string {
  const base = path.split("/").pop() ?? path;
  return /^[0-9a-z]{32}-/.test(base) ? base.slice(33) : base;
}
