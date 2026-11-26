---
title: Agent protocol
sidebar:
  order: 5
---

X-Nix's server and agents speak X-Libs' agent protocol over one WebSocket, which each agent dials to `/api/agent`.
X-Nix adds two things on top: the **task** every request carries is an `Operation` (plain data, never a command line),
and agents back from pull mode send **pull reports**. The app description is `x_nix_app` in
`src/shared/agent_protocol.ts`:

```ts
export const x_nix_app: AgentApp<Operation> = { name: "x-nix", protocol_version: 2, task_field: "operation", is_task: is_operation };
```

Raise `protocol_version` when an agent and a server of different versions could no longer understand each other.

## Logging in

1. The agent opens the WebSocket with its host's name in the `x-nix-agent-host` header.
2. The hub admits the upgrade only for a host with a key: declared in the config's `hosts[].agent_key`, or made by an
   install (`provisioned_agents`). Config keys win.
3. The server sends `challenge {nonce}`; the agent answers `hello {protocol, host, agent_version, runs, signature}`,
   signing the nonce with the host's ed25519 private key.
4. The hub checks the signature against the public key line. On success the agent joins the `AgentPool` under its host
   name; on failure the socket closes with one of X-Libs' `close_codes`.

The sequence is drawn in [Flows](/developer/flows/#agent-connection-and-login). The server's own host connects the same
way over `ws://127.0.0.1`, unless `localAgent` has the in-process `LocalAgent` serve it, which implements the same
`Agent` interface.

## Requests

After login the server sends requests and the agent answers each with `reply` or `failed`:

| Request  | Body                              | Answer          | Used for                                              |
| -------- | --------------------------------- | --------------- | ----------------------------------------------------- |
| `run`    | `operation`, `stdin`, timeout     | `RunResult`: exit code, stdout, stderr | Quick reads and signals, performed in the agent process (`agent/run.ts`). |
| `start`  | `run_id`, `operation`, `stdin`    | `LongRun`       | Anything slow: starts a runner process (`agent/runner.ts`). |
| `poll`   | `run_id`, `offset`                | `LongRunPoll`: state, exit code, new output from `offset`, next offset | Following a long run. |
| `stop`   | `run_id`                          | `LongRun`       | Stopping a long run.                                  |
| `forget` | `run_id`                          | nothing         | Removing a finished run's folder.                     |
| `runs`   | nothing                           | `LongRun[]`     | Listing what the agent has.                           |

A long run's state is `running`, `exited`, `stopped`, or `lost` (its process is gone without writing an exit status).
`stdin` is how secrets travel, such as a new host's private key for an install: the runner reads it from a pipe and it
is never written to the run's folder.

Both sides also exchange `ping` and `pong`, and X-Libs' stream messages (`stream`, `attach`, `credit`, `cancel`,
`stream_end`), which X-Nix does not use.

## Operations

Every operation is a JSON object with a `kind`; the types are in `src/shared/operations.ts` and the agent dispatches
on `kind` in `src/agent/operations/index.ts`. An operation names *what* to do; the agent decides how, and runs only
programs with argument vectors through `src/agent/programs.ts`.

### Wrappers

| Kind          | Wraps an operation to…                                                                   |
| ------------- | ---------------------------------------------------------------------------------------- |
| `kept_awake`  | Hold `systemd-inhibit --what=sleep` for as long as the inner operation runs.          |
| `timed`       | Stop the inner operation after a time limit, such as `eval_timeout`.                       |
| `nix_config`  | Run the inner operation with `NIX_CONFIG` including a file, for `access_tokens_file`.       |

`innermost()` unwraps them, which the server and tests use to see what an operation really does.

### Reads (requests that answer at once)

