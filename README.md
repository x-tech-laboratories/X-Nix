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

Hosts are named by agent. Only the server's own host has one so far, so a deployment, `eval_agent`,
`build_agent` or `switch_agent` naming another host reads as unreachable.

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

## Package

`nix build` builds the `x-nix` program from the flake, and `nixosModules.default` runs it as
`services.x-nix`, whose `deployments` and `caches` attribute sets take the settings above by id:

```nix
services.x-nix = {
  enable = true;
  passwordHashFile = config.sops.secrets.x_nix_password_hash.path;
  deployments.workstation = {
    flake = "github:example/nixos-config";
    configuration = "workstation";
  };
};
```

The service runs as the `x-nix` user, in the `systemd-journal` group so it can read the last
collection from the journal. Update, switch, reboot and Collect Garbage run under `sudo -n` unless
`require_sudo` is off, so grant that user NOPASSWD rules for exactly the commands its deployments
run, such as `/run/current-system/sw/bin/nixos-rebuild switch --flake <flake> --refresh`,
`/run/current-system/sw/bin/systemctl reboot`,
`/run/current-system/sw/bin/nix-collect-garbage --delete-older-than 7d`, and for systemd-boot
`/run/current-system/sw/bin/bootctl list --json=short` and
`/run/current-system/sw/bin/bootctl set-oneshot *`.

## License

GPL-3.0-or-later.
