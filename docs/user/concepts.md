---
title: Concepts
sidebar:
  order: 1
---

X-Nix describes your machines with four kinds of thing, which you write in its config file, and records what happens to
them as jobs and events.

## The four things you declare

**Host.** A machine. A host has a name, which is the name its agent logs in as, and holds what is true of the machine
whatever runs on it: its Nix store, its boot entries, how it is woken and kept awake. The machine the X-Nix server runs
on is a host too, called by the server's name. A host that a deployment names needs no entry of its own.

**Flake.** A flake X-Nix reads and updates, such as `github:you/nixos-config` or `/etc/nixos`. One flake can describe
many machines; X-Nix reads it once and updates it once for all of them.

**Deployment.** One NixOS configuration on one host: the host, the flake, and the `nixosConfigurations` attribute to
build. A host runs one deployment. This is what X-Nix compares, builds and switches.

**Cache.** A machine that builds the fleet's systems ahead of time and pushes them to an Attic binary cache, so other
machines fetch instead of building.

Deployments, flakes and caches share one set of ids, so no two of them may have the same id. Hosts have their own.

## What X-Nix records

**Job.** Anything X-Nix runs on a machine that takes time: an evaluation, a build, a switch, a garbage collection, a
flake update, an install. A job keeps its whole output, what started it (the signed-in user, marked when they used a token,
a schedule, an automatic switch, a push, a fleet run), and how it ended. Long jobs keep running if the X-Nix server restarts, and the page picks them up
again.

**Event.** A line in a deployment's, host's, flake's or cache's history: its status changed, a switch was rolled back, a
job ran overdue.

**Build.** One target a build job built, with its store path and the files it made, kept in the build history.

**Fleet run.** One action on many deployments at once.

## Statuses

Every host, flake, deployment and cache has a status, the worst of everything its last reading found:

| Status        | Means                                                                     |
| ------------- | ------------------------------------------------------------------------- |
| `online`      | All is well.                                                              |
| `info`        | Something worth knowing, nothing wrong.                                   |
| `unavailable` | X-Nix could not find out, such as when the host's agent is not connected. |
| `warning`     | Something needs attention soon, such as drift or a store filling up.      |
| `failed`      | Something is broken, such as an evaluation that fails.                    |

Several settings let you choose which status a finding raises, such as `drift_status` and `reboot_status`.

## Drift

A deployment is **in sync** when the system running on its host is the store path its flake evaluates to, and has
**drift** when they differ. Drift means the host is behind the flake (or ahead of it, with changes the flake does not
have). X-Nix shows how long drift has lasted and can switch by itself once it has lasted long enough.

## Where things run

X-Nix runs every command on a machine through that machine's **agent**, a small service that dials out to the X-Nix
server. The server's own machine needs no agent; the server does its work itself. Some settings move work to another
machine: `eval_agent` evaluates on a bigger machine, `build_agent` builds there, and a cache builds for many.
