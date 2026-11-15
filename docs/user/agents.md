---
title: Agents
sidebar:
  order: 7
---

Every machine other than the X-Nix server's own runs `x-nix-agent`. The agent dials out to the server, so nothing
listens on the machine and it needs no open port; a laptop that sleeps simply reconnects when it wakes. The server's own
machine needs no agent.

## Setting up a host

1. Make the host's key on the host, and keep the private half only there:

   ```sh
   ssh-keygen -t ed25519 -N "" -C x-nix-agent-workstation -f /etc/x-nix-agent/key
   ```

2. Declare its public half in the server's config, as the host's `agent_key`:

   ```nix
   services.x-nix.hosts.workstation.agent_key = "ssh-ed25519 AAAA... x-nix-agent-workstation";
   ```

3. Enable the agent on the host:

   ```nix
   services.x-nix-agent = {
     enable = true;
     url = "wss://nix.example.org/api/agent";
     keyFile = "/etc/x-nix-agent/key";   # or a sops secret
   };
   ```

The agent logs in by proving it holds the key the server's config declares for its host. A host's Machine tab shows
whether its agent is connected, and the Overview lists hosts whose agent is not under **Needs attention**.

A host X-Nix installed from the [Provision](/user/provisioning/) page has its key made for it and is accepted
without step 2, until you declare it.

### Agent module options

| Option        | Default        | Meaning                                                              |
| ------------- | -------------- | -------------------------------------------------------------------- |
| `enable`      | `false`        | Run the agent.                                                       |
| `url`         | required       | The server's agent address, `wss://<server>/api/agent`.              |
| `keyFile`     | required       | The host's private key.                                              |
| `host`        | the hostname   | The name the agent logs in as, which must be the host's id in the server's config. |
| `path`        | none           | Extra programs on the PATH of the commands the agent runs.           |
| `sudoRules`   | `true`         | Install the sudo rules the agent needs; see [Installing](/user/installing/#what-runs-as-root). |
| `pull.*`      |                | Pull mode, below.                                                    |

## What the agent runs

The agent runs only the programs X-Nix needs, such as `nix`, `nixos-rebuild`, `git` and `bootctl`, each with its
arguments. It never runs a script the server sends. The only shell commands it runs are the ones you write in the
config yourself, `pre_switch_checks`, `health_commands`, `post_switch` and `push_command`, each with `/bin/sh -c`
exactly as written.

A job's page shows what it asked the agent to do, and its output shows each program as it starts. Long jobs keep running
if the agent restarts or loses its connection, and the server follows them again once the agent is back.

## Pull mode

Pull mode lets a host keep deploying from Git while the X-Nix server is down. Once the server has been unreachable for
`after`, the agent asks its Git remotes, in order, every `interval` for the head of their branch with `git ls-remote`.
When the head moves, it runs

```sh
nixos-rebuild switch --flake 'git+<url>?ref=refs/heads/<branch>&rev=<revision>#<configuration>'
```

and logs what it does. The first revision it sees is only noted, so turning pull mode on never switches by itself.
Once the server is back, the agent reports each switch, which joins the job history of every deployment on that host
with the trigger `agent pull`.

```nix
services.x-nix-agent.pull = {
  enable = true;
  remotes = [
    { url = "https://github.com/example/nixos-config"; }
    { url = "https://git.example.org/example/nixos-config"; }
  ];
};
```

| Option          | Default          | Meaning                                                        |
| --------------- | ---------------- | -------------------------------------------------------------- |
| `remotes`       | required         | `{ url, branch }` entries (branch `main` by default), asked in order; https://, ssh://, git:// or file://. |
| `after`         | `15m`            | How long the server must be unreachable before the agent deploys. |
| `interval`      | `5m`             | How often the remotes are asked; at least 30 seconds.          |
| `configuration` | the agent's host | The `nixosConfigurations` attribute.                           |
| `rebuildArgs`   | none             | Arguments after the switch.                                    |
| `requireSudo`   | `true`           | Run the switch under `sudo -n`.                                |

Without the module, the agent reads `X_NIX_AGENT_URL`, `X_NIX_AGENT_KEY_FILE`, `X_NIX_AGENT_HOST` and
`X_NIX_AGENT_STATE_DIR` from its environment, and its pull settings from the JSON file `X_NIX_AGENT_PULL_FILE` names
(with `rebuild_bin`, `rebuild_args`, `require_sudo` and `git_bin` in snake case).
