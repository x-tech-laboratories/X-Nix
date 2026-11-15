---
title: Using the page
sidebar:
  order: 3
---

The sidebar holds every section, with each flake, cache and host listed under its own. Settings, your account and the
theme are at its foot. The page follows changes as they happen, so a job's output, a new reading or an agent connecting
shows up without a reload.

## Overview

![The Overview](/assets/screenshots/overview.png)

The Overview counts the hosts, how many are in sync, failing, need a reboot, or have their agent offline. **Hosts by
status** charts them, and **Needs attention** lists each host that is not well with why: drifting, agent offline,
evaluation failed, reboot needed, a job overdue.

**What builds what** maps the fleet from left to right: each flake, the caches that build from it, and the hosts they
deploy to, each with its status. A line from a flake straight to a host means the host builds for itself.

## Flakes

Each flake's page shows its revision, when it last changed, its oldest input, the last update, its locked inputs with
their ages, and which deployments and caches use it, with **Read now** and **Update**. See [Flakes](/user/flakes/).

## Cache

Each cache's page shows how many targets are built and pushed, each target's state with the paths it still misses, the
cache server's health and size, with **Check now** and **Build all**, and each target's own **Build** and **Push**. See
[Caches](/user/caches/).

## Hosts

![The Hosts page](/assets/screenshots/hosts.png)

The Hosts page lists every machine with its status, tags, NixOS version, when it last switched, its pin, how full its
store is, and what it is waiting on. Search by name glob or `@tag`, or tick hosts, to run one action across them; see
[Fleet runs](/user/fleet/).

Each host's page has the actions at the top: **Check now**, **Build**, **Rebuild and switch**, **Rebuild for next boot**,
**Rebuild and test**, **Dry activate**, **Collect garbage** and **Reboot**. Below them are four tabs:

- **System**: its deployment's drift, findings, details, what a switch would change, its pin, its jobs and events,
  and its generations. See [Deployments](/user/deployments/).
- **Store**: the Nix store's use over time, profiles and garbage collection. See [Hosts](/user/hosts/#the-nix-store).
- **Boot**: the boot loader's entries, with **Boot next** and **Reboot into**. See [Hosts](/user/hosts/#boot-entries).
- **Machine**: its agent's connection, its key, and how it is woken and kept awake.

![A host's Machine tab](/assets/screenshots/machine.png)

Every action that changes a machine asks you to confirm first, and answers with a link to the job it started.

## Jobs

The Jobs page lists every job, newest first, with what started it and its last line. **Show evaluations and checks**
adds the hourly evaluations and cache checks. The **Builds** tab lists every finished build. See
[Jobs and builds](/user/jobs-and-builds/).

![The Jobs page](/assets/screenshots/jobs.png)

## Provision

Installs NixOS on a new machine and builds install media. See [Provisioning](/user/provisioning/).

## Users, Account and Settings

**Users** (admins only) lists who can sign in and every token. **Account** changes your password, turns on a second
factor and makes tokens. **Settings** holds the theme, the server's version, the MCP address for AI clients, and
**Backups**. See [Users and access](/user/users-and-access/) and [Integrations](/user/integrations/#backups).
