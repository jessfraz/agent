{
  description = "A local agent CLI";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/3ec636362e1816bc2f0888fa0fa2c69f1bc9e504";

  outputs = {self, nixpkgs, ...}: let
    systems = ["aarch64-darwin" "x86_64-linux" "aarch64-linux"];
    eachSystem = nixpkgs.lib.genAttrs systems;
  in {
    darwinModules.default = import ./nix/module.nix {inherit self;};
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
        postBuild = ''
          npm prune --omit=dev --ignore-scripts --offline
        '';
        installPhase = ''
          runHook preInstall
          mkdir -p "$out/lib/agent-runtime/dist" "$out/lib/agent-runtime/src/generated"
          cp -r dist/src "$out/lib/agent-runtime/dist/"
          cp -r node_modules package.json "$out/lib/agent-runtime/"
          cp src/generated/*.schema.json "$out/lib/agent-runtime/src/generated/"
          runHook postInstall
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
        nativeCheckInputs = [pkgs.nodejs_22 pkgs.git pkgs.lsof];
        postInstall = ''
          wrapProgram "$out/bin/agent" \
            --set AGENT_RUNTIME_PATH "${runtime}/lib/agent-runtime/dist/src/bridge.js" \
            --prefix PATH : "${pkgs.lib.makeBinPath [pkgs.nodejs_22 pkgs.git pkgs.lsof pkgs.openssh]}"
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
        meta.description = "An agent CLI with durable conversations and Rex workers";
      };
    });
    devShells = eachSystem (system: let
      pkgs = import nixpkgs {inherit system;};
    in {
      default = pkgs.mkShell {
        packages = with pkgs; [cargo rustc rustfmt clippy nodejs_22 pkg-config git lsof actionlint];
      };
    });
  };
}
