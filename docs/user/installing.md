---
title: Installing
sidebar:
  order: 2
---

X-Nix comes as a flake with two NixOS modules: `nixosModules.default` runs the server on one machine, and
`nixosModules.agent` runs the agent on every machine you want to manage, the server's own included.

## 1. Add the flake

```nix
{
  inputs.x-nix.url = "github:x-tech-laboratories/X-Nix";

  outputs = { nixpkgs, x-nix, ... }: {
    nixosConfigurations.server = nixpkgs.lib.nixosSystem {
      modules = [ x-nix.nixosModules.default x-nix.nixosModules.agent ./server.nix ];
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
are added later under Settings → Users; see [Users and access](/user/users-and-access/).

## 3. Run the server

```nix
services.x-nix = {
  enable = true;
  passwordHashFile = config.sops.secrets.x_nix_password_hash.path;
  hosts.server.agent_key = "ssh-ed25519 AAAA... x-nix-agent-server";
  deployments.server = {
    flake = "github:example/nixos-config";
    configuration = "server";
  };
};

# The server's own machine is switched by its agent, so the server answering the web needs no root.
services.x-nix-agent = {
  enable = true;
  url = "ws://127.0.0.1:7720/api/agent";
  keyFile = config.sops.secrets.x_nix_agent_key.path;
};
```

Make the agent's key as [Agents](/user/agents/) shows. Secrets the jobs read on this machine, such as a flake's push key
or a cache's push token, must be readable by the `x-nix-agent` user. With `localAgent = true` the server works on its own
machine itself instead, as root through sudo rules, and needs no agent there; see [What runs as root](#what-runs-as-root).

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
| `signIn.sessionLifetime`, `signIn.rememberedLifetime` | `12h`, `30d` | How long a sign-in lasts without and with Keep me signed in. |
| `signIn.tokenLifetime` | `90d`        | The longest a token lasts; `never` for no limit.                         |
| `signIn.adminSecondFactor` | `true`   | Admins must set up a second factor before they change anything.          |
| `localAgent`        | `false`         | Work on the server's own machine from the server itself rather than through its agent. |
| `sudoRules`         | `localAgent`    | Install the sudo rules the built-in agent needs; see [below](#what-runs-as-root). |
| `sudoAllow.*`       | all on          | Drop groups of those rules this host does not use; see [Least privilege](#least-privilege). |

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
| `X_NIX_SESSION_LIFETIME`, `X_NIX_REMEMBERED_LIFETIME` | `12h`, `30d` | How long a sign-in lasts without and with Keep me signed in. |
| `X_NIX_TOKEN_LIFETIME`       | `90d`         | The longest a token lasts; `never` for no limit.                     |
| `X_NIX_ADMIN_SECOND_FACTOR`  | `yes`         | `no` lets admins act without a second factor.                        |
| `X_NIX_LOCAL_AGENT`          | `no`          | `yes` to work on this machine from the server itself rather than through its agent. |

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

By default the server runs no command as root: every machine, its own included, is worked on by its agent, and the
server's unit is sandboxed, with no new privileges and the file system read-only but for its state and the install media
folder, `/var/lib/x-nix-media`, which the agent writes and the server reads. A flaw in the part that answers the web
then stops at the `x-nix` user, though an admin's account can still switch every machine.

Switching, rolling back, rebooting, collecting garbage, setting the next boot and keeping a host awake need root. The
agent module ships sudo rules, and so does the server module when `localAgent` is on, that let the service user run
those commands with `sudo -n` and no password, each matched by its path under `/run/current-system/sw/bin`. Where the
command line is fixed, a rule is a regular expression over all its arguments (sudo 1.9.10 or later), so it allows that
command line and no other; with an older sudo the module falls back to wider shell-style patterns.

| Rule                                                                   | For                                          | Arguments allowed |
| ---------------------------------------------------------------------- | -------------------------------------------- | ----------------- |
| `nixos-rebuild <mode> --flake …`                                        | switch, boot, test, dry activation, pull mode | any flake and `rebuild_args` |
| `/nix/store/*-nixos-system-*/bin/switch-to-configuration <mode>`        | switch from the cache, the watchdog's rollback | any NixOS system in the store |
| `nix-env -p /nix/var/nix/profiles/system --switch-generation N`         | rollback, the watchdog                       | a generation number |
| `/nix/var/nix/profiles/system/bin/switch-to-configuration switch`       | rollback                                     | exact |
| `systemctl reboot`, `bootctl list --json=short`, `cat /boot/grub/grub.cfg`, `grub-editenv list`, `systemd-inhibit … cat` | reboot, boot entries, `keep_awake` | exact |
| `nix-collect-garbage`                                                   | Collect Garbage                              | any, or exactly `sudoAllow.collectGarbageArgs` |
| `nix-env -p /nix/var/nix/profiles/system --set /nix/store/<hash>-nixos-system-…` | `sudoAllow.cacheSwitch`             | one NixOS system |
| `nix … flake update --flake …` and `cp -T <tmp>/x-nix-update-XXXXXX/flake.lock …/flake.lock` | `sudoAllow.flakeUpdates` | any `nix_args`; the copy is exact |
| `kill -TERM <pids>`, `kill -KILL <pids>`                                | `sudoAllow.lockHolders`                      | process ids other than 1 |
| `systemd-run --unit=x-nix-run-<run id>.service … -- <node> <runner.ts> <run folder>`, `systemctl stop x-nix-run-<run id>.service` | `sudoAllow.runUnits` (agent only) | the agent's runner as a non-root user, with the module's properties |
| `bootctl set-oneshot <entry>`, `grub-reboot <entry>`, `efibootmgr --bootnext XXXX` | `sudoAllow.bootEntries`              | one entry, no options |
| `/bin/sh -c …`                                                          | `sudoAllow.postSwitch`                       | any command |
| `ssh …`                                                                 | `sudoAllow.targetHost`                       | any |

The `x-nix-agent` user is root-equivalent, and so is the `x-nix` user when `localAgent` is on, whatever you turn off:
`nixos-rebuild` builds and activates whatever flake it is given, and `switch-to-configuration` runs from any store path
named like a NixOS system, which any user can add to the store. The `post_switch`, `ssh` and unrestricted
`nix-collect-garbage` and `nix flake update` rules are each a root shell on their own, too. The narrow rules keep a
mistake or a confused command to the one thing it was meant for; they are not a boundary against someone who controls
the agent or the server. The server module's unit is left unsandboxed with `localAgent`, so a switch can write the
system. Set `sudoRules = false` on either module to write your own, such as for a `rebuild_bin` outside the system
profile.

### Least privilege

Every `sudoAllow` option defaults to what the code may need, so an upgrade changes nothing a host uses. Turn off on a
host what no deployment switched on it uses (the server module takes the same options for `localAgent`):

```nix
services.x-nix-agent.sudoAllow = {
  postSwitch = false;   # no deployment on this host sets post_switch
  targetHost = false;   # none switches another machine with target_host
  bootEntries = false;  # nobody uses Set next boot here
  lockHolders = false;  # none sets close_nix_lock_holders
  flakeUpdates = false; # no flake updated here is a local checkout
  cacheSwitch = false;  # none switches from a cache (cache or cache_url)
  collectGarbageArgs = [ "--delete-older-than" "7d" ]; # exactly this host's gc.gc_args
};
```

A deployment whose setting needs a rule you turned off fails at that step with sudo's "a password is required". Setting
`users.users.x-nix-agent.uid` and `users.groups.x-nix-agent.gid` lets the run unit rule name the agent's own ids rather
than any id but root's; set them only to the ids the user already has. `runUnits` follows `runUnits.enable`.

Both services carry `nix-diff`, `nixos-anywhere`, `ssh` and `nix-eval-jobs` on their PATH.
