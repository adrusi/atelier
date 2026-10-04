# atelier — design spec

Status: draft · 2026-09-29

atelier is a system for giving the web services you use every day bespoke userstyles that match each other and your desktop. The styles are written, maintained and repaired by LLM agents working from themes you write.

It is closer to traditional userstyles than to Dark Reader: every style is written for a specific site, stored as plain files, and applied with no agent involved when a page loads. The agent takes the place of the online style repository (userstyles.world and similar). It writes a style when you ask for one and repairs it when the site changes underneath it.

---

## 1. Goals and non-goals

### Goals

- **Bespoke, coherent styling.** Each service gets styles written for it, following one theme written by the user, so services look like they belong together and with the desktop.
- **Durable.** Styles are plain files applied by an ordinary extension. Agents are needed to write and repair styles, never to view a page.
- **Breakage gets noticed.** atelier detects when a site change has probably broken a style, limits the damage, and queues a repair.
- **Local and user-controlled.** No cloud service. atelier never holds LLM credentials. Users bring their own agent harness and their own way of managing dotfiles.
- **Agents are contractors, not tools.** Agents can ask questions, report problems, make suggestions, decline a task, and give feedback to the atelier developers.

### Non-goals (v1)

- A cloud service, account system, or style marketplace. The file format stays compatible with Stylus, so styles can still be shared by hand.
- A built-in generic fallback (Dark Reader-style recolouring) for sites without styles. Instead, atelier makes an installed Dark Reader step aside on pages it styles (§6.5). A built-in fallback is a possible future direction (§18).
- Chrome and other Chromium browsers.
- Flatpak or Snap builds of Firefox. Their native-messaging support goes through portals and is unreliable; this is documented as unsupported.
- Services defined by the software they run ("every Mastodon instance"). A service is whatever set of scopes the agent writes for the user's description.
- Variants other than light/dark. A different look is a different theme.

---

## 2. Principles

1. **atelier owns exactly one directory, and nothing else.** The directory is plain files. atelier knows nothing about version control. Users can manage the directory however they like, including inside a dotfiles repo (§5).
2. **atelier never holds LLM credentials.** Agent sessions run in the user's own harness, started by the user or by a command the user configured (§9.1).
3. **Content and state are kept apart.** Content (themes, styles, notes) lives in the owned directory and is portable. Runtime state (queue, task trees, journal, health, approvals) lives in the state directory and belongs to one machine.
4. **Assume unusual setups.** One tab per window, containers, sway-managed windows, bare-repo dotfiles, jj, Nix, read-only home directories. Make as few assumptions as possible about the browser, window manager, filesystem or VCS, and document the ones we do make.
5. **Page loads never depend on the host.** Styles are cached in the extension and applied synchronously. If the daemon is down, styling carries on.

---

## 3. Glossary

| Term | Meaning |
|---|---|
| **Owned directory** (`ATELIER_DIR`) | The one directory atelier owns. Holds themes, services, styles, scripts, checks and notes. |
| **State directory** | `$XDG_STATE_HOME/atelier/<dir-id>/`, where `<dir-id>` is a hash of the canonical `ATELIER_DIR` path. Runtime state for that owned directory. |
| **Theme** | A document written by the user describing an artistic vision, plus reference images and optional parameters. Exactly one theme is active at a time. |
| **Service** | A short user description of something to style ("GitHub", "my Nextcloud"), plus the styles, scripts and checks that implement it for each theme. |
| **Style** | A UserCSS file (`*.user.css`). A service can have several, each with its own scopes. |
| **Script** | A userscript (`*.user.js`) that supports a style, e.g. by reaching into shadow roots or adding stable hook attributes. |
| **Check** | A test that a style still works (§11). |
| **Source** | A directory tree that styles are served from: the owned directory, or a task's tree. Every tab is bound to one source. |
| **Task** | One piece of work (create, repair, revise, port, audit, notes) with its own tree, base and thread. |
| **Session** | One run of an agent harness connected to atelier's MCP server. |
| **Supervisor** | The top-level agent in a session. It coordinates contractors and is the only one that may change theme-level files. |
| **Contractor** | An agent (usually a subagent) working on exactly one task. |
| **Landing** | Applying a finished task's changes to the owned directory. |

---

## 4. Architecture

```
┌──────────── Firefox profile ────────────┐
│ extension                               │
│  • registered content scripts (cache)   │        ┌───────────── user's harness ─────────────┐
│  • tab → source bindings                │        │ supervisor ──delegates──▶ contractor(s)  │
│  • agent tabs, passive checks           │        │        │ MCP (stdio)            │ MCP     │
│  • popup + sidebar UI                   │        └────────┼────────────────────────┼─────────┘
└──────────────┬──────────────────────────┘                 ▼                        ▼
               │ native messaging                    atelier mcp ─────────── atelier mcp
               ▼                                            │                        │
        atelier native-host ──────────┐                     │                        │
                                      ▼                     ▼                        ▼
                           atelier daemon  ◀──── $XDG_RUNTIME_DIR/atelier/<dir-id>.sock ────▶ atelier (CLI)
                              │        │
                 ATELIER_DIR ◀┘        └▶ $XDG_STATE_HOME/atelier/<dir-id>/
                 (content, watched)       (queue, tasks, journal, health, approvals, threads)
```

Everything on the host side is a single Rust binary, `atelier`, with subcommands:

- **`atelier daemon`**: one per owned directory. Owns the queue, task lifecycle, landing, journal, file watching and message threads, and routes MCP calls to the browser. Listens on `$XDG_RUNTIME_DIR/atelier/<dir-id>.sock`. The first client for an owned directory starts it (optionally via systemd socket activation), and it exits after being idle for a while.
- **`atelier native-host`**: started by Firefox through native messaging. A thin bridge between the extension and the daemon. Firefox doesn't tell the native host which profile launched it, so the extension sends its configured `ATELIER_DIR` when it connects, and the native host connects to that directory's daemon, starting it if necessary.
- **`atelier mcp`**: the stdio MCP server started by the agent harness. A thin client of the daemon. It resolves the owned directory from `ATELIER_DIR` or `--dir`.
- **CLI subcommands** (§13).

**Topology:** one daemon per owned directory. Browser profiles pick their owned directory in the extension's settings; the default is `$XDG_DATA_HOME/atelier`, and Nix can set it through Firefox's managed-storage manifest. Profiles that share a directory share one daemon, queue and set of styles. Each profile keeps its own tab bindings, agent tabs and container mapping.

When no browser is connected, MCP tools that need one fail right away with `browser_not_connected` rather than hanging.

### 4.1 Wire protocol (proposed)

Every hop speaks the same protocol: extension ↔ native host ↔ daemon ↔ (`atelier mcp`, CLI). Only the framing differs. Native messaging uses its own length-prefixed JSON framing, and the unix socket uses length-prefixed frames. The native host is a relay that only changes the framing.

- **Control:** JSON-RPC 2.0, in both directions, with LSP-style extensions:
  - `$/cancel` to cancel a request, needed for long polls such as `next_task`;
  - `$/progress` for long operations;
  - notifications for subscriptions, such as a source changing or a tab being closed.
