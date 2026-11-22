---
title: Roadmap
sidebar:
  order: 3
---

What X-Nix does not do yet. What it does today is in the [user guide](/user/) and the
[architecture](/developer/architecture/), and what changed when is in the [changelog](/changelog/). When an item ships,
its commit takes it off this page and describes it in the guides.

## Platforms

### Desktop and Android portals

The [Application Standard](https://x-tech-laboratories.github.io/standards/application/) asks every app whose daemon
belongs on one host to ship desktop and Android apps as portals onto it. X-Nix is a web page only today. The desktop
app is Electron on the X-Libs window and bridge, and the Android app is Capacitor, both wrapping the same `src/web`
page and connecting to a remote X-Nix server signed in with the user's name and password. Neither offers
"This computer", since X-Nix's server manages other machines.

## Extending X-Nix

### Plugins

Every X-app runs the X-Libs plugin host, so others can add to it without changing it. X-Nix has none yet: its hooks
(a job started or ended, a switch verified or rolled back), its providers (where a notification goes) and a Plugins
section on Settings, through X-Libs' `plugins`, `plugin_folder` and `server/plugin_files`.

## Hosts

### Waking a host with its screen off

A host woken for a job, such as a phone, turns its screen on as it resumes, though nobody is looking at it. The agent
could turn the screen back off once it has connected for a job, through a per-host command (for Phosh, asking the
session to blank the display), and the job's inhibitor could block only sleep rather than idle too, so the screen
stays off while the job runs.
