# X-Nix

A web portal for managing NixOS deployments: drift against the flake, updates, builds, switches,
the Nix store, the Attic cache and boot entries.

## Development

```sh
nix develop           # or nix-shell
npm install
npm run hash-password -- admin # adds a user to password.hash, which the dev server reads
npm run dev:server    # the API on http://127.0.0.1:7720
npm run dev:web       # the page, reaching the API through Vite's proxy
```

`npm run build` type-checks and builds the page into `dist/`; `npm start` serves both on one port.
`npm test` runs the tests and `npm run lint` the linter.

## Settings

| Variable            | Default       | Meaning                                  |
| ------------------- | ------------- | ---------------------------------------- |
| `HOST`              | `127.0.0.1`   | The address the server listens on.       |
| `PORT`              | `7720`        | The port the server listens on.          |
| `X_NIX_PASSWORD_HASH_FILE` | required | The admins who may sign in, one `name:hash` line each, from `npm run hash-password`. |
| `X_NIX_CONFIG`      | none          | The config file naming the flakes, deployments and caches. |
| `X_NIX_STATE_DIR`   | `state`       | Where the database and job output live.  |
| `X_NIX_SERVER_NAME` | the hostname  | What the page calls the server's machine. |
| `X_NIX_WEBHOOK_SECRET_FILE` | none  | The push webhook's shared secret; the webhook is off without it. |
| `X_NIX_WEBHOOK_DEBOUNCE` | `10s`    | How long after the last push to a deployment or flake it is evaluated or read. |

## Flakes

The config file lists `flakes`, each a flake X-Nix reads and updates once for every deployment and
cache that names it by its id in `flake`; see `config.example.json`. Every `interval` the flake's
host reads `nix flake metadata`, and the Flakes page shows its revision, when it last changed and
each locked input with its age. Update runs as a long run on that host: a local checkout's lock is
written in place (with `sudo -n` under `require_sudo`), and a `github:` flake with a `push_ssh_key`
is cloned unprivileged, updated, committed and pushed back over SSH, with github.com's host key
taken from the system's known hosts. Once an update ends well, every deployment and cache naming
the flake evaluates afresh. A flake reference no flake declares still works for evaluation, build
and switch, but has no page and no Update.

| Setting          | Default                       | Meaning                                                    |
| ---------------- | ----------------------------- | ---------------------------------------------------------- |
| `id`             | required                      | Letters, digits, `-` and `_`, unique among flakes, deployments and caches. |
| `name`           | the id                        | What the page calls it.                                    |
| `url`            | required                      | The flake reference, such as `github:owner/config` or `/etc/nixos`. |
| `host`           | the server's own host         | The host that reads and updates it; a local checkout's own host. |
| `interval`       | `1h`                          | How often its metadata is read.                            |
| `timeout`        | `2m`                          | How long one read may take.                                |
| `job_poll`       | `30s`                         | How often a running update is read.                        |
| `max_input_age`  | none                          | Warn once the oldest locked input is older than this.      |
| `update_at`      | none                          | Update daily at this local time, such as `02:00`.          |
| `input_check_interval` | `1m`                    | How often each watched input's remote is asked whether it moved; `null` never asks. |
| `watch_inputs`   | every input                   | The inputs that check and the push webhook watch, by name. |
| `access_tokens_file` | none                      | A nix.conf file on the flake's host holding `access-tokens`, read when the flake is read or updated. |
| `push_ssh_key`   | none                          | The key a `github:` flake's update pushes with.            |
| `commit_author`  | `X-Nix <x-nix@localhost>`     | The update commit's author.                                |
| `commit_message` | `chore(flake): update inputs` | The update commit's message.                               |
| `require_sudo`   | `true`                        | Update a local checkout under `sudo -n`.                   |
| `nix_bin`        | `nix`                         | The nix program.                                           |
| `nix_args`       | the experimental features     | Arguments before nix's subcommand.                         |

### Input checks

Every `input_check_interval` the flake's host runs `git ls-remote` against each watched input's
remote, asking only where its branch or tag points. That goes over Git's own protocol rather than a
forge's API, so it costs nothing against GitHub's API rate limit. Once an input's remote points past
its locked revision, Update starts at once; an update that fails is not retried for the same upstream
commit. `github:`, `gitlab:`, `sourcehut:` and `git+https://` or `git+ssh://` inputs are watched;
`follows`, `path:`, tarball, registry (`nixpkgs` without a scheme) and commit-pinned inputs are not.
The flake's metadata is still read every `interval`. A channel such as `nixos-unstable` moves several
times a day, and each move is an update and a commit; leave it out of `watch_inputs` to move it only
with `update_at`.

### Access tokens

Updating a `github:` input asks GitHub's API, which allows 60 calls an hour per address without a
token. `access_tokens_file` names a file in nix.conf syntax on the flake's host, such as
`access-tokens = github.com=<token>`. X-Nix never reads the file: nix includes it through
`NIX_CONFIG`, and `sudo` keeps that for a local checkout's update, which the module's sudo rules
allow. With sops-nix, a template renders it:

```nix
sops.templates."nix-access-tokens".content = "access-tokens = github.com=${config.sops.placeholder.github-token}";
# The user that runs on the flake's host: x-nix for the server's own host, x-nix-agent for an agent's.
sops.templates."nix-access-tokens".owner = "x-nix";
services.x-nix.flakes.fleet.access_tokens_file = config.sops.templates."nix-access-tokens".path;
```

