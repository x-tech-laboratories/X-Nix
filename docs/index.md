---
title: X-Nix
description: A web portal for managing NixOS deployments.
template: splash
hero:
  tagline: A web portal for managing NixOS deployments.
  image: ../resources/icon.svg
  actions:
    - text: Read the user guide
      link: /user/
    - text: Read the developer guide
      link: /developer/
      variant: secondary
---

X-Nix is a web portal for a fleet of NixOS machines. It tells you whether each machine runs what its flake says it
should, and it updates flakes, builds systems, switches them safely, keeps binary caches filled, watches the Nix store
and boot entries, and installs NixOS on new machines, all from one page.

![The Overview: hosts, flakes, caches, jobs, deployments, reboots and agents by status, the last week of jobs, what needs attention, and which flakes build which caches and hosts](/assets/screenshots/overview.png)

---

## What it does

- **Drift at a glance.** Every machine's running system is compared with what its flake evaluates to, so you see which
  ones are behind and since when.
- **Flakes kept fresh.** Locked inputs are watched for new commits and updated, committed and pushed for you, on a
  schedule or the moment an input moves.
- **Safer switches.** Checks before a switch, health checks after it, and a watchdog on the machine that rolls back when
  the switch breaks it or cuts it off.
- **Build once, deploy everywhere.** A build machine fills an Attic cache, and small machines fetch their systems from
  it instead of building.
- **Fleet runs.** Build, switch or reboot many machines at once, or roll out in stages with a canary first.
- **The machine, not just the system.** The Nix store's size and garbage collection, the boot loader's entries, and
  Wake-on-LAN for machines that sleep.
- **New machines.** Installs NixOS over SSH with nixos-anywhere, and builds installer ISOs, netboot files and kexec
  tarballs.
- **An agent instead of SSH.** Each machine runs a small agent that dials out to the server, so nothing listens on it.

## The documentation

The **[user guide](/user/)** is for people who install X-Nix, write its config and use the page. It says what X-Nix
does and how to set it up.

The **[developer guide](/developer/)** is for people who change X-Nix itself: how the code is laid out, how its parts
talk to each other, what the database holds and how each long process runs, with diagrams.
