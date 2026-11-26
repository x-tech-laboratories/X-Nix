---
title: Development
sidebar:
  order: 7
---

## Setting up

```sh
nix develop                              # or nix-shell: Node 24 and the tools
npm install
npm run hash-password -- admin           # writes password.hash, which dev:server reads
npm run dev:server                       # the API on http://127.0.0.1:7720, against config.example.json
npm run dev:web                          # the page, reaching the API through Vite's proxy
```

`dev:server` runs `node --watch src/server/main.ts` with `X_NIX_CONFIG` defaulting to `config.example.json` and
`X_NIX_PASSWORD_HASH_FILE` to `password.hash`. State goes to `./state`. The example config names hosts with no agents,
so only the server's own machine reads as connected; the server's own host is read for real, so run it on a NixOS
machine to see readings.

| Script                  | Does                                                    |
| ----------------------- | ------------------------------------------------------- |
| `npm run dev:server`    | The server, restarting on change.                       |
| `npm run dev:web`       | Vite's dev server for the page.                         |
| `npm run build`         | `tsc -b` over every target, then `vite build` into `dist/`. |
| `npm start`             | The server in production mode, serving `dist/`.         |
| `npm test`              | `vitest run`.                                           |
| `npm run coverage`      | The tests with coverage; raises the floor in `vite.config.ts`, which only rises. |
| `npm run lint`          | `oxlint`.                                               |
| `npm run hash-password` | Adds a user to the password file.                       |

The agent runs from source with `node src/agent/main.ts` and `X_NIX_AGENT_URL`, `X_NIX_AGENT_KEY_FILE`,
`X_NIX_AGENT_HOST` and `X_NIX_AGENT_STATE_DIR` set.

## Tests

Tests are in `tests/`, one file per behaviour, run by Vitest. They never touch a real machine:

- `tests/fake_agent.ts` holds `FakeAgent`, a scripted `Agent` that answers each operation with what a test sets and
  keeps every long run until the test ends it, plus builders for probe, store, metadata and generation answers, a fixed
  `clock`, and `make_deployment()` / `make_host()` harnesses over an in-memory `Store`.
- Server tests drive an owner's `cycle()` and actions against `FakeAgent`, then check the store.
- Route tests build the app with `build_app()` and call it with `app.inject()`, signing in through `/api/login`.
- Agent tests run operations against fake programs (`tests/reads.test.ts`, `tests/switch_operation.test.ts`,
  `tests/waits.test.ts`, `tests/pull.test.ts`).

Run one file with `npx vitest run tests/deployment.test.ts`, or one test with `-t "<name>"`.

## CI

`.github/workflows/ci.yml` runs on every push to `main` and every pull request: `npm ci`, `npm audit signatures`,
`npm run build`, `npm run coverage`, a check that any raised coverage floor is committed, and `npm run lint`. `main`
changes only through pull requests with passing CI. Dependabot's X-Libs and Halon bumps merge on their own only when
npm's provenance shows they were built from our own repositories (`.github/scripts/check-provenance.mjs`).

`.github/workflows/pages.yml` builds this documentation site from `docs/` with the X-Libs site framework and publishes
it to GitHub Pages on every push to `main` that touches `docs/`.

## Packaging

`flake.nix` gives:

| Output                  | From                       |
| ----------------------- | -------------------------- |
| `packages.default`      | `nix/package.nix`: the server and the built page. |
| `packages.agent`        | `nix/agent-package.nix`: the agent alone.          |
| `nixosModules.default`  | `nix/module.nix`: `services.x-nix`.                |
| `nixosModules.agent`    | `nix/agent-module.nix`: `services.x-nix-agent`.    |
| `devShells.default`     | `shell.nix`.                                       |

Both packages use `buildNpmPackage` with `importNpmLock`, which reads `package-lock.json` directly, so there is no npm
dependency hash to keep up to date. Each wraps Node 24 around the TypeScript sources, which Node runs directly.

Both modules import `nix/sudo-rules.nix`, which lists every command X-Nix runs under `sudo -n`, and `nix/sudo-allow.nix`,
the `sudoAllow` options that drop groups of those rules. A new privileged command needs a rule there, as narrow as
works: an exact argument list where it is fixed, else a `^…$` regular expression in `nix/sudo-patterns.json`, which
`tests/sudo_rules.test.ts` checks against the command lines the code builds, so a change to one that the rule no longer
allows fails the tests.

## Code conventions

Follow the X-Tech [readable code guideline](https://x-tech-laboratories.github.io/guidelines/readable-code/) and the
style already in the code:

- `snake_case` names, written out in full: `timeout_in_seconds`, never `t` or `tmo`.
- Each file opens with one overview comment saying what it is, then sections under `// ── Name ──…` banners:
  Imports, Shapes, Settings, then the code.
- Comments are short, plain, one line, and say what the code does now.
- Anything that runs on a machine is an `Operation` performed by the agent; never build a shell string.
- Owners decide meaning; `Store` only stores.
- Reach for X-Libs and Halon before writing a widget, helper or server piece; a piece another app could use goes into
  X-Libs.

## How to add…

### A deployment action

1. Add its id to `ActionId` and `action_ids` in `deployment.ts`, with its refusal in `action_refusal()` and its job in
   `operation_for()`.
2. If it is a new job kind, add it to `JobKind` in `store.ts`.
3. The route `POST /api/deployments/:id/actions/:action` and its MCP tool take any id in `action_ids`; the page shows
   every action the view lists.
4. Test it in `tests/deployment.test.ts` against `FakeAgent`.

### A config setting

1. Add it to the settings interface in `config.ts`, with its default and its check in the matching `*_settings()`
   function.
2. Add it to `nix/module.nix` if the module needs to know about it; most settings pass through as JSON.
3. Document it in the user guide's table for that topic.

### A page or tab

1. Add a view under `src/web/views/`, built from X-Libs' layout, table, chart and dialog widgets.
2. Route to it in `page_for()` in `src/web/main.tsx`, and add it to the sidebar in `sidebar.tsx` if it is a section.
3. Read through `api.ts`; the view reloads on the change feed by itself.

### A metric

Add its name to `metric_names` in `store.ts`, record it with `store.add_sample()` from the owner's cycle, and chart it
in the view with X-Libs' charts.

## The documentation

This site lives in `docs/` and builds with the X-Libs site framework (`x-libs-site`), styled by Halon:

```sh
cd docs
npm install
npm run dev        # preview at the address it prints
npm run build      # into docs/dist
```

`docs/user/` is the user guide and `docs/developer/` this guide; each page's `sidebar.order` sets its place. Internal
and architectural detail belongs here, in the developer guide, never in the user guide. Screenshots live in
`docs/public/assets/screenshots/` and are referenced as `/assets/screenshots/<name>.png`.
