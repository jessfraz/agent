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
      embeddingModel = pkgs.fetchurl {
        url = "https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/370f27d7550e0def9b39c1f16d3fbaa13aa67728/Qwen3-Embedding-0.6B-Q8_0.gguf";
        hash = "sha256-BlB8e0JohGnE5ymLCh4W3v8GyvKRzwpbJ4wwgknD5Dk=";
      };
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
        nodejs = pkgs.nodejs_26;
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
          fileset = pkgs.lib.fileset.unions [./src ./tests ./examples ./Cargo.toml ./Cargo.lock];
        };
        cargoLock.lockFile = ./Cargo.lock;
        cargoBuildFlags = ["--bin" "agent"];
        nativeBuildInputs = [pkgs.makeWrapper];
        nativeCheckInputs = [pkgs.nodejs_26 pkgs.git pkgs.lsof];
        AGENT_RUNTIME_PATH = "${runtime}/lib/agent-runtime/dist/src/bridge.js";
        postInstall = ''
          wrapProgram "$out/bin/agent" \
            --set AGENT_RUNTIME_PATH "${runtime}/lib/agent-runtime/dist/src/bridge.js" \
            --set AGENT_LLAMA_SERVER "${pkgs.llama-cpp}/bin/llama-server" \
            --set AGENT_EMBEDDING_MODEL "${embeddingModel}" \
            --set AGENT_SQLITE_VEC "${pkgs.sqlite-vec}/lib/vec0${pkgs.stdenv.hostPlatform.extensions.sharedLibrary}" \
            --prefix PATH : "${pkgs.lib.makeBinPath [pkgs.nodejs_26 pkgs.git pkgs.lsof pkgs.openssh]}" \
            --suffix PATH : /run/current-system/sw/bin
        '';
      };
    in {
      default = cli;
      inherit runtime embeddingModel;
      embeddingRuntime = pkgs.llama-cpp;
      sqliteVec = pkgs.sqlite-vec;
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
        packages = with pkgs; [cargo rustc rustfmt clippy nodejs_26 pkg-config git lsof actionlint];
        AGENT_LLAMA_SERVER = "${pkgs.llama-cpp}/bin/llama-server";
        AGENT_EMBEDDING_MODEL = self.packages.${system}.embeddingModel;
        AGENT_SQLITE_VEC = "${pkgs.sqlite-vec}/lib/vec0${pkgs.stdenv.hostPlatform.extensions.sharedLibrary}";
      };
    });
  };
}