- **Handshake:** the first exchange on any connection carries protocol version, peer role (extension, native host, mcp, cli), capabilities and, for the extension, its `ATELIER_DIR` and profile identity.
- **Large data goes through a blob channel.** Screenshots, CSS bundles and file trees are **content-addressed** blobs, referenced by hash in control messages and fetched in chunks by the receiver (`blob/get {hash, offset, len}`).
  - The receiver pulls chunks at its own pace, which gives flow control.
  - Small chunks (≈256 KiB) interleave with control messages, so a big screenshot never holds up a cancel.
  - Receivers cache blobs by hash, so a source update only transfers the files that changed.
  - This stays under native messaging's message-size limits in both directions. Design for the most restrictive browser (Chrome's host→extension limit is 1 MB); Firefox's actual limits still need checking.
- **One schema source:** message types are defined in a Rust crate (`atelier-proto`), and TypeScript types for the extension are generated from it (e.g. with `ts-rs` or `specta`). The two sides can't drift apart.
- **Why not something heavier** (e.g. a TCP-like stream plus multiplexing over native messaging): the stdio pipe is already reliable and ordered. What it lacks is multiplexing and handling of large payloads, and chunked blobs pulled by the receiver cover both.

### 4.2 Manifest version

The extension targets **Manifest V3**:
- §12 depends on the MV3 `userScripts` API (`configureWorld` and the `USER_SCRIPT` world). The MV2 `userScripts` API is an older, different design.
- MV3 keeps a future Chrome port possible.

MV2's one advantage is a persistent background page. In MV3 the background may be suspended when idle, so the background must be restartable anyway: the daemon holds the authoritative state, and the extension reconnects and resynchronises when it wakes up. R4 found that the background is not suspended while its native port is open, so in practice a restart follows the host going away, or the browser starting.

---

## 5. The owned directory

### 5.1 Contract

> atelier owns `ATELIER_DIR`. It writes there only when a task lands or a landing is undone, and it writes only the files that change touched, using write-then-rename. It never deletes a file that a change didn't delete, and it ignores dotfiles and dot-directories (so a `.git` inside the directory is fine). Anything may change the directory at any time. atelier reloads, and tasks based on stale files are sent back for reconciliation. `ATELIER_DIR` must be writable.

For Nix and home-manager users: don't manage the directory's contents with `home.file`, which produces read-only symlinks into the store. Point `ATELIER_DIR` at a checkout, e.g. using `mkOutOfStoreSymlink`.

### 5.2 Layout (proposed)

```
ATELIER_DIR/
├── atelier.toml                  # active theme; directory-level settings
├── themes/
│   └── <theme>/
│       ├── THEME.md              # user-written: vision, visual language, parameters
│       ├── refs/                 # reference images (screenshots, moodboards, palettes)
│       ├── notes.md              # design notes maintained by the supervisor
│       └── global/               # optional styles for every site (scrollbars, ::selection, focus rings)
└── services/
    └── <service>/
        ├── service.toml          # description, prerequisites, per-theme file lists, canaries
        ├── notes.md              # durable decisions and user preferences (not specific to a theme)
        └── <theme>/
            ├── *.user.css
            ├── *.user.js
            ├── checks/*.check.js
            └── previews/*.jpg        # screenshots of the styled site, for people and the UI
```

- **`service.toml`** (optional) records the user's original description (`description`), a short summary written by the agent (`summary`), any **prerequisites** (`prerequisites`, for example "set GitHub's appearance to 'sync with system'"), and whether to keep Dark Reader off its pages (`dark_reader_lock`, default true; §6.5). Every style file in `services/<service>/<active theme>/` is loaded. Canaries (§11) will be added here too.
- **Service notes are independent of theme.** They record things like "the user wants the sidebar kept visible". They are written by contractors when a task lands, so later contractors inherit decisions without reading old threads.
- **Theme notes are written only by the supervisor** (§9.3).
- **Previews.** Whoever writes or revises a style leaves a few screenshots of representative pages in `previews/`, named for what they show (`repo-home.jpg`). They let the user judge a style without visiting the site, and are meant for thumbnails in the extension's UI later. JPEG at viewport size keeps them small enough to commit.
- Scopes are expressed inside each style using UserCSS `@-moz-document` blocks. A service is not itself a scope.
- A service with no styles for the active theme is left unstyled. The UI can offer to queue a `port` task.

### 5.3 File formats

- **Styles** are UserCSS, the `==UserStyle==` metadata format used by Stylus, with `@-moz-document` sections, so styles can be imported from and exported to Stylus. v1 supports only the `default` preprocessor; `stylus`, `less` and `uso` are rejected by the linter.
- **Scripts** use Greasemonkey/Violentmonkey metadata (`==UserScript==`). No `@grant`s in v1 (§12).
- **Light/dark** is handled with `@media (prefers-color-scheme: …)` inside styles. There is no other variant mechanism.

### 5.4 Variables

- A style declares UserCSS `@var`s with defaults. As with Stylus's default preprocessor, each `@var` is exposed as a `--<name>` custom property.
- Values come from **`$XDG_CONFIG_HOME/atelier/vars.json`**, a flat global map from var name to value. It is watched, and a change updates every tab without any agent involvement.
- atelier doesn't read pywal, matugen, base16 or any other colour-scheme manager's output. Users who want that write a template for their manager that renders `vars.json`.
- **Whether a theme takes parameters at all is decided in THEME.md.** The theme lists the vars it depends on and says how hard agents should work across the range of possible values: "must look good with any base16 scheme" versus "the palette is fixed; optimise for exactly these values". Agents follow that.

---

## 6. The extension

### 6.1 Applying styles

- The extension keeps a **cache for each source**: compiled CSS and scripts, pushed by the daemon. It is derived data and can be rebuilt at any time.
- **Default source:** styles from the owned directory are registered as user scripts that run at `document_start` (mechanism below), so page loads never wait on messages.
- **Cascade origin:** styles are injected as **author-origin** CSS, the same way Stylus does it. `cssOrigin: "user"` isn't used by default: user-origin normal declarations lose to author normal declarations, so it only helps with `!important` everywhere, and it would break semantic compatibility with existing UserCSS.
- **Injection mechanism** (decided by R1): a user script (`userScripts.register`, USER_SCRIPT world, `document_start`) with the CSS embedded in its code inserts a `<style>` element. The element is kept as the last child of `<html>`, so it wins ties with the page's own rules, and a MutationObserver puts it back if the page removes it. In Firefox 156 this applies before first paint, isn't blocked by strict CSP, survives hydration-style clobbering, and can be removed per tab. `scripting.insertCSS` on navigation commit was measured too, and misses the first frame on every page.
- **This makes the `userScripts` permission necessary for styles**, not only for userscripts (§12). It's optional-only in Firefox, so first-run setup includes a grant step with a real click.
- **Changing a style** updates the user-script registration, for future loads, and the `<style>` text in tabs that are already open: shims connect back to the background and take live updates. Tabs that have no shim yet (opened before any style matched them, or before the extension started) get one injected with `userScripts.execute` when a style starts applying to them. Without that, a newly written style only showed up after a reload, which breaks the most basic authoring loop (dogfooding, examples/DOGFOODING.md).
- **A save that breaks a style** (it no longer parses or lints) doesn't unstyle open pages: the daemon keeps serving the last version that loaded, with a warning, until the file is fixed. Deleting the file removes the style.
- **Variables** are compiled into each style as `:root { --name: value; … }`, with values from `vars.json` and the style's own `@var` defaults as fallback. A change to `vars.json` produces a new bundle like any other change.

