---
title: Fleet runs
sidebar:
  order: 9
---

The Hosts page runs Build, Switch or Reboot across many deployments at once.

![The Hosts page with a fleet run](/assets/screenshots/hosts.png)

## Picking deployments

Tick them, or search with space-separated terms. Each term is a glob on the id or name, such as `web-*`, or a tag, such
as `@canary`; a deployment matching any term is picked. Tags come from each deployment's `tags`.

The Hosts table shows each host's NixOS version, when it last switched, its pin, and whether it waits on a rebuild
(drift) or a sync (an evaluation running or due).

## Running

No more than `parallel` deployments run at once; the page may lower it for one run. Each deployment's part is an
ordinary job, which names the fleet run as its trigger, and the run keeps who started it. The run keeps going if the X-Nix server restarts, and Stop
ends it after the jobs already running. **Stop running jobs** also stops those jobs, as [Stop on a job](/user/jobs-and-builds/#stopping-a-job)
does; their deployments read as skipped, and the run as stopped.

## Staged rollouts

![A staged switch that stopped at its first failure](/assets/screenshots/fleet-run.png)

A staged rollout goes through its stages in order, each a selector such as `@canary`, with the hosts no stage names in a
last stage. With no stages it goes one host at a time.

A staged switch waits, before the next host starts, for each host to read as in sync against an evaluation made after
the switch. The first failure, drift or `sync_timeout` stops the rollout, and the hosts still queued are skipped.

Once a stage has finished, the run can hold before the next:

- **Soak.** With `soak` set, the finished stage must stay healthy that long. A host whose status turns failed, or a
  switched host that drifts from the flake again, fails the stage and stops the rollout.
- **Approval.** With `approve_stages` on, the next stage waits until an admin presses **Approve next stage** on the
  run's page; the approval is noted in the history of each host of the finished stage.

A run started from the API or MCP may set `soak` and `approve` for itself.

## Settings

The config's `fleet` object:

| Setting        | Default | Meaning                                                          |
| -------------- | ------- | ---------------------------------------------------------------- |
| `parallel`     | `4`     | How many deployments a run acts on at once.                      |
| `stages`       | none    | The stage selectors a staged rollout goes through, such as `["@canary", "@web"]`. |
| `sync_timeout` | `30m`   | How long a staged switch may take to read as in sync.            |
| `soak`           | `0s`    | How long each finished stage must stay healthy before the next starts. |
| `approve_stages` | `false` | Wait for an admin's approval before each next stage.             |
