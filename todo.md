# X-Nix

## Tasks

1. [ ] **Assess existing NixOS tooling.** Survey web and desktop software for NixOS deployment,
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
