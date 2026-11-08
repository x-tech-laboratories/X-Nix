// The closure browser: a system closure's dependency tree with each path's own size and closure size, and its largest
// paths, to find what makes a closure large.

import { Crumbs, PageHeading, Section, Stack, Tabs, Tile, Tiles } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Loaded, use_resource } from "@x-tech-laboratories/x-libs/web/react/states";
import { DataTable } from "@x-tech-laboratories/x-libs/web/react/table";
import { bytes } from "@x-tech-laboratories/x-libs/web/format";
import { link } from "@x-tech-laboratories/x-libs/web/router";
import { useState } from "react";
import { api, type ClosurePath, type ClosureTree, type Host } from "../api.ts";

// How many paths the largest-paths table lists.
const largest_count = 25;

type Choice = "current" | "target" | "generation";

// ── View ─────────────────────────────────────────────────────────────────────

// What the closure browser shows: the running closure, the flake's, or a generation's.
export function closure_title(generation: string | null, which: "current" | "target"): string {
  return generation !== null ? `Generation ${generation}` : which === "target" ? "The flake's closure" : "The running closure";
}

// The closure browser of the deployment a host runs.
export function ClosureView({ host_name, generation, which }: { host_name: string; generation: string | null; which: "current" | "target" }) {
  const closure = use_resource(async () => {
    const search = generation !== null ? `generation=${encodeURIComponent(generation)}` : `which=${which}`;
    const host = await api<Host>(`/api/hosts/${encodeURIComponent(host_name)}`);
    const deployment = host.deployments[0];
    if (deployment === undefined) throw new Error(`Nothing is deployed to ${host_name}`);
    const { tree } = await api<{ tree: ClosureTree }>(`/api/deployments/${encodeURIComponent(deployment.id)}/closure?${search}`);
    return tree;
  }, [host_name, generation, which]);

  const active: Choice = generation !== null ? "generation" : which;
  const choices: { id: Choice; label: string; href: string }[] = [
    { id: "current", label: "Running", href: link(["hosts", host_name, "closure"]) },
    { id: "target", label: "The flake's", href: link(["hosts", host_name, "closure"], { which: "target" }) },
  ];
  if (generation !== null) choices.push({ id: "generation", label: `Generation ${generation}`, href: link(["hosts", host_name, "closure"], { generation }) });

  return (
    <div className="page">
      <Crumbs items={[["Hosts", link(["hosts"])], [host_name, link(["hosts", host_name])], ["Closure", null]]} />
      <PageHeading title={closure_title(generation, which)} />
      <Tabs label="Closure" active={active} items={choices} />
      <Stack>
        <Loaded resource={closure}>{(tree) => <ClosureBody tree={tree} />}</Loaded>
      </Stack>
    </div>
  );
}

function ClosureBody({ tree }: { tree: ClosureTree }) {
  const root = tree.paths[0];
  const largest = [...tree.paths].sort((first, second) => second.nar_size - first.nar_size).slice(0, largest_count);
  return <>
    <Tiles>
      <Tile label="Paths" value={String(tree.paths.length)} />
      <Tile label="Closure size" value={bytes(root.closure_size)} />
      <Tile label="Own size" value={bytes(root.nar_size)} />
    </Tiles>
    <p className="muted small path">{tree.root}</p>
    <Section title="Dependency tree" tools={<span className="muted small">Each path's own size, then its closure size; children from the largest closure down.</span>}>
      <div className="tree"><TreeNode tree={tree} index={0} opened /></div>
    </Section>
    <Section title={`Largest ${largest.length} paths by own size`}>
      <DataTable<ClosurePath> caption="Largest paths" rows={largest} row_key={(path) => path.path} columns={[
        { label: "Path", cell: (path) => <code title={path.path}>{path_name(path.path)}</code> },
        { label: "Own", class: "number", cell: (path) => bytes(path.nar_size) },
        { label: "Closure", class: "number", cell: (path) => bytes(path.closure_size) },
        { label: "Share", class: "number", cell: (path) => `${((path.nar_size / Math.max(1, root.closure_size)) * 100).toFixed(1)}%` },
      ]} />
    </Section>
  </>;
}

// ── Tree ─────────────────────────────────────────────────────────────────────

// One path of the tree; its children are drawn the first time it is opened, as a closure repeats paths many times over.
function TreeNode({ tree, index, opened = false }: { tree: ClosureTree; index: number; opened?: boolean }) {
  const [drawn, set_drawn] = useState(opened);
  const path = tree.paths[index];
  const label = <>
    <span className="tree-name" title={path.path}>{path_name(path.path)}</span>
    <span className="muted small closure-sizes">{`${bytes(path.nar_size)} · ${bytes(path.closure_size)}`}</span>
  </>;
  if (path.references.length === 0) return <div className="tree-file">{label}</div>;
  const ordered = drawn ? [...path.references].sort((first, second) => tree.paths[second].closure_size - tree.paths[first].closure_size) : [];
  return (
    <details className="tree-folder" open={opened} onToggle={(event) => {
      if (event.currentTarget.open) set_drawn(true);
    }}>
      <summary>{label}<span className="muted small"> {path.references.length} references</span></summary>
      <div className="tree-children">{ordered.map((child) => <TreeNode key={child} tree={tree} index={child} />)}</div>
    </details>
  );
}

// A store path's name without its hash, such as `glibc-2.40`.
function path_name(path: string): string {
  const base = path.split("/").pop() ?? path;
  return /^[0-9a-z]{32}-/.test(base) ? base.slice(33) : base;
}
