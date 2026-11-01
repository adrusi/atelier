# Developing atelier

Status: phase 1 (SPEC §15) is underway. Styles in an owned directory reach pages: `crates/atelier` has the loader, daemon, native-host relay and CLI basics, and `extension/` applies styles with the page shim. `kit/` and the rest of the later phases are still planned.

Get the tools with `nix develop`, which also puts `atelier-dev` on `PATH`. Then:

```sh
cargo build                                  # target/debug/atelier
(cd extension && npm install && npm run build)   # extension/dist; `npm run check` typechecks
atelier-dev up                               # picks up both automatically
```

## Repo layout

```
crates/
  atelier/          # the single binary: daemon, native-host, mcp, CLI
  atelier-proto/    # wire-protocol types (SPEC §4.1); `cargo test -p atelier-proto` regenerates
                    # the TypeScript bindings in extension/src/proto/ (committed; don't edit by hand)
extension/          # the WebExtension (TypeScript, esbuild, web-ext; MV3)
  src/page/         # the page runtime: atelier's code inside pages (ARCHITECTURE.md);
                    # only page/core.ts reaches into the page's structure (`npm run check`)
kit/                # agent kit: MCP prompts, skills, authoring guidance
dev/
  atelier-dev.ts    # the dev-environment script (below); dev/bin/atelier-dev runs it
  sway.conf         # compositor config for dev instances
  fixtures/         # fixture sites for tests and spikes, plus their server
  bidi.ts           # minimal WebDriver BiDi client, used by atelier-dev and by spikes
  smoke-extension/  # trivial extension for checking that extension loading works
spikes/             # throwaway spike code (R1–R5); never imported by the real code
flake.nix           # dev shell, packages, home-manager module
```

## Dev environments

Agents and humans test atelier in **dev instances**. Each is a jailed Firefox running inside its own compositor, completely separate from the developer's real browser, home directory and desktop. Nothing in development should touch the real profile, `~/.mozilla`, or the real XDG directories.

### Commands

```
atelier-dev up [--name NAME] [--visible] [--extension PATH]... [--native-host BIN]
               [--pref NAME=VALUE]... [--system-access] [--atelier-dir DIR] [--no-fixtures]
atelier-dev down NAME... | --all [--keep]
atelier-dev ls
atelier-dev env NAME                  shell exports: ATELIER_DEV_BIDI, ATELIER_DEV_FIXTURES, ...
atelier-dev exec NAME -- CMD [ARG]... run a command inside the instance's compositor
atelier-dev screenshot NAME [OUT]     compositor screenshot (grim); prints the path
atelier-dev capture NAME [OUT] [--full | --selector CSS]
                                      screenshot of the page itself (viewport, document, or element)
atelier-dev atelier NAME ARGS...      run the atelier CLI against the instance's daemon
atelier-dev vnc NAME [--port PORT]    serve a headless instance over VNC

atelier-dev navigate NAME URL         load URL in the first tab and wait for it
atelier-dev eval NAME EXPR            evaluate EXPR in the first tab
atelier-dev install-ext NAME PATH     install an extension (directory or .xpi) as a temporary add-on
atelier-dev bidi NAME METHOD [PARAMS] send one raw WebDriver BiDi command
```

A typical loop:

```sh
atelier-dev up --extension dev/smoke-extension   # prints name, BiDi URL, fixture URL
eval "$(atelier-dev env dev1)"
atelier-dev navigate dev1 "$ATELIER_DEV_FIXTURES/basic/"
atelier-dev screenshot dev1
atelier-dev down dev1
```

