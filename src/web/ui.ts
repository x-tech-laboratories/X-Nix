// The building blocks every view shares: panels, facts, and the loading, empty and failed states.

import { h, nodes, type Child } from "./dom.ts";

// ── Layout ───────────────────────────────────────────────────────────────────

export function section(title: Child, body: Child, tools: Child = null): HTMLElement {
  return h("section", { class: "panel" },
    h("div", { class: "panel-head" }, h("h2", {}, title), tools && h("div", { class: "panel-tools" }, tools)),
    body);
}

// Labelled values in a grid of tiles, or as rows of label and value for long values such as store paths.
export function facts(rows: [label: string, value: Child, class_name?: string][], layout: "grid" | "rows" = "grid"): HTMLElement {
  return h("dl", { class: layout === "rows" ? "facts facts-rows" : "facts" }, ...rows.map(([label, value, class_name]) => h("div", {},
    h("dt", {}, label), h("dd", { class: class_name ?? null }, value ?? "—"),
  )));
}

// ── States ───────────────────────────────────────────────────────────────────

export function skeleton(lines = 3): HTMLElement {
  return h("div", { class: "skeleton", "aria-busy": "true", "aria-label": "Loading" },
    ...Array.from({ length: lines }, (_, index) => h("div", { class: "skeleton-line", style: `width: ${90 - index * 15}%` })));
}

export function empty(title: string, hint: Child = null): HTMLElement {
  return h("div", { class: "empty" }, h("p", { class: "empty-title" }, title), hint && h("p", { class: "muted" }, hint));
}

export function failure(error: unknown, retry: () => void): HTMLElement {
  return h("div", { class: "failure", role: "alert" },
    h("p", {}, `Could not load this: ${error instanceof Error ? error.message : String(error)}`),
    h("button", { onclick: retry }, "Retry"));
}

// Fills the target with what the work builds, showing a skeleton first and an error with Retry if it fails.
export async function load(target: HTMLElement, work: () => Promise<Child>): Promise<boolean> {
  target.replaceChildren(skeleton());
  try {
    target.replaceChildren(...nodes(await work()));
    return true;
  } catch (error) {
    target.replaceChildren(failure(error, () => void load(target, work)));
    return false;
  }
}
