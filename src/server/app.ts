// ── Imports ──────────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import fastify, { type FastifyInstance } from "fastify";
import fastify_static from "@fastify/static";

// ── Settings ─────────────────────────────────────────────────────────────────

export interface app_options {
  serve_web: boolean;
  logger: boolean;
  // What the page calls this machine; the system's hostname unless set.
  server_name?: string;
}

export interface HealthAnswer {
  name: string;
  version: string;
  server_name: string;
  started_epoch: number;
}

const web_build_directory = fileURLToPath(new URL("../../dist", import.meta.url));
const package_file = fileURLToPath(new URL("../../package.json", import.meta.url));

// ── App ──────────────────────────────────────────────────────────────────────

export async function build_app(options: app_options): Promise<FastifyInstance> {
  const app = fastify({ logger: options.logger });
  const version = (JSON.parse(readFileSync(package_file, "utf8")) as { version: string }).version;
  const started_epoch = Math.floor(Date.now() / 1000);
  const server_name = options.server_name ?? hostname();

  app.get("/api/health", async (): Promise<HealthAnswer> => ({ name: "X-Nix", version, server_name, started_epoch }));

  // An API path the server does not know answers as JSON, never with the page.
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/") || !options.serve_web) return reply.code(404).send({ error: "Not found" });
    return reply.sendFile("index.html");
  });

  if (options.serve_web) {
    if (!existsSync(web_build_directory)) throw new Error(`The web page is not built; run npm run build to fill ${web_build_directory}`);
    await app.register(fastify_static, { root: web_build_directory });
  }

  return app;
}