### 6.2 Binding tabs to sources

Every tab is bound to a source, and the owned directory is the default. Agent tabs are bound to their task's tree. The daemon watches every live source and pushes changes only to the tabs bound to it, so:

- work in progress never appears in the user's real tabs;
- a user can bind one of their own tabs to a task's tree to preview it ("try this before it lands"), which gives optional review without any approval machinery;
- hand edits to the owned directory show up in real tabs as soon as the file is saved.

Agent tabs can tolerate a brief flash of the wrong styles. So a tab bound to something other than the default may load with the default styles and then swap them out asynchronously. Only the default source has to be synchronous. The mechanism (R1, R2; implemented):

- **Daemon.** `bundle/get { source: <task id> }` starts serving a claimed task's tree as a source: the daemon loads it like the owned directory (with the same last-good handling), watches it, and announces changes as `bundle/changed { source, hash, size }`. `status { source }` reports that source's hash, so tools can wait for a save to arrive. A source stops being served when its task lands, is declined or is abandoned. A task whose lease ran out keeps its tree, and its source.
- **Extension.** The background keeps the tab → task bindings in `storage.session` and a bundle per bound source. When a shim connects, the background tells it which source its tab is bound to and sends that source's styles. Those replace whatever the shim had and win over anything registered scripts add later. When a task finishes, its tabs go back to the owned directory, which by then has the landed change.
- **Shim.** A bound tab's `sessionStorage` holds a marker (`atelier:source`), which is readable synchronously at `document_start`. With the marker present, the shim skips the default styles that registered scripts add and waits for the bound source's styles. The marker is per origin and pages can clear it. Without it, the first load on an origin shows the default styles until the background's message arrives.
- **Pages with no default style.** A task can style a site the owned directory doesn't cover yet, where no registered script runs. So on every top-level navigation in a bound tab, the background injects the shim with `userScripts.execute`.

Agents get bound tabs with `tab/open { url, task }`, and `tab/bind { tab, task | null }` moves an agent tab between sources. A user binding one of their own tabs (for a preview) is still to come, in the popup.

### 6.3 Agent tabs

- atelier **creates tabs, never windows**. Where they end up is up to the browser and whatever extensions the user runs. A user preference can request a new window, off by default.
- Agent tabs are tracked by tab ID, not by position. atelier tolerates them being moved, closed or discarded, and recreates them when needed.
- **Containers:** an agent tab opens in the same `cookieStoreId` as the tab the request came from, or the container named in the task. Otherwise it wouldn't be logged in.
- Agent tabs are closed when their task finishes, or when their session disconnects without holding a lease.
- **Screenshots** (decided by R3): agent tabs are background tabs in the user's current window by default, captured with `tabs.captureTab`. That works for hidden tabs and gets DOM and CSS state right, including timers, lazy images and freshly injected CSS. But `requestAnimationFrame` stops while a tab is hidden, and CSS animations don't run in tabs that have never been shown. So the screenshot tool fast-forwards CSS animations before capturing, and tells the agent when content drawn by animation frames may be missing. A window on a hidden workspace behaves the same as a background tab, so the "new window" preference stays off by default.

### 6.4 UI

- **Toolbar popup** (per page):
  - which service and styles apply, and their health;
  - **Style this**: a `create` task, with a free-text description prefilled from the page's origin;
  - **Something's off**: a `revise` task, with a note and an optional screenshot of a selected region;
  - per-style on/off toggles;
  - undo the most recent landing for this service;
  - when a session is needed but none is connected: a **Start session** button, if a spawn command is configured (§9.1).

  *Implemented (phase 3a):* the popup asks **Style this site** (a `create` task; the description defaults to "Style <host>", the text box adds detail) on pages no service's styles apply to, and **Something's off?** (a `revise` task for that service) on pages they do. Either can attach a screenshot of the visible page (on by default), which the daemon stores with the task and the brief lists for the agent (`brief.attachments`). The request carries the page's URL and container. The popup lists the site's recent requests and their state, refreshing while it's open, and offers undo for the latest landing on the site's service that hasn't been undone. Region selection, per-style toggles and a Start session button are still to come. `popup.html?tab=ID` shows the popup for any tab as a page of its own, which is how `dev/e2e/popup.ts` drives it.

- **Sidebar panel** (the "inbox"):
  - message threads with agents, for questions, reports and suggestions (§9.4);
  - the task queue and task states;
  - scripts awaiting approval (§12);
  - drafts of feedback to the developers, for the user to review.
- **Badge** on the toolbar icon, for broken styles or questions waiting on the user. atelier never uses alerts or modal notifications.

### 6.5 Working alongside Dark Reader

Users will reasonably want a generic fallback, such as Dark Reader, for the many pages that will never get a bespoke style. To avoid the user having to disable Dark Reader by hand on every styled origin, atelier injects `<meta name="darkreader-lock">` at `document_start` on any page where a bespoke style matches. Dark Reader respects this tag, which sites use to opt out. This lets atelier work alongside Dark Reader without any communication between the two extensions.

- The tag is injected by the same shim that applies the default source's styles (§6.1), so it is present whenever bespoke styles are. At `document_start` it's appended to `<html>`, since `<head>` doesn't exist yet. Dark Reader checks the whole document once `<head>` appears, so it never acts, not even its first-paint fallback (R5).
- If a style starts matching later in the same document (single-page-app navigation), the lock goes in `<head>`, the only place Dark Reader watches. Dark Reader then removes its theme.
- If a style stops matching, the lock stays: Dark Reader wouldn't come back until a reload anyway. Within a document, once atelier has styled the page, Dark Reader stays off until reload. For single-page apps that's a reason to scope a service's styles to the whole app.
- A per-service setting (`service.toml`) can turn the lock off, for the rare style meant to sit on top of Dark Reader. Only sections with `@-moz-document` matchers lock: CSS outside any block (which `atelier lint` warns about in service styles) and theme-wide global styles never do, or they would switch Dark Reader off everywhere.
- The fallback's colours stay the user's business: Dark Reader's settings aren't linked to the atelier theme.

---

## 7. State directory

