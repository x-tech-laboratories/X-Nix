// The building blocks every view shares: panels, facts, badges, tables, toasts, dialogs, and the loading states.

import { LoginNeeded, type EventLevel, type JobState, type Status } from "./api.ts";
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
export async function load(target: HTMLElement, work: () => Promise<Child>, options: { quiet?: boolean } = {}): Promise<boolean> {
  if (!options.quiet) target.replaceChildren(skeleton());
  try {
    target.replaceChildren(...nodes(await work()));
    return true;
  } catch (error) {
    // A login is the page's to ask for.
    if (error instanceof LoginNeeded) throw error;
    // A quiet refresh keeps what is already shown.
    if (!options.quiet) target.replaceChildren(failure(error, () => void load(target, work)));
    return false;
  }
}

// ── Badges ───────────────────────────────────────────────────────────────────

const status_labels: Record<Status, [text: string, tone: string]> = {
  online: ["OK", "good"], info: ["OK", "good"], warning: ["Warning", "warn"], unavailable: ["Unreachable", "warn"], failed: ["Failed", "bad"],
};

export function status_badge(status: Status | null): HTMLElement {
  if (status === null) return h("span", { class: "badge tone-none" }, "Not read yet");
  const [text, tone] = status_labels[status];
  return h("span", { class: `badge tone-${tone}` }, text);
}

const job_tones: Record<JobState, string> = { running: "info", succeeded: "good", failed: "bad" };

export function job_badge(state: JobState): HTMLElement {
  return h("span", { class: `badge tone-${job_tones[state]}` }, state);
}

const level_tones: Record<EventLevel, string> = { info: "none", warning: "warn", error: "bad" };

export function level_badge(level: EventLevel): HTMLElement {
  return h("span", { class: `badge tone-${level_tones[level]}` }, level);
}

export function crumbs(items: [label: string, href: string | null][]): HTMLElement {
  return h("nav", { class: "crumbs", "aria-label": "Breadcrumb" }, ...items.flatMap(([label, href], index) => [
    index > 0 ? h("span", { class: "muted", "aria-hidden": "true" }, " / ") : null,
    href ? h("a", { href }, label) : h("span", { "aria-current": "page" }, label),
  ]));
}

// ── Tables ───────────────────────────────────────────────────────────────────

export interface Column<Row> {
  label: string;
  cell: (row: Row) => Child;
  class?: string;
}

// A table whose cells carry their column's label, so phones can show each row as a card.
export function data_table<Row>(columns: Column<Row>[], rows: Row[], caption: string): HTMLElement {
  return h("div", { class: "table-wrap" },
    h("table", { class: "responsive" },
      h("caption", { class: "visually-hidden" }, caption),
      h("thead", {}, h("tr", {}, ...columns.map((column) => h("th", { class: column.class ?? null, scope: "col" }, column.label)))),
      h("tbody", {}, ...rows.map((row) => h("tr", {}, ...columns.map((column) =>
        h("td", { class: column.class ?? null, "data-label": column.label }, column.cell(row)))))),
    ),
  );
}

// ── Toasts ───────────────────────────────────────────────────────────────────

export function toast(message: string, tone: "good" | "bad" | "info" = "info", link: { href: string; text: string } | null = null): void {
  const region = document.querySelector<HTMLElement>("#toasts")!;
  const close = () => item.remove();
  const item = h("div", { class: `toast tone-${tone}`, role: tone === "bad" ? "alert" : "status" },
    h("span", {}, message),
    link && h("a", { href: link.href, onclick: close }, link.text),
    h("button", { class: "icon", "aria-label": "Dismiss", onclick: close }, "×"));
  region.append(item);
  // An error stays until closed; anything else fades after a few seconds.
  if (tone !== "bad") setTimeout(close, 6000);
}

// ── Dialogs ──────────────────────────────────────────────────────────────────

// Asks before an action that cannot be undone, running it while the dialog stays open.
export function confirm_dialog(title: string, message: string, confirm_label: string, run: () => Promise<void>): void {
  const dialog = h("dialog", { class: "dialog", "aria-labelledby": "dialog-title" });
  const close = () => {
    dialog.close();
    dialog.remove();
  };
  const cancel = h("button", { onclick: close }, "Cancel");
  const confirm = h("button", { class: "danger solid" }, confirm_label);
  confirm.addEventListener("click", async () => {
    confirm.disabled = true;
    cancel.disabled = true;
    confirm.textContent = "Working…";
    try {
      await run();
    } finally {
      close();
    }
  });
  dialog.addEventListener("close", () => dialog.remove());
  dialog.append(h("h2", { id: "dialog-title" }, title), h("div", { class: "dialog-body" }, h("p", {}, message)), h("div", { class: "dialog-buttons" }, cancel, confirm));
  document.body.append(dialog);
  dialog.showModal();
  confirm.focus();
}
