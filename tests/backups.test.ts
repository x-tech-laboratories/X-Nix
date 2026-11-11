import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { backup_naming } from "@x-tech-laboratories/x-libs/backups";
import { json_backup_schedule } from "@x-tech-laboratories/x-libs/server/backup_routes";
import { sqlite_backups, take_staged_restore } from "@x-tech-laboratories/x-libs/server/sqlite_backups";
import type { FastifyInstance } from "fastify";
import { afterEach, expect, it, vi } from "vitest";

import { build_app } from "../src/server/app.ts";
import { hash_password } from "../src/server/auth.ts";
import { Poller } from "../src/server/poller.ts";
import { Store } from "../src/server/store.ts";

let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
  vi.useRealTimers();
});

const accounts = new Map([["admin", hash_password("correct horse battery staple")], ["viewer", hash_password("another password")]]);

it("serves the state database's backups to admins and stages a restore for the next start", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-10T09:00:00Z"), toFake: ["Date"] });
  const folder = mkdtempSync(join(tmpdir(), "x-nix-backups-"));
  const path = join(folder, "x-nix.sqlite");
  const store = new Store(path);
  const after_staging = vi.fn();
  const backups = sqlite_backups({ folder: () => join(folder, "backups"), naming: backup_naming("x-nix", ".sqlite"), database: () => store.sql, database_path: () => path, after_staging });
  app = await build_app({
    serve_web: false, logger: false, server_name: "workstation", accounts, store, poller: new Poller([], null, [], [], [], []),
    backups: { backups, schedule: json_backup_schedule(join(folder, "backup-schedule.json")) },
  });
  const login = await app.inject({ method: "POST", url: "/api/login", payload: { name: "admin", password: "correct horse battery staple" } });
  const cookie = String(login.headers["set-cookie"]).split(";")[0];
  const inject = (method: "GET" | "POST", url: string) => app!.inject({ method, url, headers: { cookie } });

  const taken = (await inject("POST", "/api/backups")).json<{ name: string }>();
  expect((await inject("GET", "/api/backups")).json<{ name: string }[]>().map((backup) => backup.name)).toEqual([taken.name]);

  vi.setSystemTime(new Date("2026-11-10T10:00:00Z"));
  expect((await inject("POST", `/api/backups/${taken.name}/restore`)).statusCode).toBe(204);
  expect(after_staging).toHaveBeenCalled();
  await app.close();
  app = null;
  store.close();
  expect(take_staged_restore(path)).toBe(true);
});

it("refuses a restore to a signed-out caller", async () => {
  const folder = mkdtempSync(join(tmpdir(), "x-nix-backups-"));
  const store = new Store(join(folder, "x-nix.sqlite"));
  const backups = sqlite_backups({ folder: () => join(folder, "backups"), naming: backup_naming("x-nix", ".sqlite"), database: () => store.sql, database_path: () => join(folder, "x-nix.sqlite") });
  app = await build_app({
    serve_web: false, logger: false, accounts, store, poller: new Poller([], null, [], [], [], []),
    backups: { backups, schedule: json_backup_schedule(join(folder, "backup-schedule.json")) },
  });

  expect((await app.inject({ method: "POST", url: "/api/backups/x-nix-2026-11-10T09-00-00Z.sqlite/restore" })).statusCode).toBe(401);
});