```
$XDG_STATE_HOME/atelier/<dir-id>/
├── dir                       # canonical ATELIER_DIR path (for humans and for diagnosing problems)
├── queue.json                # task order
├── tasks/<task-id>/
│   ├── task.json             # the task record (§8.2)
│   ├── base.json             # path → hash for every file when the task was claimed
│   ├── tree/                 # full copy of ATELIER_DIR, which the contractor edits
│   ├── handoff.md            # contractor's notes for whoever resumes the task
│   └── thread.jsonl          # messages
├── journal/<seq>.json        # undo journal (§8.5)
├── health/                   # latest check results, per style
├── approvals/<sha256>        # approved script hashes (§12)
└── feedback/                 # drafts of feedback to the developers
```

---

## 8. Tasks

### 8.1 Kinds

| Kind | Started by | Carries |
|---|---|---|
| `create` | user ("Style this") | description, origin hint, container |
| `revise` | user ("Something's off") | the style concerned, user note, optional region screenshot |
| `repair` | health checks, or the user | failing check results, screenshots, what was disabled |
| `port` | user or UI suggestion | service, source theme, target theme |
| `audit` | user, e.g. after editing THEME.md | theme; re-check and report on every service in it, then usually spawn `revise` tasks |
| `notes` | supervisor only | proposed changes to theme notes, collected from contractors |

### 8.2 Task record

```jsonc
{
  "id": "…", "kind": "create",
  "service": "github",                // null for a create task until the agent picks an id
  "theme": "…",
  "brief": { "description": "…", "origin": "https://github.com", "note": "…", "attachments": ["…"] },
  "container": "firefox-container-2",
  "state": "working",
  "lease": { "session": "…", "expires": "…" },
  "token": "…",                       // capability token (§10.2)
  "created": "…", "updated": "…",
  "outcome": null                     // landed{journal_seq} | declined{reason} | abandoned
}
```

### 8.3 Lifecycle

```
queued ─▶ claimed ─▶ working ─────────────▶ submitted ─▶ landed
            ▲          │  │                    │
            │          │  └─▶ blocked ──(user replies)──▶ working
            │          │      (awaiting user)  │ gate or conflict fails
            │          │                       ▼
            │          └─▶ declined          working (with reasons)
            └── lease expires: back to queued, tree kept
```

- **Claiming** copies the whole owned directory to `tasks/<id>/tree/` and records `base.json`. Owned directories are kilobytes to a few megabytes, so a full copy is cheaper and simpler than an overlay, and the contractor gets one ordinary directory to work in with its own tools.
- **Leases** are renewed by heartbeat. If a lease expires, the task goes back to the queue with its tree and `handoff.md` intact, and the next contractor resumes it.
- **One active task per service.** A new request for a service that already has a task in flight is added to that task's brief and thread, instead of starting a competing task.
- **Blocking:** a contractor may park a task waiting for the user. The supervisor moves on in the meantime. The default for low-stakes choices is to carry on and record the assumption in the landing summary (§9.4).
- **Declining** is a legitimate outcome, e.g. "this app renders into a canvas; CSS can't meaningfully restyle it." The reason is shown to the user and written to the service notes.

### 8.4 Landing

The contractor calls `task_submit` with a **summary**: a commit-message-quality description of the change, plus any assumptions it made. The daemon then:

1. Diffs the task tree against `base.json` to get a **change set** of added, modified and deleted paths.
2. **Checks paths.** Contractor tasks may only change `services/<its service>/…`. Only `notes` tasks from the supervisor may change `themes/…`. Changes to `atelier.toml` are rejected.
3. **Lints**: remote `url()`s, fragile selectors, unsupported preprocessors, metadata (§12).
4. **Gate:** runs the service's checks in the agent tab against the task tree (§11).
5. **Concurrency check:** for every path in the change set, the file's current hash in the owned directory must equal its hash in `base.json`. If any differs (a hand edit, another landing, or a VCS rollback), the submission is rejected and the contractor is given the current files to reconcile. The contractor does the merge; atelier has no merge algorithm.
6. **Writes** the change set: journal entry first (§8.5), then write-then-rename per file. The daemon ignores watcher events caused by its own writes and pushes a single reload.
7. Runs the **`on_land` hook** (§8.6).

### 8.5 Undo journal

- Each landing records the **pre-image** of every file it touched (content, or "didn't exist"), plus the hash of each file as written.
- **Undo** for an entry restores the pre-images, provided every touched file still matches the hash recorded as written. If any don't match (a hand edit, a later landing, or a VCS rollback), undo refuses for that entry and says why. Undo is recorded as an entry of its own, so it can itself be undone.
- The journal is bounded (default: 50 entries or 90 days, whichever is larger) and survives browser and daemon restarts.
- Persistent history beyond the journal is the user's job, via the hooks.

### 8.6 Hooks

`on_land` and `on_undo` run a command configured by the user. It receives:

- `ATELIER_DIR`, `ATELIER_TASK_ID`, `ATELIER_TASK_KIND`, `ATELIER_SERVICE`, `ATELIER_JOURNAL_SEQ` in the environment;
- the summary on stdin;
- the changed paths, NUL-separated, in `ATELIER_CHANGED_FILE`.

A typical git hook:

```sh
#!/bin/sh
cd "$ATELIER_DIR" && git add -A . && git commit -F -
```

Hook failures are reported in the inbox but never roll back a landing.

---

## 9. Agent sessions

### 9.1 Starting a session

Work always goes into the queue first. What happens next depends on the user's configuration (`$XDG_CONFIG_HOME/atelier/config.toml`, with optional overrides per owned directory):

- **`pull`** (default): nothing happens. The user opens their harness and invokes the kit (e.g. `/atelier`), and the supervisor works through the queue.
- **`spawn`**: when there is work the user asked for and no session is connected, the daemon runs a command template, e.g. `foot -D {dir} -e claude "/atelier work"`. This starts an interactive session in the user's own harness, with the user's own authentication, because they clicked a button.
- **`headless`**: the same mechanism with a non-interactive command (`claude -p …`, `codex exec …`, a script using an API key). Whether that is allowed under the user's plan is for the user to check, and the docs say so plainly.

Rules:

- **If a session is already connected, new work goes to it.** The supervisor's loop ends with `next_task`, which long-polls for a few minutes before returning `idle`.
- **Work the user asked for** (create, revise, port, audit) may start a session straight away, under `spawn` or `headless`.
- **Work the system found** (repairs) never starts a session by default. It is queued and flagged, and the user clicks **Fix** or opens a session themselves. Opting in: `on_breakage = "spawn"`, with a rate limit (default: at most once per 24 hours, batched).
- **Sandboxing is up to the user.** A container is just a spawn command that bind-mounts the socket and the state directory.

