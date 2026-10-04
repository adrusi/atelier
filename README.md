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

## Letting an agent work on styles

`atelier mcp` is an MCP server with tools for working in your browser: agent
tabs (background tabs, logged in where you are), screenshots, a design-token
inventory, "why does this rule (not) apply", a contrast scan, and so on. With
Firefox and the extension running, register it with your harness, e.g. for
Claude Code:

```sh
claude mcp add --scope user atelier -- atelier mcp
```

Then start a session on the queue with the `work` prompt, which Claude Code
offers as a command:

```
/mcp__atelier__work style lobste.rs
```

The agent puts your request in the queue (or picks up what's already there),
claims it, and works in a copy of your styles: its own tabs show its work in
progress, while yours keep your current styles. When it submits, the change
lands in the owned directory, and your tabs pick it up. Every landing can be
undone:

```sh
atelier journal          # landings and undos, newest first
atelier undo             # undo the most recent landing
atelier task list        # the queue
```

To commit each landing to git (or anything else), set a hook in
`~/.config/atelier/config.toml`:

```toml
[hooks]
on_land = 'git add -A . && git commit -qF -'   # runs in the owned directory; the summary is on stdin
```

To have atelier start a session when you ask for something, rather than
starting one yourself, give it a command in `~/.config/atelier/config.toml`:

```toml
[session]
start = "spawn"   # or "headless" for a command nobody watches; "pull" (default) never starts one
command = 'foot -D {dir} claude /mcp__atelier__work'
```

`{dir}` is the owned directory and `{task}` the task that prompted the
session, both already shell-quoted, so leave them outside quotes. Inside a
quoted script, use `$ATELIER_DIR` and `$ATELIER_TASK_ID` instead. A session
starts when a request arrives and no session is working or waiting. Try your
command with `atelier session start`. Whether a headless command is allowed
under your harness's plan is yours to check.

Requests from the browser itself ("Style this", "Something's off") are still
to come (SPEC.md §6.4).

## Watching agents work

Agents test styles in jailed Firefox instances that are headless by default.
To watch one, start an instance with `--visible` (from `nix develop`):

```sh
atelier-dev up --visible --atelier-dir examples/owned --grant-user-scripts --color-scheme dark
```

It appears as a single window running its own sway, so it doesn't disturb your
own windows. See DEVELOPING.md for the rest of `atelier-dev`.
