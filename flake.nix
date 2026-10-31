{
  description = "atelier: agent-authored userstyles";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      # Tools the dev environment (dev/atelier-dev) needs. They must resolve to
      # store paths, because the jail can't see ~/.nix-profile.
      devEnvTools = pkgs: with pkgs; [
        nodejs_24
        web-ext
        bubblewrap
        sway
        firefox
        grim
        wayvnc
        dbus
        wtype
        foot  # a terminal, for testing [session] commands
      ];
    in
    {
      packages = forAllSystems (pkgs: rec {
        # The atelier binary: daemon, native host, CLI.
        atelier = pkgs.rustPlatform.buildRustPackage {
          pname = "atelier";
          version = "0.0.0";
          src = pkgs.lib.fileset.toSource {
            root = ./.;
            fileset = pkgs.lib.fileset.unions [ ./Cargo.toml ./Cargo.lock ./crates ./.cargo ];
          };
          cargoLock.lockFile = ./Cargo.lock;
          # The integration tests start daemons on unix sockets; keep them in the dev shell.
          doCheck = false;
          meta.mainProgram = "atelier";
        };

        # The unpacked dev build of the extension (dist/), for about:debugging.
        extension = pkgs.buildNpmPackage {
          pname = "atelier-extension";
          version = "0.0.0";
          src = ./extension;
          npmDeps = pkgs.importNpmLock { npmRoot = ./extension; };
          npmConfigHook = pkgs.importNpmLock.npmConfigHook;
          nodejs = pkgs.nodejs_24;
          npmBuildScript = "build";
          installPhase = ''
            runHook preInstall
            cp -r dist $out
            runHook postInstall
          '';
        };

        default = atelier;
      });

      # Registers the native hosts with Firefox, optionally sets the owned
      # directory, and (with programs.firefox) installs the signed extension,
      # release/atelier.xpi, through Firefox's policies.
      homeManagerModules.default = { config, lib, pkgs, ... }:
        let
          cfg = config.programs.atelier;
          # One host per flavor of the extension (extension/build.ts), both
          # the same binary: the signed extension, and a dev build beside it.
          manifest = name: extension: builtins.toJSON {
            inherit name;
            description = "atelier native host";
            path = lib.getExe cfg.package;
            type = "stdio";
            allowed_extensions = [ extension ];
          };
          xpi = ./release/atelier.xpi;
        in
        {
          options.programs.atelier = {
            enable = lib.mkEnableOption "atelier, agent-authored userstyles";
            package = lib.mkOption {
              type = lib.types.package;
              default = self.packages.${pkgs.stdenv.hostPlatform.system}.atelier;
              description = "The atelier package.";
            };
            installExtension = lib.mkOption {
              type = lib.types.bool;
              default = config.programs.firefox.enable && builtins.pathExists xpi;
              defaultText = lib.literalExpression "config.programs.firefox.enable";
              description = ''
                Install the signed extension (release/atelier.xpi) in Firefox
                through its policies, and keep it updated with this flake.
                Needs Firefox managed by home-manager (programs.firefox).
              '';
            };
            atelierDir = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              example = "~/src/my-styles";
              description = "The owned directory (SPEC §5). Defaults to $XDG_DATA_HOME/atelier.";
            };
          };
          config = lib.mkIf cfg.enable {
            home.packages = [ cfg.package ];
            home.file.".mozilla/native-messaging-hosts/atelier.json".text = manifest "atelier" "atelier@adrusi.com";
            home.file.".mozilla/native-messaging-hosts/atelier_dev.json".text = manifest "atelier_dev" "atelier-dev@atelier.invalid";
            programs.firefox.policies.ExtensionSettings = lib.mkIf cfg.installExtension {
              "atelier@adrusi.com" = {
                installation_mode = "normal_installed";
                install_url = "file://${xpi}";
              };
            };
            xdg.configFile."atelier/config.toml" = lib.mkIf (cfg.atelierDir != null) {
              text = ''atelier_dir = "${cfg.atelierDir}"'' + "\n";
            };
          };
        };

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = devEnvTools pkgs ++ (with pkgs; [ cargo rustc clippy rustfmt rust-analyzer ]);
          shellHook = ''
            export PATH="$PWD/dev/bin:$PATH"
          '';
        };
      });
    };
}
