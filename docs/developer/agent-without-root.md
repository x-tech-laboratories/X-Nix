---
title: Running the agent without root
sidebar:
  order: 9
---

The agent's user, `x-nix-agent`, is root-equivalent through its NOPASSWD sudo rules. This page sets out how X-Nix takes
that away in stages, so that a compromised server can at worst ask a host to switch to a system its operator built and
signed. Stages 1 and 2 are built; stages 3 to 5 are designs.

## Threat model

| Attacker | Today | Goal |
| --- | --- | --- |
| **Network attacker** between server and agent | Stopped: TLS, and with `serverPublicKeys` every server message is signed and bound to its connection. | Unchanged. |
| **Compromised server** (its process, its config or its key) | Root on every host: `nixos-rebuild switch --flake <any>`, `switch-to-configuration` of any system in the store, and `/bin/sh -c` on hosts that still take `post_switch` text. | Can only start, stop and roll back switches to closures the operator signed, run the host's own declared commands by name, and read what the agent reports. |
| **Compromised agent user** (a bug in the agent, or code running as `x-nix-agent`) | Root, through the same rules. | Same as a compromised server: no root without a closure the operator signed. |

Out of scope: the operator's signing key and Git signing keys, the binary cache's own integrity beyond its signatures,
and anything already root on a host.

## Stage 1: only the rules a host uses (built)

The module adds a group of rules only when the host's own config shows it is needed, or when the operator turns it on:
boot loader tools for the host's loader alone; `ssh` (`targetHost`) and `nix … flake update` with `cp` (`flakeUpdates`)
off by default; `sleepInhibitors` its own group. The off groups are written to `X_NIX_AGENT_SUDO_FILE`, and a step
needing one fails at once, naming the option.

Removes: the other loaders' tools, both `ssh` rules, both `nix flake update` rules and the lock copy.

## Stage 2: the host's own commands (built)

`services.x-nix-agent.switchCommands` declares pre-switch checks, health commands and post-switch commands by name; the
server's `host_*` settings only name them. Post-switch commands are store scripts allowed by exact path. The host's
declarations live in `/etc/x-nix-agent/host.json`, read afresh, so a switch that changes them runs the new system's own
after activation. Garbage collection starts the fixed `x-nix-gc.service`, with the host's own arguments; the
`nix-collect-garbage` rule narrows to exactly those arguments for a server too old to start the unit.

Removes: `/bin/sh -c *` on every host that declares its commands, and `nix-collect-garbage` with any arguments.

Migration: the text settings keep working, with a warning, until a host declares; a declaring host ignores text and, if
given text without names, runs all its declared commands of that kind, so either side can deploy first.

## Stage 3: typed operations

`programs` takes argv the server built. Replace each privileged use with an operation that names what it wants, and have
the agent build and check the command line:

- `reboot`, `next_boot { entry }` (checked against the entries the agent itself read), `rollback { generation }`
  (checked against the profile's generations), `collect_garbage`, `stop_lock_holders`, `inhibit { why }`.
- `switch` carries `{ mode, store_path | flake_ref }` instead of `steps`; the agent builds `nix build`, `nix-env --set`
  and `switch-to-configuration` itself, refusing a store path that is not a NixOS system or a flake ref with options.
- `programs` stays for unprivileged reads; the agent refuses any `sudo` in it.

Removes nothing from sudo by itself, but makes every privileged argument one the agent checked, so stage 4's helper has
a small, fixed interface. Migration: the server sends typed operations to agents whose version announces them (a new
app message after hello), and `programs` to older ones.

## Stage 4: a root activation helper

A small root service, `x-nix-activate`, socket-activated and reached over a Unix socket that only `x-nix-agent` may open
(or a polkit action on a systemd unit), takes `{ action, store_path, mode }` and:

1. checks that the closure is signed by a key in the host's `activation.trustedKeys` (`nix path-info --sigs`, every path
   of the closure), or was built from a flake in `activation.allowedFlakes` at a commit signed by an allowed signer, as
   pull mode already checks;
2. sets the system profile and runs `switch-to-configuration`, or a rollback to an existing generation, a one-shot boot
   entry, a reboot, a collection, or stopping lock holders;
3. logs every request and refusal to the journal.

Removes: `nixos-rebuild <mode> --flake *`, `/nix/store/*-nixos-system-*/bin/switch-to-configuration *`, `nix-env --set`
and `--switch-generation`, `kill`, `bootctl`/`grub-reboot`/`efibootmgr`, `systemctl reboot` and `systemctl start
x-nix-gc.service`. What is left for `x-nix-agent`: starting and stopping its own run units, which run as itself, and
`systemd-inhibit`. Builds with `nixos-rebuild` move to `nix build` as the agent's user, and activation goes through the
helper.

Migration: the module installs the helper beside the rules; `activation.enforce = true` drops the rules. Hosts that
switch from a flake rather than a cache need `allowedFlakes` and signed commits first.

## Stage 5: pull-only mode

With `pull.only = true` the agent never accepts a switch from the server: it reads the deployed revision from Git as pull
mode does today, verifies the commit signature, builds or fetches, and activates through the helper. The server keeps
reads, history and health, and can only ask the agent to check for a new revision now. A compromised server can then do
nothing to a host's system at all.

## Open questions

- Stage 3: is a hello capability list the right way to tell typed-operation agents apart, and should it go into X-Libs'
  agent protocol so other X-apps can use it?
- Stage 4: one signing key per fleet or per host, and how does a key rotate without locking every host out? Is checking
  every path's signature fast enough on the phone, or is the toplevel's signature plus the daemon's own substituter
  checks enough?
- Stage 4: Unix socket with peer credentials, or polkit on a templated unit? polkit is heavier but already on desktops.
- Stage 4: how do `target_host` deployments fit, given the helper is local? Likely they are dropped in favour of an
  agent on every host.
- Stage 2 leftovers: `push_command` and `wake_on_lan.screen_off` still run server-sent text as the agent's user (not
  root); should they move into the host's config too?
- Install and media builds on the build host run `nixos-anywhere` and `nix build` as the agent's user; those need no
  root but trust the server's flake choice, already limited to configured flakes.
