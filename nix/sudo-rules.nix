# The NOPASSWD sudo rules for every command X-Nix runs under `sudo -n` on a host, for the user its server or agent runs as.
# sudo matches the path a command resolves to, and both services resolve bare names through the system profile.
# The user these rules are for is root-equivalent while any activation rule or the `post_switch` rule is present.
# nixos-rebuild with any flake, switch-to-configuration of any store path named like a NixOS system and `/bin/sh -c` each run code of the user's choosing as root.
# sudo matches a rule's arguments against all of a command's arguments joined by spaces, so a shell-style `*` there also allows any further arguments.
# A rule written `^…$` is a POSIX extended regular expression over those joined arguments, which sudo 1.9.10 and later read, and is used wherever it makes a rule exact.
{ pkgs, lib }:
{
  # The user the rules are for.
  user,
  # The groups of rules to add, by the module's `sudoAllow` option names.
  allow,
  # The agent's state directory, whose `runs` folder holds each run unit's folder; null when no run units are allowed.
  state_directory ? null,
  # The run units' extra properties, which the rule allows exactly as set.
  run_unit_properties ? { },
  # The agent user's and group's fixed ids, or null to allow any id but root's.
  uid ? null,
  gid ? null,
  # The sudo package, whose version says whether rules may be regular expressions.
  sudo_package ? pkgs.sudo,
}:
let
  system_bin = "/run/current-system/sw/bin";
  system_profile = "/nix/var/nix/profiles/system";
  modes = [
    "switch"
    "boot"
    "test"
    "dry-activate"
  ];

  patterns = lib.importJSON ./sudo-patterns.json;

  # An older sudo cannot read `^…$` rules, so it gets the wider shell-style rules instead.
  exact = lib.versionAtLeast (lib.getVersion sudo_package) "1.9.10";

  # A regular expression rule for a command, or its shell-style fallback for an older sudo or a pattern over sudo's 1024 character limit.
  either =
    command: regex: fallback:
    if exact && builtins.stringLength regex <= 1024 then "${command} ${regex}" else "${command} ${fallback}";

  # sudo reads `#` in a rule as the start of a comment, so it is escaped.
  sudoers_escape = builtins.replaceStrings [ "#" ] [ "\\#" ];

  id_pattern = id: if id == null then "[1-9][0-9]*" else toString id;

  run_unit_property_patterns = lib.concatStrings (
    lib.mapAttrsToList (name: value: "|${lib.escapeRegex "${name}=${value}"}") run_unit_properties
  );

  start_run_unit = sudoers_escape (
    builtins.replaceStrings
      [ "@uid@" "@gid@" "@runs@" "@properties@" ]
      [
        (id_pattern uid)
        (id_pattern gid)
        (lib.escapeRegex "${toString state_directory}/runs")
        run_unit_property_patterns
      ]
      patterns.start_run_unit
  );

  # nix-collect-garbage with exactly the arguments given, or with any when the list is null.
  collect_garbage =
    if allow.collectGarbageArgs == null then
      "${system_bin}/nix-collect-garbage"
    else if allow.collectGarbageArgs == [ ] then
      ''${system_bin}/nix-collect-garbage ""''
    else
      either "${system_bin}/nix-collect-garbage"
        (sudoers_escape "^${lib.concatMapStringsSep " " lib.escapeRegex allow.collectGarbageArgs}$")
        (lib.concatMapStringsSep " " (argument: lib.escape [ "\\" "," ":" "=" "*" "?" "[" "]" ] argument) allow.collectGarbageArgs);

  # Update Flake on a local checkout, with or without nix_args, keeping NIX_CONFIG for the flake's access_tokens_file; nix_args may hold any `--option`, so these rules alone make the user root.
  flake_updates = lib.optionals allow.flakeUpdates [
    "${system_bin}/nix flake update --flake *"
    "${system_bin}/nix * flake update --flake *"
  ];

  commands =
    # Switch, boot, test and dry activation with nixos-rebuild of any flake and rebuild_args, which pull mode's switch to a git+ flake also uses.
    map (mode: "${system_bin}/nixos-rebuild ${mode} --flake *") modes
    # A fetched system's own activation, which the switch from the cache and the watchdog's rollback both run.
    ++ map (mode: "/nix/store/*-nixos-system-*/bin/switch-to-configuration ${mode}") modes
    # Rollback and the guarded switch's watchdog: an earlier generation, then that system's activation.
    ++ [
      (either "${system_bin}/nix-env" patterns.switch_generation "-p ${system_profile} --switch-generation *")
      "${system_profile}/bin/switch-to-configuration switch"
    ]
    # Reboot, and Collect Garbage with the arguments the host's gc_args give.
    ++ [
      "${system_bin}/systemctl reboot"
      collect_garbage
    ]
    # The boot loader's entries, read with root first since /boot is often root's alone.
    ++ [
      "${system_bin}/bootctl list --json\\=short"
      "${system_bin}/cat /boot/grub/grub.cfg"
      "${system_bin}/grub-editenv list"
    ]
    # inhibit_sleep's inhibitor, which holds until its stdin closes; the idle form is for a server not yet updated.
    ++ [
      "${system_bin}/systemd-inhibit --what\\=sleep --mode\\=block --who\\=X-Nix --why\\=switching cat"
      "${system_bin}/systemd-inhibit --what\\=idle\\:sleep --mode\\=block --who\\=X-Nix --why\\=switching cat"
    ]
    # The inhibitor every job holds on a host listed under wake_on_lan; the idle form is for a server not yet updated.
    ++ [
      "${system_bin}/systemd-inhibit --what\\=sleep --mode\\=block --who\\=X-Nix --why\\=job cat"
      "${system_bin}/systemd-inhibit --what\\=idle\\:sleep --mode\\=block --who\\=X-Nix --why\\=job cat"
    ]
    # Switch from the cache: the fetched system becomes the system profile's next generation.
    ++ lib.optional allow.cacheSwitch (
      either "${system_bin}/nix-env" patterns.set_system_profile "-p ${system_profile} --set /nix/store/*"
    )
    # A checked update of a local checkout copies the lock it checked over the checkout's own.
    ++ lib.optional allow.flakeUpdates (
      either "${system_bin}/cp" patterns.copy_checked_lock "-T *x-nix-update-*/flake.lock */flake.lock"
    )
    # close_nix_lock_holders stops what holds the Nix store database open while an activation waits for it.
    ++ lib.optionals allow.lockHolders [
      (either "${system_bin}/kill" patterns.kill_term "-TERM *")
      (either "${system_bin}/kill" patterns.kill_kill "-KILL *")
    ]
    # Long runs, each a transient unit of its own running the agent's runner as the agent's user, and stopping one.
    ++ lib.optionals (allow.runUnits or false) [
      (either "${system_bin}/systemd-run" start_run_unit "--unit\\=x-nix-run-* *")
      (either "${system_bin}/systemctl" patterns.stop_run_unit "stop x-nix-run-*")
    ]
    # Set next boot with the loader's own one-shot tool.
    ++ lib.optionals allow.bootEntries [
      (either "${system_bin}/bootctl" patterns.set_oneshot_entry "set-oneshot *")
      (either "${system_bin}/grub-reboot" patterns.grub_reboot_entry "*")
      (either "${system_bin}/efibootmgr" patterns.efi_boot_next "--bootnext *")
    ]
    # post_switch runs any shell command as root, so this rule alone makes the user root.
    ++ lib.optional allow.postSwitch "/bin/sh -c *"
    # A switch over SSH to target_host logs in with root's own SSH setup and any NIX_SSHOPTS options, so this rule alone makes the user root.
    ++ lib.optionals allow.targetHost [
      "${system_bin}/ssh"
      "${pkgs.openssh}/bin/ssh"
    ];
in
{
  users = [ user ];
  commands =
    map (command: {
      inherit command;
      options = [ "NOPASSWD" ];
    }) commands
    ++ map (command: {
      inherit command;
      options = [
        "NOPASSWD"
        "SETENV"
      ];
    }) flake_updates;
}
