{
  description = "A local agent CLI";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/3ec636362e1816bc2f0888fa0fa2c69f1bc9e504";

  outputs = {self, nixpkgs, ...}: let
    systems = ["aarch64-darwin" "x86_64-linux" "aarch64-linux"];
    eachSystem = nixpkgs.lib.genAttrs systems;
  in {
    packages = eachSystem (system: let
      pkgs = import nixpkgs {inherit system;};
      runtime = pkgs.buildNpmPackage {
        pname = "agent-runtime";
        version = "0.1.0";
        src = pkgs.lib.fileset.toSource {
          root = ./runtime;
          fileset = pkgs.lib.fileset.unions [
            ./runtime/src ./runtime/test ./runtime/package.json
            ./runtime/package-lock.json ./runtime/tsconfig.json
          ];
        };
        nodejs = pkgs.nodejs_22;
        npmDeps = pkgs.importNpmLock {npmRoot = ./runtime;};
        npmConfigHook = pkgs.importNpmLock.npmConfigHook;
        npmFlags = ["--ignore-scripts"];
        installPhase = ''
          mkdir -p "$out/lib/agent-runtime/src"
          cp -r dist node_modules package.json "$out/lib/agent-runtime/"
          cp -r src/generated "$out/lib/agent-runtime/src/"
        '';
      };
      cli = pkgs.rustPlatform.buildRustPackage {
        pname = "agent";
        version = "0.1.0";
        src = pkgs.lib.fileset.toSource {
          root = ./.;
          fileset = pkgs.lib.fileset.unions [./src ./tests ./Cargo.toml ./Cargo.lock];
        };
        cargoLock.lockFile = ./Cargo.lock;
        cargoBuildFlags = ["--bin" "agent"];
        nativeBuildInputs = [pkgs.makeWrapper];
        nativeCheckInputs = [pkgs.nodejs_22];
        postInstall = ''
          wrapProgram "$out/bin/agent" \
            --set AGENT_RUNTIME_PATH "${runtime}/lib/agent-runtime/dist/src/bridge.js" \
            --prefix PATH : "${pkgs.nodejs_22}/bin"
        '';
      };
    in {
      default = cli;
      inherit runtime;
    });
    apps = eachSystem (system: {
      default = {
        type = "app";
        program = "${self.packages.${system}.default}/bin/agent";
      };
    });
    devShells = eachSystem (system: let
      pkgs = import nixpkgs {inherit system;};
    in {
      default = pkgs.mkShell {
        packages = with pkgs; [cargo rustc rustfmt clippy nodejs_22 pkg-config];
      };
    });
  };
}
