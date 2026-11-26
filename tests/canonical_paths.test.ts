import { describe, expect, it } from "vitest";
import fastify from "fastify";

import { path_refusal, register_canonical_paths } from "../src/server/canonical_paths.ts";
import { needed } from "../src/server/auth.ts";

// ── Checking ─────────────────────────────────────────────────────────────────

describe("path_refusal", () => {
  it.each([
    "/",
    "/api/hosts",
    "/api/hosts/host-1/actions/reboot",
    "/api/hosts/",
    "/assets/index-AbC_12.js",
    "/hosts/host.example",
    "/api/hosts/a%20b",
    "/api/hosts/%C3%A9t%C3%A9",
    "/api/hosts/a%3Fb",
    "/api/hosts?path=%2e%2e/%61&x=;y#z",
    "/api/provisioning/media/1/download?path=nixos.iso",
  ])("lets %s through", (url) => {
    expect(path_refusal(url)).toBeNull();
  });

  it.each([
    ["/%61pi/hosts", "needs no escaping"],
    ["/api/%68osts", "needs no escaping"],
    ["/api/builds/1/%70roducts/0", "needs no escaping"],
    ["/api/provisioning/media/1/%64ownload", "needs no escaping"],
    ["/api/hosts/%7E", "needs no escaping"],
    ["/api/hosts/%2E%2E", "needs no escaping"],
    ["/api%2Fhosts", "needs no escaping"],
    ["/api%5Chosts", "needs no escaping"],
    ["/%2561pi/hosts", "needs no escaping"],
    ["/api/hosts/a%3fb", "upper-case hex"],
    ["/api/hosts/a%2", "upper-case hex"],
    ["/api/hosts/a%zz", "upper-case hex"],
    ["/api/hosts/%C3", "not UTF-8"],
    ["//api/hosts", "empty segment"],
    ["/api//hosts", "empty segment"],
    ["/api;x/hosts", "must be escaped"],
    ["/api/hosts#x", "must be escaped"],
    ["/api\\hosts", "must be escaped"],
    ["/api/../api/hosts", "dot segment"],
    ["/api/./hosts", "dot segment"],
    ["/api/hosts/..", "dot segment"],
    ["http://localhost/api/hosts", "start with /"],
    ["*", "start with /"],
  ])("refuses %s", (url, reason) => {
    expect(path_refusal(url)).toContain(reason);
  });
});

describe("needed", () => {
  it.each([
    ["GET", "/api/hosts", "/api/hosts", "any"],
    ["GET", "/api/hosts/a b", "/api/hosts/:name", "any"],
    ["GET", "/api/hosts/a%2Fb", "/api/hosts/:name", "any"],
    ["POST", "/api/mcp", "/api/mcp", "any"],
    ["POST", "/api/hosts/host/refresh", "/api/hosts/:name/refresh", "admin"],
    ["GET", "/api/builds/1/products/0", "/api/builds/:id/products/:index", "admin"],
    ["HEAD", "/api/builds/1/products/0", "/api/builds/:id/products/:index", "admin"],
    ["GET", "/api/builds/1/products/0%2F", "/api/builds/:id/products/:index", "admin"],
    ["GET", "/api/provisioning/media/1/download", "/api/provisioning/media/:id/download", "admin"],
    ["GET", "/api/provisioning/media/a%2Fb/download", "/api/provisioning/media/:id/download", "admin"],
  ] as const)("asks %s %s, routed to %s, for %s", (method, path, route, role) => {
    expect(needed(method, path, route)).toEqual(role === "any" ? "any" : { role: "admin" });
  });

  it.each([
    ["GET", "/api/no-such-route", "any"],
    ["POST", "/api/no-such-route", "admin"],
    ["GET", "/api/builds/1/products/0", "admin"],
    ["GET", "/api/builds/1/products/0/", "admin"],
    ["GET", "/api/provisioning/media/1/download", "admin"],
    ["GET", "/api/builds/1/products%2F0", "admin"],
    ["GET", "/api/hosts/a%3Fb", "admin"],
  ] as const)("asks %s %s, which no route matched, for %s", (method, path, role) => {
    expect(needed(method, path, null)).toEqual(role === "any" ? "any" : { role: "admin" });
  });
});

// ── Registration ─────────────────────────────────────────────────────────────

describe("register_canonical_paths", () => {
  it("refuses with 400 as JSON before the route runs", async () => {
    const app = fastify();
    register_canonical_paths(app);
    let calls = 0;
    app.get("/api/hosts", async () => ({ calls: ++calls }));

    const refused = await app.inject({ method: "GET", url: "/%61pi/hosts" });
    const answered = await app.inject({ method: "GET", url: "/api/hosts?x=%61" });

    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toEqual({ error: "The path escapes a character that needs no escaping." });
    expect(answered.json()).toEqual({ calls: 1 });
    await app.close();
  });

  it.each([{ caseSensitive: false }, { ignoreTrailingSlash: true }, { ignoreDuplicateSlashes: true }, { useSemicolonDelimiter: true }])(
    "refuses to start with the router option %o",
    (options) => {
      expect(() => register_canonical_paths(fastify({ routerOptions: options }))).toThrow("must match paths as spelled");
    },
  );
});
