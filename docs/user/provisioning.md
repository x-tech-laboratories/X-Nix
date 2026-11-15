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

**This erases the target's disks.** For that reason it is only on the page: the MCP tools cannot install.

### What a full install gives you

- **hardware-configuration.nix**, generated on the target with `nixos-generate-config` and shown with the install, for
  you to copy into the flake.
- **An agent key.** X-Nix makes the new host's key, places the private half on the new system at `agent_key_path`, and
  keeps only the public line. Once the install succeeds, X-Nix accepts that key, so the agent logs in on first boot,
  provided the configuration already enables `services.x-nix-agent` with that `keyFile`. The page shows the lines.
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
otherwise the configuration extended with nixpkgs' installer module. Media is built on the server's own machine and
linked under `media_root_dir`, so it stays in the store until you remove it from the page. Each file downloads from the
page.

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
| `media_root_dir`      | `<state dir>/media`       | Where each built medium is linked.                                   |
| `job_poll`            | `30s`                     | How often a running install or media build is read.                  |
