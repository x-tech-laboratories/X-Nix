// Builds elements without innerHTML, so names from hosts and build logs are always shown as text.

export type Child = Node | string | number | null | undefined | false | Child[];

type Attributes = Record<string, string | number | boolean | EventListener | null | undefined>;

export function h<Tag extends keyof HTMLElementTagNameMap>(tag: Tag, attributes: Attributes = {}, ...children: Child[]): HTMLElementTagNameMap[Tag] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === null || value === undefined || value === false) continue;
    if (typeof value === "function") element.addEventListener(name.replace(/^on/, ""), value);
    else if (value === true) element.setAttribute(name, "");
    else element.setAttribute(name, String(value));
  }
  element.append(...nodes(children));
  return element;
}

// The nodes a child stands for, with lists flattened and the empty values dropped.
export function nodes(children: Child): (Node | string)[] {
  if (!Array.isArray(children)) children = [children];
  return children.flatMap((child): (Node | string)[] => {
    if (Array.isArray(child)) return nodes(child);
    if (child === null || child === undefined || child === false) return [];
    return [child instanceof Node ? child : String(child)];
  });
}

// ── Formatting ───────────────────────────────────────────────────────────────

export function age(epoch: number | null | undefined): string {
  if (!epoch) return "never";
  const seconds = Math.max(0, Date.now() / 1000 - epoch);
  if (seconds < 90) return `${Math.round(seconds)}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 129600) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

// How long until a time to come, such as "in 3d".
export function until(epoch: number): string {
  const seconds = Math.max(0, epoch - Date.now() / 1000);
  if (seconds < 90) return "now";
  if (seconds < 5400) return `in ${Math.round(seconds / 60)}m`;
  if (seconds < 129600) return `in ${Math.round(seconds / 3600)}h`;
  return `in ${Math.round(seconds / 86400)}d`;
}

// Sizes in binary units, such as "44.4 GiB".
export function bytes(count: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let value = count;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${Math.round(value)} B` : `${value.toFixed(1)} ${units[unit]}`;
}

export function stamp(epoch: number): string {
  return new Date(epoch * 1000).toLocaleString();
}
