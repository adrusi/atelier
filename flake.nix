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

        # The signed extension (release/atelier.xpi, from `npm run sign`), laid
        # out for home-manager's programs.firefox.profiles.<name>.extensions.packages.
        extension = pkgs.stdenvNoCC.mkDerivation {
          pname = "atelier-firefox-addon";
          version = pkgs.lib.removeSuffix "\n" (builtins.readFile ./release/VERSION);
          src = ./release/atelier.xpi;
          dontUnpack = true;
          installPhase = ''
            dir=$out/share/mozilla/extensions/{ec8030f7-c20a-464f-9b0e-13a3a9e97384}
            mkdir -p $dir
            cp $src $dir/atelier@adrusi.com.xpi
          '';
          passthru.addonId = "atelier@adrusi.com";
          meta = {
            description = "atelier: agent-authored userstyles";
            # extension/src/manifest.json: permissions, host permissions, and
            # the optional user-scripts permission it asks for on first run.
            mozPermissions = [
              "nativeMessaging" "storage" "webNavigation" "alarms" "sessions" "cookies"
              "contextualIdentities" "userScripts" "<all_urls>"
            ];
          };
        };

        # The native-messaging host manifests for both flavors of the extension
        # (extension/build.ts), for programs.firefox.nativeMessagingHosts.
        native-host = pkgs.runCommand "atelier-native-host" { } ''
          mkdir -p $out/lib/mozilla/native-messaging-hosts
          for host in "atelier atelier@adrusi.com" "atelier_dev atelier-dev@atelier.invalid"; do
            set -- $host
            cat > $out/lib/mozilla/native-messaging-hosts/$1.json <<EOF
          {
            "name": "$1",
            "description": "atelier native host",
            "path": "${pkgs.lib.getExe atelier}",
            "type": "stdio",
            "allowed_extensions": ["$2"]
          }
          EOF
          done
        '';

        # The unpacked dev build of the extension (dist/), for about:debugging.
        extension-dev = pkgs.buildNpmPackage {
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
