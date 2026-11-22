---
title: Users and access
sidebar:
  order: 12
---

## Users and roles

X-Nix has two roles:

| Role     | Can                                                                                  |
| -------- | ------------------------------------------------------------------------------------ |
| `viewer` | Read everything, change nothing, download nothing.                                   |
| `admin`  | Also update flakes, build, switch, roll back, reboot, provision, download build products and install media, and manage users. |

**Admins from the password file.** Each line of the file `passwordHashFile` (`X_NIX_PASSWORD_HASH_FILE`) names is a user:
`name:scrypt$...`. `npm run hash-password -- <name> [file]` adds the user or changes their password, asking at a
terminal or reading stdin. Removing a user is deleting their line. A line holding only a hash signs in as `admin`. The
file is read at start, so a change takes a restart, and only the file changes these users' passwords.

**Users from Settings.** An admin adds more users under **Settings → Users**, as a viewer or an admin, and sees every
user's tokens under **Settings → Tokens**.

## Signing in

Unless **Keep me signed in** is ticked, a session ends when the browser closes; ticked, it lasts until it is signed out
from the Account page. Sessions are kept in X-Nix's database, so a restart keeps everyone signed in.

The Account page also turns on a second factor (an authenticator app) and makes tokens for scripts.

## Tokens

A token from the Account page lets a script or an AI client call X-Nix as you, sent as `Authorization: Bearer <token>`.
A token can be read-only. A token never reaches the account and user pages, and never does more than its owner may.

## MCP

`/api/mcp` offers X-Nix to AI clients as MCP tools: listing and reading hosts, flakes, deployments, caches, fleet runs,
jobs, samples, builds and backups, and the same actions the page has. Each tool runs as the caller, so a viewer's
token reads and only an admin's acts, and a read-only token runs only the tools that read.

Left to the page: installing onto a machine (it wipes disks), file downloads, and the account and user pages.

Settings shows the address to give a client:

```sh
claude mcp add --transport http x-nix https://x-nix.example/api/mcp --header "Authorization: Bearer <token>"
```

## What needs no sign-in

Only `/api/health`, which answers the server's name and version; the agents' address `/api/agent`, where each agent
proves its key instead; and the push webhook `/api/webhook`, which checks the forge's signature.
