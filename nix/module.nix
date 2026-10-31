self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.x-nix;
  inherit (lib)
    mkEnableOption
    mkIf
    mkOption
    types
    ;

  json = pkgs.formats.json { };

  # systemd places each loaded secret here, readable only by the service.
  credentials_directory = "/run/credentials/x-nix.service";

  config_file = json.generate "x-nix.json" {
    deployments = lib.mapAttrsToList (id: settings: { inherit id; } // settings) cfg.deployments;
    caches = lib.mapAttrsToList (id: settings: { inherit id; } // settings) cfg.caches;
    inherit (cfg) agents provisioning;
  };
in
{
  options.services.x-nix = {
    enable = mkEnableOption "X-Nix, a web portal for managing NixOS deployments";

    package = mkOption {
      type = types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "x-nix.packages.\${system}.default";
      description = "The X-Nix package.";
    };

    host = mkOption {
      type = types.str;
      default = "127.0.0.1";
      description = "The address the server listens on.";
    };

    port = mkOption {
      type = types.port;
      default = 7720;
      description = "The port the server listens on.";
    };

    openFirewall = mkOption {
      type = types.bool;
      default = false;
      description = "Open the port in the firewall.";
    };

    serverName = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = "What the page calls this machine, and the host name its own agent answers to; the hostname when null.";
    };

    passwordHashFile = mkOption {
      type = types.str;
      description = "A file holding the login password's hash, written by `npm run hash-password`; read at runtime, never copied to the store.";
    };

    deployments = mkOption {
      type = types.attrsOf json.type;
      default = { };
      example = lib.literalExpression ''
        {
          workstation = {
            flake = "github:example/nixos-config";
            configuration = "workstation";
            eval_interval = "6h";
          };
        }
      '';
      description = "The deployments to watch, by id, each with the settings README.md lists.";
    };

    caches = mkOption {
      type = types.attrsOf json.type;
      default = { };
      example = lib.literalExpression ''
        {
          fleet = {
            flake = "github:example/nixos-config";
            configurations = [ "workstation" "server" ];
            cache_url = "https://attic.example/fleet";
          };
        }
      '';
      description = "The Attic caches to watch, by id, each with the settings README.md lists; ids are shared with deployments.";
    };

    agents = mkOption {
      type = types.attrsOf types.str;
      default = { };
      example = {
        odin = "ssh-ed25519 AAAA... x-nix-agent-odin";
      };
      description = ''
        Each other host's agent key, as the OpenSSH public key line of the key its
        `services.x-nix-agent.keyFile` holds. Only a host named here can dial in on `/api/agent`.
      '';
    };

    provisioning = mkOption {
      type = json.type;
      default = { };
      example = {
        ssh_key = "/var/lib/x-nix/install_key";
        agent_url = "wss://nix.example.org/api/agent";
      };
      description = "How the Provision page installs new hosts and builds install media, with the settings README.md lists.";
    };

    path = mkOption {
      type = types.listOf (types.either types.package types.str);
      default = [ ];
      description = "Extra entries on the PATH of the commands X-Nix runs, such as a wrapper named by rebuild_bin.";
    };
  };

  config = mkIf cfg.enable {
    users.users.x-nix = {
      isSystemUser = true;
      group = "x-nix";
      # Reads the last garbage collection's outcome from the system journal.
      extraGroups = [ "systemd-journal" ];
      home = "/var/lib/x-nix";
      description = "X-Nix";
    };
    users.groups.x-nix = { };

    systemd.services.x-nix = {
      description = "X-Nix";
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];
      after = [ "network-online.target" ];
      restartTriggers = [ config_file ];

      # The setuid sudo in /run/wrappers must come before the plain one in the system profile, which cannot raise privileges.
      path = [
        "/run/wrappers"
        "/run/current-system/sw"
        pkgs.git
        # Installs new hosts from the Provision page, logging in to them over SSH.
        pkgs.nixos-anywhere
        pkgs.openssh
        # Build all evaluates every target of a cache with it.
        pkgs.nix-eval-jobs
      ]
      ++ cfg.path;

      environment = {
        HOST = cfg.host;
        PORT = toString cfg.port;
        HOME = "/var/lib/x-nix";
        X_NIX_CONFIG = toString config_file;
        X_NIX_PASSWORD_HASH_FILE = "${credentials_directory}/password-hash";
        X_NIX_STATE_DIR = "/var/lib/x-nix";
      }
      // lib.optionalAttrs (cfg.serverName != null) { X_NIX_SERVER_NAME = cfg.serverName; };

      # Left unsandboxed because sudo inherits the unit's sandbox, and a switch run under it could not write the system.
      serviceConfig = {
        ExecStart = lib.getExe cfg.package;
        User = "x-nix";
        Group = "x-nix";
        StateDirectory = "x-nix";
        StateDirectoryMode = "0700";
        LoadCredential = [ "password-hash:${cfg.passwordHashFile}" ];
        Restart = "on-failure";
        RestartSec = "5s";
        # A restart stops only the server, so a running switch carries on and is followed again from its output.
        KillMode = "process";
        UMask = "0077";
      };
    };

    networking.firewall.allowedTCPPorts = mkIf cfg.openFirewall [ cfg.port ];
  };
}
