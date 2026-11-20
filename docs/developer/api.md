---
title: HTTP API
sidebar:
  order: 6
---

Every route lives in `src/server/app.ts`, except the sign-in, account, user and backup routes, which X-Libs registers.
Answers are JSON. Errors answer `{ message }` with a 4xx or 5xx status through X-Libs' `register_error_replies`.

## Who may call what

`auth.ts` decides, for every route under `/api`:

| Request                                              | Needs                                            |
| ---------------------------------------------------- | ------------------------------------------------ |
| `GET /api/health`, the agent socket `/api/agent`, `POST /api/webhook` | Nothing (the agent proves its key; the webhook its signature). |
| Any other `GET`                                      | A session or a token: any signed-in user.         |
| `/api/mcp`                                           | Any signed-in user; each tool then runs its route as that user. |
| Any other method                                     | An `admin` session or a non-read-only admin token. |
| Account and user routes                              | A session; X-Libs refuses tokens there.           |

A token is sent as `Authorization: Bearer xn_…`. A read-only token can only make `GET` requests.

## Routes

### Server

| Method & path              | Does                                                       |
| -------------------------- | ---------------------------------------------------------- |
| `GET /api/health`          | `{ name, version, server_name, started_epoch }`.           |
| `GET /api/agents`          | Each host with a key and its agent's status when connected. |
| `GET /api/events`          | Server-sent events: one `change` whenever the store is written or an agent connects or drops, at most once a second. |

### Hosts

