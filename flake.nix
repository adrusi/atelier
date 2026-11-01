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

      # atelier for home-manager: the binary, its config.toml (the owned
      # directory, and how agent sessions start), the native-messaging hosts,
      # and optionally `atelier-agent`, Claude Code on atelier's queue with
      # only atelier's MCP server, and the signed extension through Firefox's
      # policies (or install packages.extension in a profile yourself).
      homeManagerModules.default = { config, lib, pkgs, ... }:
        let
          cfg = config.programs.atelier;
          system = pkgs.stdenv.hostPlatform.system;
          exe = lib.getExe cfg.package;
          # One host per flavor of the extension (extension/build.ts), both
          # this binary: the signed extension, and a dev build beside it.
          nativeHost = pkgs.runCommand "atelier-native-host" { } ''
            mkdir -p $out/lib/mozilla/native-messaging-hosts
            for host in "atelier atelier@adrusi.com" "atelier_dev atelier-dev@atelier.invalid"; do
              set -- $host
              cat > $out/lib/mozilla/native-messaging-hosts/$1.json <<EOF
            {"name": "$1", "description": "atelier native host", "path": "${exe}", "type": "stdio", "allowed_extensions": ["$2"]}
            EOF
            done
          '';
          dir = if cfg.atelierDir != null then cfg.atelierDir else "${config.xdg.dataHome}/atelier";
          # Only atelier's server, for agent sessions (never registered globally).
          mcpConfig = pkgs.writeText "atelier-mcp.json" (builtins.toJSON {
            mcpServers.atelier = { type = "stdio"; command = exe; args = [ "mcp" ]; };
          });
          # Ends a session once its work is done (atelier agent-hook).
          agentSettings = pkgs.writeText "atelier-agent-settings.json" (builtins.toJSON {
            hooks = {
              Stop = [ { hooks = [ { type = "command"; command = "${exe} agent-hook stop"; } ]; } ];
              UserPromptSubmit = [ { hooks = [ { type = "command"; command = "${exe} agent-hook prompt"; } ]; } ];
            };
          });
          agentArgs =
            lib.optionals cfg.agent.closeWhenDone [ "--settings" "${agentSettings}" ]
            ++ lib.optionals (cfg.agent.permissionMode != null) [ "--permission-mode" cfg.agent.permissionMode ]
            ++ cfg.agent.extraArgs;
          agent = pkgs.writeShellScriptBin "atelier-agent" ''
            # Claude Code on atelier's queue (SPEC §9.1): in the atelier
            # directory, with only atelier's MCP server and its tools allowed,
            # and atelier's state directory (where task trees are) writable.
            # The work prompt goes in as text: Claude Code connects MCP
            # servers in the background, so /mcp__atelier__work on its
            # command line would run before the command exists.
            cd "''${ATELIER_DIR:-${dir}}" || exit 1
            # Claude Code keeps this pid (exec), and its hooks and atelier mcp
            # see it, so a finished session can be ended.
            export ATELIER_AGENT_PID=$$
            exec ${lib.escapeShellArg cfg.agent.command} \
              --mcp-config ${mcpConfig} --strict-mcp-config \
              --allowedTools mcp__atelier \
              --add-dir "''${XDG_STATE_HOME:-$HOME/.local/state}/atelier" \
              ${lib.escapeShellArgs agentArgs} \
              "$@" "$(${exe} work-prompt)"
          '';
          toml = pkgs.formats.toml { };
          settings =
            lib.optionalAttrs (cfg.atelierDir != null) { atelier_dir = cfg.atelierDir; }
            // lib.optionalAttrs (cfg.session.start != "pull" || cfg.session.command != null || cfg.session.windows) {
              session = { inherit (cfg.session) start; }
                // lib.optionalAttrs (cfg.session.command != null) { inherit (cfg.session) command; }
                // lib.optionalAttrs cfg.session.windows { windows = true; };
            }
            // lib.optionalAttrs (cfg.hooks != { }) { inherit (cfg) hooks; };
          xpi = ./release/atelier.xpi;
        in
        {
          options.programs.atelier = {
            enable = lib.mkEnableOption "atelier, agent-authored userstyles";
            package = lib.mkOption {
              type = lib.types.package;
              default = self.packages.${system}.atelier;
              description = "The atelier package.";
            };
            atelierDir = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              example = "/home/me/src/atelier-styles";
              description = "The owned directory (SPEC §5): your themes and styles. Defaults to $XDG_DATA_HOME/atelier.";
            };
            session = {
              start = lib.mkOption {
                type = lib.types.enum [ "pull" "spawn" "headless" ];
                default = "pull";
                description = ''
                  How agent sessions start when you request work (SPEC §9.1):
                  "pull", by hand; "spawn", by running `command` (in a terminal,
                  so you can watch and answer); "headless", by running it
                  with nobody watching.
                '';
              };
              command = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = null;
                example = "ghostty --working-directory={dir} -e atelier-agent";
                description = ''
                  The command that starts a session, run with sh -c, with
                  {dir} (the owned directory), {state} (its state directory)
                  and {task} replaced by shell-quoted values. With agent.enable,
                  atelier-agent starts Claude Code on atelier's queue.
                '';
              };
              windows = lib.mkOption {
                type = lib.types.bool;
                default = false;
                description = ''
                  Open each agent session's tabs in a Firefox window of its own,
                  rather than as background tabs in your current window. The window
                  closes when the session ends. With hooks.on_agent_window, your
                  desktop can put it somewhere out of the way.
                '';
              };
            };
            hooks = lib.mkOption {
              type = lib.types.attrsOf lib.types.str;
              default = { };
              example = { on_agent_window = "move-to-workspace atelier"; };
              description = ''
                Commands for [hooks] in config.toml, run with sh -c: on_land and
                on_undo (SPEC §8.6), and on_agent_window, run when atelier opens a
                window for an agent session (session.windows), with
                ATELIER_FIREFOX_WINDOW_ID, ATELIER_AGENT and ATELIER_AGENT_PID.
              '';
            };
            agent = {
              enable = lib.mkEnableOption ''
                atelier-agent: Claude Code on atelier's queue, in the atelier
                directory, with only atelier's MCP server (nothing is registered
                with Claude Code globally)'';
              command = lib.mkOption {
                type = lib.types.str;
                default = "claude";
                description = "The Claude Code executable.";
              };
              closeWhenDone = lib.mkOption {
                type = lib.types.bool;
                default = true;
                description = ''
                  End a session (and so its terminal window) once it holds no task,
                  the queue is empty, and you haven't said anything to it. With
                  requests still queued, the agent is asked to carry on first.
                '';
              };
              permissionMode = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = "auto";
                description = ''
                  Claude Code's --permission-mode for atelier sessions, or null
                  for its default. Agents edit files, open tabs and run checks
                  all through a session, and answering a prompt for each isn't
                  practical, so the default is "auto". (Sandboxing that would let
                  agents run unprompted with less at stake is on the roadmap,
                  SPEC §15.)
                '';
              };
              extraArgs = lib.mkOption {
                type = lib.types.listOf lib.types.str;
                default = [ ];
                example = [ "--model" "opus" ];
                description = "More arguments for Claude Code.";
              };
            };
            installExtension = lib.mkOption {
              type = lib.types.bool;
              default = false;
              description = ''
                Install the signed extension (release/atelier.xpi) in Firefox
                through its policies. Needs Firefox managed by home-manager
                (programs.firefox). Alternatively, add packages.extension to a
                profile's extensions.packages.
              '';
            };
          };
          config = lib.mkIf cfg.enable {
            home.packages = [ cfg.package ] ++ lib.optional cfg.agent.enable agent;
            xdg.configFile."atelier/config.toml" = lib.mkIf (settings != { }) {
              source = toml.generate "atelier-config.toml" settings;
            };
            # Firefox finds native hosts through home-manager's programs.firefox
            # when it manages Firefox, and through ~/.mozilla otherwise.
            programs.firefox.nativeMessagingHosts = lib.mkIf config.programs.firefox.enable [ nativeHost ];
            home.file = lib.mkIf (!config.programs.firefox.enable) {
              ".mozilla/native-messaging-hosts/atelier.json".source = "${nativeHost}/lib/mozilla/native-messaging-hosts/atelier.json";
              ".mozilla/native-messaging-hosts/atelier_dev.json".source = "${nativeHost}/lib/mozilla/native-messaging-hosts/atelier_dev.json";
            };
            programs.firefox.policies.ExtensionSettings = lib.mkIf cfg.installExtension {
              "atelier@adrusi.com" = {
                installation_mode = "normal_installed";
                install_url = "file://${xpi}";
              };
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
