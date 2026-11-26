---
title: Flakes
sidebar:
  order: 4
---

A flake under `flakes` is read and updated once for every deployment and cache that names it by its id in `flake`.
A deployment can also name a flake reference directly, such as `"flake": "github:you/config"`. That works for
evaluation, build and switch, but the flake gets no page and no Update.

## Upgrading

Defaults that changed, and the line that keeps the earlier behaviour:

- `check_update` is `build`, so an update lands only once every system naming the flake builds against the new lock,
  on the flake's own host. Keep the cheaper check with `"check_update": "evaluate"`.

![The Flakes page, with a flake's revision and its locked inputs](/assets/screenshots/flake.png)

## Reading

Every `interval` the flake's host reads `nix flake metadata`, and the Flakes page shows its revision, when it last
changed, and each locked input with its age. With `max_input_age`, the flake warns once its oldest input is older than
that.

## Update

Update moves every input of the lock to its newest revision, as `nix flake update` does, and runs as a job on the
flake's host:

- **A local checkout**, such as `/etc/nixos`, has its `flake.lock` written in place, under `sudo -n` when
  `require_sudo` is on.
- **A `github:` flake with a `push_ssh_key`** is cloned, updated, committed with `commit_author` and `commit_message`,
  and pushed back over SSH. github.com's host key comes from the system's known hosts. If the branch moved while the new
  lock was being checked, the update puts its lock on the branch's new tip and pushes again, up to three times, as long
  as the branch's own `flake.lock` is unchanged; a branch that changed its lock is left to the next update.

With `land_update` set to `pull_request`, a `github:` flake's update pushes its commit to the `x-nix/flake-update` branch
instead and opens a pull request from it to the branch the flake follows, so CI and a reviewer see the new lock before
deployments build it. There is only ever one: a later update replaces that branch and brings the open pull request up to
date, so commit nothing of your own there. Opening it takes the `github.com` token in `access_tokens_file`, which needs
permission to write pull requests and contents; the job's last line links the pull request.

Before either writes or pushes the new lock, it is checked: the system of every deployment naming the flake, and every
target of a cache naming the flake, is built against it, one after another on the flake's host, which takes as long as
the builds do and has no time limit of its own. A target that fails to build keeps the lock from landing; the others are
still built, so the job names every one that broke. With `check_update` set to `evaluate` they are only evaluated, and
with `none` the lock is written unchecked. A check that fails keeps the old lock, pushes nothing, and fails
the update with the attributes that broke. A deployment is checked once its host's name is known, which its first read
supplies when it sets no `configuration`.

Any other flake cannot be updated by X-Nix, and the page says so. Once an update ends well, every deployment and cache
naming the flake evaluates afresh, so drift shows at once.

Update runs when you press it, daily at `update_at`, when an input check finds an input moved, and on a push to an
input's repository through the [push webhook](/user/integrations/#push-webhook).

## Input checks

Every `input_check_interval` the flake's host runs `git ls-remote` against each watched input's remote, asking only where
its branch or tag points. That uses Git's own protocol, not a forge's API, so it costs nothing against GitHub's API
rate limit. Once an input's remote points past its locked revision, Update starts at once. An update that fails is not
retried for the same upstream commit.

Watched: `github:`, `gitlab:`, `sourcehut:`, and `git+https://` or `git+ssh://` inputs. Not watched: `follows`, `path:`,
tarball, registry (`nixpkgs` without a scheme) and commit-pinned inputs.

`watch_inputs` names the inputs to watch, all of them by default. A channel such as `nixos-unstable` moves several times
a day, and each move is an update and a commit; leave it out of `watch_inputs` to move it only with `update_at`. Set
`input_check_interval` to `null` to never check.

## Access tokens

Updating a `github:` input asks GitHub's API, which allows 60 calls an hour per address without a token.
`access_tokens_file` names a file in nix.conf syntax on the flake's host, such as `access-tokens = github.com=<token>`.
nix includes it through `NIX_CONFIG`, and `sudo` keeps that for a local checkout's update, which the module's sudo rules
allow. X-Nix itself reads it only with `land_update` set to `pull_request`, taking the `github.com` token to open the
update's pull request, and never prints it. With sops-nix, a template renders it:

```nix
sops.templates."nix-access-tokens".content = "access-tokens = github.com=${config.sops.placeholder.github-token}";
# The user that runs on the flake's host: x-nix-agent, or x-nix on the server's own host with localAgent on.
sops.templates."nix-access-tokens".owner = "x-nix-agent";
services.x-nix.flakes.fleet.access_tokens_file = config.sops.templates."nix-access-tokens".path;
```

## Settings

| Setting                | Default                       | Meaning                                                    |
| ---------------------- | ----------------------------- | ---------------------------------------------------------- |
| `id`                   | required                      | Letters, digits, `-` and `_`, unique among flakes, deployments and caches. |
| `name`                 | the id                        | What the page calls it.                                    |
| `url`                  | required                      | The flake reference, such as `github:owner/config` or `/etc/nixos`. |
| `host`                 | the server's own host         | The host that reads and updates it; a local checkout's own host. |
| `interval`             | `1h`                          | How often its metadata is read.                            |
| `timeout`              | `2m`                          | How long one read may take.                                |
| `job_poll`             | `30s`                         | How often a running update is read.                        |
| `max_input_age`        | none                          | Warn once the oldest locked input is older than this.      |
| `update_at`            | none                          | Update daily at this local time, such as `02:00`.          |
| `input_check_interval` | `1m`                          | How often each watched input's remote is asked whether it moved; `null` never asks. |
| `watch_inputs`         | every input                   | The inputs that the check and the push webhook watch, by name. |
| `access_tokens_file`   | none                          | A nix.conf file on the flake's host holding `access-tokens`. |
| `push_ssh_key`         | none                          | The key a `github:` flake's update pushes with.            |
| `commit_signing_key`   | none                          | An SSH private key file a `github:` flake's update commit is signed with, so an agent's pull mode with `allowedSignersFile` can deploy it. |
| `commit_author`        | `X-Nix <x-nix@localhost>`     | The update commit's author.                                |
| `commit_message`       | `chore(flake): update inputs` | The update commit's message.                               |
| `check_update`         | `build`                       | What an update does to everything naming the flake before it writes the lock: `evaluate`, `build` or `none`. |
| `land_update`          | `push`                        | How a `github:` flake's update lands: `push` to its branch, or `pull_request`, which needs `access_tokens_file`. |
| `require_sudo`         | `true`                        | Update a local checkout under `sudo -n`.                   |
| `nix_bin`              | `nix`                         | The nix program.                                           |
| `nix_args`             | the experimental features     | Arguments before nix's subcommand.                         |
