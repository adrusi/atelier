# atelier

Agent-authored userstyles: you describe the look you want in a theme, and
agents write bespoke styles that make the sites you use match your desktop.
Early days. The design is in [SPEC.md](SPEC.md), and how to work on it is in
[DEVELOPING.md](DEVELOPING.md).

## Trying it in your own Firefox

Style files in an owned directory are applied to pages, before first paint,
and update live when you edit them; agents can write and revise them for you.
The extension is signed (unlisted on AMO) as `release/atelier.xpi`, so
release Firefox keeps it installed.

1. **Build** the binary and the extension:
   ```sh
   nix build .#atelier .#extension-dev     # the binary, and an unpacked dev build of the extension
   ```
   Or in a dev shell: `cargo build` and `(cd extension && npm install && npm run build)`.
2. **Register the native host**, and choose the owned directory. The examples
   in this repo are a good start:
   ```sh
   atelier setup --dir examples/owned     # `nix run .#atelier -- setup …`, or target/debug/atelier
   ```
   This writes native-host manifests to `~/.mozilla/native-messaging-hosts/`
   (`atelier.json` for the signed extension, `atelier_dev.json` for a dev
   build; the same for LibreWolf or Waterfox if present) and
   `~/.config/atelier/config.toml`. With home-manager, import
   `homeManagerModules.default` from this flake instead and set
   `programs.atelier = { enable = true; atelierDir = "…"; };`.
3. **Install the extension:** open `release/atelier.xpi` in Firefox (File →
   Open File). With home-manager managing Firefox (`programs.firefox`), the
   module installs it through Firefox's policies instead, and keeps it updated
   with the flake. It asks to be allowed to run user scripts; it needs that to
   style pages before they first appear. (A dev build loads through
   `about:debugging` → This Firefox → Load Temporary Add-on, picking
   `extension/dist/manifest.json`; Firefox removes it when it restarts.)
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

Ask for things from atelier's toolbar button: **Style this site** on a page
with no style yet, or **Something's off?** on one that has one, optionally
with a screenshot of what you're looking at. Requests go into a queue. To
work through it, start a session with the `work` prompt, which Claude Code
offers as a command (or have atelier start one for you; see below):

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

Agents put questions to you in atelier's **inbox** (linked from the toolbar
button, which shows how many are waiting): batched, with screenshots, and with
the agent's own choice preselected, so keeping it is one click. While your
theme is new, agents ask readily, since your answers sharpen it. Once styles
meet your bar without back-and-forth, mark the theme *settled* (in the inbox,
or `atelier stage settled`), and they'll make their own calls and record
them for you to revisit.

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
command = 'foot -D {dir} claude --add-dir {state} "$(atelier work-prompt)"'
```

(The prompt goes in as text because Claude Code connects to MCP servers in
the background: `/mcp__atelier__work` on its command line runs before the
command exists.)

`{dir}` is the owned directory, `{state}` atelier's state directory for it
(where agents edit their copies of your styles, so Claude Code needs
`--add-dir` for it), and `{task}` the task that prompted the session, all
already shell-quoted, so leave them outside quotes. Inside a
quoted script, use `$ATELIER_DIR` and `$ATELIER_TASK_ID` instead. A session
starts when a request arrives and no session is working or waiting. Try your
command with `atelier session start`. Whether a headless command is allowed
under your harness's plan is yours to check.

Agent tabs open as background tabs in your current window. To keep them out
of the way instead, give each session a Firefox window of its own, and have
your desktop move it somewhere (a workspace of its own, say):

```toml
[session]
windows = true    # each session's tabs in a window of its own, closed when it ends

[hooks]
on_agent_window = 'my-move-script'   # gets ATELIER_FIREFOX_WINDOW_ID, ATELIER_AGENT, ATELIER_AGENT_PID
```

The hook gets Firefox's id for the window, not the window manager's. An
extension that puts the id in window titles (firefox-sway-favicon sets
`[fx:ID] `) lets a script find it, e.g. `swaymsg '[title="^\[fx:ID\] "] move
container to workspace atelier'`. When a session ends (its `atelier mcp`
exits), the tabs it opened close, in either mode.

With Nix, the home-manager module's `atelier-agent` also ends a Claude Code
session once its work is done: when it holds no task, the queue is empty and
you haven't typed anything to it (`atelier agent-hook`, run from Claude Code's
Stop and UserPromptSubmit hooks; `programs.atelier.agent.closeWhenDone`). It
starts Claude Code in `auto` permission mode (`agent.permissionMode`).


## Watching agents work

Agents test styles in jailed Firefox instances that are headless by default.
To watch one, start an instance with `--visible` (from `nix develop`):

```sh
atelier-dev up --visible --atelier-dir examples/owned --grant-user-scripts --color-scheme dark
```

It appears as a single window running its own sway, so it doesn't disturb your
own windows. See DEVELOPING.md for the rest of `atelier-dev`.