## Users

Each line of the `X_NIX_PASSWORD_HASH_FILE` file is a user: `name:scrypt$...`. `npm run hash-password -- <name> [file]`
adds the user or changes their password, asking for it at a terminal or reading it from stdin; removing a user is
deleting their line. A line holding only a hash signs in as `admin`. The file is read at start, so a change takes a
restart. Its users are admins, whose passwords only the file changes.

Signing in, the Account and Users pages are the X-Libs accounts every X-app shares. An admin adds more users on the
Users page as a `viewer`, who reads everything and changes nothing, or an `admin`, who also builds, deploys, reboots and
manages users. Unless "Keep me signed in" is ticked, a session ends when the browser closes; ticked, it lasts until it
is signed out from the Account page. Sessions are kept in the database, so a restart keeps everyone signed in. The
Account page also turns on a second factor and makes tokens for scripts.

## MCP

`/api/mcp` offers the API to AI clients as MCP tools over streamable HTTP: listing and reading hosts, flakes,
deployments, caches, fleet runs, jobs, samples, builds and backups, and the same actions the page has. Each tool runs
its route as the caller, so a viewer's token reads and only an admin's acts. Installing onto a machine wipes its disks
and stays on the page, as do file downloads and the account and user routes, which take no tokens. A client sends a token from the Account page as a bearer header; a read-only token runs only the
tools that read. Settings shows the address to give a client.

```sh
claude mcp add --transport http x-nix https://x-nix.example/api/mcp --header "Authorization: Bearer <token>"
```

## Backups

The state database, which holds the users added on the Users page, their sessions and tokens, and every job, event and
reading, is backed up once a day into `<X_NIX_STATE_DIR>/backups`, keeping the last 14 daily copies; an admin changes
that, backs up by hand, restores or deletes a backup under Backups on the Settings page. A restore first backs up the current data,
then stops the server, which systemd starts again with the backup in place of the database.

X-Nix keeps no history of its items, which the Application Standard asks of apps whose users edit items: what it stores
is jobs, events and readings, which are a log, and its flakes, hosts and deployments come from the config file.

## Deployments

The config file lists `deployments`, each a NixOS host and the flake that describes it; see
`config.example.json`. A host runs one deployment, which its page shows on its System tab. Every `interval` X-Nix reads the host's running system, and every
`eval_interval` it evaluates `<flake>#nixosConfigurations.<configuration>.config.system.build.toplevel`
and compares the two store paths. Build, switch, garbage collection and evaluation run as long runs
that survive a restart of X-Nix; each lands in the job history with its output.

No action waits on a cache, which only speeds things up. Build, and a switch, boot, test or dry activation started by a
person, the API (as the page and the MCP tools do), a fleet run or the drift, build where `direct_on` says: `ranked` (the
default) takes the first connected host of the deployment's `cache`, else of its build agents; `server` takes the X-Nix
server; `host` takes the host that switches. Build runs there; with a `cache` it runs that cache's build of the system,
at the deployment's pin when it has one, which pushes what it built.

A switch built on the switching host, or one with `target_host`, runs `nixos-rebuild` at once. Built anywhere else, its
job builds there first, with the build's output as it prints, and fails without touching the host when the build
fails. Once the system reaches `cache_url`, which a cache's build pushes it to (without a cache, something else must,
such as `attic watch-store`, within 15 minutes), the switch fetches it with `nix build`, so the host's Nix daemon
substitutes it, and activates it. A host too small to evaluate or build so never does. `cache_url` must therefore be one
of the host's substituters, and the system signed by a key the host trusts; the rest of the closure may come from any
other substituter, as Attic leaves out what an upstream cache such as cache.nixos.org already serves. A `switch` or
`boot` sets it as the system profile's next generation, and every mode runs its own `switch-to-configuration` with that
mode, so `test` leaves the profile alone. It runs plain or guarded like any switch, on the switch agent's own host;
`build_host`, `rebuild_bin` and `rebuild_args` do not apply to it. Without a `cache_url` to carry the system such a
switch is refused.

A new switch ends one still building first and takes over its build; a Build asked for meanwhile answers with that
build. An automatic switch runs once per target closure.

Hosts are named by agent: the server's own host is served by the server itself, and any other host
by its agent (see Agents). A deployment, `eval_agent`, `build_agent` or `switch_agent` naming a host
whose agent is not connected reads as unreachable. A deployment's `build_agent` and a cache's `host` may
also list several hosts, most preferred first: each job runs on the first whose agent is connected,
else on the first that can be woken, so a build moves to a faster machine whenever it is up.

