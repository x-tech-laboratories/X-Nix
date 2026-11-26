# The `sudoAllow` options both modules offer, each dropping one group of sudo rules a host's deployments do not use.
{ lib }:
let
  inherit (lib) mkEnableOption mkOption types;

  # An option for a group of rules that is on unless turned off.
  group = description: mkEnableOption description // { default = true; };
in
{
  options =
    extra:
    {
      postSwitch = group ''
        the rule that runs a deployment's `post_switch` as root with `/bin/sh -c`, which takes any
        command and so makes the service user root by itself; safe to turn off when no deployment
        switched on this host sets `post_switch` with `require_sudo`
      '';

      targetHost = group ''
        the rules that run `ssh` as root, so a switch, rollback or inhibitor reaches `target_host` with
        root's own SSH setup; `ssh` takes any options here, which makes the service user root by itself;
        safe to turn off when no deployment switched from this host sets `target_host`
      '';

      bootEntries = group ''
        the rules that set the next boot with `bootctl set-oneshot`, `grub-reboot` or
        `efibootmgr --bootnext`; safe to turn off when nobody uses Set next boot for this host
      '';

      lockHolders = group ''
        the rules that `kill -TERM` and `kill -KILL` the processes holding the Nix store database open
        while an activation waits for it, any process but PID 1; safe to turn off when no deployment
        switched on this host sets `close_nix_lock_holders`
      '';

      flakeUpdates = group ''
        the rules that run `nix flake update` on a local checkout and copy the checked lock over the
        checkout's own; safe to turn off when no flake updated on this host is a local checkout with
        `require_sudo`
      '';

      cacheSwitch = group ''
        the rule that makes a system fetched from a cache the system profile's next generation with
        `nix-env --set`, which a switch or boot from the cache needs; safe to turn off when no
        deployment switched on this host sets `cache` or `cache_url`
      '';

      collectGarbageArgs = mkOption {
        type = types.nullOr (types.listOf types.str);
        default = null;
        example = [
          "--delete-older-than"
          "7d"
        ];
        description = ''
          The exact arguments Collect Garbage may run `nix-collect-garbage` with as root, which must
          match the host's `gc.gc_args`; null allows any arguments, `--option` included, which makes the
          service user root by itself.
        '';
      };
    }
    // extra;
}
