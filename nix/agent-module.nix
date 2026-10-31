self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.x-nix-agent;
  inherit (lib)
    literalExpression
    mkEnableOption
    mkIf
    mkOption
    types
    ;

  state_directory = "/var/lib/x-nix-agent";

  json = pkgs.formats.json { };

  pull_file = json.generate "x-nix-agent-pull.json" {
    inherit (cfg.pull)
      remotes
      after
      interval
      configuration
      ;
    rebuild_args = cfg.pull.rebuildArgs;
    require_sudo = cfg.pull.requireSudo;
  };
  # systemd places the loaded key here, readable only by the service.
  credentials_directory = "/run/credentials/x-nix-agent.service";
in
{
  options.services.x-nix-agent = {
    enable = mkEnableOption "the X-Nix agent, which reads, builds and switches this host for an X-Nix server";

    package = mkOption {
      type = types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.agent;
      defaultText = literalExpression "x-nix.packages.\${system}.agent";
      description = "The X-Nix agent package.";
    };

    url = mkOption {
      type = types.strMatching "wss?://.+";
      example = "wss://nix.example.org/api/agent";
      description = ''
        The server's agent endpoint. It must be `wss://`; `ws://` is only accepted to this machine.
        The server's certificate is checked against the system's CA bundle, so an internal CA in
        `security.pki.certificates` is trusted.
      '';
    };

    keyFile = mkOption {
      type = types.str;
      example = "/var/lib/x-nix-agent/key";
      description = ''
        File holding this host's unencrypted OpenSSH ed25519 private key, made with
        `ssh-keygen -t ed25519 -N "" -C x-nix-agent-<host>`; read at runtime, never copied to the
        store. The server declares its public line under `agents`.
      '';
    };

    host = mkOption {
      type = types.str;
      default = lib.toLower config.networking.hostName;
      defaultText = literalExpression "lib.toLower config.networking.hostName";
      description = "The host the agent logs in as, which must be its name in the server's config.";
    };

    path = mkOption {
      type = types.listOf (types.either types.package types.str);
      default = [ ];
      description = "Extra entries on the PATH of the commands the agent runs, such as a wrapper named by rebuild_bin.";
    };

    pull = {
      enable = mkEnableOption ''
        pull mode: once the server has been unreachable for `after`, the agent asks `remotes` every
        `interval` and switches to a new revision with `nixos-rebuild switch --flake` on its own,
        reporting each switch to the server once it is back
      '';

      remotes = mkOption {
        type = types.listOf (
          types.submodule {
            options = {
              url = mkOption {
                type = types.strMatching "(git\\+)?(https?|ssh|git|file)://.+";
                example = "https://github.com/example/nixos-config";
                description = "The flake's Git remote.";
              };
              branch = mkOption {
                type = types.str;
                default = "main";
                description = "The branch to follow.";
              };
            };
          }
        );
        default = [ ];
        description = "The remotes asked in order, typically mirrors of one repository, so no single remote is a point of failure.";
      };

      after = mkOption {
        type = types.str;
        default = "15m";
        description = "How long the server must have been unreachable before the agent deploys on its own.";
      };

      interval = mkOption {
        type = types.str;
        default = "5m";
        description = "How often the remotes are asked while the server is unreachable.";
      };

      configuration = mkOption {
        type = types.str;
        default = cfg.host;
        defaultText = literalExpression "config.services.x-nix-agent.host";
        description = "The nixosConfigurations attribute to switch to.";
      };

      rebuildArgs = mkOption {
        type = types.listOf types.str;
        default = [ ];
        description = "Arguments after the switch.";
      };

      requireSudo = mkOption {
        type = types.bool;
        default = true;
        description = "Run the switch under `sudo -n`.";
      };
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      {
        assertion = !cfg.pull.enable || cfg.pull.remotes != [ ];
        message = "services.x-nix-agent.pull needs at least one remote.";
      }
    ];

    users.users.x-nix-agent = {
      isSystemUser = true;
      group = "x-nix-agent";
      # Reads the last garbage collection's outcome from the system journal.
      extraGroups = [ "systemd-journal" ];
      home = state_directory;
      description = "X-Nix agent";
    };
    users.groups.x-nix-agent = { };

    systemd.services.x-nix-agent = {
      description = "X-Nix agent";
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];
      after = [ "network-online.target" ];

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
        # Compares the derivations of two closures whose packages are the same, for the diff shown before a switch.
        pkgs.nix-diff
      ]
      ++ cfg.path;

      environment = {
        X_NIX_AGENT_URL = cfg.url;
        X_NIX_AGENT_HOST = cfg.host;
        X_NIX_AGENT_KEY_FILE = "${credentials_directory}/key";
        X_NIX_AGENT_STATE_DIR = state_directory;
        HOME = state_directory;
        # Node keeps its own CA list, so the system bundle, which holds security.pki.certificates, is added to it.
        NODE_EXTRA_CA_CERTS = "/etc/ssl/certs/ca-certificates.crt";
      }
      // lib.optionalAttrs cfg.pull.enable { X_NIX_AGENT_PULL_FILE = toString pull_file; };

      # Left unsandboxed because sudo inherits the unit's sandbox, and a switch run under it could not write the system.
      serviceConfig = {
        ExecStart = lib.getExe cfg.package;
        User = "x-nix-agent";
        Group = "x-nix-agent";
        StateDirectory = "x-nix-agent";
        StateDirectoryMode = "0700";
        LoadCredential = [ "key:${cfg.keyFile}" ];
        Restart = "always";
        RestartSec = "5s";
        # A restart stops only the agent, so a running switch carries on and is followed again from its output.
        KillMode = "process";
        UMask = "0077";
      };
    };
  };
}
