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

A job keeps up to 16 MiB of output. Past that its middle is cut: the job keeps its first 2 MiB and its last 8 MiB, with
one line saying where the cut is, so the outcome a switch prints at its end is still read.

### How long history is kept

Every six hours, and a minute after the server starts, X-Nix deletes finished jobs, builds, events and finished fleet
runs older than `historyRetention` (`X_NIX_HISTORY_RETENTION`, 180 days by default; `never` keeps them all). Whatever
their age, it keeps each owner's newest 20 jobs of each kind and 100 events, the newest 20 builds of each target, the
newest 20 fleet runs, every running job, installs and install media, and every job something still points at: a
waiting switch, a held build, a cache's last Build all, a kept fleet run or build, or an installed host's agent key.
What a pass deletes is gone from the database; the daily [backups](/user/integrations/#backups) still hold it.

### Stopping a job

**Stop** on a running job's page (admins only) ends its processes on its host: they are asked to stop, and killed if
they have not within a few seconds. The job then fails as stopped by whoever pressed it, and the owner's history notes
it. A job still waking its host is called off before it starts. Stopping a switch while it activates can leave
the host part-way between systems.

A guarded switch (with `magic_rollback` or health checks) keeps its watchdog inside the job's run, so stopping the run
would also end the watchdog and leave the new system running with nothing to roll it back. Stop on a guarded switch
that has already activated, and has no outcome yet, therefore tells its watchdog to roll back instead, naming who
stopped it, and the job ends by itself with the watchdog's outcome, usually rolled back. The run is stopped outright
only when the watchdog cannot be told, which the answer and the history say, or when no outcome has come within the
watchdog's own window (`activation_timeout`, the confirmation window and two minutes). Stop again meanwhile is refused.

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
