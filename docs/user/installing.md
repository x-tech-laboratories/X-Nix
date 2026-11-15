---
title: Installing
sidebar:
  order: 2
---

X-Nix comes as a flake with two NixOS modules: `nixosModules.default` runs the server on one machine, and
`nixosModules.agent` runs the agent on every other machine you want to manage.

## 1. Add the flake

```nix
{
  inputs.x-nix.url = "github:x-tech-laboratories/X-Nix";

  outputs = { nixpkgs, x-nix, ... }: {
    nixosConfigurations.server = nixpkgs.lib.nixosSystem {
      modules = [ x-nix.nixosModules.default ./server.nix ];
    };
    nixosConfigurations.workstation = nixpkgs.lib.nixosSystem {
      modules = [ x-nix.nixosModules.agent ./workstation.nix ];
    };
  };
}
```

## 2. Make the first admin

Admins come from a password file, one `name:hash` line each. Make it on any machine with the flake checked out:

```sh
nix develop
npm install
npm run hash-password -- admin x-nix-passwords   # asks for the password, never takes it as an argument
```

Keep the file as a secret, such as with sops-nix, and point `passwordHashFile` at it. More users, who need no file entry,
are added later on the Users page; see [Users and access](/user/users-and-access/).

## 3. Run the server

```nix
services.x-nix = {
  enable = true;
  passwordHashFile = config.sops.secrets.x_nix_password_hash.path;
  deployments.server = {
    flake = "github:example/nixos-config";
    configuration = "server";
  };
};
```

The server listens on `127.0.0.1:7720`. Put it behind a reverse proxy with HTTPS, such as nginx or Caddy, which agents
and the browser both reach. `openFirewall = true` opens the port when you serve it directly.

The module's `hosts`, `flakes`, `deployments` and `caches` take the settings in this guide, keyed by id; `provisioning`,
`fleet` and `notifications` take theirs. Each setting has the same name as in the [configuration
reference](/user/configuration/). The module writes them into the config file the server reads.

### Module options

| Option              | Default         | Meaning                                                                 |
| ------------------- | --------------- | ----------------------------------------------------------------------- |
| `enable`            | `false`         | Run the X-Nix server.                                                   |
| `host`              | `127.0.0.1`     | The address the server listens on.                                      |
| `port`              | `7720`          | The port the server listens on.                                         |
| `openFirewall`      | `false`         | Open the port in the firewall.                                          |
| `serverName`        | the hostname    | What the page calls the server's machine, and that host's name.         |
| `passwordHashFile`  | required        | The admins' password file.                                              |
| `hosts`, `flakes`, `deployments`, `caches` | none | The things X-Nix watches, by id.                              |
| `provisioning`, `fleet`, `notifications`   | none | Their settings.                                               |
| `webhookSecretFile` | none            | Turns on the [push webhook](/user/integrations/#push-webhook).          |
| `webhookDebounce`   | `10s`           | How long after the last push an evaluation starts.                      |
| `path`              | none            | Extra programs on the PATH of the commands the server runs.             |
| `sudoRules`         | `true`          | Install the sudo rules X-Nix needs; see [below](#what-runs-as-root).    |

### Without the module

`nix build` builds the `x-nix` program, which reads its settings from the environment:

| Variable                     | Default       | Meaning                                                              |
| ---------------------------- | ------------- | -------------------------------------------------------------------- |
| `HOST`                       | `127.0.0.1`   | The address the server listens on.                                   |
| `PORT`                       | `7720`        | The port the server listens on.                                      |
| `X_NIX_PASSWORD_HASH_FILE`   | required      | The admins' password file.                                           |
| `X_NIX_CONFIG`               | none          | The config file naming the flakes, deployments and caches.           |
| `X_NIX_STATE_DIR`            | `state`       | Where the database, backups and job output live.                     |
| `X_NIX_SERVER_NAME`          | the hostname  | What the page calls the server's machine.                            |
| `X_NIX_WEBHOOK_SECRET_FILE`  | none          | The push webhook's shared secret; the webhook is off without it.     |
| `X_NIX_WEBHOOK_DEBOUNCE`     | `10s`         | How long after the last push to a deployment or flake it is evaluated or read. |

The config file is JSON; `config.example.json` in the repository is a complete example.

## 4. Sign in

Open the page, sign in with the name and password from step 2, and the Overview shows your first deployment. Its first
reading arrives within a minute; its first evaluation can take a few minutes.

## 5. Add more machines

Every other machine runs the agent. [Agents](/user/agents/) shows how to make its key and enable it. Then add a
deployment for it:

```nix
services.x-nix.hosts.workstation.agent_key = "ssh-ed25519 AAAA... x-nix-agent-workstation";
services.x-nix.deployments.workstation = {
  host = "workstation";
  flake = "fleet";
  configuration = "workstation";
};
```

## What runs as root

The server runs as the `x-nix` user and the agent as `x-nix-agent`. Both are in the `systemd-journal` group, so they can
read the last garbage collection from the journal.

Switching, rolling back, rebooting, collecting garbage, setting the next boot and keeping a host awake need root. Both
modules ship sudo rules that let the service user run exactly those commands with `sudo -n` and no password, each
matched by its path under `/run/current-system/sw/bin`. They cover:

- `nixos-rebuild` in each mode with `--flake`, pull mode's `git+` switch included;
- a switch that fetches what another machine built: `nix-env -p /nix/var/nix/profiles/system --set /nix/store/*` and
  that system's `switch-to-configuration` in each mode;
- rollbacks and the watchdog: `nix-env ... --switch-generation *` and the system profile's `switch-to-configuration`;
- a flake's Update on a local checkout: `nix ... flake update --flake *`;
- `systemctl reboot` and `nix-collect-garbage`;
- the boot loader's reads and one-shot setters: `bootctl list --json=short`, `cat /boot/grub/grub.cfg`,
  `grub-editenv list`, `bootctl set-oneshot`, `grub-reboot`, `efibootmgr --bootnext`;
- the `keep_awake` inhibitor, `systemd-inhibit`;
- `/bin/sh -c *` for `post_switch`, and `ssh` for `target_host`.

A service that activates whole systems can do anything root can, which is why some rules take any arguments. Treat the
`x-nix` and `x-nix-agent` users as root. Set `sudoRules = false` on either module to write your own, such as for a
`rebuild_bin` outside the system profile.

Both services carry `nix-diff`, `nixos-anywhere`, `ssh` and `nix-eval-jobs` on their PATH.