- `up` installs `extension/dist` automatically if it exists, unless `--extension` is given (a directory, or a packed `.xpi`), and registers `target/debug/atelier` as the native host if it exists (override with `--native-host`).
- Extensions and the native host must be inside the repo, because that's the only part of the real filesystem the jail can see (read-only).
- The BiDi commands each open and end their own session. **Firefox allows only one BiDi session at a time**, so these commands fail while another client (e.g. a test runner) holds one. Browsing-context IDs from one session aren't accepted by the next, so anything that needs IDs should do all its work in one session: write a script using `dev/bidi.ts` (see `spikes/r1/run.ts`).
- `--pref` adds a line to the profile's `user.js`; the value is parsed as JSON if it can be (`--pref extensions.foo=false`). `--system-access` starts Firefox with `--remote-allow-system-access`, which lets BiDi script extension pages (`script.evaluate` in a `moz-extension://` tab) and reach the browser's chrome (`browsingContext.getTree` with `"moz:scope": "chrome"`): `dev/e2e/recovery.ts` and the fidelity harness rely on it.
- `--fontconfig FILE` installs FILE as the jail's user `fonts.conf`, instead of binding the developer's fontconfig directory. Fonts it adds with `<dir>` must be in the Nix store, or somewhere else Firefox's content sandbox allows reading: a directory under the repo looks fine to `fc-list` but isn't visible to pages.
- `--color-scheme dark|light` sets what pages see as `prefers-color-scheme` (instances otherwise default to light).
- `--atelier-dir DIR` makes a host directory the instance's owned directory, bound read-write at the same path inside the jail, so host-side tools (`atelier-dev atelier`, `atelier mcp`) reach the same daemon and files. Use it to try real styles in a dev instance.
- Console output from extensions and pages goes to `log/firefox.log`. The extension's background logs its connection, bundle loads and user-script registration there.
- **Real input:** `atelier-dev exec NAME -- wtype …` types through the compositor, which produces trusted events. That's how to satisfy APIs that need a user gesture, such as `permissions.request`. Start with a delay (`wtype -s 300 …`): the first keystroke otherwise races the virtual keyboard's setup and is dropped.
- Logs for the jail, Firefox and the fixture server are in the instance's `log/` directory.

Instances live in `$XDG_RUNTIME_DIR/atelier-dev/<name>/` (override with `ATELIER_DEV_ROOT`). They're on tmpfs and disposable: `down` deletes them unless given `--keep`. Several can run at once (one per parallel agent). Budget about 0.5–1 GB of RAM each.

### What an instance contains

- **A bubblewrap jail.** Inside it:
  - `HOME` is the instance's own directory;
  - the XDG runtime, state, config and data directories are private, and so are the Firefox profile and `ATELIER_DIR`;
  - `/nix`, `/etc`, the repo and (on NixOS) `/run/current-system` are bound read-only; nothing else from the real home directory or `$XDG_RUNTIME_DIR` is visible;
  - `PATH` is the host's, with symlinked entries such as `~/.nix-profile/bin` resolved to store paths the jail can see;
  - sway runs under its own private session D-Bus (the nixpkgs wrapper starts one), so the jailed Firefox can never find the real one and open its windows there ("Firefox is already running").

  The network is shared for now, so that fixture sites, public smoke-test sites and the BiDi port are reachable. That means the jail's localhost is the host's localhost, and abstract unix sockets (which belong to the network namespace) are shared too. That's why Xwayland is disabled in `sway.conf`: it would collide with the host's X server. Tighter network isolation (pasta/slirp4netns) can come later.
- **Teardown:** `up` records the PID of the jail's PID-namespace init (from bwrap's `--info-fd`). `down` SIGKILLs it, and the kernel kills everything else in the namespace. PID-1 of a namespace ignores catchable signals from outside, which is why it's SIGKILL.
- **Fonts** are bound read-only into the jail: `~/.config/fontconfig` and `~/.local/share/fonts`. Fonts matter a lot when judging a style, so instances should render like the real desktop.
- **sway**, as the compositor:
  - default `WLR_BACKENDS=headless`: renders for real, but nothing appears on the desktop;
  - rendering is in software (`WLR_RENDERER=pixman`, overridable with `ATELIER_DEV_WLR_RENDERER`): GPU access inside the jail is unreliable, and software output is more reproducible across machines anyway;
  - `--visible`: `WLR_BACKENDS=wayland`, with the host's Wayland socket (and only that socket) bound into the jail, so the whole instance shows up as a single window;
  - sway rather than cage, so that tests can reproduce different window arrangements (one tab per window, focus, active tab per window).
