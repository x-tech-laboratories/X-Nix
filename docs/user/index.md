---
title: User guide
---

This guide is for people who install X-Nix, write its config file and use its page. It tells you what X-Nix does and
how to set it up. How it is built is in the [developer guide](/developer/).

## Where to start

1. Read [Concepts](/user/concepts/) for the few words X-Nix uses everywhere: host, flake, deployment, cache, job.
2. Follow [Installing](/user/installing/) to run the server, sign in, and watch your first machine.
3. Add the [agent](/user/agents/) to each other machine you want to manage.
4. Read [Using the page](/user/using-the-page/) for a tour of every page.

## By task

| I want to…                                                   | Read                                              |
| ------------------------------------------------------------ | ------------------------------------------------- |
| See which machines are behind their flake                    | [Deployments](/user/deployments/)                 |
| Update a flake's inputs by hand, daily, or when one moves    | [Flakes](/user/flakes/)                           |
| Switch a machine without breaking it                         | [Deployments: safer switches](/user/deployments/#safer-switches) |
| Build systems once and let other machines fetch them         | [Caches](/user/caches/)                           |
| Switch many machines at once, canary first                   | [Fleet runs](/user/fleet/)                        |
| Keep the Nix store from filling up                           | [Hosts: the Nix store](/user/hosts/#the-nix-store) |
| Boot a machine into a different entry once                   | [Hosts: boot entries](/user/hosts/#boot-entries)  |
| Wake a machine that sleeps before a job                      | [Hosts: Wake-on-LAN](/user/hosts/#wake-on-lan)    |
| Install NixOS on a new machine                               | [Provisioning](/user/provisioning/)               |
| See why a job failed, or download what a build made          | [Jobs and builds](/user/jobs-and-builds/)         |
| Give someone read-only access, or a token to a script        | [Users and access](/user/users-and-access/)       |
| Let an AI client read and act on the fleet                   | [Users and access: MCP](/user/users-and-access/#mcp) |
| Evaluate on push, get notified, back up X-Nix's data         | [Integrations](/user/integrations/)               |
| Look up one setting                                          | [Configuration reference](/user/configuration/)   |