| Setting             | Default                           | Meaning                                                              |
| ------------------- | --------------------------------- | -------------------------------------------------------------------- |
| `id`                | required                          | Letters, digits, `-` and `_`.                                        |
| `name`              | the id                            | What the page calls it.                                              |
| `host`              | the server's own host             | The host that is read, rebooted, and by default runs every job.      |
| `flake`             | `/etc/nixos`                      | The id of a flake under `flakes`, or a flake reference of its own.   |
| `configuration`     | the host's hostname               | The `nixosConfigurations` attribute.                                 |
| `interval`          | `5m`                              | How often the host is read.                                          |
| `eval_interval`     | `1h`                              | How often the flake is evaluated.                                    |
| `retry_interval`    | `15m`                             | How soon a failed evaluation is tried again.                         |
| `eval_timeout`      | `10m`                             | How long an evaluation may run.                                      |
| `job_poll`          | `30s`                             | How often a running job is read.                                     |
| `drift_status`      | `warning`                         | The status drift raises.                                             |
| `reboot_status`     | `warning`                         | The status a needed reboot raises.                                   |
| `nix_bin`           | `nix`                             | The nix program.                                                     |
| `rebuild_bin`       | `nixos-rebuild`                   | The nixos-rebuild program.                                           |
| `nix_args`          | flakes enabled                    | Arguments before every nix command.                                  |
| `rebuild_args`      | none                              | Arguments after the switch.                                          |
| `eval_agent`        | the host                          | The host that evaluates, for a host too small to evaluate itself.    |
| `build_host`        | none                              | `--build-host` for the switch.                                       |
| `build_agent`       | the switch agent                  | The host that runs Build, or a list of them most preferred first, so one host can warm the cache for others. |
| `build_args`        | `--keep-going --print-build-logs` | Arguments for Build.                                                 |
| `build_root_dir`    | none                              | Keep each build as one garbage-collector root here.                  |
| `cache`             | none                              | The id of the cache that builds this host's system (see Caches); it gives the `cache_url`, and takes the place of `build_at`, `build_agent` and `build_root_dir`. |
| `cache_url`         | none                              | Without `cache`, the cache a build skips what it holds of, and a switch built on another host fetches from. |
| `switch_agent`      | the host                          | The host that runs switch.                                           |
| `direct_on`         | `ranked`                          | Where Build and a switch build: `ranked` (the cache's hosts, else the build agents), `server` or `host` (see above). |
| `target_host`       | none                              | `--target-host` for a plain switch; not with `pre_switch_checks`, health checks or `magic_rollback`, which run on the switch agent's own host. |
| `auto_switch`       | `false`                           | Switch by itself once drift lasts `auto_switch_after`.               |
| `auto_switch_after` | `30m`                             | How long drift lasts before an automatic switch.                     |
| `build_at`          | none                              | Build daily at this local time.                                      |
| `switch_wrapper`    | none                              | A command each program of the switch runs inside, outside sudo.      |
| `post_switch`       | none                              | A command run after the switch, as root with `require_sudo`, which keeps the switch's status. |
| `pre_switch_checks` | none                              | Commands run on the host before a switch; the first to fail refuses it. |
| `magic_rollback`    | `false`                           | Roll a switch back unless X-Nix confirms it still reaches the host.  |
| `close_nix_lock_holders` | `false`                      | Once the activation has waited a minute for the Nix store database, as a newer Nix does to upgrade it, stop what holds it open, such as a language server's daemon connections; their work ends, so it is off by default. Not with `target_host`. |
| `activation_timeout`| `4m`                              | How long the activation may take before it is rolled back; a switch built on another host fetches its closure first, and a guarded `nixos-rebuild` with a `configuration` and no `build_host` or `target_host` builds the system first, both outside this time. |
| `confirm_timeout`   | `30s`                             | How long after the activation X-Nix has to confirm.                  |
| `health_commands`   | none                              | Commands run on the host after a switch; a failure rolls it back.    |
| `health_urls`       | none                              | URLs X-Nix fetches after a switch; a non-2xx answer rolls it back.   |
| `health_period`     | `5s`                              | How often failing health checks are tried again.                     |
| `health_timeout`    | `2m`                              | How long health checks may keep failing before the rollback.         |
| `build_progress`    | `true`                            | Read Build's structured log into counts and a tree of what builds and downloads. |
| `tags`              | none                              | Names a fleet selector picks the deployment by, as `@tag`.           |
| `pin`               | none                              | A commit hash or tag that evaluation, build and switch use instead of the branch head. |

### Pins

A pin fixes a deployment at one commit or tag, so a rollback names a fixed version: X-Nix evaluates,
builds and switches `github:owner/repo?rev=<commit>` (or `?ref=<tag>`), and for a git flake
`git+https://…?rev=<commit>&allRefs=1` (or `?ref=refs/tags/<tag>`); a plain checkout such as
`/etc/nixos` is read as `git+file://`. A `path:` or tarball flake cannot be pinned. The deployment's
page shows the pin and sets another, follows the branch head again, or goes back to the settings'
`pin`. The flake's Update still updates the branch, and a pinned deployment ignores pushes.

### Switches

The System tab offers nixos-rebuild's `switch`, `boot`, `test` and `dry-activate`. Before a
switch, boot or test, the page compares the running system with the flake's closure on the host
with `nix store diff-closures` and `nix path-info -S`, and shows the packages added, removed and
changed and the closure's size before and after; when no package changed but the store paths
differ, it shows `nix-diff`'s account of the derivations. The comparison runs as a job, and a Build
on the host itself compares at once when it ends. When the flake's closure is not in the host's
store yet, the page says so and the switch builds it. The Generations panel lists every generation
of the system profile, rolls back to any of them as a job that records why, and opens the closure
browser: a generation's dependency tree with each path's own and closure size, and its largest
paths. A Build with `build_progress` shows what is building, downloading and done, and its job's
page shows every derivation nix plans to build as a tree table, each under a derivation that needs
it, with the paths it fetches, each one's status and build phase, and how long it took.

A switch is guarded when `pre_switch_checks`, `health_commands`, `health_urls` or `magic_rollback`
is set, and runs as one long run on the switch agent, which must be on the host it activates, so a
guarded switch takes no `target_host`. The pre-switch checks run first, and the first to fail
refuses the switch before anything changes. For `switch` and `test` it then starts a watchdog on
that host in a session of its own, so it outlives the run, the agent and a lost connection. After
the activation the health commands run every `health_period` until they pass, then X-Nix fetches
the health URLs and, once they answer, confirms by touching a file in the watchdog's folder under
`/tmp`. The watchdog rolls back to the previous system when the activation fails, outlasts
`activation_timeout`, or a health check keeps failing for `health_timeout`, and, with
`magic_rollback`, when no confirmation arrives within `confirm_timeout` (plus `health_timeout` when
health checks are set). Without `magic_rollback` an unconfirmed switch is kept. Each refusal and
rollback lands in the job and the events with its reason. On the server's own host the confirmation
means the X-Nix server is still running after the switch, or came back up if the switch restarted it;
on a host switched by its own agent, it means X-Nix still reaches that
agent. While a guarded switch runs, X-Nix polls it every `health_period`, so keep `confirm_timeout`
well above it.

`post_switch` runs after the activation, inside the guarded switch before its health checks, as
root through `sudo -n /bin/sh -c` when `require_sudo` is on, so it can restart a system service such
as a display manager; it runs on the switch agent's host and its status never changes the switch's.
When the host sets `keep_awake`, a switch or rollback holds a `systemd-inhibit --what=idle:sleep --mode=block`
inhibitor on the activated host from its first step, the download from the cache included, until
the job ends however it ends: the inhibitor reads a pipe only the job's own runner holds open, so the
job ending, failing or being stopped releases it, and nothing the switch leaves running keeps it.

A guarded switch whose activation hangs ends once its watchdog gives an outcome, as a failure with
the watchdog's reason, rather than waiting on the hung activation. The watchdog changes nothing while
the switch lock is still held, since the previous system could not activate anyway, and names the
process holding it.

### Stalled and overdue jobs

A job on an agent that prints nothing for five minutes notes, on `@@x-nix-stall` lines in its output,
what it still runs and any file lock one of those programs waits for, with the processes holding
it, and notes again each half hour it stays quiet. A switch that moves to a newer Nix is the usual
case: the new Nix needs the store database to itself to upgrade it, and a long-lived Nix client,
such as an editor's language server, keeps its daemon connection open and the activation waiting.
`close_nix_lock_holders` has the switch stop those holders once it has waited a minute.

A job that runs three times longer than the longest of its owner's last ten successful jobs of its
kind, and at least half an hour (an hour with none to go by), puts a warning on its deployment
naming what it waits for, adds an event to the history, and sends one notification to every channel
under `notifications`:

| Type      | Settings                                                                                       |
|-----------|------------------------------------------------------------------------------------------------|
| `ntfy`    | `topic` or `topic_file`, `url` (default `https://ntfy.sh`), `token` or `token_file`, or `username` with `password` or `password_file`, `priority` (1-5 or a name; by default by the notification's level), `tags`. |
| `webhook` | `url` or `url_file`, `method`, `headers`, `bearer_token` or `bearer_token_file`, and a `payload` template whose `{title}`, `{body}` and `{level}` are filled in; JSON of those three by default. |
| `apprise` | `urls`, or `urls_file` with one per line; needs the `apprise` program on the service's path.   |

```json
"notifications": [{ "type": "ntfy", "topic": "x-nix", "token_file": "/var/lib/x-nix/ntfy-token" }]
```

## Hosts

The config file may list `hosts`, each a machine by the name its agent answers to; a host a
deployment names needs no entry of its own, and the server's own host is the one named by
`X_NIX_SERVER_NAME`. A host holds what is true of the machine whatever runs on it: its agent's key,
how it is woken and kept awake, its Nix store and its boot entries. Every `interval` its agent
reads the store and the boot entries, and the host's page shows them on its Store and Boot tabs,
with Collect Garbage, Reboot and Set next boot, and its agent and wake-on-LAN on its Machine tab. A
deployment's Reboot reboots its host.

| Setting        | Default               | Meaning                                                           |
| -------------- | --------------------- | ----------------------------------------------------------------- |
| `id`           | required              | The name the host's agent answers to.                             |
| `name`         | the id                | What the page calls it.                                           |
| `agent_key`    | none                  | Its agent's public key line (see Agents); none for the server's own host. |
| `wake_on_lan`  | none                  | Its MAC address, or the Wake-on-LAN settings below.               |
| `keep_awake`   | `true` with `wake_on_lan` | Hold off idle and sleep on the host through every job, switch and rollback. |
| `interval`     | `5m`                  | How often the store and boot entries are read.                    |
| `job_poll`     | `30s`                 | How often a running collection is read.                           |
| `require_sudo` | `true`                | Run switch, rollback, reboot, Collect Garbage, Set next boot and `post_switch` under `sudo -n`, and read the boot entries with it first. |
| `gc`           | the defaults below    | How the Nix store is watched, or `false` to leave it alone.       |
| `boot`         | `true`                | Read the boot entries, and let the Boot tab set the next boot.    |

### Store

Every cycle also reads the host's Nix store: how full it is, its path and GC root counts, every
profile's generations, the collection unit and timer, and the last collection's summary from the
journal. The last collection is kept after the journal rotates past it, and Collect Garbage runs the
timer's collection as a job that counts as the last collection once it ends. With `collect_at`, X-Nix
starts that same job each day in place of the timer: a host that is away then collects once it is
back, the timer is expected to be off, and one still on raises a warning, since two schedules would
collect side by side. The store's status is the host's, set by these keys of `gc`:

| Setting              | Default                     | Meaning                                                      |
| -------------------- | --------------------------- | ------------------------------------------------------------ |
| `unit`               | `nix-gc.service`            | The collection unit.                                         |
| `timer`              | `nix-gc.timer`              | The timer that starts it, unless `collect_at` is set.        |
| `store`              | `/nix/store`                | The store whose filesystem is measured.                      |
| `max_age`            | `2w`                        | How long since the last collection before it is stale.       |
| `stale_status`       | `failed`                    | The status a stale collection raises.                        |
| `timer_status`       | `warning`                   | The status a missing or inactive timer raises without `collect_at`. |
| `warning`            | `80`                        | Warn once the store's filesystem is this full, in percent; `null` turns it off. |
| `threshold`          | `90`                        | Fail once it is this full; `null` turns it off.              |
| `max_generations`    | none                        | Warn about a profile keeping more generations than this.     |
| `max_generation_age` | none                        | Warn once the oldest generation kept is older than this.     |
| `gc_bin`             | `nix-collect-garbage`       | The collection program.                                      |
| `gc_args`            | `--delete-older-than 7d`    | Its arguments, which should match the timer's.               |
| `collect_at`         | none                        | The time of day, such as `03:30`, X-Nix collects every day in place of the timer. |

### Boot

Every cycle also reads the host's boot loader: systemd-boot through `bootctl list`, GRUB from its
environment block and `grub.cfg`, or any other EFI loader through `efibootmgr`, with the default
and the one-shot next entry. The Boot tab sets the next boot with the loader's own one-shot tool
(`bootctl set-oneshot`, `grub-reboot` or `efibootmgr --bootnext`), and can reboot into it at once.
Reading `/boot` usually needs root, so the read tries `sudo -n` first and falls back to reading
unprivileged.

## Fleet

The Hosts page runs Build, Switch or Reboot across many deployments at once. Pick them by
checkbox, or search with space-separated terms, each a glob on the id or name (`web-*`) or a
tag (`@canary`); any term matching picks the deployment. No more than `parallel` run at once. Each
host's part is an ordinary job whose trigger names the fleet run, and the run itself is kept in the
database and advanced every few seconds, so it carries on after a restart of X-Nix.

A staged rollout goes through its stages in order, each a selector, with hosts no stage names in a
last stage; with no stages it goes one host at a time. A staged switch waits for each host to read
as in sync against an evaluation made after the switch before the next host starts, and the first
failure, drift or `sync_timeout` stops the rollout. The Hosts table shows each
host's NixOS version, when it last switched, its pin, and whether it waits on a rebuild (drift) or a
sync (an evaluation running or due). The config file's `fleet` object sets:

| Setting        | Default | Meaning                                                          |
| -------------- | ------- | ---------------------------------------------------------------- |
| `parallel`     | `4`     | How many deployments a run acts on at once; the page may lower it. |
| `stages`       | none    | The stage selectors a staged rollout goes through, such as `["@canary", "@web"]`. |
| `sync_timeout` | `30m`   | How long a staged switch may take to read as in sync.           |

## Push webhook

With `X_NIX_WEBHOOK_SECRET_FILE` set, `POST /api/webhook` takes push deliveries without signing in and
evaluates every deployment whose flake follows the pushed repository and branch at once, instead of
waiting for `eval_interval`, and reads every such flake again. Every flake with a watched input
following the pushed branch updates at once, so a webhook on an input's own repository skips even the
input check's wait. A `github:`, `gitlab:` or `sourcehut:` flake, or a `git+https://` or
`git+ssh://` one, follows its repository; a flake naming no branch follows the default branch, and a
pinned one follows nothing. Pushes to one deployment within `X_NIX_WEBHOOK_DEBOUNCE` start one
evaluation, and an address sending ten unsigned deliveries is turned away for five minutes.

- **GitHub**: Settings → Webhooks → Add webhook, payload URL `https://nix.example.org/api/webhook`,
  content type `application/json`, the secret file's contents as the secret, just the push event.
  X-Nix checks `X-Hub-Signature-256`.
- **Forgejo or Gitea**: Settings → Webhooks → Add webhook → Forgejo (or Gitea), the same URL,
  `POST` with `application/json`, the secret as the secret, push events. Forgejo's "Authorization
  header" may instead hold `Bearer <secret>`.
- **GitLab**: the secret token goes in `X-Gitlab-Token`.

## Caches

A deployment naming a cache by its id in `cache` is built by it: the deployment's Build builds its
configuration with the cache's settings on the cache's hosts, as the deployment's own job and at its pin, and a switch
built there fetches from the cache's `cache_url`. Such a
deployment is also evaluated by the cache: it takes its target, the flake's revision and when the
flake last changed from the cache's last check of its configuration instead of evaluating on its own,
so the fleet is evaluated once per check. Check now, a push and a fleet run's sync ask the cache to
check at once. A pinned deployment evaluates on its own, as its pin is not what the cache builds.

The config file may also list `caches`, each a host that builds closures for the fleet and the Attic
cache they are pushed to. Every `interval` the host runs one check: it evaluates every tracked
target from the flake, sees whether that store path is built, and asks the cache which of the
closure's own paths it lacks, leaving out paths an upstream cache signed. The check runs as a long
run, and the previous reading stands until it ends. Each target can be built or pushed by hand;
the job checks that target again once it ends. Pushing a target not built from the latest flake
builds it instead, and the build pushes it. Cache ids share one space with deployment ids.

Build all builds every target in one job, the way nix-fast-build does: `nix-eval-jobs` evaluates
all of them in one parallel pass, each target's build starts as soon as its own evaluation ends, and
with a `push_command` each is pushed once built. It ends by checking every target, and the cache's
page lists how each one ended and how long its build took. The modules put `nix-eval-jobs` on the
PATH; elsewhere, a host without it fails the job with a message saying so.

| Setting          | Default                           | Meaning                                                                 |
| ---------------- | --------------------------------- | ----------------------------------------------------------------------- |
| `id`             | required                          | Letters, digits, `-` and `_`.                                           |
| `name`           | the id                            | What the page calls it.                                                 |
| `host`           | the server's own host             | The host that evaluates, builds and pushes, or a list of them most preferred first; each needs `build_root_dir` and what `push_command` uses. |
| `flake`          | `/etc/nixos`                      | The flake reference.                                                    |
| `configurations` | none                              | `nixosConfigurations` names, tracked by their system toplevel.          |
| `installables`   | none                              | Any other derivation, as a name and its flake attribute.                |
| `cache_url`      | required                          | The cache, as `nix path-info --store` takes it.                         |
| `upstream_keys`  | `cache.nixos.org-1`               | Signing keys of upstream caches, whose paths Attic never stores.        |
| `missing_limit`  | `50`                              | How many missing paths each target lists.                               |
| `pending_status` | `warning`                         | The status of a target not built, or not fully pushed.                  |
| `interval`       | `1h`                              | How often the check runs.                                               |
| `job_poll`       | `30s`                             | How often a running job is read.                                        |
| `timeout`        | `30m`                             | How long a check may run.                                               |
| `nix_bin`        | `nix`                             | The nix program.                                                        |
| `nix_args`       | flakes enabled                    | Arguments before every nix command.                                     |
| `build_args`     | `--keep-going --print-build-logs` | Arguments for Build.                                                    |
| `build_root_dir` | none                              | Link each build here, so it stays rooted until the next replaces it.    |
| `build_links`    | `<cache id>-<target>`             | Each target's link name under `build_root_dir`.                         |
| `build_at`       | none                              | Run Build all daily at this local time, such as `04:00`, in place of that cycle's check. |
| `push_command`   | none                              | Run with a store path appended to push it; Build also pushes with it.   |
| `retry_push`     | `true`                            | After a check, push again the first target built here whose closure the cache still lacks paths of, so a failed upload is retried every `interval`. |
| `drop_pushed`    | none                              | Targets kept only in the cache: once fully pushed, the root is removed and the closure's path list kept beside it as `<link>.closure`. |
| `eval_jobs_bin`  | `nix-eval-jobs`                   | The program Build all evaluates every target with.                      |
| `eval_workers`   | `4`                               | How many targets Build all evaluates at once.                           |
| `info_url`       | `<cache_url>/nix-cache-info` for an http cache | The cache server's nix-cache-info, or `false` to not read it.  |
| `health_url`     | none                              | The cache server's health check; any 2xx answer is healthy.           |
| `metrics_url`    | none                              | The cache server's Prometheus metrics, such as `/metrics`.              |
| `size_metric`    | none                              | The metric whose samples add up to the cache's size in bytes.           |
| `server_status`  | `warning`                         | The status an unreachable or unhealthy cache server raises.             |

Every cycle the X-Nix server also fetches the cache server's own `info_url`, `health_url` and
`metrics_url`, each named or derived, and the cache's page shows what they answered with a status of
its own, apart from the targets': the store directory and priority, whether it reports itself healthy,
its size from `size_metric`, and every metric ending in `_bytes`. A cache needing a token to read is
not read with one, so it shows the status it answered with.

## Provisioning

The Provision page installs NixOS on a reachable Linux host over SSH with
[nixos-anywhere](https://github.com/nix-community/nixos-anywhere): it kexecs the target into an
installer, partitions its disks with the configuration's disko layout, installs the flake's
`nixosConfigurations` attribute and reboots, or stops after partitioning. The page names the new
host, the target's SSH address, user and port, the flake and attribute, and the host that runs
nixos-anywhere, and it starts only once the target's address is typed to confirm its disks are
wiped. The install is a long run that survives a restart of X-Nix and lands in the job history.

A full install also generates the new host's `hardware-configuration.nix` with
`nixos-generate-config` on the target, shown with the install for you to copy into the flake, and
makes the new host's agent key. The private half is piped to the install and placed on the new
system at `agent_key_path` through `--extra-files`; X-Nix keeps only the public line. Once the
install succeeds X-Nix accepts that key, so the agent logs in on first boot, provided the
configuration already enables `services.x-nix-agent` with that `keyFile` (the page shows the
lines). The page then shows what to add to the config to declare the key and watch the host as a
deployment; X-Nix never writes the config file itself. A key the config declares for
the same host wins. A made key shows on the Provision page until the config names its host, then on
the host's Machine tab, and either can forget it.

The page also builds install media for a deployment or any flake and attribute: an installer ISO,
the netboot (iPXE) files or a kexec tarball. It builds the configuration's own
`system.build.isoImage`, `netbootRamdisk` or `kexecTarball` when it has one, and otherwise the
configuration extended with nixpkgs' installer module. Media is built on the server's own host,
linked under `media_root_dir` so it stays in the store until removed from the page, and each file
downloads from inside the built store path only.

These keys of `provisioning` in the config file set it up:

| Setting               | Default                   | Meaning                                                              |
| --------------------- | ------------------------- | -------------------------------------------------------------------- |
| `ssh_key`             | none                      | The private key nixos-anywhere logs in to targets with, as a path on the host that runs it; installs are refused without it. |
| `install_agent`       | the server's own host     | The host that runs nixos-anywhere unless an install names another.   |
| `nixos_anywhere_bin`  | `nixos-anywhere`          | The nixos-anywhere program.                                          |
| `nixos_anywhere_args` | none                      | Extra arguments for nixos-anywhere, such as `["--build-on", "remote"]`. |
| `agent_key_path`      | `/etc/x-nix-agent/key`    | Where the new host's agent key is placed on its disk.                |
| `agent_url`           | none                      | The server's agent endpoint, for the snippets the page shows.        |
| `nix_bin`             | `nix`                     | The nix program media builds run.                                    |
| `nix_args`            | flakes enabled            | Arguments before every nix command.                                  |
| `media_root_dir`      | `<X_NIX_STATE_DIR>/media` | Where each built medium is linked.                                   |
| `job_poll`            | `30s`                     | How often a running install or media build is read.                  |
## Builds

The Builds tab of the Jobs page lists every finished build, newest first and filtered by deployment or cache and
target: a deployment's Build, a cache target's Build, and each target of a Build all. Each shows its
result, how long it took, its store path, a link to its job and so its whole log, and the products
its store path lists in Hydra's `nix-support/hydra-build-products`, read once when the build ends. A
product that is a regular file inside its build's store path, such as an installer ISO, downloads
through the signed-in page: the host that built it checks again that the file still lies inside that
store path, then sends it in pieces through its agent. A product collected since reads as gone.
Builds that ended before this history existed are only in the job history.

## Agents

Every host other than the server's own runs `x-nix-agent`, which dials out to the server's
`/api/agent` over a WebSocket, so nothing listens on the host. It logs in with the host's own
ed25519 key: the server sends a nonce, the agent signs it, and the server checks the signature
against the public key line the config file declares as that host's `agent_key`:

```json
{ "hosts": [{ "id": "odin", "agent_key": "ssh-ed25519 AAAA... x-nix-agent-odin" }] }
```

Make each key with `ssh-keygen -t ed25519 -N "" -C x-nix-agent-<host>` and keep the private half
only on its host. The agent performs operations and long runs for the server as the `x-nix-agent`
user. The server never sends it a shell script: each operation, such as reading the host, evaluating,
building or switching, names what to do as plain data, and the agent carries it out in TypeScript,
running only programs with their arguments. The only shell left runs the commands written into the
config, such as `pre_switch_checks`, `health_commands`, `post_switch` and `push_command`, each with
`/bin/sh -c` exactly as written. A job's page shows its operation, and its output shows each program
as it starts. Long runs run in a runner process of their own, outlive the agent and are followed
again once it reconnects. The protocol is X-Backups'
agent protocol without its streams. The Overview counts the hosts whose agent is not
connected and lists them under Needs attention, and each host's Machine tab shows its agent.

### Wake-on-LAN

A host with `wake_on_lan` is woken before an operation on it when its agent is not connected:
X-Nix sends a magic packet, from the server or from the agent `via` names, which sends it itself, and waits for the agent
to dial in, then starts the operation. A job appears at once with the progress `Waking <host>` and starts its run once the agent
is back, or fails with the reason when it does not come back within `timeout`; Reboot, Set next boot
and a download wait for the host instead. Update, Build, switches, rollbacks, Collect Garbage, Reboot, Set next boot, a cache's
Build, Push and Build all, an install or media build run by that host, and a build product's download
all wake it, whether started by hand, on a schedule or by a fleet run. The periodic read, evaluation
and cache check never do, so a sleeping host reads as unreachable until something wakes it. With the
host's `keep_awake`, every job on it, woken or not, holds a `systemd-inhibit --what=idle:sleep`
inhibitor there until it ends, so the host's own idle suspend cannot cut it off. `wake_on_lan` is
the host's MAC address, or an object of these settings:

```json
{ "hosts": [{ "id": "thor", "wake_on_lan": "aa:bb:cc:dd:ee:ff" }, { "id": "odin", "wake_on_lan": { "mac": "aa:bb:cc:dd:ee:01", "broadcast": "192.168.1.255" } }] }
```

| Setting     | Default           | Meaning                                                       |
| ----------- | ----------------- | ------------------------------------------------------------- |
| `mac`       | required          | The MAC address of the network card that wakes the host.      |
| `broadcast` | `255.255.255.255` | Where the packet is sent, such as the host's subnet broadcast. |
| `port`      | `9`               | The UDP port the packet is sent to.                           |
| `timeout`   | `3m`              | How long to wait for the agent before the operation fails.    |
| `via`       | the server        | The host whose agent sends the packet with `wakeonlan`, for a host on another network. |

### Pull mode

An agent given `X_NIX_AGENT_PULL_FILE`, a JSON file of the settings below, deploys from Git on its own
once the server has been unreachable for `after`: every `interval` it asks its remotes in order for
the head of their branch with `git ls-remote`, and when it has moved, runs
`nixos-rebuild switch --flake 'git+<url>?ref=refs/heads/<branch>&rev=<revision>#<configuration>'` as a
long run, logging what it does. The first revision it sees is only noted, so turning pull mode on
never switches by itself. Once the server is back, the agent reports each switch, which joins the
job history of every deployment on that host with the trigger `agent pull`.

| Setting         | Default         | Meaning                                                        |
| --------------- | --------------- | -------------------------------------------------------------- |
| `remotes`       | required        | `{ "url", "branch" }` objects (branch `main` by default), or bare URLs, asked in order; https://, ssh://, git:// or file://. |
| `after`         | `15m`           | How long the server must be unreachable before the agent deploys. |
| `interval`      | `5m`            | How often the remotes are asked; at least 30 seconds.          |
| `configuration` | the agent's host | The `nixosConfigurations` attribute.                          |
| `rebuild_bin`   | `nixos-rebuild` | The nixos-rebuild program.                                     |
| `rebuild_args`  | none            | Arguments after the switch.                                    |
| `require_sudo`  | `true`          | Run the switch under `sudo -n`.                                |
| `git_bin`       | `git`           | The git program.                                               |

## Package

`nix build` builds the `x-nix` program from the flake, and `nixosModules.default` runs it as
`services.x-nix`, whose `hosts`, `flakes`, `deployments` and `caches` attribute sets take the settings above by id,
whose `provisioning` takes the Provisioning settings, whose `fleet` takes the fleet settings, and whose `notifications` takes the notification channels; `webhookSecretFile` and `webhookDebounce` set the push webhook, and `sudoRules` the
sudo rules below. Both modules put nixos-anywhere and ssh on the PATH of the commands they run. `nix build .#agent`
builds the agent, and `nixosModules.agent` runs it as `services.x-nix-agent` with `url`, `keyFile`, `host` and
`sudoRules`, and pull mode under `pull` with `enable`, `remotes`, `after`, `interval`, `configuration`, `rebuildArgs`
and `requireSudo`:

```nix
services.x-nix = {
  enable = true;
  passwordHashFile = config.sops.secrets.x_nix_password_hash.path;
  deployments.workstation = {
    flake = "github:example/nixos-config";
    configuration = "workstation";
  };
};

# On every other host:
services.x-nix-agent = {
  enable = true;
  url = "wss://nix.example.org/api/agent";
  keyFile = config.sops.secrets.x_nix_agent_key.path;
  pull = {
    enable = true;
    remotes = [
      { url = "https://github.com/example/nixos-config"; }
      { url = "https://git.example.org/example/nixos-config"; }
    ];
  };
};
```

The service runs as the `x-nix` user, and the agent as `x-nix-agent`, each in the `systemd-journal`
group so it can read the last collection from the journal. Both modules ship NOPASSWD sudo rules for
that user covering every command X-Nix runs under `sudo -n` (see `nix/sudo-rules.nix`), so a host
needs nothing beyond enabling the module: nixos-rebuild in each mode with `--flake` (pull mode's
`git+` switch included), a switch that fetches what another host built (`nix-env -p /nix/var/nix/profiles/system --set
/nix/store/*` and `/nix/store/*-nixos-system-*/bin/switch-to-configuration` in each mode), rollback
and the watchdog (`nix-env ... --switch-generation *` and the system profile's
`switch-to-configuration switch`), a flake's Update on a local checkout (`nix ... flake update --flake
*`), `systemctl reboot`, `nix-collect-garbage`, the boot loader's reads and one-shot setters
(`bootctl list --json=short`, `cat /boot/grub/grub.cfg`, `grub-editenv list`, `bootctl
set-oneshot`, `grub-reboot`, `efibootmgr --bootnext`), the `keep_awake` inhibitors,
`/bin/sh -c *` for `post_switch`, and `ssh` for `target_host`. Each command is matched by its path
under `/run/current-system/sw/bin`, where both services find it. The service user activates whole
systems and so is root-equivalent, which is why some rules take any arguments. Set `sudoRules =
false` on either module to write your own, such as for a `rebuild_bin` outside the system profile.
Both services carry `nix-diff` on their PATH for the derivation diff; a host without it says so on
the page.

## License

GPL-3.0-or-later.