- **Firefox** from the dev shell, with a fresh profile (first-run UI suppressed) and `--remote-debugging-port` for WebDriver BiDi on a port chosen per instance. It's launched as a child of sway via `swaymsg exec`, and so is the fixture server.
- **The dev build of the extension**, installed as a temporary add-on over BiDi (`webExtension.install`), so no signing is needed. Dev builds use their own IDs, `atelier-dev@…` for the extension and `atelier_dev` for the native host, as a second safeguard against clashing with a real install.
- **The dev native-messaging manifest**, written into the jail's `HOME` (`~/.mozilla/native-messaging-hosts/atelier_dev.json`), never the real one. It points at a small wrapper script that runs `atelier native-host`, since Firefox can't pass arguments to a host. The stub host logs every connection and message to `~/.local/state/atelier/native-host.log` inside the instance's home.
- **An atelier daemon** (planned) for the instance's `ATELIER_DIR`, whose socket is in the jail's runtime directory, exposed to the host through the instance directory.

### Driving an instance

- **From outside atelier:** WebDriver BiDi for navigation, script evaluation, screenshots and assertions, and `grim` for true compositor screenshots. Use these to check what atelier can't observe about itself (e.g. whether a page ever painted without its styles).
- **Through atelier:** `atelier-dev atelier NAME ARGS…` runs the CLI with the instance's XDG directories, so it reaches the instance's daemon: `status`, `browser METHOD JSON` (the agent tools, e.g. `browser tab/open '{"url":"…"}'`), or `mcp` to point an MCP client at the instance. (`atelier-dev env` only exports BiDi and fixture addresses.)
- Don't use Playwright here: it uses a patched Firefox, and its extension support is weak.

### End-to-end tests