| Kind           | Answers                                                                    | Sent by            |
| -------------- | -------------------------------------------------------------------------- | ------------------ |
| `probe`        | `ProbeFields`: running and booted system, generation, version, boot parts. | Deployment cycle   |
| `store_probe`  | `GcFields`: filesystem, paths, roots, collection unit and timer, journal summary, profiles. | Host cycle |
| `boot_probe`   | `Boot`: loader, entries, default, next.                                    | Host cycle         |
| `generations`  | `Generation[]` of the system profile.                                      | Generations panel  |
| `products`     | A built path's Hydra build products.                                       | Build history      |
| `locate`       | A product's real path and size, checked to be inside its store path.      | Product download   |
| `piece`        | One base64 piece of a product file.                                        | Product download   |
| `derivations`  | Which planned paths each planned derivation needs, read from `.drv` files. | Live build tree    |
| `cache_holds`  | Whether a cache holds a store path.                                        | Switch from cache  |
| `closure_diff` | `nix store diff-closures`, closure sizes, and `nix-diff` when no package changed, between marker lines. | Switch preview |
| `remote_heads` | Where each Git remote's refs point, via `git ls-remote`.                   | Flake input check  |
| `programs`     | Runs a list of programs, stopping at the first failure.                    | Many: metadata, reboot, next boot, closure sizes, collection |
| `wake`         | Sends a magic packet with `wakeonlan`.                                     | Wake via another host |
| `confirm_switch`  | Touches the confirmation file in a guarded switch's watch folder.        | Guarded switch     |
| `signal_rollback` | Writes the rollback file with a reason.                                  | Guarded switch     |

### Jobs (long runs)

| Kind              | Does                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------- |
| `evaluate`        | `nix eval` of the toplevel and `nix flake metadata`, printed between `@@x-nix-eval` markers. Usually inside `timed`. |
| `build`           | `nix build` with `--log-format internal-json`, so the server can show live progress.    |
| `switch`          | Pre-switch checks, fetch, watchdog, activation, `post_switch`, health commands; `@@x-nix-switch` markers. See [Flows](/developer/flows/#a-guarded-switch). |
| `github_update`   | Clones a `github:` flake over SSH, updates its lock, checks it, commits and pushes.   |
| `local_update`    | Updates a local checkout's lock into a spare file, checks it, and copies it over the checkout's. |
| `cache_check`     | Evaluates and checks every cache target; `@@x-nix-cache` lines.                       |
| `cache_build`     | Builds one target, pushes it, checks it.                                              |
| `cache_push`      | Pushes one target, checks it.                                                         |
| `cache_build_all` | `nix-eval-jobs` over every target, builds and pushes each as it is ready, checks all. |
| `install`         | nixos-anywhere, with the agent key placed through `--extra-files`. With `host_key` it puts an `ssh` pinned to that key first on nixos-anywhere's PATH; without it, it runs only when `trust_unknown_host` is true. |
| `media`           | Builds an ISO, netboot files or a kexec tarball and links it under `media_root_dir`.  |

Collections, unchecked local flake updates and rollbacks are `programs` long runs.

### Marker lines

Long runs talk back to the server through lines in their output, which the parsers in `src/server/nixos/` read:

| Marker          | Written by         | Read by                       |
| --------------- | ------------------ | ----------------------------- |
| `@@x-nix-eval`  | `evaluate`         | `Deployment.fold_evaluation`  |
| `@@x-nix-switch`| `switch`           | `switch_verdict()`            |
| `@@x-nix-cache` | cache operations   | `parse_report()`              |
| `@@x-nix-diff`  | `closure_diff`     | `parse_diff()`                |
| `@@x-nix-stall` | the runner (`stalls.ts`), `close_nix_lock_holders` | `overdue.ts`, which names what an overdue job waits for |

## Pull reports

After its `hello`, an agent that switched on its own while the server was away sends
`pulls {pulls: PullReport[]}`. Each report names the run id, the Git remote, branch and revision, the operation, its
times, exit code and the end of its output. A report of a revision the agent refused, because it does not descend from
the deployed revision or lacks an allowed signature, also carries `refused`, the reason, and an empty operation. The
server records each switch as a job and each refusal as an error event on every deployment of that host
(`pull_reports.ts`) and answers `pulls_received {run_ids}`; the agent then drops those from `pull.json`. A server that
does not know `refused` records a refusal as a failed switch whose output is the reason.

## Adding an operation

1. Add its type to the `Operation` union in `src/shared/operations.ts`, and its `kind` to the list `is_operation`
   accepts.
2. Perform it in `src/agent/operations/`, running programs only through `programs.ts`, and add the `case` in
   `operations/index.ts`.
3. Build it on the server in the matching `src/server/nixos/` module, with a parser for what it prints.
4. Add a sudo rule in `nix/sudo-rules.nix` if it needs root, matching the narrowest command line that works.
5. Test the agent side (see `tests/reads.test.ts`, `tests/switch_operation.test.ts`) and the server side against
   `FakeAgent`.
6. Raise `protocol_version` if an older agent would misread it.
