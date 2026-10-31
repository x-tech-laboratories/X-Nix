# X-Nix

## Tasks

Features worth taking from existing NixOS tooling, from a survey of deployment, installation,
configuration, cache and fleet tools. Each names where it comes from. X-Nix already has drift,
evaluation, update, build, switch, reboot, remote build and activation, Attic push, garbage
collection, boot entries and agents, so those are left out.

1. [ ] **Safer switches.**
   - Automatic rollback when the switched host stops answering: the agent waits for X-Nix to
     confirm it can still reach the host after activation, and rolls back to the previous
     generation if no confirmation arrives within a timeout (deploy-rs' magic rollback, with
     `confirmTimeout` and `activationTimeout`).
   - Health checks after a switch: commands run on the host and HTTP checks run from X-Nix,
     repeated every `period` until they pass, with a failure rolling back (morph's health checks;
     Cachix Deploy's rollback script, where a non-zero exit rolls back).
   - Checks before a switch, run against the host before anything changes (morph's pre-deploy
     checks).
   - Switch modes besides `switch`: `boot`, `test` and `dry-activate` (`nixos-rebuild`, also
     `fh apply nixos`).
   - A Rollback action to any earlier generation, not only the previous one (deploy-rs,
     `nixos-rebuild --rollback`).

2. [ ] **See what a switch changes before making it.**
   - A package diff between the running generation and the built one: added, removed and
     upgraded packages and closure size change, shown before Switch and kept in the job history
     (nvd, and nh's `os switch`, which now uses dix and diffs remote builds too).
   - A derivation-level diff for when the package diff is empty but the store path still
     differs (nix-diff).
   - A confirmation step that shows that diff before switching (nh's `os switch`).
   - A closure browser: a generation's dependency tree with each path's own and closure size,
     to find what makes a closure large (nix-tree).
   - Live build progress: which derivations are building, downloading and done, rather than raw
     log lines (nix-output-monitor).

3. [ ] **Fleet-wide operations.**
   - Act on many deployments at once, selected by name glob or by tag, with a cap on how many
     run in parallel (Colmena's `--on` with `@tag` and `--parallel`; morph's tag selection).
   - Staged rollouts: switch one tag, wait for its health checks, then the next (Cachix Deploy
     and comin's testing branches, done in X-Nix's own scheduler).
   - Fleet status at a glance: time since each host last updated, its NixOS version and whether
     it is waiting on a rebuild or a sync (bento's `bento status`).
   - Deploy a pinned flake revision or tag rather than the branch head, so a rollback names a
     fixed version (FlakeHub's SemVer releases with `fh apply`).

4. [ ] **Pull-based and push-triggered deployment.**
   - Let an agent deploy from Git on its own when X-Nix is unreachable, polling several remotes
     and branches so no single remote is a point of failure, and reporting back once X-Nix
     returns (comin; bento's per-host SFTP drop with logs sent back after each rebuild).
   - A webhook that starts evaluation at once on a push, instead of waiting for `eval_interval`
     (a requested comin feature; Hydra triggers a jobset on input changes).

5. [ ] **Builds and caches.**
   - Evaluate every deployment in one parallel pass and start each build as soon as its own
     evaluation ends (nix-fast-build over nix-eval-jobs).
   - A switch that skips evaluation and building on the host: fetch the store path already in
     the cache and activate it, for hosts too small to evaluate (`fh apply nixos`; Cachix Deploy
     agents).
   - Build history with each build's log and products kept and browsable, such as an ISO from a
     deployment's flake (Hydra's build products).
   - Show the cache's own health and size, reading Harmonia's or Attic's `/nix-cache-info`,
     `/health` and `/metrics` where offered (Harmonia).

6. [ ] **Install and provision new hosts.**
   - Install NixOS on a reachable Linux host over SSH: kexec into an installer, partition with
     disko, install the flake's configuration and reboot, with an option to stop after
     partitioning (nixos-anywhere with disko).
   - Build install media for a deployment: installer ISO, netboot (iPXE) and kexec tarball
     (nixos-generators, nixos-images).
   - Generate a new host's `hardware-configuration.nix` and its agent key during the install,
     then add it as a deployment (nixos-anywhere's `--extra-files`; Clan's `clan machines
     install`).

7. [ ] **Configuration and secrets.**
   - Search NixOS options and packages from the deployment's own nixpkgs pin, including
     Home Manager options (NixOS Search, mynixos.com).
   - Set simple options (booleans, strings, enums) through a form that writes them back to the
     flake as a commit (nixos-conf-editor over nix-editor; mynixos.com's flake builder).
   - Upload secrets to a host outside the store, into memory under `/run/keys`, with a systemd
     unit per secret that later units can wait on (Colmena's `deployment.keys`, morph's secrets).
   - An inventory of machines and the roles or services each takes, kept in one file the page
     edits (Clan's `inventory.json`).