*Implemented (phase 2d):* `[session]` in `config.toml` sets `start` (`pull`, `spawn` or `headless`) and `command`. The command is a string run with `sh -c`, with `{dir}` and `{task}` replaced by shell-quoted values, or an array run directly. It runs in the owned directory, detached from the daemon, with its output in the state directory's `session.log`. It gets `ATELIER_DIR`, `ATELIER_TASK_ID` and `ATELIER_SESSION` (`spawn` or `headless`) in its environment. Harnesses pass their environment on to MCP servers (Claude Code does), so `atelier mcp` knows when a session is headless, and its `work` prompt then says that nobody is there to answer: calls go in `assumptions`, and declining with what's missing is fine. A task created by anything but an agent (`create`, `revise`, `port`, `audit`) starts a session unless one is at work (some task is claimed), one is waiting for work (`task_claim` was called in the last 15 seconds), or one was started in the last 3 minutes and hasn't claimed anything yet. `atelier session start [--force]` runs the command by hand, whatever `start` says, which is also how to try a template. Verified in the dev jail: a daemon started by Firefox through the native host inherits the compositor's environment, and `foot` opened beside Firefox.

### 9.2 The agent kit

The kit ships with atelier and is installed by `atelier setup` (§14):

- **MCP server** (`atelier mcp`) providing tools (§10) and MCP *prompts* for the supervisor and contractor workflows, so any harness that speaks MCP gets the workflow.
- **Skill / command files** for harnesses that support them (Claude Code first).
- **Authoring guidance**, available as an MCP resource:
  - Prefer overriding the site's own design tokens (CSS custom properties) over restyling components.
  - Build on the site's own dark or light mode when it has one, and record that as a prerequisite.
  - Prefer selectors on ARIA roles and attributes and `data-testid` over hashed class names.
  - Split a service into several styles along natural seams (base, compose view, settings) so a breakage can be disabled narrowly.
  - Use scripts only for what CSS can't do.
  - Start by inventorying the site's custom properties, and which selectors and media queries define them. On Wikipedia, one block of token overrides restyled the whole skin (examples/DOGFOODING.md).
  - Always set default link and text colours: sites leave some links to the browser default, which is unreadable on a dark theme.
- **Tone:** briefs and instructions are written in a collegial register, for a colleague being briefed, not as imperative commands. The kit tells agents explicitly that they may ask, push back, suggest and decline.

### 9.3 Supervisor and contractors

- **The supervisor** is the top-level agent in the session. It claims tasks, reads and extends briefs, and hands each task (including its token) to a contractor through whatever delegation the harness offers. It also answers contractors' questions where it can, and relays or escalates to the user where it can't. Contractors send it proposals for changes to the theme notes; the supervisor collects them and lands them through its own `notes` task. Only the supervisor may change theme-level files, so contractors working in parallel never compete over them.
- **Contractors** each work on one task, in the task tree, with MCP tools limited to that task (§10.2).
- Harnesses that can't delegate still work: the supervisor does each task itself, one after another.
- **Messaging goes through the daemon**, not through harness features. Harnesses differ in whether a subagent can talk to its parent before finishing, and routing through the daemon also makes every conversation visible to the user.

### 9.4 Channels

| Channel | Examples | Behaviour |
|---|---|---|
| contractor ↔ supervisor | "Should this follow the GitLab style's treatment of code blocks?"; proposed theme-note changes; status | Thread attached to the task; `message_wait` blocks for replies |
| agent ↔ user | Clarifying questions; reports; suggestions ("THEME.md says nothing about data tables; here's a proposal") | Shown in the sidebar inbox and CLI. Asynchronous: the contractor either carries on and records assumptions, or blocks the task |
| agent → developers | A broken or missing MCP tool; unclear kit guidance | Stored as a draft. The user reviews and edits it in the sidebar. Approving opens GitHub's prefilled new-issue URL in a tab. **Never filed automatically.** No credentials needed; the user submits it |

Before landing, contractors distil any lasting decisions from their threads into the service's `notes.md`. Threads themselves are state and are eventually pruned.

### 9.5 Questions, answers, and the theme's lifecycle

An author agent with an underspecified task has three moves: make a call itself and record it, ask the supervisor (who may have context the brief lacks), or ask the user. All three are right sometimes. Two failures sit on either side. The user gets a dozen questions per task. Or agents deliver work they aren't confident in, from a brief that was never enough. Design goals:

- **Batched by default, with pictures.** Most questions wait for a natural checkpoint, usually after a first pass, and go to the user together, with screenshots (and side-by-side variants where the question is "this or that?"). Answering a batch should take a minute.
- **An escape hatch.** Some uncertainty doesn't fit a checkpoint ("this domain hosts three different products; which one did you mean?"), and the agent must be able to ask straight away, at the cost of parking the task.
- **Never the same question twice.** Answers improve the persistent documents (theme, notes, briefs), and the supervisor decides how. They aren't pasted into notes as Q&A.
- **Tuned to the theme's maturity.** A new theme should generate many questions, and they should improve THEME.md. A settled theme should be set-and-forget.

#### Calls: questions and assumptions are one thing

A **call** is a decision an agent faced: the question, what it's about (a page, an element, the theme), the options considered, the agent's provisional choice (if it has one), visual aids, and whether the question concerns this site or the theme as a whole. Assumptions and questions are both calls. An assumption is a call with a provisional choice that the agent was comfortable acting on. A question is a call the agent wants answered first. A blocking question is a call with no acceptable provisional choice.

Calls are posted in batches. Each call in a batch is marked:

- **For the record:** the agent goes ahead and lands with its choices, and the batch shows up in the inbox as decisions the user may revisit. Answering one differently queues a `revise` carrying the answer. This is what `task_submit`'s `assumptions` become.
- **Before landing:** the task parks (`awaiting user`) with its tree, and the session moves on to other work. The answers come back with the task when it's next claimed. The tree may hold variants for the user to pick between.
- **Blocking:** the same, but a single call can be sent at any time, not only at a checkpoint. The UI marks it as the agent needing the user, with the agent's reason.

Tools (contractor): `task_ask(calls, wait: record | review | block)`, with screenshots attached by path or taken by `screenshot(..., attach: true)`. The agent sees answers in `task_info` and in the brief when it reclaims the task.

#### The supervisor in the loop

- **Before the user:** a contractor's calls go to the supervisor first. It answers what it can from THEME.md, the theme and service notes, and earlier answers (a searchable log in the state directory), and forwards the rest. It can merge questions from several tasks into one batch ("three sites raised how to treat code blocks"). A blocking call is forwarded at once.
- **After the user:** answered calls go back through the supervisor before the contractor sees them. It decides whether an answer changes something persistent: a site-specific answer goes into that service's `notes.md` (by the contractor, as part of its landing); a theme-level answer goes into the theme notes (the supervisor's `notes` task) or becomes a proposed edit to THEME.md; an answer that shows the brief was missing something improves the brief, and the briefs of other queued tasks it affects.
- **THEME.md stays the user's.** Agents never land changes to it. The supervisor *proposes* edits as a diff, which the user accepts, edits or declines in the inbox. An accepted edit lands like any other change (journal, undo, hooks).
- With no separate supervisor (one session doing everything), the session plays both parts in turn, and the work prompt says so. That's what's built first. Batches are stored with an addressee (`supervisor` or `user`) and a delivery state from the start, so adding a separate supervisor later is new tools and routing, not a migration.
- **Whether "calls" are the right unification** is an open question for agent interviews to answer: whether agents find assumptions and questions natural as one thing, or want them apart.

