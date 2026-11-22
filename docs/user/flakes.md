---
title: Flakes
sidebar:
  order: 4
---

A flake under `flakes` is read and updated once for every deployment and cache that names it by its id in `flake`.
A deployment can also name a flake reference directly, such as `"flake": "github:you/config"`. That works for
evaluation, build and switch, but the flake gets no page and no Update.

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
  and pushed back over SSH. github.com's host key comes from the system's known hosts.

Before either writes or pushes the new lock, it is checked: every deployment naming the flake has its system evaluated
against it, and so does every target of a cache naming the flake. With `check_update` set to `build` they are built
instead, and with `none` the lock is written unchecked. A check that fails keeps the old lock, pushes nothing, and fails
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
X-Nix never reads the file: nix includes it through `NIX_CONFIG`, and `sudo` keeps that for a local checkout's update,
which the module's sudo rules allow. With sops-nix, a template renders it:

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
| `commit_author`        | `X-Nix <x-nix@localhost>`     | The update commit's author.                                |
| `commit_message`       | `chore(flake): update inputs` | The update commit's message.                               |
| `check_update`         | `evaluate`                    | What an update does to everything naming the flake before it writes the lock: `evaluate`, `build` or `none`. |
| `require_sudo`         | `true`                        | Update a local checkout under `sudo -n`.                   |
| `nix_bin`              | `nix`                         | The nix program.                                           |
| `nix_args`             | the experimental features     | Arguments before nix's subcommand.                         |
