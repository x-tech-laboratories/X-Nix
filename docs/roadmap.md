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

## Quality

### A flaky agent key test

The agent key test in `tests/provisioning.test.ts` has the system's OpenSSL tools read back a generated key and compares
the result with the line X-Nix made. In CI it failed once with `error:1E08010C:DECODER routines::unsupported` on a pull
request that did not touch it, and passed on rerun. Find what makes the key readable only sometimes, such as the key's
format or the OpenSSL on the runner, and make the test deterministic.
