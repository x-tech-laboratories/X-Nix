# X-Nix

A web portal for managing NixOS deployments: drift against the flake, updates, builds, switches,
the Nix store, the Attic cache and boot entries.

## Development

```sh
nix develop           # or nix-shell
npm install
npm run hash-password # writes the login's hash, which the dev server reads
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
| `X_NIX_PASSWORD_HASH_FILE` | required | The login password's hash, from `npm run hash-password`. |
| `X_NIX_CONFIG`      | none          | The config file naming the deployments.  |
| `X_NIX_STATE_DIR`   | `state`       | Where the database and job output live.  |
| `X_NIX_SERVER_NAME` | the hostname  | What the page calls the server's machine. |

## Deployments

The config file lists `deployments`, each a NixOS host and the flake that describes it; see
`config.example.json`. Every `interval` X-Nix reads the host's running system, and every
`eval_interval` it evaluates `<flake>#nixosConfigurations.<configuration>.config.system.build.toplevel`
and compares the two store paths. Update, build, switch, garbage collection and evaluation run as
long runs that survive a restart of X-Nix; each lands in the job history with its output.

With `switch_from_cache`, Switch never evaluates or builds on the host: it takes the store path of the latest
successful evaluation, which may run on `eval_agent`, fetches it with `nix copy --from <cache_url>`, sets it as the
system profile's next generation and runs its `switch-to-configuration switch`. The closure must already be in the
cache, built and pushed by a cache's Build or Build all, and signed by a key the host trusts; `build_host`,
`target_host`, `rebuild_bin` and `rebuild_args` do not apply to it.

Hosts are named by agent: the server's own host is served by the server itself, and any other host
by its agent (see Agents). A deployment, `eval_agent`, `build_agent` or `switch_agent` naming a host
whose agent is not connected reads as unreachable.

| Setting             | Default                           | Meaning                                                              |
| ------------------- | --------------------------------- | -------------------------------------------------------------------- |
| `id`                | required                          | Letters, digits, `-` and `_`.                                        |
| `name`              | the id                            | What the page calls it.                                              |
| `host`              | the server's own host             | The host that is read, rebooted, and by default runs every job.      |
| `flake`             | `/etc/nixos`                      | The flake reference.                                                 |
| `configuration`     | the host's hostname               | The `nixosConfigurations` attribute.                                 |
| `interval`          | `5m`                              | How often the host is read.                                          |
| `eval_interval`     | `1h`                              | How often the flake is evaluated.                                    |
| `retry_interval`    | `15m`                             | How soon a failed evaluation is tried again.                         |
| `eval_timeout`      | `10m`                             | How long an evaluation may run.                                      |
| `job_poll`          | `30s`                             | How often a running job is read.                                     |
| `max_input_age`     | none                              | Warn once the oldest locked input is older than this.                |
| `drift_status`      | `warning`                         | The status drift raises.                                             |
| `reboot_status`     | `warning`                         | The status a needed reboot raises.                                   |
| `require_sudo`      | `true`                            | Run update, switch and reboot under `sudo -n`.                       |
| `nix_bin`           | `nix`                             | The nix program.                                                     |
| `rebuild_bin`       | `nixos-rebuild`                   | The nixos-rebuild program.                                           |
| `nix_args`          | flakes enabled                    | Arguments before every nix command.                                  |
| `rebuild_args`      | none                              | Arguments after the switch.                                          |
| `eval_agent`        | the host                          | The host that evaluates, for a host too small to evaluate itself.    |
| `build_host`        | none                              | `--build-host` for the switch.                                       |
| `build_agent`       | the switch agent                  | The host that runs Build, so one host can warm the cache for others. |
| `build_args`        | `--keep-going --print-build-logs` | Arguments for Build.                                                 |
| `build_root_dir`    | none                              | Keep each build as one garbage-collector root here.                  |
| `cache_url`         | none                              | Skip a build this cache already holds.                               |
| `switch_agent`      | the host                          | The host that runs update and switch.                                |
| `switch_from_cache` | `false`                           | Switch by fetching the evaluated closure from `cache_url` and activating it, for a host too small to evaluate or build. |
| `target_host`       | none                              | `--target-host` for the switch.                                      |
| `auto_switch`       | `false`                           | Switch by itself once drift lasts `auto_switch_after`.               |
| `auto_switch_after` | `30m`                             | How long drift lasts before an automatic switch.                     |
| `update_at`         | none                              | Update the flake daily at this local time, such as `02:00`.          |
| `build_at`          | none                              | Build daily at this local time.                                      |
| `switch_wrapper`    | none                              | A command the switch runs inside, outside sudo.                      |
| `post_switch`       | none                              | A command run after the switch, which keeps the switch's status.     |
| `push_ssh_key`      | none                              | The key a `github:` flake's update pushes with.                      |
| `commit_author`     | `X-Nix <x-nix@localhost>`         | The update commit's author.                                          |
| `commit_message`    | `chore(flake): update inputs`     | The update commit's message.                                         |
| `gc`                | the defaults below                | How the host's Nix store is watched, or `false` to leave it alone.   |
| `boot`              | `true`                            | Read the host's boot entries, and let the Boot page set the next boot. |