`dev/e2e/` holds end-to-end tests that run the whole stack in a dev instance:
owned directory, daemon, native host, extension and page shim. Build first
(`cargo build`, `(cd extension && npm run build)`), then
`node dev/e2e/phase1.ts` (styles reaching pages), `node dev/e2e/tools.ts`
(the agent tools, driven through `atelier mcp` the way a harness would),
`node dev/e2e/sources.ts` (tabs bound to a task's tree),
`node dev/e2e/tasks.ts` (a task from queue to landing through `atelier mcp`),
`node dev/e2e/popup.ts` (requests and undo from the popup, driven by keystrokes),
`node dev/e2e/calls.ts` (questions from agents, the inbox, answers, theme stage),
`node dev/e2e/recovery.ts` (agent tabs and containers reconciled after a restart, simulated by reloading the extension),
`node dev/e2e/permissions.ts` (an install without site access: asking for it, and restarting to use it),
`node dev/e2e/windows.ts` (an agent session's tabs in a window of its own, the on_agent_window hook, and closing them when the session ends), and
`node dev/e2e/fidelity.ts` (emulation against the real thing, through the fidelity harness). A failing run keeps the instance and its owned
directory (`$XDG_RUNTIME_DIR/atelier-dev/<name>{,-owned}`) for inspection.

Unit and integration tests for the Rust side run with `cargo test`. Those for
the daemon start real daemons against temporary directories.

### The fidelity harness

`node dev/fidelity.ts [--scheme dark|light | --viewport WxH] [--ignore SELECTOR]... [--scroll Y] URL...`
renders each page for real and through atelier's emulation in one dev
instance, and prints what differs: computed styles per property, the root's
custom properties, layout (resized, or only moved), which image a
`<picture>` chose, and pixels, attributed to the elements they're in. Paths
starting with `/` are fixtures (`/scheme-hard/`). It starts its own instance
unless given `--instance NAME` (one started with `--system-access`); images
and `report.json` go to `$XDG_RUNTIME_DIR/atelier-dev/fidelity-reports/`.
Real pages are loaded twice, and what varies between loads is left out as
noise; `--ignore` leaves out what varies on every load (ad slots).
`--no-emulation` is the control: everything emulation should fix, unfixed.
For `--viewport`, the truth is a tab given that size with BiDi's
`setViewport`, and the emulated tab keeps a different real size; `--scroll`
compares the pages scrolled down that far.


### The UI tour

`node dev/tour.ts [--out DIR]` brings up dev instances and puts atelier's UI
into each state a person meets (first run before and after the permission,
an unstyled site, a request with no agent running, a styled site with a
change to undo, the inbox empty and with an agent's calls, a THEME.md
proposal and a design note, a request in progress), capturing each through
the compositor, browser chrome included. Screenshots and an `index.txt`
saying what each shows go to `$XDG_RUNTIME_DIR/atelier-dev/tour-shots/`. Run
it after changing the UI, and look.
### Fixture sites

`dev/fixtures/` holds small deterministic sites, each exercising one thing. Each instance runs `dev/fixtures/server.ts` inside the jail on its own port (`$ATELIER_DEV_FIXTURES`), serving each fixture directory at `/<name>/`. A fixture can have a `_fixture.json` that adds response headers (e.g. a CSP) or makes unknown paths serve `index.html` (for single-page apps), and HTML can use `{{ALT_ORIGIN}}` to reference the same server under a different origin; see the comment at the top of `server.ts`.

| Fixture | Exercises | Status |
|---|---|---|
| basic | ordinary light page, for smoke tests | exists |
| plain | minimal page carrying the style-injection probe | exists |
| strict-csp | style injection under strict CSP (R1) | exists |
| slow-stream | early first paint: the server pauses partway through the document (R1) | exists |
| hostile-head | a page that removes `<style>` elements, rebuilds `<head>` and resets adopted stylesheets after load (R1) | exists |
| capture | eight boxes, each coloured by a different mechanism (static CSS, timers, rAF, CSS animation, lazy image, ...), for checking what screenshots show; `?start=MS` delays the animated ones (R3) | exists |
| dark-reader | an ordinary light page reporting whether Dark Reader is acting on it, including in the first frame (R5) | exists |
| spa | navigation without page loads, for styles that start or stop matching mid-session | planned |
| shadow-dom | open and closed shadow roots; styles that need a script | planned |
| hashed-classes | selector-fragility linting; canaries | planned |
| color-scheme | every common way a page picks light or dark, including a cross-origin stylesheet (R2) | exists |
| cards | boxes of each kind (filled, rounded, shadowed, framed), a flat row, a control and a round avatar, for `shape_scan` | exists |

Write the planned ones alongside the spikes that need them. `_shared/probe.js` is a reusable probe for style-injection tests; its header comment describes how to use it. Directories starting with `_` are served but not listed.

Public smoke tests use sites that don't need logging in (Wikipedia, MDN, Hacker News). **Never copy cookies or profile data from a real profile into a dev instance.** Testing on logged-in services is done by hand, by the developer, in their own browser.

### Notes

- Temporarily installed MV3 extensions get their host permissions without a prompt. A signed install may not: one installed by policy or into a profile (home-manager) never sees a prompt, so it starts without site access, and then its styles aren't injected and APIs like `tabs.captureTab` don't exist (in any page or background started without it). atelier asks for it (`dev/e2e/permissions.ts`).
- Agent harnesses may themselves run tools inside a bubblewrap sandbox (Claude Code does on Linux). Nested bwrap usually works when unprivileged user namespaces are enabled. If it doesn't, run `atelier-dev` outside the harness's sandbox.

### Signing a release

The extension comes in two flavors (`extension/build.ts`): **dev**, the
default (ID `atelier-dev@atelier.invalid`, native host `atelier_dev`, built
into `extension/dist/`), and **release** (ID `atelier@adrusi.com`, native
host `atelier`, into `extension/dist-release/`). To sign a release through
AMO, with API credentials from addons.mozilla.org (Developer Hub → Tools →
Manage API Keys), from a `nix develop` shell:

```sh
cd extension
WEB_EXT_API_KEY=<JWT issuer> WEB_EXT_API_SECRET=<JWT secret> npm run sign
```

It versions the build by date and time (AMO needs a new version each time),
signs it as unlisted (not listed publicly), and saves
`release/atelier.xpi` and `release/VERSION`; commit both, since the
home-manager module installs from the flake. If AMO is still reviewing when
`web-ext` stops waiting, no file comes back; `npm run fetch-signed VERSION`
(same keys) downloads it once it's approved. As before, the
home-manager module installs from the flake. `web-ext lint --source-dir
extension/dist-release --self-hosted` runs AMO's validator locally first.
