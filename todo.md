# X-Nix

A web-based NixOS management portal that takes over the NixOS functions now in X-Monitor. X-Monitor keeps
only the job of watching X-Nix itself, as it does for X-Backups.

## Stack

- A TypeScript web app.
- Themed with Halon, as X-Backups is: a `halon-tokens.css` holding every color for the light and
  dark schemes, following `prefers-color-scheme`, and a `halon.css` with the component rules, so no
  other file states a literal color. Sources: `THEME-DESIGN-GUIDE.md` in `../../Coding/Halon`, and
  X-Backups' `src/web/halon-tokens.css` and `src/web/halon.css`.

## Tasks

1. [ ] **Port X-Monitor's NixOS functions.** Bring every NixOS management function across from
   X-Monitor, then remove it there. Sources, under `../X-Monitor/x_monitor/plugins/`:
   - `nixos_upgrade.py`: deployment drift, comparing `/run/current-system` with what
     `<flake>#nixosConfigurations.<host>.config.system.build.toplevel` evaluates to, plus the
     running generation, NixOS version, flake revision (`nix flake metadata`) and input ages
     (`max_input_age`).
     - Evaluation as a detached job that survives a restart, with `eval_interval`,
       `retry_interval`, `eval_timeout` and `job_poll`; `eval_agent` evaluates on another host.
     - Actions: `nix flake update`, build, `nixos-rebuild switch --flake`, reboot. Every action
       lands in the job history with its output.
     - A `github:` flake with `push_ssh_key` is updated in a fresh clone, committed and pushed
       back over SSH (`commit_author`, `commit_message`).
     - Remote building and activation: `build_host`, `build_agent` (one host warms the cache for
       the rest), `build_root_dir` (one GC root per target, replaced by the next build),
       `cache_url` (skip a build already in the cache), `switch_agent` with `target_host`.
     - `auto_switch` after `auto_switch_after`, once per closure and only when the flake changed
       since the running generation; `update_at` and `build_at` daily slots, with a missed slot
       run once on return; `switch_wrapper` and `post_switch` hooks; `require_sudo`, `nix_bin`,
       `rebuild_bin`, `nix_args`, `rebuild_args`.
   - `base/nixos_boot.py` and the NixOS part of `reboot_required.py`: reboot needed when the
     booted and current `initrd`, `kernel`, `kernel-modules` or `systemd` differ.
   - `nix_gc.py`: store size and path count, every profile's generations, the `nix-gc` unit and
     timer, the last collection's freed space from the journal (kept after the journal rotates),
     `max_generations` and `max_generation_age`, and a `nix-collect-garbage` action.
   - `attic_push.py`: whether each tracked closure is built from the flake's latest revision and
     fully pushed to an Attic cache (upstream-signed paths left out), per-target Build and Push
     actions, `build_links`, and `drop_pushed` to keep a closure only in the cache.
   - `host_control.py`, where it concerns boot: boot entries, the default and one-shot next-boot
     entry, reboot.
   - The Fleet view's "NixOS deployments" tiles (`../X-Monitor/x_monitor/core/ui/views/fleet.py`):
     one per deployment with its generation and in-sync, drifting or failed state.
   - The agent's NixOS module (`../X-Monitor/nix/agent-module.nix`): detached jobs such as
     `nixos-rebuild switch` outliving the agent unit, secrets read at runtime rather than from the
     store, `/run/wrappers` first on `PATH`.
   - Bring the matching tests under `../X-Monitor/tests/plugins/` across as specifications.

2. [ ] **Assess existing NixOS tooling.** Survey web and desktop software for NixOS deployment,
   installation and orchestration, and list the features worth integrating, each with where it
   comes from. Candidates to start from:
   - Deployment and orchestration: Colmena, deploy-rs, morph, NixOps, krops, bento, comin
     (pull-based GitOps), Clan (clan.lol, including its GUI), Cachix Deploy, FlakeHub
     (`fh apply`), nixos-anywhere.
   - Installation and provisioning: the graphical NixOS installer (Calamares), nixos-anywhere,
     disko, nixos-generators, nixos-images, SnowflakeOS' installer.
   - Configuration editing and packages: nixos-conf-editor, nix-software-center, SnowflakeOS'
     Snow Store and nix-editor, NixOS Search and mynixos.com (option and package browsing).
   - Build, cache and CI: Hydra, Garnix, Attic, Cachix, nix-fast-build, Harmonia.
   - Inspection: nh (`nh os switch`, `nh clean`), nvd and nix-diff (generation diffs),
     nix-output-monitor, nix-tree.
   - General fleet managers for the parts Nix tools lack: Cockpit, Webmin, Ubuntu Landscape,
     Uyuni, Ansible Semaphore and AWX.