### Store

Every cycle also reads the host's Nix store: how full it is, its path and GC root counts, every
profile's generations, the collection unit and timer, and the last collection's summary from the
journal. The last collection is kept after the journal rotates past it, and Collect Garbage runs the
timer's collection as a job that counts as the last collection once it ends. The store has its own
status, apart from the deployment's, set by these keys of `gc`:

| Setting              | Default                     | Meaning                                                      |
| -------------------- | --------------------------- | ------------------------------------------------------------ |
| `unit`               | `nix-gc.service`            | The collection unit.                                         |
| `timer`              | `nix-gc.timer`              | The timer that starts it.                                    |
| `store`              | `/nix/store`                | The store whose filesystem is measured.                      |
| `max_age`            | `2w`                        | How long since the last collection before it is stale.       |
| `stale_status`       | `failed`                    | The status a stale collection raises.                        |
| `timer_status`       | `warning`                   | The status a missing or inactive timer raises.               |
| `warning`            | `80`                        | Warn once the store's filesystem is this full, in percent; `null` turns it off. |
| `threshold`          | `90`                        | Fail once it is this full; `null` turns it off.              |
| `max_generations`    | none                        | Warn about a profile keeping more generations than this.     |
| `max_generation_age` | none                        | Warn once the oldest generation kept is older than this.     |
| `gc_bin`             | `nix-collect-garbage`       | The collection program.                                      |
| `gc_args`            | `--delete-older-than 7d`    | Its arguments, which should match the timer's.               |

### Boot

Every cycle also reads the host's boot loader: systemd-boot through `bootctl list`, GRUB from its
environment block and `grub.cfg`, or any other EFI loader through `efibootmgr`, with the default
and the one-shot next entry. The Boot page sets the next boot with the loader's own one-shot tool
(`bootctl set-oneshot`, `grub-reboot` or `efibootmgr --bootnext`), and can reboot into it at once.
Reading `/boot` usually needs root, so the read tries `sudo -n` first and falls back to reading
unprivileged.

## Caches

The config file may also list `caches`, each a host that builds closures for the fleet and the Attic
cache they are pushed to. Every `interval` the host runs one check: it evaluates every tracked
target from the flake, sees whether that store path is built, and asks the cache which of the
closure's own paths it lacks, leaving out paths an upstream cache signed. The check runs as a long
run, and the previous reading stands until it ends. Each target can be built or pushed by hand;
the job checks that target again once it ends. Cache ids share one space with deployment ids.

Build all builds every target in one job, the way nix-fast-build does: `nix-eval-jobs` evaluates
all of them in one parallel pass, each target's build starts as soon as its own evaluation ends, and
with a `push_command` each is pushed once built. It ends by checking every target, and the cache's
page lists how each one ended and how long its build took. The modules put `nix-eval-jobs` on the
PATH; elsewhere, a host without it fails the job with a message saying so.

