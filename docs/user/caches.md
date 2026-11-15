---
title: Caches
sidebar:
  order: 8
---

A cache is a machine that builds the fleet's systems ahead of time and pushes them to an Attic binary cache, so every
other machine fetches its system instead of building it. X-Nix tells you, per target, whether it is built from the
flake's latest revision and fully pushed.

![A cache's page, with its targets and the cache server's health](/assets/screenshots/cache.png)

## The check

Every `interval` the cache's host runs one check: it evaluates every tracked target from the flake, sees whether that
store path is built, and asks the cache which of the closure's own paths it lacks, leaving out paths an upstream cache
such as cache.nixos.org signed, which Attic never stores. The previous reading stands until the check ends.

Each target is:

- **built and pushed**, when the cache holds its whole closure;
- **pending** (`pending_status`, a warning by default), when it is not built yet or not fully pushed, with up to
  `missing_limit` missing paths listed;
- **failed**, when its evaluation fails.

With `retry_push`, after each check X-Nix pushes again the first target built here whose closure the cache still lacks
paths of, so a failed upload is retried every `interval`.

## Build, Push and Build all

Each target can be built or pushed by hand; the job checks that target again once it ends. Pushing a target not built
from the latest flake builds it instead, and the build pushes it.

**Build all** builds every target in one job, the way nix-fast-build does: `nix-eval-jobs` evaluates all of them in one
parallel pass, each target's build starts as soon as its own evaluation ends, and with a `push_command` each is pushed
once built. It ends by checking every target, and the cache's page lists how each one ended and how long its build took.
With `build_at`, Build all runs daily in place of that cycle's check. The modules put `nix-eval-jobs` on the PATH; a
host without it fails the job with a message saying so.

## Deployments built by a cache

A deployment naming a cache in `cache` is built by it: the deployment's Build runs the cache's build of its
configuration on the cache's hosts, at the deployment's pin, and a switch built there fetches from the cache's
`cache_url`.

Such a deployment is also evaluated by the cache: its target, the flake's revision and when the flake last changed come
from the cache's last check of its configuration, so the whole fleet is evaluated once per check. Check now, a push and
a fleet run's sync ask the cache to check at once. A pinned deployment evaluates on its own, as its pin is not what the
cache builds.

## Keeping the store small

With `build_root_dir`, each build is linked there, so it stays out of garbage collection until the next replaces it.
Targets in `drop_pushed` are kept only in the cache: once fully pushed, the link is removed and the closure's path list
kept beside it as `<link>.closure`, so the store can be collected and later checks still know the target.

## The cache server

Every cycle the X-Nix server also fetches the cache server's own `info_url`, `health_url` and `metrics_url`, and the page
shows what they answered with a status of their own: the store directory and priority, whether it reports itself
healthy, its size from `size_metric`, and every metric ending in `_bytes`. A cache that needs a token to read is not
read with one, so it shows the status it answered with.

## Settings

| Setting          | Default                           | Meaning                                                                 |
| ---------------- | --------------------------------- | ----------------------------------------------------------------------- |
| `id`             | required                          | Letters, digits, `-` and `_`; shares one space with deployments and flakes. |
| `name`           | the id                            | What the page calls it.                                                 |
| `host`           | the server's own host             | The host that evaluates, builds and pushes, or a list of them most preferred first. |
| `flake`          | `/etc/nixos`                      | The flake's id, or a flake reference.                                   |
| `configurations` | none                              | `nixosConfigurations` names, tracked by their system toplevel.          |
| `installables`   | none                              | Any other derivation, as a name and its flake attribute.                |
| `cache_url`      | required                          | The cache, as `nix path-info --store` takes it.                         |
| `upstream_keys`  | `cache.nixos.org-1`               | Signing keys of upstream caches, whose paths Attic never stores.        |
| `missing_limit`  | `50`                              | How many missing paths each target lists.                               |
| `pending_status` | `warning`                         | The status of a target not built, or not fully pushed.                  |
| `interval`       | `1h`                              | How often the check runs.                                               |
| `job_poll`       | `30s`                             | How often a running job is read.                                        |
| `timeout`        | `30m`                             | How long a check may run.                                               |
| `nix_bin`        | `nix`                             | The nix program.                                                        |
| `nix_args`       | flakes enabled                    | Arguments before every nix command.                                     |
| `build_args`     | `--keep-going --print-build-logs` | Arguments for Build.                                                    |
| `build_progress` | `true`                            | Show what builds and downloads as Build and Build all run.              |
| `build_root_dir` | none                              | Link each build here, so it stays rooted until the next replaces it.    |
| `build_links`    | `<cache id>-<target>`             | Each target's link name under `build_root_dir`.                         |
| `build_at`       | none                              | Run Build all daily at this local time, such as `04:00`.                |
| `push_command`   | none                              | Run with a store path appended to push it; Build also pushes with it.   |
| `retry_push`     | `true`                            | Push again a target whose closure the cache still lacks paths of.       |
| `drop_pushed`    | none                              | Targets kept only in the cache once fully pushed.                       |
| `eval_jobs_bin`  | `nix-eval-jobs`                   | The program Build all evaluates every target with.                      |
| `eval_workers`   | `4`                               | How many targets Build all evaluates at once.                           |
| `info_url`       | `<cache_url>/nix-cache-info` for an http cache | The cache server's nix-cache-info, or `false` to not read it. |
| `health_url`     | none                              | The cache server's health check; any 2xx answer is healthy.             |
| `metrics_url`    | none                              | The cache server's Prometheus metrics, such as `/metrics`.              |
| `size_metric`    | none                              | The metric whose samples add up to the cache's size in bytes.           |
| `server_status`  | `warning`                         | The status an unreachable or unhealthy cache server raises.             |
