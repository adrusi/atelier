# atelier

Agent-authored userstyles: you describe the look you want in a theme, and
agents write bespoke styles that make the sites you use match your desktop.
Early days. The design is in [SPEC.md](SPEC.md), and how to work on it is in
[DEVELOPING.md](DEVELOPING.md).

## Trying it in your own Firefox

Phase 1 works: style files in an owned directory are applied to pages, before
first paint, and update live when you edit them. There are no signed builds
yet, so the extension loads as a temporary add-on, which Firefox removes when
it restarts.

1. **Build** the binary and the extension:
   ```sh
   nix build .#atelier .#extension
   ```
   Or in a dev shell: `cargo build` and `(cd extension && npm install && npm run build)`.
2. **Register the native host**, and choose the owned directory. The examples
   in this repo are a good start:
   ```sh
   atelier setup --dir examples/owned     # `nix run .#atelier -- setup …`, or target/debug/atelier
   ```
   This writes `~/.mozilla/native-messaging-hosts/atelier_dev.json` (and the
   same for LibreWolf or Waterfox if present) and
   `~/.config/atelier/config.toml`. With home-manager, import
   `homeManagerModules.default` from this flake instead and set
   `programs.atelier = { enable = true; atelierDir = "…"; };`.
3. **Load the extension:** go to `about:debugging` → This Firefox → Load
   Temporary Add-on, and pick `manifest.json` in the built extension
   (`result-1/` from `nix build`, or `extension/dist/`). It asks to be allowed
   to run user scripts; it needs that to style pages before they first appear.
4. **Look around.** The toolbar button shows what applies to the current page,
   and `atelier status`, `atelier lint` and `atelier match URL` help from the
   terminal. Edit a style under the owned directory and open pages update as
   you save.

Each service's styles have screenshots in `previews/` next to them, if you'd
rather look first.

## Watching agents work

Agents test styles in jailed Firefox instances that are headless by default.
To watch one, start an instance with `--visible` (from `nix develop`):

```sh
atelier-dev up --visible --atelier-dir examples/owned --grant-user-scripts --color-scheme dark
```

It appears as a single window running its own sway, so it doesn't disturb your
own windows. See DEVELOPING.md for the rest of `atelier-dev`.
