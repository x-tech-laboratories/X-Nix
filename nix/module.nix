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

  sudo_rules = import ./sudo-rules.nix { inherit pkgs lib; };

  sudo_allow = import ./sudo-allow.nix { inherit lib; };

  # systemd places each loaded secret here, readable only by the service.
  credentials_directory = "/run/credentials/x-nix.service";

  # Where install media is linked when this host's agent builds it, so the agent writes the links and the server reads and removes them.
  shared_media_directory = "/var/lib/x-nix-media";

  provisioning =
    if cfg.localAgent then cfg.provisioning else { media_root_dir = shared_media_directory; } // cfg.provisioning;

  config_file = json.generate "x-nix.json" {
    hosts = lib.mapAttrsToList (id: settings: { inherit id; } // settings) cfg.hosts;
    flakes = lib.mapAttrsToList (id: settings: { inherit id; } // settings) cfg.flakes;
    deployments = lib.mapAttrsToList (id: settings: { inherit id; } // settings) cfg.deployments;
    caches = lib.mapAttrsToList (id: settings: { inherit id; } // settings) cfg.caches;
    inherit provisioning;
    inherit (cfg) fleet notifications;
  };

  agent_enabled = config.services ? x-nix-agent && config.services.x-nix-agent.enable;

  # Every string in the settings written to the world-readable store, with where it sits and the setting it belongs to.
  config_strings =
    let
      walk =
        where: name: value:
        if builtins.isAttrs value then
          lib.concatLists (lib.mapAttrsToList (key: walk "${where}.${key}" key) value)
        else if builtins.isList value then
          lib.concatLists (lib.imap0 (index: walk "${where}.${toString index}" name) value)
        else if builtins.isString value then
          [ { inherit where name value; } ]
        else
          [ ];
    in
    lib.concatLists (
      lib.mapAttrsToList (key: walk "services.x-nix.${key}" key) {
        inherit (cfg)
          hosts
          flakes
          deployments
          caches
          provisioning
          fleet
          notifications
          ;
      }
    );

  # The settings that name a file holding a secret, which must be a path rather than the secret itself.
  is_path_setting =
    name:
    lib.hasSuffix "_file" name
    || builtins.elem name [
      "push_ssh_key"
      "commit_signing_key"
      "ssh_key"
    ];

  # Where each string matching a test sits, for a message that never shows the value.
  places = test: map (entry: entry.where) (builtins.filter test config_strings);

  private_keys = places (
    entry:
    lib.hasInfix "PRIVATE KEY-----" entry.value
    || lib.hasInfix "AGE-SECRET-KEY-" entry.value
    || lib.hasInfix "-----BEGIN PGP PRIVATE" entry.value
  );

  inline_in_path_settings = places (
    entry:
    is_path_setting entry.name
    && (lib.hasInfix "\n" entry.value || (!lib.hasPrefix "/" entry.value && lib.hasInfix "=" entry.value))
  );

  relative_path_settings = places (
    entry: is_path_setting entry.name && !lib.hasPrefix "/" entry.value && !lib.hasInfix "=" entry.value
  );

  inline_secret_settings = places (
    entry:
    builtins.match "(.*_)?(token|password|passwd|secret|api_key|apikey|private_key|credentials?)" (lib.toLower entry.name) != null
  );

  # A URL carrying a password, a token-like query parameter, or a chat service's secret webhook path.
  secret_urls = places (
    entry:
    builtins.match "[A-Za-z][A-Za-z0-9+.-]*://[^/@ ]*:[^/@ ]+@.*" entry.value != null
    || builtins.match ".*://.*[?&](access_token|token|key|api_key|apikey|secret|sig|signature|password|auth)=[^&]+.*" (lib.toLower entry.value) != null
    || builtins.match "https?://(hooks\\.slack\\.com/|(discord|discordapp)\\.com/api/webhooks/|[^/]*\\.webhook\\.office\\.com/|chat\\.googleapis\\.com/).*" (lib.toLower entry.value) != null
  );

  # Webhook headers that carry credentials, which have no file form of their own.
  secret_headers = lib.concatLists (
    lib.imap0 (
      index: channel:
      map (header: "services.x-nix.notifications.${toString index}.headers.${header}") (
        builtins.filter (
          header: builtins.match ".*(authorization|cookie|token|key|secret|auth|password).*" (lib.toLower header) != null
        ) (builtins.attrNames (channel.headers or { }))
      )
    ) cfg.notifications
  );

  inline_apprise_urls = lib.concatLists (
    lib.imap0 (
      index: channel:
      lib.optional ((channel.type or null) == "apprise" && (channel.urls or [ ]) != [ ]) "services.x-nix.notifications.${toString index}.urls"
    ) cfg.notifications
  );

  # One warning naming every place a check found, or none.
  warn_about = places: text: lib.optional (places != [ ]) "${text}: ${lib.concatStringsSep ", " places}";
in
{
  imports = [
    (lib.mkRemovedOptionModule [ "services" "x-nix" "agents" ] "Set each host's agent_key under services.x-nix.hosts.")
    (lib.mkRemovedOptionModule [ "services" "x-nix" "wakeOnLan" ] "Set each host's wake_on_lan under services.x-nix.hosts.")
  ];

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
      description = "A file holding the users who may log in, one `name:hash` line each, written by `npm run hash-password`; read at runtime, never copied to the store.";
    };

    serverKeyFile = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = lib.literalExpression "config.sops.secrets.x_nix_server_key.path";
      description = ''
        A file holding the server's unencrypted OpenSSH ed25519 private key, made with
        `ssh-keygen -t ed25519 -N "" -C x-nix-server`; read at runtime, never copied to the store.
        The server signs what it sends every agent with it, and an agent listing its public line in
        `services.x-nix-agent.serverPublicKeys` refuses anything it did not sign. Agents tell the
        server only by its TLS certificate when null.
      '';
    };

    flakes = mkOption {
      type = types.attrsOf json.type;
      default = { };
      example = lib.literalExpression ''
        {
          fleet = {
            url = "github:example/nixos-config";
            update_at = "02:00";
            push_ssh_key = "/var/lib/x-nix/deploy_key";
          };
        }
      '';
      description = "The flakes X-Nix reads and updates, by id, each with the settings README.md lists; deployments and caches name one by its id in `flake`.";
    };

    deployments = mkOption {
      type = types.attrsOf json.type;
      default = { };
      example = lib.literalExpression ''
        {
          workstation = {
            flake = "fleet";
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
      description = "The Attic caches to watch, by id, each with the settings README.md lists; ids are shared with flakes and deployments.";
    };

    hosts = mkOption {
      type = types.attrsOf json.type;
      default = { };
      example = lib.literalExpression ''
        {
          odin = {
            agent_key = "ssh-ed25519 AAAA... x-nix-agent-odin";
            gc.max_generation_age = "30d";
          };
          thor = {
            agent_key = "ssh-ed25519 AAAA... x-nix-agent-thor";
            wake_on_lan = "aa:bb:cc:dd:ee:ff";
          };
        }
      '';
      description = ''
        The machines X-Nix reaches, by the name their agent answers to, each with the settings README.md
        lists: `agent_key`, the OpenSSH public key line of the key its `services.x-nix-agent.keyFile`
        holds, so only a host named here can dial in on `/api/agent`; `wake_on_lan`; `keep_awake`; `gc`;
        `boot` and `require_sudo`. A host a deployment names needs no entry of its own.
      '';
    };

    provisioning = mkOption {
      type = json.type;
      default = { };
      example = {
        ssh_key = "/var/lib/x-nix/install_key";
        agent_url = "wss://nix.example.org/api/agent";
        allowed_flakes = [ "github:example-org/" ];
      };
      description = ''
        How the Provision page installs new hosts and builds install media, with the settings README.md lists.
        Installs and media take only the flakes `flakes`, `deployments` and `caches` name, in any form of the same
        repository; `allowed_flakes` lists more flake references, or prefixes ending in `/` that allow every
        repository under them.
      '';
    };

    fleet = mkOption {
      type = json.type;
      default = { };
      example = {
        parallel = 2;
        stages = [
          "@canary"
          "@web"
        ];
      };
      description = "How fleet runs act on many deployments at once: `parallel`, `stages` and `sync_timeout`, as README.md lists.";
    };

    notifications = mkOption {
      type = types.listOf json.type;
      default = [ ];
      example = [
        {
          type = "ntfy";
          topic = "x-nix";
          token_file = "/var/lib/x-nix/ntfy-token";
        }
      ];
      description = ''
        Where X-Nix sends notifications, such as of a job running well past its time: `ntfy`, `webhook`
        or `apprise` channels with the settings README.md lists. A `*_file` secret must be readable by
        the x-nix user; an apprise channel needs `pkgs.apprise` in `path`.
      '';
    };

    webhookSecretFile = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = ''
        A file holding the shared secret forges sign pushes to `/api/webhook` with, or send as a bearer
        token; read at runtime, never copied to the store. The webhook is off when null.
      '';
    };

    webhookDebounce = mkOption {
      type = types.str;
      default = "10s";
      description = "How long after the last push to a deployment its evaluation starts.";
    };

    historyRetention = mkOption {
      type = types.str;
      default = "180d";
      description = "How long finished jobs, builds, events and fleet runs are kept, or \"never\" to keep them all; the newest of each kind are kept whatever their age.";
    };

    path = mkOption {
      type = types.listOf (types.either types.package types.str);
      default = [ ];
      description = "Extra entries on the PATH of the commands X-Nix runs, such as a wrapper named by rebuild_bin.";
    };

    signIn = {
      sessionLifetime = mkOption {
        type = types.str;
        default = "12h";
        description = "How long a sign-in lasts without \"Keep me signed in\".";
      };

      rememberedLifetime = mkOption {
        type = types.str;
        default = "30d";
        description = "How long a sign-in with \"Keep me signed in\" lasts.";
      };

      tokenLifetime = mkOption {
        type = types.str;
        default = "90d";
        description = "The longest a new token lasts, in whole days, and how long one lasts unless made shorter; `never` for no limit.";
      };

      adminSecondFactor = mkOption {
        type = types.bool;
        default = true;
        description = "Have each admin set up a second factor on their account page before they can change anything; until then they only read.";
      };
    };

    localAgent = mkOption {
      type = types.bool;
      default = false;
      description = ''
        Whether the server works on this host itself, as root through sudo rules. Off, this host is
        served by `services.x-nix-agent` like any other, dialling in on `ws://127.0.0.1:<port>/api/agent`
        with the key under its `hosts` entry, so the process that answers the web has no sudo and runs
        sandboxed. Secrets the jobs read, such as a flake's push key or a cache's token, must then be
        readable by the x-nix-agent user.
      '';
    };

    sudoRules = mkOption {
      type = types.bool;
      default = cfg.localAgent;
      defaultText = lib.literalExpression "config.services.x-nix.localAgent";
      description = ''
        Whether to add the NOPASSWD sudo rules for every command X-Nix runs under `sudo -n` on this host,
        as README.md lists, which only the built-in agent of `localAgent` needs; turn them off only to
        write your own, such as for a rebuild_bin outside the system profile.
      '';
    };

    # The built-in agent runs no long run as a transient unit, so the server's rules never include those.
    sudoAllow = sudo_allow.options { };
  };

  config = mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.localAgent || agent_enabled;
        message = ''
          services.x-nix needs services.x-nix-agent on this host, with its key under services.x-nix.hosts,
          or services.x-nix.localAgent = true to work on this host from the server itself.
        '';
      }
      {
        assertion = private_keys == [ ];
        message = "services.x-nix settings are written to the world-readable Nix store, so they must not hold private key material; give a key's file path instead at ${lib.concatStringsSep ", " private_keys}.";
      }
      {
        assertion = inline_in_path_settings == [ ];
        message = "services.x-nix settings that name a secret's file must be a path, not the secret itself, as they are written to the world-readable Nix store: ${lib.concatStringsSep ", " inline_in_path_settings}.";
      }
    ];

    warnings =
      warn_about inline_secret_settings "services.x-nix settings are written to the world-readable Nix store; move these secrets into the setting's `_file` form"
      ++ warn_about secret_urls "services.x-nix settings are written to the world-readable Nix store; these URLs look like they carry a password or token, which belongs in a file instead, such as a notification's `url_file` or a flake's `access_tokens_file`"
      ++ warn_about inline_apprise_urls "services.x-nix settings are written to the world-readable Nix store, and apprise URLs usually carry credentials; list them in `urls_file` instead"
      ++ warn_about secret_headers "services.x-nix settings are written to the world-readable Nix store; these webhook headers look like credentials, which belong in `bearer_token_file` or the URL's `url_file`"
      ++ warn_about relative_path_settings "services.x-nix settings that name a secret's file should be absolute paths";

    # Media links are made by the agent and removed by the server, so both may write the folder.
    systemd.tmpfiles.settings."X-Nix media" = mkIf (!cfg.localAgent && !(cfg.provisioning ? media_root_dir)) {
      ${shared_media_directory}.d = {
        user = "x-nix-agent";
        group = "x-nix";
        mode = "0770";
      };
    };

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
        # Compares the derivations of two closures whose packages are the same, for the diff shown before a switch.
        pkgs.nix-diff
      ]
      ++ cfg.path;

      environment = {
        HOST = cfg.host;
        PORT = toString cfg.port;
        HOME = "/var/lib/x-nix";
        X_NIX_CONFIG = toString config_file;
        X_NIX_PASSWORD_HASH_FILE = "${credentials_directory}/password-hash";
        X_NIX_STATE_DIR = "/var/lib/x-nix";
        X_NIX_WEBHOOK_DEBOUNCE = cfg.webhookDebounce;
        X_NIX_HISTORY_RETENTION = cfg.historyRetention;
        X_NIX_LOCAL_AGENT = if cfg.localAgent then "yes" else "no";
        X_NIX_SESSION_LIFETIME = cfg.signIn.sessionLifetime;
        X_NIX_REMEMBERED_LIFETIME = cfg.signIn.rememberedLifetime;
        X_NIX_TOKEN_LIFETIME = cfg.signIn.tokenLifetime;
        X_NIX_ADMIN_SECOND_FACTOR = if cfg.signIn.adminSecondFactor then "yes" else "no";
      }
      // lib.optionalAttrs (cfg.serverName != null) { X_NIX_SERVER_NAME = cfg.serverName; }
      // lib.optionalAttrs (cfg.webhookSecretFile != null) {
        X_NIX_WEBHOOK_SECRET_FILE = "${credentials_directory}/webhook-secret";
      }
      // lib.optionalAttrs (cfg.serverKeyFile != null) {
        X_NIX_SERVER_KEY_FILE = "${credentials_directory}/server-key";
      }
      // lib.optionalAttrs cfg.sudoRules { X_NIX_AGENT_SUDO_FILE = toString (sudo_allow.groups_file pkgs cfg.sudoAllow); };

      # With the built-in agent it is left unsandboxed, because sudo inherits the unit's sandbox and a switch run under it
      # could not write the system; without it the server runs no command as root and is kept to its own state.
      serviceConfig = lib.optionalAttrs (!cfg.localAgent) {
        NoNewPrivileges = true;
        PrivateTmp = true;
        PrivateDevices = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        ReadWritePaths = [ provisioning.media_root_dir ];
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectKernelLogs = true;
        ProtectControlGroups = true;
        ProtectClock = true;
        ProtectHostname = true;
        RestrictSUIDSGID = true;
        RestrictRealtime = true;
        RestrictNamespaces = true;
        LockPersonality = true;
        CapabilityBoundingSet = "";
        SystemCallArchitectures = "native";
      }
      // {
        ExecStart = lib.getExe cfg.package;
        User = "x-nix";
        Group = "x-nix";
        StateDirectory = "x-nix";
        StateDirectoryMode = "0700";
        LoadCredential = [
          "password-hash:${cfg.passwordHashFile}"
        ]
        ++ lib.optional (cfg.webhookSecretFile != null) "webhook-secret:${cfg.webhookSecretFile}"
        ++ lib.optional (cfg.serverKeyFile != null) "server-key:${cfg.serverKeyFile}";
        Restart = "on-failure";
        RestartSec = "5s";
        # A restart stops only the server, so a running switch carries on and is followed again from its output.
        KillMode = "process";
        UMask = "0077";
      };
    };

    security.sudo.extraRules = mkIf cfg.sudoRules [
      (sudo_rules {
        user = "x-nix";
        allow = cfg.sudoAllow;
        sudo_package = config.security.sudo.package;
        boot_loader = sudo_allow.boot_loader config;
      })
    ];

    # A switch's cache check asks the daemon, which would otherwise answer from a miss cached before the push for an hour.
    nix.settings.narinfo-cache-negative-ttl = lib.mkDefault 60;

    networking.firewall.allowedTCPPorts = mkIf cfg.openFirewall [ cfg.port ];
  };
}
