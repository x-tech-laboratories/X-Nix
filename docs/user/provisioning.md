---
title: Provisioning
sidebar:
  order: 10
---

The Provision page installs NixOS on new machines and builds install media.

![The Provision page](/assets/screenshots/provision.png)

## Installing a machine

X-Nix installs NixOS on any reachable Linux machine over SSH with
[nixos-anywhere](https://github.com/nix-community/nixos-anywhere): it boots the target into an installer with kexec,
partitions its disks with the configuration's disko layout, installs the flake's `nixosConfigurations` attribute and
reboots, or stops after partitioning.

You give the new host's name, the target's SSH address, user and port, the flake and attribute, and the host that runs
nixos-anywhere. The install starts only once you type the target's address to confirm that its disks will be wiped. It
runs as a job, keeps running if X-Nix restarts, and lands in the job history.

### The target's host key

An install needs the target's **SSH host key**, so the new host's agent key and the system reach only the target. Get
it with `ssh-keyscan -t ed25519 <address>` and compare its fingerprint with `ssh-keygen -lf
/etc/ssh/ssh_host_ed25519_key.pub` on the target's console. The install
first has the target prove it holds that key, then runs nixos-anywhere with an `ssh` ahead of its own on the PATH that
accepts only that key. nixos-anywhere turns host key checks off with `-o UserKnownHostsFile=/dev/null -o
StrictHostKeyChecking=no`, and ssh keeps the first value it is given for each option, so the pinned check comes first and
wins. It covers every connection nixos-anywhere makes, through `ssh`, `ssh-copy-id` and `nix copy`:

- to the running system, before kexec, which holds the key you gave;
- to the installer it kexecs into, which nixos-anywhere's kexec installer starts with the running system's host keys, so
  the same key holds;
- while partitioning, copying the system, copying the agent key with `--extra-files` and installing, all in that
  installer.

nixos-anywhere does not log in to the installed system after its reboot, so that system's own key is not checked. An
installer that shows another key, such as a custom `--kexec` image that makes its own, fails the check: nixos-anywhere
keeps waiting for the target to come back, its output shows `Host key verification failed`, and nothing is copied to
it; stop the job. For a target booted from install media, give the key of that running installer.

With no host key the install is refused, unless you tick **Trust whatever host key answers**. Then nothing is checked,
and anyone between the host that runs nixos-anywhere and the target can take over the install and the new host's agent
key. The job's first line and the install's record say which of the two an install used.

**This erases the target's disks.** For that reason it is only on the page: the MCP tools cannot install.

### What a full install gives you

- **hardware-configuration.nix**, generated on the target with `nixos-generate-config` and shown with the install, for
  you to copy into the flake.
- **An agent key.** X-Nix makes the new host's key, places the private half on the new system at `agent_key_path`, and
  keeps only the public line. Once the install succeeds, X-Nix accepts that key, so the agent logs in on first boot,
  provided the configuration already enables `services.x-nix-agent` with that `keyFile`. The page shows the lines.
  When the server has a [key of its own](/user/installing/#6-sign-what-the-server-sends-agents), the lines also list its
  public line in `serverPublicKeys`; put them in the new host's configuration before you install, so its agent checks
  the server from its first boot. The Provision page shows the server's public line and fingerprint under **Server key**.
- **Config snippets** to declare the key and watch the host as a deployment. X-Nix never writes its config itself. A
  key the config declares for the same host wins.

A key X-Nix made shows on the Provision page until the config names its host, then on the host's Machine tab, and
either can forget it.

## Install media

The page builds install media for a deployment or any flake and attribute:

- an **installer ISO**;
- the **netboot** (iPXE) files;
- a **kexec tarball**.

It builds the configuration's own `system.build.isoImage`, `netbootRamdisk` or `kexecTarball` when it has one, and
otherwise the configuration extended with nixpkgs' installer module. Media is built on the server's own machine by its agent and
linked under `media_root_dir`, so it stays in the store until you remove it from the page. Each file downloads from the
page, for admins only, since a system can have secrets built into it.

## Settings

The config's `provisioning` object:

| Setting               | Default                   | Meaning                                                              |
| --------------------- | ------------------------- | -------------------------------------------------------------------- |
| `ssh_key`             | none                      | The private key nixos-anywhere logs in to targets with, as a path on the host that runs it; installs are refused without it. |
| `install_agent`       | the server's own host     | The host that runs nixos-anywhere unless an install names another.   |
| `nixos_anywhere_bin`  | `nixos-anywhere`          | The nixos-anywhere program.                                          |
| `nixos_anywhere_args` | none                      | Extra arguments for nixos-anywhere, such as `["--build-on", "remote"]`. |
| `agent_key_path`      | `/etc/x-nix-agent/key`    | Where the new host's agent key is placed on its disk.                |
| `agent_url`           | none                      | The server's agent address, for the snippets the page shows.         |
| `nix_bin`             | `nix`                     | The nix program media builds run.                                    |
| `nix_args`            | flakes enabled            | Arguments before every nix command.                                  |
| `media_root_dir`      | `/var/lib/x-nix-media` with the module, else `<state dir>/media` | Where each built medium is linked; the agent writes it and the server removes links from it. |
| `job_poll`            | `30s`                     | How often a running install or media build is read.                  |
