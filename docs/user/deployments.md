---
title: Deployments
sidebar:
  order: 5
---

A deployment is one NixOS configuration on one host: the host, the flake that describes it, and the
`nixosConfigurations` attribute to build. Its page is the host's System tab.

## Upgrading

Defaults that changed, and the line that keeps the earlier behaviour:

- `magic_rollback` is on unless the deployment has a `target_host`, so a switch X-Nix cannot confirm reaching the host
  afterwards is rolled back. Keep switches unwatched with `"magic_rollback": false`.
- On the server's own host, a switch whose `magic_rollback` comes from that default has `confirm_timeout` `2m`, as the
  server and its agent restart first. Set `"confirm_timeout": "30s"` to keep the shorter wait.

![A deployment's System tab, showing drift and the actions](/assets/screenshots/system.png)

## Drift

Every `interval` X-Nix reads the host's running system, booted system, generation and NixOS version. Every
`eval_interval` it evaluates `<flake>#nixosConfigurations.<configuration>.config.system.build.toplevel` and compares
the two store paths:

- **In sync**: the running system is the flake's.
- **Drift**: they differ, which raises `drift_status` (a warning by default) and notes how long it has lasted.
- **Reboot required**: the booted kernel, initrd or systemd is not the running system's, which raises `reboot_status`.

A failed evaluation is tried again after `retry_interval`. When the running system changes between evaluations, X-Nix
evaluates again before judging drift, so a switch made by hand does not read as drift.

### Automatic switch

With `auto_switch`, a deployment switches by itself once drift has lasted `auto_switch_after`. It switches once per
target system, and never when the running generation is newer than the flake's last change, since that generation came
from somewhere else, such as an unpushed checkout, and switching would undo it. While the agent that builds or switches
the system is not connected and its host cannot be woken, it waits and says so, and switches once the agent is back.

`auto_switch_after` is also how long a new lock waits before it reaches the host by itself: its clock starts when X-Nix
first sees the host drift to that exact system, which is never before the lock changed, and starts again for every new
system. Raise it to give a bad upstream commit more time to be noticed before anything switches to it; a person, a
fleet run or a manual switch never waits for it.

A deployment that switches automatically with `magic_rollback` off and no health checks warns that nothing would roll
a bad switch back.

With the fleet's `stages`, an automatic switch of a later stage waits for the earlier stages, as
[staged automatic switches](/user/fleet/#staged-automatic-switches) describes.

With `auto_switch_max_input_age`, a deployment does not switch by itself while the oldest locked input changed longer
ago than that, and says so on its page; a person can still switch it.

## Build

Build builds the deployment's system without activating it. With `build_at` it also runs daily. Build, and any switch,
builds where `direct_on` says:

| `direct_on`        | Builds on                                                                         |
| ------------------ | --------------------------------------------------------------------------------- |
| `ranked` (default) | The first connected host of the deployment's `cache`, else of its `build_agent` list. |
| `server`           | The X-Nix server's own machine.                                                   |
| `host`             | The machine that switches.                                                        |

Only one whole system builds on a machine at a time, since a fleet's systems change together and building them all at
once runs the machine out of memory. A Build, daily or by hand, or a switch's build waits while another one runs there,
showing "Waiting to build on …" in its job, and starts once that build ends; Stop ends a waiting Build before it starts.

`build_agent`, like a cache's `host`, may list several hosts, most preferred first: each job runs on the first whose
agent is connected, else on the first that can be woken, so a build moves to a faster machine whenever it is up. A
deployment whose host, `eval_agent`, `build_agent` or `switch_agent` names a host whose agent is not connected reads as
unavailable.

Build, daily or by hand, builds the commit X-Nix last evaluated for a remote flake, so it builds the system the page
names as the target even after the branch moved on; before any evaluation it builds the pin, or else the branch head.
With a `cache`, Build runs that cache's build of the system at that commit, and pushes what it built. No action ever waits on a cache being healthy: a cache only speeds things up.

## Switch, boot, test, dry-activate

The System tab offers nixos-rebuild's four modes:

| Action           | Does                                                                   |
| ---------------- | ---------------------------------------------------------------------- |
| **Switch**       | Activates the new system now and makes it the default boot.            |
| **Boot**         | Makes it the default boot, without activating it now.                  |
| **Test**         | Activates it now, without changing the default boot.                   |
| **Dry activate** | Shows what activating it would change, and changes nothing.            |

Before a switch, boot or test, the page shows what would change: the packages added, removed and changed, and the
closure's size before and after. When no package changed but the store paths still differ, it shows `nix-diff`'s account
of the derivations (a host without `nix-diff` says so). When the new system is not on the host yet, the page says so and the switch builds it.

![What a switch would change](/assets/screenshots/diff.png)

### Where a switch builds

A switch built on the switching host itself, or one with `target_host`, runs `nixos-rebuild` straight away. For a
remote flake it builds and switches the commit X-Nix last evaluated, not whatever the branch holds by then, so a push
between the build and the activation cannot make the activation build a newer system against `activation_timeout`. A
local checkout switches as it is on disk. A switch built anywhere else goes in two steps:

1. Its job builds on the build host first, at the commit X-Nix last evaluated, showing the build's output as it prints.
   A failed build fails the switch without touching the host.
2. X-Nix checks that the build made exactly the store path the evaluation named. When it made anything else, or named
   something that is not a store path, the switch fails without touching the host, saying which path the build made and
   which one the evaluation named, and the deployment evaluates again; switch once the new evaluation is in.
3. Once the system reaches `cache_url`, the switch fetches it with `nix build`, so the host's Nix daemon downloads it,
   and activates it. A cache's build pushes the system there; without a cache, something else must, such as
   `attic watch-store`, within 15 minutes.

So a host too small to evaluate or build never has to. For this to work, `cache_url` must be one of the host's
substituters and the system signed by a key the host trusts. Without a `cache_url` to carry the system, or before the
flake has been evaluated once, such a switch is refused.

### Checking the evaluated commit

The host that evaluates also reports which commit it evaluated, and switches use that commit. Before a switch starts, by
hand, from a fleet run or automatically, X-Nix compares it with what it knows independently:

- With a pin that is a full commit hash, the evaluated commit must be that commit.
- When the deployment names a flake from `flakes` whose own `host` is not the host that evaluated, the evaluated commit
  and its date must be the ones the flake's last read found.

When they disagree, the switch is refused with both commits named, the deployment evaluates again and the flake reads
its metadata again, and an automatic switch waits until they agree. A tag pin, a local checkout, or a flake read on the
same host that evaluates is not compared. The hosts named as `eval_agent`, `build_agent` or a cache's `host` are trusted as
much as the machines they build for: when one host both evaluates and builds, the two agreeing proves nothing.

A new switch takes over one still building, and a Build asked for meanwhile answers with that build.

## Pins

A pin fixes a deployment at one commit or tag, so a rollback names a fixed version. X-Nix then evaluates, builds and
switches `github:owner/repo?rev=<commit>` (or `?ref=<tag>`), or for a git flake `git+https://…?rev=<commit>&allRefs=1`
(or `?ref=refs/tags/<tag>`); a plain checkout such as `/etc/nixos` is read as `git+file://`. A `path:` or tarball flake
cannot be pinned.

The deployment's page shows the pin and sets another once its field is left or Enter is pressed; emptying the field follows
the branch head again, as does its button, and another button goes back to the settings' `pin`.
The flake's Update still moves the branch, and a pinned deployment ignores pushes.

## Generations and rollback

The Generations panel lists every generation of the system profile. Roll back to any of them as a job that records why.
![The Generations panel](/assets/screenshots/generations.png)

Each generation opens the closure browser: its dependency tree with each path's own and closure size, and its largest
paths.

![The closure browser](/assets/screenshots/closure.png)

## Safer switches

A switch is **guarded** when any of `pre_switch_checks`, `health_commands`, `health_urls` or `magic_rollback` is set.
A guarded switch runs on the switching host itself, so it takes no `target_host`.

1. **Pre-switch checks** run first. The first to fail refuses the switch before anything changes.
2. For `switch` and `test`, a **watchdog** starts on the host in a session of its own, so it outlives the job, the agent
   and a lost connection.
3. The system **activates**, then `post_switch` runs.
4. The **health commands** run every `health_period` until they pass. Then X-Nix fetches the **health URLs**.
5. Once they pass, X-Nix **confirms** the switch to the watchdog.

The watchdog rolls back to the previous system when:

- the activation fails, or takes longer than `activation_timeout`;
- a health check keeps failing for `health_timeout`;
- with `magic_rollback`, no confirmation arrives within `confirm_timeout` (plus `health_timeout` when there are health
  checks). Without `magic_rollback` an unconfirmed switch is kept.

`magic_rollback` is on by default, so every switch and test runs guarded, except for a deployment with a `target_host`,
which a guarded switch cannot reach. Boot and dry activate never run a watchdog, since they activate nothing. A host
that sleeps must stay awake until the switch is confirmed, which `keep_awake` sees to. On the server's own host the
confirmation comes only once the server and its agent are back from any restart the switch caused, so there the default
`confirm_timeout` is `2m` when `magic_rollback` is left to its default.

A switch whose checks failed, or that nothing confirmed with `magic_rollback`, while the system had not changed, has
nothing to roll back; it still fails, saying so, and a fleet run counts that host as failed.

An activation that only failed to start some units (switch-to-configuration's status 4) counts as activated: the health
checks decide, and a switch they pass is kept. Its job succeeds, and the history and the host's status warn with the
units that failed until the host runs another system.

Every refusal and rollback lands in the job and the history with its reason. On the server's own host, a confirmation
means the X-Nix server is still running after the switch, or came back if the switch restarted it; on another host it
means X-Nix still reaches that host's agent. Keep `confirm_timeout` well above `health_period`.

A guarded switch whose activation hangs ends as soon as its watchdog gives an outcome. The watchdog changes nothing while
another switch still holds the system's switch lock, and names the process holding it.

`post_switch` runs after the activation as root (through `sudo -n /bin/sh -c` with `require_sudo`), so it can restart a
service such as a display manager. Its exit status never changes the switch's.

### Keeping the host awake

When the host sets `keep_awake`, a switch or rollback holds off sleep on the host from its first step,
download included, until the job ends however it ends.

### The Nix store lock

A switch that moves to a newer Nix must upgrade the store database, which needs it to itself. A long-lived Nix client,
such as an editor's language server, keeps it open and the switch waiting. A job that prints nothing for five minutes
notes what it is waiting for and who holds the lock. With `close_nix_lock_holders`, the switch stops those holders
after a minute; their work ends, so it is off by default.

### Switching at the next boot

Some parts of a system cannot be swapped while it runs. With `defer_switch_on` naming any of `kernel`, `systemd` and
`dbus`, a switch compares those parts of the new system with the running one before it activates anything. When one
differs, it sets the new system for the next boot instead, as Boot does, and the deployment shows it waiting on a
reboot until the host runs another system. A staged fleet run counts such a host as done. It needs the new system's
path on the switching host before the activation: one fetched from the cache, or one nixos-rebuild builds there for a
named `configuration`; a switch to a `target_host` always switches.

## Settings

| Setting             | Default                           | Meaning                                                              |
| ------------------- | --------------------------------- | -------------------------------------------------------------------- |
| `id`                | required                          | Letters, digits, `-` and `_`.                                        |
| `name`              | the id                            | What the page calls it.                                              |
| `host`              | the server's own host             | The host that is read, rebooted, and by default runs every job.      |
| `flake`             | `/etc/nixos`                      | The id of a flake under `flakes`, or a flake reference of its own.   |
| `configuration`     | the host's hostname               | The `nixosConfigurations` attribute.                                 |
| `interval`          | `5m`                              | How often the host is read.                                          |
| `eval_interval`     | `1h`                              | How often the flake is evaluated.                                    |
| `retry_interval`    | `15m`                             | How soon a failed evaluation is tried again.                         |
| `eval_timeout`      | `10m`                             | How long an evaluation may run.                                      |
| `job_poll`          | `30s`                             | How often a running job is read.                                     |
| `drift_status`      | `warning`                         | The status drift raises.                                             |
| `reboot_status`     | `warning`                         | The status a needed reboot raises.                                   |
| `nix_bin`           | `nix`                             | The nix program.                                                     |
| `rebuild_bin`       | `nixos-rebuild`                   | The nixos-rebuild program.                                           |
| `nix_args`          | flakes enabled                    | Arguments before every nix command.                                  |
| `rebuild_args`      | none                              | Arguments after the switch.                                          |
| `eval_agent`        | the host                          | The host that evaluates, for a host too small to evaluate itself.    |
| `build_host`        | none                              | `--build-host` for the switch.                                       |
| `build_agent`       | the switch agent                  | The host that runs Build, or a list of them most preferred first.    |
| `build_args`        | `--keep-going --print-build-logs` | Arguments for Build.                                                 |
| `build_root_dir`    | none                              | Keep each build as one garbage-collector root here.                  |
| `cache`             | none                              | The id of the cache that builds this host's system; it gives the `cache_url`, and takes the place of `build_at`, `build_agent` and `build_root_dir`. |
| `cache_url`         | none                              | Without `cache`, the cache a build skips what it holds of, and a switch built on another host fetches from. |
| `switch_agent`      | the host                          | The host that runs switch.                                           |
| `direct_on`         | `ranked`                          | Where Build and a switch build: `ranked`, `server` or `host`.        |
| `target_host`       | none                              | `--target-host` for a plain switch; not with a guarded switch.       |
| `auto_switch`       | `false`                           | Switch by itself once drift lasts `auto_switch_after`.               |
| `auto_switch_after` | `30m`                             | How long drift lasts before an automatic switch.                     |
| `auto_switch_max_input_age` | none                      | Do not switch by itself while the oldest locked input is older than this. |
| `build_at`          | none                              | Build daily at this local time.                                      |
| `switch_wrapper`    | none                              | A command each program of the switch runs inside, outside sudo.      |
| `post_switch`       | none                              | A command run after the switch, as root with `require_sudo`.         |
| `pre_switch_checks` | none                              | Commands run on the host before a switch; the first to fail refuses it. |
| `magic_rollback`    | `true`, or `false` with `target_host` | Roll a switch back unless X-Nix confirms it still reaches the host.  |
| `close_nix_lock_holders` | `false`                      | Stop what holds the Nix store database once the activation has waited a minute for it. Not with `target_host`. |
| `defer_switch_on`   | none                              | Set a switch for the next boot instead when the new system changes any of `kernel`, `systemd` or `dbus`. |
| `activation_timeout`| `4m`                              | How long the activation may take before it is rolled back; fetching or building the system comes before and is not counted. |
| `confirm_timeout`   | `30s`, or `2m` on the server's own host with the default `magic_rollback` | How long after the activation X-Nix has to confirm. |
| `health_commands`   | none                              | Commands run on the host after a switch; a failure rolls it back.    |
| `health_urls`       | none                              | URLs X-Nix fetches after a switch; a non-2xx answer rolls it back.   |
| `health_period`     | `5s`                              | How often failing health checks are tried again.                     |
| `health_timeout`    | `2m`                              | How long health checks may keep failing before the rollback.         |
| `build_progress`    | `true`                            | Show what builds and downloads as a build or switch runs.            |
| `tags`              | none                              | Names a fleet selector picks the deployment by, as `@tag`.           |
| `pin`               | none                              | A commit hash or tag that evaluation, build and switch use instead of the branch head. |
