---
title: Configuration reference
sidebar:
  order: 14
---

X-Nix reads one JSON config file, which the NixOS module writes from `services.x-nix`. Each topic's page holds the full
table of its settings; this page shows the file's shape and where each part is described.

## The file

```json
{
  "hosts":         [{ "id": "workstation", "agent_key": "ssh-ed25519 AAAA..." }],
  "flakes":        [{ "id": "fleet", "url": "github:example/nixos-config", "update_at": "02:00" }],
  "deployments":   [{ "id": "workstation", "host": "workstation", "flake": "fleet", "tags": ["desktop"] }],
  "caches":        [{ "id": "builder", "host": "builder", "flake": "fleet", "configurations": ["workstation"],
                      "cache_url": "https://cache.example.org/fleet" }],
  "fleet":         { "parallel": 4, "stages": ["@canary"] },
  "provisioning":  { "ssh_key": "/var/lib/x-nix/install_key" },
  "notifications": [{ "type": "ntfy", "topic": "x-nix" }]
}
```

`config.example.json` in the repository is a complete, working example. In the NixOS module, the lists become attribute
sets keyed by id:

```nix
services.x-nix.deployments.workstation = { host = "workstation"; flake = "fleet"; tags = [ "desktop" ]; };
```

| Key             | Holds                                  | Settings                                                         |
| --------------- | -------------------------------------- | ---------------------------------------------------------------- |
| `hosts`         | Machines, by their agent's name        | [Hosts](/user/hosts/#settings), with [`gc`](/user/hosts/#the-nix-store) and [`wake_on_lan`](/user/hosts/#wake-on-lan) |
| `flakes`        | Flakes X-Nix reads and updates         | [Flakes](/user/flakes/#settings)                                 |
| `deployments`   | NixOS configurations on hosts          | [Deployments](/user/deployments/#settings)                       |
| `caches`        | Build machines and their Attic caches  | [Caches](/user/caches/#settings)                                 |
| `fleet`         | Fleet run defaults                     | [Fleet runs](/user/fleet/#settings)                              |
| `provisioning`  | Installs and install media             | [Provisioning](/user/provisioning/#settings)                     |
| `notifications` | Where notifications go                 | [Notifications](/user/integrations/#notifications)               |

The server's own settings come from its environment or the module's options; see
[Installing](/user/installing/#module-options).

## Values

- **Ids** are letters, digits, `-` and `_`. Deployments, flakes and caches share one set of ids; hosts have their own.
- **Durations** are a number and a unit, such as `30s`, `5m`, `1h`, `2d` or `2w`.
- **Times of day** are local 24-hour times, such as `02:00`.
- **Statuses**, for settings such as `drift_status`, are `online`, `info`, `unavailable`, `warning` or `failed`.
- **Commands** written into the config, such as `health_commands`, run with `/bin/sh -c` on the host exactly as written.
- **Secrets** are always paths to files, such as `push_ssh_key`, `token_file` and `access_tokens_file`, so they never
  sit in the config itself.

## When the config changes

The config is read when the server starts. The NixOS module restarts the server when the config changes, and a restart
leaves running jobs running.

A wrong setting stops the server at start with a message naming the setting.