| Method & path                             | Does                                                     |
| ----------------------------------------- | -------------------------------------------------------- |
| `GET /api/hosts`                          | Every host's view: status, store, boot, agent, deployment. |
| `GET /api/hosts/:name`                    | One host.                                                |
| `POST /api/hosts/:name/refresh`           | Runs the host's cycle now.                               |
| `POST /api/hosts/:name/actions/:action`   | `collect` or `reboot`.                                   |
| `POST /api/hosts/:name/next-boot`         | `{ entry, reboot? }`: sets the one-shot next boot.       |
| `GET /api/hosts/:name/events`             | The host's events.                                       |
| `GET /api/hosts/:name/runs`               | The agent's long runs, each with the job following it.  |
| `POST /api/hosts/:name/runs/:run_id/:action` | `stop` ends a run (as its job's stop when one follows it); `forget` removes an ended one. |

### Flakes

| Method & path                     | Does                                     |
| --------------------------------- | ---------------------------------------- |
| `GET /api/flakes`                 | Every flake with its reading, users and last update. |
| `GET /api/flakes/:id`             | One flake.                               |
| `POST /api/flakes/:id/refresh`    | Reads the flake now.                     |
| `POST /api/flakes/:id/update`     | Starts Update.                           |
| `GET /api/flakes/:id/events`      | The flake's events.                      |

### Deployments

| Method & path                                  | Does                                                            |
| ---------------------------------------------- | --------------------------------------------------------------- |
| `GET /api/deployments`                         | Every deployment's view: settings, reading, evaluation, running job, actions with refusals. |
| `GET /api/deployments/:id`                     | One deployment.                                                 |
| `POST /api/deployments/:id/refresh`            | Runs the cycle now with a forced evaluation.                    |
| `POST /api/deployments/:id/actions/:action`    | `build`, `switch`, `boot`, `test`, `dry-activate` or `reboot`.  |
| `POST /api/deployments/:id/pin`                | `{ pin }` to pin, `{ pin: null }` to follow the head, `{ reset: true }` for the settings' pin. |
| `POST /api/deployments/:id/diff`               | `{ force? }`: compares the running and target closures.         |
| `GET /api/deployments/:id/generations`         | The system profile's generations.                               |
| `GET /api/deployments/:id/generations/sizes`   | Each generation's closure size.                                 |
| `POST /api/deployments/:id/rollback`           | `{ generation, reason }`.                                       |
| `GET /api/deployments/:id/closure`             | `?which=current|target` or `?generation=n`: the closure graph.  |
| `GET /api/deployments/:id/events`              | The deployment's events.                                        |

### Fleet

| Method & path                     | Does                                                         |
| --------------------------------- | ------------------------------------------------------------ |
| `GET /api/fleet`                  | Settings, tags and recent runs.                              |
| `GET /api/fleet/select`           | `?selector=`: the deployment ids a selector picks.           |
| `POST /api/fleet/runs`            | `{ action, selector or ids, staged?, stages?, parallel? }`: starts a run. |
| `GET /api/fleet/runs/:id`         | One run.                                                     |
| `POST /api/fleet/runs/:id/stop`   | Stops a run after its running hosts.                         |

### Caches

| Method & path                                  | Does                                       |
| ---------------------------------------------- | ------------------------------------------ |
| `GET /api/caches`                              | Every cache with its reading and server reading. |
| `GET /api/caches/:id`                          | One cache.                                 |
| `POST /api/caches/:id/refresh`                 | Checks now.                                |
| `POST /api/caches/:id/build-all`               | Starts Build all.                          |
| `POST /api/caches/:id/targets/:name/:action`   | `build` or `push` one target.              |
| `GET /api/caches/:id/events`                   | The cache's events.                        |

### Provisioning

Registered only when the server has a provisioner.

| Method & path                                    | Does                                          |
| ------------------------------------------------ | --------------------------------------------- |
| `GET /api/provisioning`                          | Settings, installs, made keys, media.         |
| `POST /api/provisioning/install`                 | Starts an install (page only; not an MCP tool). |
| `POST /api/provisioning/media`                   | `{ deployment or flake + configuration, format }`. |
| `GET /api/provisioning/media/:id/download`       | `?path=`: a file from inside the built medium. |
| `POST /api/provisioning/media/:id/remove`        | Removes a medium's root.                      |
| `POST /api/provisioning/agents/:host/forget`     | Forgets a key X-Nix made.                     |

### Jobs, samples and builds

| Method & path                            | Does                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| `GET /api/jobs`                          | `?deployment=&kind=&evaluations=1&since=&limit=`: jobs without output.   |
| `GET /api/jobs/:id`                      | One job with its output.                                                 |
| `POST /api/jobs/:id/stop`                | Ends a running job's run on its agent; the job fails as stopped.         |
| `GET /api/samples`                       | `?owner=&metrics=a,b&since=`: chart readings.                            |
| `GET /api/builds`                        | `?owner=&target=&limit=`: build history and the targets that have one.   |
| `GET /api/builds/:id/products/:index`    | Downloads a product file in pieces through the agent that built it.      |

### From X-Libs

| Prefix           | Routes                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------- |
| `/api/login`, `/api/logout`, `/api/me` | Signing in and out, and who is signed in.                              |
| `/api/account/…` | Password, second factor, sessions and tokens of the signed-in user.                           |
| `/api/users/…`   | Adding, changing and removing users (admins).                                                 |
| `/api/backups/…` | Listing, making, restoring and deleting backups, and the schedule.                            |
| `/api/agent`     | The agents' WebSocket.                                                                        |
| `/api/mcp`       | MCP over streamable HTTP.                                                                     |

## The change feed

The page opens `/api/events` once signed in. The server announces a change after any `Store` write, and when an agent
connects or drops, at most once a second, since a running build writes many times a second. The page then reloads what
the current view shows. There is no payload to apply: views always read from the routes above.

## MCP

`src/server/mcp.ts` lists each tool as a route with a description and parameter schemas (`routes`), and X-Libs'
`register_mcp` turns them into MCP tools. A tool call is injected into the app as a request carrying the caller's own
`Authorization`, so authorisation is exactly the route's. There are 50 tools, named by what they do: `list_hosts`,
`get_deployment`, `run_deployment_action`, `start_fleet_run`, `roll_back_deployment`, `build_media`, `back_up_now`, and
so on.

Left out on purpose: `POST /api/provisioning/install` (it wipes disks), file downloads, and the account and user
routes.

To add a route: add it in `app.ts`, then add a tool entry in `mcp.ts`'s `routes` with its parameters, unless it is one
of the kinds left out above, and cover it in `tests/mcp.test.ts`.

The Application Standard asks every app to serve `/api/openapi.json`. X-Nix does not yet; the `routes` table in
`mcp.ts` is its machine-readable list of calls.