#### The theme's lifecycle

Users won't write a good THEME.md in one go. They write a first draft, see styles, answer questions, and the theme sharpens: dogfooding this repo went exactly that way (examples/DOGFOODING.md). After a while, the theme is settled and the user just wants new sites styled. So each theme has a **stage**, in `themes/<theme>/theme.toml`:

- **`forming`** (the default for a new theme): agents ask readily, at checkpoints, and treat any gap in the theme as a question worth asking, since the answer improves THEME.md for every later task. Before-landing review is the norm for `create` tasks. The supervisor proposes THEME.md edits as answers come in.
- **`settled`**: the user is finding that agents' styles meet their bar without back-and-forth. Briefs put it to contractors like this: *the user isn't saying your assignment is free of ambiguity; they're saying they expect to be satisfied with whatever provisional calls you make.* So agents make calls and record them, and ask only when they think the user would be unhappy with any call they could make on their own, or when the site is territory the theme doesn't cover (a kind of page no other service has).

**The stage is the user's to set** (owner's decision), not something inferred from a checklist: the right moment is when the user finds the styles meet their bar without back-and-forth, and only they know that. Moving back to `forming` (a new direction) is equally theirs. **How often the user keeps the agent's provisional choice** is tracked per theme as information: it's shown to agents in their briefs, so they calibrate to this user rather than to a guess, and to the user, who may find it a useful prompt.

#### The inbox

A page in the extension (the sidebar, or a tab): batches grouped by task, each with its screenshots, the calls as cards, options as buttons, the provisional choice preselected (so "keep all" is one click), and free text for anything else. Blocking calls come first. THEME.md proposals show as diffs. The toolbar badge counts batches waiting. No alerts or notifications beyond the badge.

#### What's built (phase 3b)

