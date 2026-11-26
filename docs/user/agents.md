---
title: Agents
sidebar:
  order: 7
---

Every machine X-Nix manages runs `x-nix-agent`, the server's own included. The agent dials out to the server, so nothing
listens on the machine and it needs no open port; a laptop that sleeps simply reconnects when it wakes. On the server's
own machine it dials `ws://127.0.0.1:<port>/api/agent`; it needs none there only when the server's `localAgent` is on.

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
| `sudoAllow.postSwitch`, `.targetHost`, `.bootEntries`, `.lockHolders`, `.flakeUpdates`, `.cacheSwitch` | `true` | Each keeps one group of sudo rules; see [Least privilege](/user/installing/#least-privilege). |
| `sudoAllow.runUnits` | `runUnits.enable` | Keep the rules that start and stop run units. |
| `sudoAllow.collectGarbageArgs` | any | The exact arguments Collect Garbage may pass to `nix-collect-garbage` as root. |
| `runUnits.enable` | `true`    | Run each job as a transient systemd unit, `x-nix-run-<run id>.service`, so stopping it stops every process it started. |
| `runUnits.slice` | `nix-work.slice` | The slice those units share, and with it the slice's memory and CPU limits. |
| `runUnits.properties` | the agent's scheduling | Further unit properties; by default the agent unit's `Nice`, `CPUSchedulingPolicy`, `IOSchedulingClass`, `IOSchedulingPriority`, `OOMScoreAdjust` and `UMask`. |
| `pull.*`      |                | Pull mode, below.                                                    |

## What the agent runs

The agent runs only the programs X-Nix needs, such as `nix`, `nixos-rebuild`, `git` and `bootctl`, each with its
arguments. The only shell commands it runs are the ones written in the server's config, `pre_switch_checks`,
`health_commands`, `post_switch` and `push_command`, each with `/bin/sh -c` exactly as written; they reach the agent
from the server with each job, and `post_switch` runs as root, so whoever controls the server or its config can run
commands on the host.

A job's page shows what it asked the agent to do, and its output shows each program as it starts. Long jobs keep running
if the agent restarts or loses its connection, and the server follows them again once the agent is back.

### Runs on the agent

Each long job runs in a folder on its agent, which the server removes once it has read the job's end. The **Runs**
section of a host's Machine tab (and `list_host_runs` over MCP) lists every run the agent still holds, with the job that
follows it. A run with no job was left behind, such as by a job whose history was lost; **Stop** ends one still running
and **Remove** deletes an ended one's folder. Stopping a run a job follows stops that job, as Stop on its page does. Reading
the list does not wake a sleeping host.

## Pull mode

Pull mode lets a host keep deploying from Git while the X-Nix server is down. Once the server has been unreachable for
`after`, the agent asks its Git remotes, in order, every `interval` for the head of their branch with `git ls-remote`.
When the head moves, it fetches that commit into its own repository under its state folder and checks it with
`git verify-commit` against `allowedSignersFile`, then runs

```sh
nixos-rebuild switch --flake 'git+<url>?ref=refs/heads/<branch>&rev=<revision>#<configuration>'
```

and logs what it does. A commit with no allowed signature is not switched to, and is logged once. The first revision it
sees is only noted, so turning pull mode on never switches by itself.

A host in pull mode switches to whatever its remotes say once the server is out of reach, and someone who can block the
server can choose when that is. So it needs the keys its commits are signed with, as Git's allowed signers file, such
as `me@example.org ssh-ed25519 AAAA...` per line; only SSH signatures are checked. `allowUnsigned = true` switches to
unsigned commits instead, which hands root on the host to anyone who can push to a remote or impersonate one.
Once the server is back, the agent reports each switch, which joins the job history of every deployment on that host
with the trigger `agent pull`.

```nix
services.x-nix-agent.pull = {
  enable = true;
  remotes = [
    { url = "https://github.com/example/nixos-config"; }
    { url = "https://git.example.org/example/nixos-config"; }
  ];
  allowedSignersFile = pkgs.writeText "allowed_signers" "me@example.org ssh-ed25519 AAAA...";
};
```

| Option          | Default          | Meaning                                                        |
| --------------- | ---------------- | -------------------------------------------------------------- |
| `remotes`       | required         | `{ url, branch }` entries (branch `main` by default), asked in order; https://, ssh:// or file://. |
| `allowedSignersFile` | required unless `allowUnsigned` | The keys a commit must be signed with, in Git's allowed signers format. |
| `allowUnsigned` | `false`          | Switch to unsigned commits when no `allowedSignersFile` is given. |
| `after`         | `15m`            | How long the server must be unreachable before the agent deploys. |
| `interval`      | `5m`             | How often the remotes are asked; at least 30 seconds.          |
| `configuration` | the agent's host | The `nixosConfigurations` attribute.                           |
| `rebuildArgs`   | none             | Arguments after the switch.                                    |
| `requireSudo`   | `true`           | Run the switch under `sudo -n`.                                |

Without the module, the agent reads `X_NIX_AGENT_URL`, `X_NIX_AGENT_KEY_FILE`, `X_NIX_AGENT_HOST` and
`X_NIX_AGENT_STATE_DIR` from its environment, and its pull settings from the JSON file `X_NIX_AGENT_PULL_FILE` names
(with `rebuild_bin`, `rebuild_args`, `require_sudo`, `git_bin`, `allowed_signers` and `allow_unsigned` in snake case).
