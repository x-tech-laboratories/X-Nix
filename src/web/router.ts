// Reads and writes the hash route: a path such as #/deployments/odin, and a query holding a view's filters.

export interface Route {
  parts: string[];
  query: URLSearchParams;
}

export function current_route(): Route {
  const hash = location.hash.replace(/^#\/?/, "");
  const [path, search = ""] = hash.split("?", 2);
  return { parts: path.split("/").filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(search) };
}

// A link to a path built from parts, each one encoded, with an optional query.
export function link(parts: string[], values: Record<string, string | number | null | undefined> = {}): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    if (value !== null && value !== undefined && value !== "") params.set(name, String(value));
  }
  const search = params.toString();
  return `#/${parts.map(encodeURIComponent).join("/")}${search ? `?${search}` : ""}`;
}

// Changes the current route's query without a new history entry or a redraw, so typing in a filter keeps focus.
export function replace_query(changes: Record<string, string | number | null | undefined>): URLSearchParams {
  const route = current_route();
  for (const [name, value] of Object.entries(changes)) {
    if (value === null || value === undefined || value === "") route.query.delete(name);
    else route.query.set(name, String(value));
  }
  const search = route.query.toString();
  history.replaceState(null, "", `#/${route.parts.map(encodeURIComponent).join("/")}${search ? `?${search}` : ""}`);
  return route.query;
}
