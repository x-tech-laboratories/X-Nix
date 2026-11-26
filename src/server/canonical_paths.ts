// Every request's path must be spelled canonically, so the sign-in guard, which reads the path as sent, and the router,
// which decodes it before matching, always see the same route. A path the router would read differently is refused
// with 400 before sign-in or any route sees it; the query string is left alone.

// ── Imports ──────────────────────────────────────────────────────────────────

import { send_error } from "@x-tech-laboratories/x-libs/server/replies";
import type { FastifyInstance } from "fastify";

// ── Settings ─────────────────────────────────────────────────────────────────

// Characters a path writes as themselves, so an escape of one is a second spelling of the same path.
const unreserved_character = /^[A-Za-z0-9\-._~]$/;

// Characters whose escape would read as a path separator or as another escape.
const separator_characters = new Set(["/", "\\", "%"]);

// One percent escape, spelled with upper-case hex digits.
const canonical_escape = /^%[0-9A-F]{2}$/;

// ── Checking ─────────────────────────────────────────────────────────────────

// Why a request target's path is not canonical, or null when it is.
export function path_refusal(url: string): string | null {
  if (!url.startsWith("/")) return "The path must start with /.";
  const query_start = url.indexOf("?");
  const path = query_start === -1 ? url : url.slice(0, query_start);
  if (path.includes("#") || path.includes(";") || path.includes("\\")) return "The path holds a character that must be escaped.";
  if (path.includes("//")) return "The path holds an empty segment.";
  if (path.split("/").some((segment) => segment === "." || segment === "..")) return "The path holds a dot segment.";
  for (let index = path.indexOf("%"); index !== -1; index = path.indexOf("%", index + 1)) {
    const escape = path.slice(index, index + 3);
    if (!canonical_escape.test(escape)) return "The path holds an escape that is not two upper-case hex digits.";
    const character = String.fromCharCode(Number.parseInt(escape.slice(1), 16));
    if (unreserved_character.test(character) || separator_characters.has(character)) return "The path escapes a character that needs no escaping.";
  }
  try {
    decodeURIComponent(path);
  } catch {
    return "The path holds an escape that is not UTF-8.";
  }
  return null;
}

// ── Registration ─────────────────────────────────────────────────────────────

// Refuses non-canonical paths ahead of every other hook, and refuses to start when the router would rewrite a canonical path.
export function register_canonical_paths(app: FastifyInstance): void {
  const { caseSensitive, ignoreTrailingSlash, ignoreDuplicateSlashes, useSemicolonDelimiter } = (app.initialConfig.routerOptions ?? {}) as Record<string, unknown>;
  if (caseSensitive === false || ignoreTrailingSlash === true || ignoreDuplicateSlashes === true || useSemicolonDelimiter === true) {
    throw new Error("The router must match paths as spelled: case-sensitive, without ignoring slashes or splitting on semicolons.");
  }
  app.addHook("onRequest", async (request, reply) => {
    const refusal = path_refusal(request.url);
    if (refusal !== null) return send_error(reply, 400, refusal, "json");
  });
}