| Setting          | Default                           | Meaning                                                                 |
| ---------------- | --------------------------------- | ----------------------------------------------------------------------- |
| `id`             | required                          | Letters, digits, `-` and `_`.                                           |
| `name`           | the id                            | What the page calls it.                                                 |
| `host`           | the server's own host             | The host that evaluates, builds and pushes.                             |
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
| `push_command`   | none                              | Run with a store path appended to push it; Build also pushes with it.   |
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
`nixos-generate-config` on the target, shown with the install or written to a path on the host
that runs nixos-anywhere, and makes the new host's agent key. The private half is piped to the
install and placed on the new system at `agent_key_path` through `--extra-files`; X-Nix keeps only
the public line. Once the install succeeds X-Nix accepts that key, so the agent logs in on first
boot, provided the configuration already enables `services.x-nix-agent` with that `keyFile` (the
page shows the lines). The page then shows what to add to the config to declare the key and watch
the host as a deployment; X-Nix never writes the config file itself. A key the config declares for
the same host wins, and a made key can be forgotten from the page.

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

The Builds page lists every finished build, newest first and filtered by deployment or cache and
target: a deployment's Build, a cache target's Build, and each target of a Build all. Each shows its
result, how long it took, its store path, a link to its job and so its whole log, and the products
its store path lists in Hydra's `nix-support/hydra-build-products`, read once when the build ends. A
product that is a regular file inside its build's store path, such as an installer ISO, downloads
through the logged-in page: the host that built it checks again that the file still lies inside that
store path, then sends it in pieces through its agent. A product collected since reads as gone.
Builds that ended before this history existed are only in the job history.

## Agents

Every host other than the server's own runs `x-nix-agent`, which dials out to the server's
`/api/agent` over a WebSocket, so nothing listens on the host. It logs in with the host's own
ed25519 key: the server sends a nonce, the agent signs it, and the server checks the signature
against the public key line the config file declares for that host under `agents`:

```json
{ "agents": { "odin": "ssh-ed25519 AAAA... x-nix-agent-odin" } }
```

Make each key with `ssh-keygen -t ed25519 -N "" -C x-nix-agent-<host>` and keep the private half
only on its host. The agent runs commands and long runs for the server as the `x-nix-agent` user;
long runs outlive the agent and are followed again once it reconnects. The protocol is X-Backups'
agent protocol without its streams. The Overview lists each declared host and whether its agent is
connected.

## Package

`nix build` builds the `x-nix` program from the flake, and `nixosModules.default` runs it as
`services.x-nix`, whose `deployments` and `caches` attribute sets take the settings above by id,
whose `provisioning` takes the Provisioning settings, and whose `agents` takes each host's key line.
Both modules put nixos-anywhere and ssh on the PATH of the commands they run. `nix build .#agent` builds the agent, and
`nixosModules.agent` runs it as `services.x-nix-agent` with `url`, `keyFile` and `host`:

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
};
```

The service runs as the `x-nix` user, in the `systemd-journal` group so it can read the last
collection from the journal. Update, switch, reboot and Collect Garbage run under `sudo -n` unless
`require_sudo` is off, so grant that user, or `x-nix-agent` on a host with an agent, NOPASSWD rules for exactly the commands its deployments
run, such as `/run/current-system/sw/bin/nixos-rebuild switch --flake <flake> --refresh`,
`/run/current-system/sw/bin/systemctl reboot`,
`/run/current-system/sw/bin/nix-collect-garbage --delete-older-than 7d`, with `switch_from_cache`
`/run/current-system/sw/bin/nix-env -p /nix/var/nix/profiles/system --set /nix/store/*` and
`/nix/store/*/bin/switch-to-configuration switch`, and for systemd-boot
`/run/current-system/sw/bin/bootctl list --json=short` and
`/run/current-system/sw/bin/bootctl set-oneshot *`.

## License

GPL-3.0-or-later.
