# The keys X-Nix uploads to a host: the writer that puts each in place as root, the `keys` option a host declares
# them with, and the `<name>-key.service` each gets, which other units order after to start once the key is there.
{ lib, pkgs }:
let
  inherit (lib) mkOption types;
in
{
  # The bundled writer with coreutils on its PATH, since sudo may reset the caller's.
  writer = pkgs.writeShellScript "x-nix-key-writer" ''
    export PATH=${lib.makeBinPath [ pkgs.coreutils ]}
    ${builtins.readFile ../src/agent/key-writer.sh}
  '';

  option = mkOption {
    type = types.attrsOf (
      types.submodule (
        { name, ... }:
        {
          options.path = mkOption {
            type = types.strMatching "/run/keys/[A-Za-z0-9_.@+/-]+";
            default = "/run/keys/${name}";
            description = "Where the key is written; the deployment's secret of this name must have the same destination.";
          };
        }
      )
    );
    default = { };
    example = {
      database-password = { };
    };
    description = ''
      Keys X-Nix uploads to this host, by the name of the deployment's secret. Each gets a
      `<name>-key.service` that finishes once the file is there, so a unit with `after` and `wants`
      on it waits for the key. Declaring any key lets the service user run the key writer as root.
    '';
  };

  # A oneshot per key that waits for its file, so units ordered after it start only once the key is there.
  units =
    keys:
    lib.mapAttrs' (
      name: key:
      lib.nameValuePair "${name}-key" {
        description = "Wait for the X-Nix key ${name}";
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
          TimeoutStartSec = "infinity";
        };
        script = ''
          while [ ! -e ${lib.escapeShellArg key.path} ]; do sleep 1; done
        '';
      }
    ) keys;

  # Lets the user run the writer as root without a password, and nothing else.
  sudo_rule = user: writer: {
    users = [ user ];
    commands = [
      {
        command = toString writer;
        options = [ "NOPASSWD" ];
      }
    ];
  };
}
