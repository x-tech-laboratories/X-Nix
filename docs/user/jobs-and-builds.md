---
title: Jobs and builds
sidebar:
  order: 11
---

## Jobs

Everything X-Nix runs on a machine that takes time is a job: an evaluation, Update, Build, a switch, a rollback, Collect
Garbage, a cache check, an install. The Jobs page lists them newest first; evaluations and cache checks, which run every
hour, are hidden unless you ask for them.

![A switch job, with the derivations it builds as a tree](/assets/screenshots/job.png)

A job's page shows:

- its **output** as it prints, followed live;
- what **started** it: a person, a schedule, an automatic switch, a push, a fleet run, or `agent pull`;
- what it **asked the agent to do**, and on which host;
- for a Build or a switch with `build_progress`, **what is building and downloading**: counts of what is done and to
  go, and every derivation nix plans to build as a tree, each under a derivation that needs it, with the paths it
  fetches, each one's status and build phase, and how long it took.

Long jobs keep running if the X-Nix server or the agent restarts, and the page picks them up again.

### Stalled jobs

A job on an agent that prints nothing for five minutes notes, in its output, what it is still running and any file lock
one of those programs waits for, with the processes holding it, and notes again each half hour it stays quiet. A switch
to a newer Nix waiting on the store database is the usual case; see [The Nix store
lock](/user/deployments/#the-nix-store-lock).

### Overdue jobs

A job that runs three times longer than the longest of its owner's last ten successful jobs of its kind, and at least half
an hour (an hour with none to go by), is **overdue**. It puts a warning on its deployment naming what it waits for, adds
an event to the history, and sends one notification to every channel under `notifications`; see
[Notifications](/user/integrations/#notifications).

## Builds

The Builds tab of the Jobs page lists every finished build, newest first, filtered by deployment or cache and target:
a deployment's Build, a cache target's Build, and each target of a Build all. Each shows its result, how long it took,
its store path, a link to its job and so its whole log, and the products it made.

![The build history](/assets/screenshots/builds.png)

**Products** are the files a build lists in Hydra's `nix-support/hydra-build-products`, such as an installer ISO. A
product that is a regular file inside its build's store path downloads through the page; the machine that built it
checks again that the file still lies inside that store path before sending it. A product collected since reads as gone.
