{self}: {
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.services.agent;
in {
  options.services.agent = {
    enable = lib.mkEnableOption "the agent coordinator";
    role = lib.mkOption {
      type = lib.types.enum ["coordinator" "client"];
      default = "coordinator";
      description = "Coordinator owns conversations and sources; client only maintains its local resources.";
    };
    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      description = "Agent CLI and its pinned Pi runtime.";
    };
    configFile = lib.mkOption {
      type = lib.types.str;
      description = "Absolute path to private runtime configuration, outside the Nix store.";
    };
    stateDirectory = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Private state directory; null uses the operating system default.";
    };
    workingDirectory = lib.mkOption {
      type = lib.types.str;
      default = "/";
      description = "Coordinator working directory.";
    };
    tailnetPort = lib.mkOption {
      type = lib.types.nullOr (lib.types.ints.between 1 65535);
      default = null;
      description = "Coordinator Tailscale port; null uses the CLI default, 43187.";
    };
    extraPackages = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = [];
      description = "Provider CLIs needed by this coordinator.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [{
      assertion = lib.hasPrefix "/" cfg.configFile && !(lib.hasPrefix "/nix/store/" cfg.configFile);
      message = "services.agent.configFile must reference a private runtime file outside /nix/store.";
    } {
      assertion = cfg.role == "coordinator" || cfg.tailnetPort == null;
      message = "Only the coordinator may listen on a Tailscale port.";
    }];
    environment.systemPackages = [cfg.package];
    launchd.user.agents.agent = {
      serviceConfig = {
        ProgramArguments = ["${cfg.package}/bin/agent" "--config" cfg.configFile]
          ++ lib.optionals (cfg.stateDirectory != null) ["--state-dir" cfg.stateDirectory]
          ++ [(if cfg.role == "coordinator" then "serve" else "maintain")]
          ++ lib.optionals (cfg.tailnetPort != null) ["--tailnet-port" (toString cfg.tailnetPort)];
        WorkingDirectory = cfg.workingDirectory;
        RunAtLoad = true;
        KeepAlive = true;
        ThrottleInterval = 10;
        ProcessType = "Background";
      };
      environment.PATH = lib.makeBinPath cfg.extraPackages
        + ":/run/current-system/sw/bin:/nix/var/nix/profiles/default/bin:/usr/bin:/bin:/usr/sbin:/sbin";
    };
  };
}
