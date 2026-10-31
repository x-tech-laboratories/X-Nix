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
and compares the two store paths. Update, build, switch and evaluation run as long runs that
survive a restart of X-Nix; each lands in the job history with its output.

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

## Package

`nix build` builds the `x-nix` program from the flake, and `nixosModules.default` runs it as
`services.x-nix`, whose `deployments` attribute set takes the settings above by id:

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

The service runs as the `x-nix` user. Update, switch and reboot run under `sudo -n` unless
`require_sudo` is off, so grant that user NOPASSWD rules for exactly the commands its deployments
run, such as `/run/current-system/sw/bin/nixos-rebuild switch --flake <flake> --refresh` and
`/run/current-system/sw/bin/systemctl reboot`.

## License

GPL-3.0-or-later.
