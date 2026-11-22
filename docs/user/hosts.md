---
title: Hosts
sidebar:
  order: 6
---

The config may list `hosts`, each a machine by the name its agent logs in as. A host that a deployment names needs no
entry of its own, and the server's own machine is the host named by `serverName` (`X_NIX_SERVER_NAME`).

A host holds what is true of the machine whatever runs on it: its agent's key, how it is woken and kept awake, its Nix
store and its boot entries. Its page has these tabs:

| Tab         | Shows                                                                         |
| ----------- | ----------------------------------------------------------------------------- |
| **System**  | Its deployment; see [Deployments](/user/deployments/).                        |
| **Store**   | The Nix store's use, profiles and garbage collection, with Collect Garbage.   |
| **Boot**    | The boot loader's entries, with Set next boot and Reboot.                     |
| **Machine** | Its agent, its Wake-on-LAN settings, and an agent key X-Nix made for it.       |

A deployment's Reboot reboots its host.

## The Nix store

![A host's Store tab](/assets/screenshots/store.png)

Every `interval` the host's agent reads its Nix store: how full the filesystem is, how many paths and garbage-collector
roots it holds, every profile's generations, the collection unit and timer, and the last collection's summary from the
journal. The last collection is remembered after the journal rotates past it. The store's use is kept for 180 days and
charted.

**Collect Garbage** runs the timer's collection (`nix-collect-garbage` with `gc_args`) as a job, which then counts as the
last collection. With `collect_at`, X-Nix starts that job every day in place of the timer: a host that is away then
collects once it is back. The timer is then expected to be off, and one still on raises a warning, since two schedules
would collect side by side.

The store's status is the host's, set by these keys of `gc` (or `gc: false` to leave the store alone):

| Setting              | Default                     | Meaning                                                      |
| -------------------- | --------------------------- | ------------------------------------------------------------ |
| `unit`               | `nix-gc.service`            | The collection unit.                                         |
| `timer`              | `nix-gc.timer`              | The timer that starts it, unless `collect_at` is set.        |
| `store`              | `/nix/store`                | The store whose filesystem is measured.                      |
| `max_age`            | `2w`                        | How long since the last collection before it is stale.       |
| `stale_status`       | `failed`                    | The status a stale collection raises.                        |
| `timer_status`       | `warning`                   | The status a missing or inactive timer raises without `collect_at`. |
| `warning`            | `80`                        | Warn once the store's filesystem is this full, in percent; `null` turns it off. |
| `threshold`          | `90`                        | Fail once it is this full; `null` turns it off.              |
| `max_generations`    | none                        | Warn about a profile keeping more generations than this.     |
| `max_generation_age` | none                        | Warn once the oldest generation kept is older than this.     |
| `gc_bin`             | `nix-collect-garbage`       | The collection program.                                      |
| `gc_args`            | `--delete-older-than 7d`    | Its arguments, which should match the timer's.               |
| `collect_at`         | none                        | The time of day, such as `03:30`, X-Nix collects every day in place of the timer. |

## Boot entries

![A host's Boot tab](/assets/screenshots/boot.png)

Every cycle also reads the host's boot loader, with its default entry and the one-shot next entry:

- **systemd-boot** through `bootctl list`;
- **GRUB** from its environment block and `grub.cfg`;
- **any other EFI loader** through `efibootmgr`.

**Set next boot** picks the entry the host boots into once, with the loader's own one-shot tool (`bootctl
set-oneshot`, `grub-reboot` or `efibootmgr --bootnext`), and can reboot into it at once. The default is untouched, so
the boot after returns to it. Reading `/boot` usually needs root, so the read tries `sudo -n` first and falls back to
reading without it. `boot: false` turns this off.

## Wake-on-LAN

A host with `wake_on_lan` is woken before an operation on it when its agent is not connected. X-Nix sends a magic
packet, from the server or from the agent `via` names, and waits for the host's agent to dial in. A job shows `Waking
<host>` meanwhile, then starts, or fails with the reason once `timeout` passes. Reboot, Set next boot and a download wait
for the host instead of failing at once.

**These wake a host:** Update, Build, every switch, rollback, Collect Garbage, Reboot, Set next boot, a cache's Build,
Push and Build all, an install or media build run by that host, and a build product's download, whether started by
hand, on a schedule or by a fleet run.

**These never wake a host:** the periodic read, evaluation and cache check. A sleeping host reads as unavailable until
something wakes it.

`wake_on_lan` is the host's MAC address, or an object of these settings:

```json
{ "hosts": [
  { "id": "thor", "wake_on_lan": "aa:bb:cc:dd:ee:ff" },
  { "id": "odin", "wake_on_lan": { "mac": "aa:bb:cc:dd:ee:01", "broadcast": "192.168.1.255" } }
] }
```

| Setting     | Default           | Meaning                                                       |
| ----------- | ----------------- | ------------------------------------------------------------- |
| `mac`       | required          | The MAC address of the network card that wakes the host.      |
| `broadcast` | `255.255.255.255` | Where the packet is sent, such as the host's subnet broadcast. |
| `port`      | `9`               | The UDP port the packet is sent to.                           |
| `timeout`   | `3m`              | How long to wait for the agent before the operation fails.    |
| `via`       | the server        | The host whose agent sends the packet with `wakeonlan`, for a host on another network. |
| `screen_off` | none             | A shell command the agent runs, as its own user, once a job has woken the host, such as one turning a phone's screen back off. |

### Keep awake

With `keep_awake` (on by default with `wake_on_lan`), every job on the host, woken or not, holds off sleep there until
it ends, so the host's own idle suspend cannot cut a build or switch short. The screen may still go dark meanwhile.

A host such as a phone lights its screen as it wakes, though nobody is looking at it. With `screen_off`, a job that woke
the host runs that command first, right after holding off sleep, so the screen goes dark again while the job runs. It
runs only when the job itself woke the host, never on a host that was already awake, and a failure is shown in the job's
output while the job runs anyway. It needs `keep_awake`. A download, Reboot and Set next boot wake the host without it.

On a Phosh phone, a small script run as the phone's user can turn the display off without unlocking it:

```nix
let
  screen_off = pkgs.writeShellScript "screen-off" ''
    export XDG_RUNTIME_DIR=/run/user/1000
    exec ${pkgs.systemd}/bin/busctl --user set-property org.gnome.Mutter.DisplayConfig \
      /org/gnome/Mutter/DisplayConfig org.gnome.Mutter.DisplayConfig PowerSaveMode i 3
  '';
in {
  security.sudo.extraRules = [{ users = [ "x-nix-agent" ]; runAs = "phone-user"; commands = [{ command = "${screen_off}"; options = [ "NOPASSWD" ]; }]; }];
}
```

and on the server, `wake_on_lan.screen_off = "sudo -n -u phone-user ${screen_off}"`.

## Settings

| Setting        | Default               | Meaning                                                           |
| -------------- | --------------------- | ----------------------------------------------------------------- |
| `id`           | required              | The name the host's agent logs in as.                             |
| `name`         | the id                | What the page calls it.                                           |
| `agent_key`    | none                  | Its agent's public key line (see [Agents](/user/agents/)); the server's own host needs none only with `localAgent`. |
| `wake_on_lan`  | none                  | Its MAC address, or the Wake-on-LAN settings above.               |
| `keep_awake`   | `true` with `wake_on_lan` | Hold off sleep on the host through every job.                 |
| `interval`     | `5m`                  | How often the store and boot entries are read.                    |
| `job_poll`     | `30s`                 | How often a running collection is read.                           |
| `require_sudo` | `true`                | Run switch, rollback, reboot, Collect Garbage, Set next boot and `post_switch` under `sudo -n`. |
| `gc`           | the defaults above    | How the Nix store is watched, or `false` to leave it alone.       |
| `boot`         | `true`                | Read the boot entries, and let the Boot tab set the next boot.    |