- **Calls and batches** (`call/post`, `call/list`, `call/answer`, `call/attachment`, `call/stats`, `call/stage`), stored with their tasks under `tasks/<task>/calls/<n>/` with copies of their attachments. A `review` or `block` batch parks the task (`Waiting`); answering it sends the task back to the queue, and the brief of whoever claims it next lists every batch with its answers. A landing's `assumptions` become a `record` batch. Changing one of those after the task has landed queues a `revise` that carries the answer.
- **MCP:** `task_ask(wait, summary, calls)`, and `screenshot(attach: true)`, which saves into the task's scratch space (next to the tree, so it never lands). Briefs say how readily to ask, by the theme's stage, and from five answered calls on, how often the user kept the agent's call. The work prompt sends questions through `task_ask` rather than the conversation.
- **The inbox** (`inbox.html`): batches as cards, blocking first, with screenshots (click to enlarge), options with the agent's choice preselected, a note per call, and "Send answers" per batch. "Look at the work in progress" opens the page in a new tab of the user's, bound to the task's tree (§6.2). It also shows and sets the theme's stage. The popup links to it, and the toolbar badge counts the batches waiting on the user (record batches aren't counted).
- **CLI:** `atelier calls`, `atelier answer BATCH [JSON]`, `atelier stage [forming|settled]`.
- **Not yet:** a separate supervisor (everything goes to the user, though batches have an addressee); THEME.md proposals as diffs; answers updating notes beyond what the agent does in its own landing; a searchable log of earlier answers.

---

## 10. MCP surface (draft)

### 10.1 Tools

*Implemented so far (phase 2a), as `atelier mcp` tools and `atelier browser` CLI methods:* `tab_open`, `tab_navigate`, `tab_reload`, `tab_list`, `tab_close`, and the browser method `tab/bind` (tabs bound to a task's tree, §6.2; not an MCP tool yet); `screenshot` (viewport, full page or one element; animations fast-forwarded; a note when frame-drawn content may be stale); `css_tokens` (custom properties with their selectors, media and layer conditions, and the nested scopes that re-declare them); `matched_rules` (rules matching an element, with specificity and conditions, atelier's own labelled); `computed_style`; `contrast_scan`; `force_state` (show hover, focus and focus-visible styles, like devtools' "force element state"); `query`; `eval` (in the userScripts world: DOM yes, page globals no); `styles_status`. The calls travel `atelier mcp` → daemon (`browser/call`) → native host → extension (`extension/src/tools.ts`), and run in pages through `userScripts.execute`. These are what the dogfooding agents wrote by hand (examples/DOGFOODING.md).

*Tasks (phase 2c, 3b):* `task_ask` (§9.5), `task_list`, `task_create` (for requests made in conversation), `task_claim` (the oldest queued task, or one by id; `waitSeconds` long-polls up to 5 minutes), `task_info` (the brief, the tree, changes so far, any handoff note), `task_submit(summary, assumptions)`, `task_decline(reason)` and `task_release(handoff)`, which returns a task to the queue with its tree and a note for whoever claims it next. Each `atelier mcp` process is one session: it holds its leases under its own id and renews them on any tool call, at most once a minute, so agents don't need to heartbeat by hand. If a lease is lost anyway, the next tool result says so. While a session holds a task, `tab_open` binds new tabs to it (§6.2; `task: null` for the user's styles), `screenshot`'s `saveAs` writes into its tree, and `styles_status` names the tree as the tab's style files. A conflicting file comes back with its current contents, and that version becomes the file's base, so the next submit takes the tree's version as the merge. The `work` MCP prompt starts a pull session (§9.1; `/mcp__atelier__work` in Claude Code), and the server's instructions carry the authoring guidance (§9.2). Still to come: capability tokens and scopes (§10.2), blocking on a question, messaging, and the supervisor/contractor split; for now one session does its tasks itself, and asks the user directly when they're in the conversation.

The full planned surface:

Tools for the **session and supervisor**:

- `session_hello(harness, capabilities)` registers the session.
- `next_task(timeout)` long-polls; returns the task's brief and token.
- `task_claim(id)`
- `task_status(id)`
- `notes_propose` / `notes_land`, used by the supervisor's `notes` tasks.

Tools for **contractors** (every call carries a task token):

- **Task:**
  - `task_info`, which returns the tree path, base, brief and thread;
  - `task_heartbeat`;
  - `task_submit(summary, assumptions)`;
  - `task_decline(reason)`;
  - `task_block(question)`.
- **Tabs:** `tab_open(url)`, `tab_navigate(url)`, `tab_reload`, `tab_close`, `tab_list`, and `tab_show`, which briefly brings an agent tab to the front for content that only renders while visible. `tab_show` takes focus from the user, so it's allowed only if the user's settings permit it.
- **Looking at a page:**
  - `screenshot(tab, {selector?, full_page?, settle_animations = true})`, which returns a note alongside the image when the tab is hidden and content drawn by animation frames may be stale (R3);
  - `dom_query(selector, {depth, attrs})`;
  - `computed_style(selector, props)`;
  - `accessibility_tree`;
  - `find_css_custom_properties`, which lists the site's own design tokens.
- **Interaction:** `click`, `hover`, `scroll`, `press_key`, `resize_viewport`. Text entry into inputs is off by default (§10.2).
- **Styles:**
  - `styles_reload`, which re-reads the task tree;
  - `draft_css(style_id, css)`, which applies CSS to the agent tab without writing files, for quick iteration;
  - `color_scheme(tab, light|dark)`, which emulates the scheme in that tab alone and reloads it (R2). Screenshots of an emulating tab say the scheme is emulated.
- **Checks:** `checks_run({passive, active})`, `lint`.
- **Messages:** `message_post(to: supervisor|user|developers, body, attachments)`, `message_wait(timeout)`.

### 10.2 Capability scope

Each task token grants access to:

- **Origins:** the origins in the brief, plus origins the contractor declares and the daemon accepts (for example a CDN or an auth redirect). Navigating anywhere else is refused.
- **Tabs:** only the agent tabs belonging to this task.
- **Files:** changes that land are restricted to `services/<service>/…` (§8.4).
- **Input:** no typing into form fields unless the brief allows it.

These scopes are the main defence against prompt injection from page content (§12). They don't protect against a misbehaving harness. That isn't in the threat model, because the user chose and runs the harness.

---

## 11. Health checks

### 11.1 Layers

1. **Built-in invariants**, supplied by atelier and needing no per-site authoring:
   - **Contrast sweep:** samples visible text for contrast failures, which catches the classic dark-on-dark breakage.
   - **Palette adherence:** samples computed colours of large visible regions and flags any far from the theme's palette, which shows unstyled areas leaking through. The palette is declared in THEME.md or derived from vars.
2. **Canaries:** selectors each style depends on, declared in `service.toml`. Each must still match at least one element.
3. **Custom checks** (`checks/*.check.js`), written by the contractor:
   - **passive** checks read the page and run cheaply in the user's own tabs;
   - **active** checks interact with the page (open a menu, a modal or the compose view) and only run in agent tabs.

### 11.2 When checks run

- **Prerequisite checks.** A service whose styles build on a site setting can give a prerequisite a `check` in `service.toml` (`[[prerequisites]]` with `description` and `check`): a CSS selector that matches in the page when the setting is right. The shim evaluates it once the document is parsed, on pages where the style applies. If it doesn't match, the toolbar badge shows "!" and the popup says what to change; agents see it in `styles_status`. Without this, a style whose prerequisite isn't met just seems to do nothing, which is what happened to the owner on Wikipedia.
- **Passive checks run during ordinary browsing**, debounced, sampled and idle-scheduled (`requestIdleCallback`), at most once per style per page load. They cover logged-in state and real content without a background crawler.
- **Active checks run** when a task is submitted (as the gate) and when the user asks.

### 11.3 When checks fail

1. **Degrade narrowly.** A failed canary disables that style file, not the whole service. Invariant failures below a severity threshold only flag the style and leave it on.
2. **Tell the user quietly:** badge, a line in the popup, an entry in the inbox. No alerts.
3. **Queue a `repair`** carrying the failing results and screenshots. What starts a session for it is covered in §9.1.

---

## 12. Security

**The threat:** an agent drives the user's logged-in browser and reads content from pages, which is a textbook prompt-injection setup. Its output (CSS and JS) then runs on those same logged-in pages.

- **Task scoping** (§10.2) limits what injected instructions could achieve.
- **CSS linting**, enforced by the daemon when syncing, for hand-written styles as well as agent ones:
  - `url()` values must be `data:` or on an allowlist (default: common font CDNs), which rules out CSS-based exfiltration (attribute selectors combined with remote backgrounds);
  - `@import` is only allowed for allowlisted URLs.
- **Scripts:**
  - They run in the `USER_SCRIPT` world, with a restrictive CSP set through `userScripts.configureWorld`, and no GM grants.
  - They are linted for network APIs and for putting URLs into the DOM. This is only partial containment, because DOM insertions fall under the page's own CSP.
  - **Approval is by content hash.** The daemon only registers a script whose SHA-256 has an approval record in `approvals/`. Contractors can't write there. A task can land with an unapproved script: its CSS applies, and the script waits for approval.
  - **The approver is configured by the user:**
    - `script_review = "<command>"`: the daemon passes the script, its diff, and a fixed policy to the command, for example a cheap headless model, and reads back approve or reject with a reason. The reviewer sees only code and never page content, so an injection would have to survive into the code and then also fool a reviewer starting from a clean context.
    - If unconfigured, approval is one click in the sidebar, with the diff shown.
    - Hand-written scripts can be approved with `atelier approve <file>`, or with `trust_local_scripts = true` for users who accept the risk.
  - Approvals are per machine: a script synced from another machine has to be approved again.

---

## 13. CLI

The owned directory is resolved from `--dir`, else `ATELIER_DIR`, else `$XDG_DATA_HOME/atelier`.

```
atelier init [--theme NAME]         scaffold an owned directory
atelier setup                       native-messaging manifests, MCP registration, agent kit
atelier status                      daemon, browsers, sessions, queue, health summary
atelier queue [add|ls|rm] …         e.g. `atelier queue add create "GitHub" --origin https://github.com`
atelier tasks [show|resume|abandon] …
atelier inbox                       threads waiting on the user; reply from the terminal
atelier undo [SEQ]                  undo a landing (default: most recent)
atelier journal                     list landings
atelier theme [get|set NAME]
atelier check [SERVICE]             run checks (asks the browser to open a check tab)
atelier lint [PATH]
atelier match URL                   which styles (and which of their sections) apply to URL
atelier approve FILE | --hash H
atelier daemon | native-host | mcp  internal entry points
```

---

## 14. Distribution

- **First-class: a Nix flake with a home-manager module.** It installs the extension through policies, the binary, the native-messaging manifests, the managed-storage default for `ATELIER_DIR`, and optionally the MCP registration and kit. It calls the same code paths as `atelier setup`.
- **Manual install:**
  1. Install the signed, self-distributed `.xpi` (signed through AMO as unlisted, with an `update_url`).
  2. Install a static musl binary from GitHub releases, or use `cargo install`.
  3. Run `atelier setup`. It writes native-messaging manifests for every Firefox-family browser it finds (Firefox, LibreWolf, Waterfox; paths in a table so more are easy to add), prints or runs the MCP registration for harnesses it recognises, and installs the kit.
- Flatpak and Snap Firefox are unsupported in v1 (§1).

---

## 15. Phasing

1. **Loader.** Owned-directory format, daemon, native host, extension applying styles from the default source, vars, lints, Dark Reader lock (§6.5), `init`/`setup`/`status`/`lint`. Useful on its own for hand-written styles, and the way to validate the format. Includes spikes R1–R3 and R5.
2. **Agent tabs and tasks.** Source binding, agent tabs, the MCP tab and style tools, task trees, landing, journal and undo, hooks, pull sessions, the Claude Code kit.
3. **Conversations and requests.** Popup requests, the sidebar inbox, message channels, supervisor/contractor roles, `spawn`/`headless` triggers, feedback drafts.
4. **Health.** Built-in invariants, canaries, custom checks, passive runs, narrow degradation, `repair` tasks, `on_breakage`.
5. **Scripts.** Userscript registration, approval by hash, `script_review`.
6. **Later:** `port` and `audit` polish, kits for more harnesses, and possibly Chrome and services defined by the software they run.

---

## 16. Risks needing spikes

- **R1: Binding tabs to sources at `document_start`.** *Answered (spikes/r1/RESULTS.md):* a user script that inserts and maintains a `<style>` element meets every requirement (§6.1). Still open: iframes, and the observer's cost on heavy pages. The swap for tabs bound elsewhere (§6.2) is built, on R2's synchronous per-tab marker (`sessionStorage`).
- **R2: Emulating `prefers-color-scheme` per tab.** *Answered (spikes/r2/RESULTS.md):* full per-tab emulation, triggered by a `sessionStorage` marker. A page-world script wraps `matchMedia`. A user-script-world script rewrites `prefers-color-scheme` conditions through the CSSOM and in `media` attributes, and forces `color-scheme`. Cross-origin stylesheets, which the CSSOM won't expose, are fetched by the background, rewritten, and swapped in as copies. This covered every mechanism in the fixture, and the user's tabs were unaffected. The global `browserSettings` override is not used. Still open: rules added later through `insertRule`, `@import` in cross-origin sheets, and iframes.
- **R3: Screenshots of background tabs.** *Answered (spikes/r3/RESULTS.md):* `tabs.captureTab` captures hidden tabs accurately except for content that depends on animation frames. CSS animations can be fast-forwarded first; content drawn by `requestAnimationFrame` needs the tab to be visible (`tab_show`). Still open: full-page captures, device pixel ratios other than 1, and minimised windows on other compositors.
- **R4: Keeping the extension alive under Firefox MV3.** *Answered (spikes/r4/RESULTS.md):* in Firefox 156, an open native-messaging port keeps an MV3 background page resident (tested to 10 minutes idle), while one without a port is suspended after about 30 s and wakes within a second on the next event. MV3 stands. Still open: behaviour of a signed permanent install, and across sleep/resume. Reconnection and resync after the host goes away still have to be designed (§4.2).
- **R5: Timing of the Dark Reader lock.** *Answered (spikes/r5/RESULTS.md):* a lock appended at `document_start` keeps Dark Reader 4.9.133 off completely. One added later works only in `<head>`. Removing it doesn't bring Dark Reader back before a reload. See §6.5. Still open: other Dark Reader versions and modes, and iframes.

---

## 17. Open questions

- **Trying site settings without touching the user's.** Agent tabs share the user's profile, so an agent can't check a prerequisite's failure case or a site's other theme without changing the user's own setting. Agents need both: the user's own containers (styles for logged-in pages), and a throwaway context for experiments. Firefox can't fork a container, but the extension can do the essential part: create a temporary container (`contextualIdentities`) and copy the site's cookies into it from the user's (`cookies.getAll`/`set` with `storeId`), giving a throwaway that's logged in like the user. Site storage (localStorage, IndexedDB) doesn't copy, so some settings won't carry over. Where there's no other way, an agent may change a setting in the user's own context (e.g. a site's light/dark choice), saying so, and setting it back.

- **Shadow DOM.** Custom properties inherit into shadow roots, so token overrides reach most web components. But colours and shapes hard-coded inside a component (MDN's syntax highlighting and code editor) can't be reached by page CSS. Proposal: a style section that targets a named custom element's shadow root (e.g. `@shadow mdn-code-example { … }`), which the shim adds as an adopted stylesheet inside each open shadow root, found with a MutationObserver and `customElements.whenDefined`. Closed shadow roots stay out of reach.
- **Frames.** Styles only go into top-level documents. Registering with `allFrames`, with sections matched against each frame's own URL as Stylus does, lets a style opt in to a frame's origin. Frames that show example output (MDN's live samples) generally shouldn't be restyled, so this must stay opt-in per matcher.
- **Calibrating questions** (§9.5): the rates and thresholds there are guesses until agents and users have used it.
- **CSS the browser rejects.** Lint can't know everything Firefox's CSS parser drops (an invalid `light-dark(inherit, …)` silently empties a rule). The shim could compare each rule's parsed declarations with its source and report dropped ones back as diagnostics.
- **The Dark Reader lock and media queries.** The lock is decided by URL matching alone, so a style whose CSS is entirely inside `@media (prefers-color-scheme: dark)` still locks Dark Reader on a light desktop. The shim could check whether any of the applied CSS actually matches the current media.

- Should `vars.json` allow overrides per style, or per owned directory, as well as the flat global map?
- The exact check API, `service.toml` schema and THEME.md conventions (frontmatter for parameters and palette?). These are best worked out against real services in phase 1.
- How threads are kept and pruned; whether a resolved thread should be summarised into the service notes automatically.
- Should `audit` fan out into `revise` tasks automatically, or report and wait for the user?
- A global style under `themes/<theme>/global/` applies to every site, including ones with their own styles. What are the precedence rules, and how does a service opt out?
- How multiple browser profiles sharing one daemon share out agent-tab work: which profile's browser gets a task's tabs? Probably the one the request came from, and for repairs the one that detected the breakage.
- Rate limits and cost visibility for `headless` users.

---

## 18. Future directions (low priority)

### 18.1 A built-in fallback engine

Dark Reader is MIT-licensed (re-check before depending on it), and its dynamic-theme engine is published as the `darkreader` npm package. atelier could embed it and apply it to pages with no bespoke style, instead of relying on a separately installed Dark Reader:

- **Precedence decided in one place:** a bespoke style matches → no fallback; otherwise fallback, unless the user turned it off for that origin.
- **Colours from the theme:** the engine's background, text, selection and scrollbar colours are filled from `vars.json`, so recolouring the desktop recolours the fallback.
- **Cross-origin stylesheet fetching** through the extension's host permissions, which works better than the engine can manage on ordinary websites.
- **Health checks** on fallback pages, which could suggest "this site looks rough; style it properly?"

Costs: the dynamic engine is heavy on large pages; upstream changes, including Dark Reader's community per-site fixes, have to be tracked; and it has to skip pages that already follow `prefers-color-scheme`.

### 18.2 Agent-written theme mapping for the fallback

Dark Reader's generator is at heart a few pure functions that take a colour and return a modified background, text or border colour, anchored only on a background and a text colour. If those functions were pluggable (probably a small fork of that module), a task at the theme level could have an agent write a **colour mapping for the theme**. Examples: snapping background brightness levels to the theme's surface levels, and pulling accent colours to the nearest theme accent of the same hue family, so that semantic colours like red for errors survive. It's written once per theme and runs with no agent involved. This works best with palettes that have semantic slots (base16-style); THEME.md should be able to turn hue snapping off.

### 18.3 Patch tasks

A cheaper tier between no style and a bespoke one: a `patch` task produces a short fallback fix in Dark Reader's fix format (selectors to invert, extra CSS, ignoring inline styles or image analysis) for a site the user visits occasionally. If a site keeps getting patched, atelier suggests a full style.
