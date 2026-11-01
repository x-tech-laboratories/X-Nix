# The NOPASSWD sudo rules for every command X-Nix runs under `sudo -n` on a host, for the user its server or agent
# runs as. sudo matches the path a command resolves to, and both services resolve bare names through the system profile.
{ pkgs }:
user:
let
  system_bin = "/run/current-system/sw/bin";
  system_profile = "/nix/var/nix/profiles/system";
  modes = [
    "switch"
    "boot"
    "test"
    "dry-activate"
  ];

  # The service user activates whole systems, so it is root-equivalent and wildcard arguments widen nothing.
  commands =
    # Switch, boot, test and dry activation with nixos-rebuild, which pull mode's switch to a git+ flake also uses.
    map (mode: "${system_bin}/nixos-rebuild ${mode} --flake *") modes
    # Switch from the cache: the system profile's next generation, then the fetched system's own activation.
    ++ [ "${system_bin}/nix-env -p ${system_profile} --set /nix/store/*" ]
    ++ map (mode: "/nix/store/*-nixos-system-*/bin/switch-to-configuration ${mode}") modes
    # Rollback and the guarded switch's watchdog: an earlier generation, then that system's activation.
    ++ [
      "${system_bin}/nix-env -p ${system_profile} --switch-generation *"
      "${system_profile}/bin/switch-to-configuration switch"
    ]
    # Update Flake on a local checkout, with or without nix_args before the subcommand.
    ++ [
      "${system_bin}/nix flake update --flake *"
      "${system_bin}/nix * flake update --flake *"
    ]
    # Reboot, and Collect Garbage with whatever gc_args the deployment sets.
    ++ [
      "${system_bin}/systemctl reboot"
      "${system_bin}/nix-collect-garbage"
    ]
    # The boot loader's entries, read with root first since /boot is often root's alone.
    ++ [
      "${system_bin}/bootctl list --json\\=short"
      "${system_bin}/cat /boot/grub/grub.cfg"
      "${system_bin}/grub-editenv list"
    ]
    # Set next boot with the loader's own one-shot tool.
    ++ [
      "${system_bin}/bootctl set-oneshot *"
      "${system_bin}/grub-reboot *"
      "${system_bin}/efibootmgr --bootnext *"
    ]
    # inhibit_sleep's inhibitor, which holds until its stdin closes.
    ++ [
      "${system_bin}/systemd-inhibit --what\\=idle\\:sleep --mode\\=block --who\\=X-Nix --why\\=switching cat"
    ]
    # post_switch, run as root.
    ++ [ "/bin/sh -c *" ]
    # A switch over SSH to target_host logs in with root's own SSH setup, as nixos-rebuild does.
    ++ [
      "${system_bin}/ssh"
      "${pkgs.openssh}/bin/ssh"
    ];
in
{
  users = [ user ];
  commands = map (command: {
    inherit command;
    options = [ "NOPASSWD" ];
  }) commands;
}
