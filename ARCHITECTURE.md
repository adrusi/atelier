# atelier's architecture

SPEC.md says what atelier is and why. This document says how the code is
shaped: the concepts it's organised around, and the invariants that keep it
correct. It's written so that the right thing is the easy thing: a new
feature built in the obvious place should get the hard parts (shadow roots,
cross-origin stylesheets, recovery after a crash) right without having to
remember them.

Status: a proposal, written after phase 3 once the components were known.
Parts of the code don't follow it yet; "Getting there" at the end says what
moves.

## The pieces

```
 owned directory ──▶ daemon ◀── atelier mcp ◀── agent harness
 (plain files)        │  ▲       atelier (CLI)
   task trees ────────┘  │
   state directory       │ native messaging
                         ▼
             extension background ──▶ page runtime (in every styled
             (sources, tabs,              or agent tab)
              resources, UI)
```

- **The daemon** owns everything durable: it compiles sources into bundles,
  keeps the task store (tasks, journal, calls, proposals), starts sessions,
  and relays browser calls. It's the only writer of the owned directory and
  the state directory.
- **The extension background** owns everything in the browser: which tab
  shows which source, the resources atelier creates (user scripts, agent
  tabs, containers), and the UI.
- **The page runtime** is atelier's code inside a page: applying styles,
  inspecting, emulating. It's the part with the most surface for subtle bugs,
  because pages are adversarial and varied.
- **`atelier mcp`** is a thin translation for agents: tool descriptions,
  briefs and the session's leases. It holds no state worth recovering.

## The page model

Every page-side feature (applying styles, every inspection tool, every
emulation, forcing states) works on the same model of the page, and gets it
from one place:

- **Scopes.** A page is a tree of scopes: the document, and every open
  shadow root, nested to any depth. Styles don't cross scope boundaries
  (only inherited properties and custom properties do), so anything that
  applies, reads or rewrites styles has to visit every scope. The runtime
  keeps one live registry of scopes, discovered once and maintained by one
  set of observers, and features iterate it. A feature never starts from
  `document` on its own.
- **Sheets.** Each scope has its stylesheets: `<style>` and `<link>`
  elements, adopted sheets, and `@import`ed sheets. Some can't be read
  through the CSSOM (cross-origin without CORS); the runtime fetches those
  through the background and treats the copies as part of the scope, with
  their provenance. Each sheet is labelled: the page's, atelier's (which
  style), or a fetched copy.
- **Rules.** One rule walker flattens a scope's sheets into rules with their
  resolved selectors (CSS nesting resolved against its parents), their
  conditions (`@media`, `@supports`, `@layer`, `@container`, `@import`), and
  whether those conditions hold now. `css_tokens`, `matched_rules`,
  `force_state` and the emulations all read rules through it, so a fix to
  how rules are read (nesting, `@supports`) reaches all of them.
- **Elements.** One query function resolves selectors, including
  `host >>> inner` into shadow roots, for every tool that takes a selector.
- **Media features.** Emulation is one layer, not one implementation per
  feature: a set of emulated media features (`prefers-color-scheme` now,
  `width` next, `hover` and `pointer` for "phone") applied to every scope
  through the rule walker (rewriting conditions in readable sheets, fetched
  copies, and media attributes), with the page-world counterparts
  (`matchMedia`, `innerWidth`) driven by the same settings. Adding a
  feature means adding it to the set, not writing another walker.
- **Limits are reported, not silent.** Closed shadow roots and cross-origin
  frames can't be reached, and stylesheets may not be readable. What can be
  counted is included in tool results (unreadable sheets, by name), so
  neither agents nor we mistake "nothing found" for "nothing there". Closed
  shadow roots can't even be counted from the userScripts world
  (`openOrClosedShadowRoot` isn't there), so tools that walk the page say
  that they can't see them.
- **Frames are documents of their own.** Each gets the runtime from its own
  registrations, matched by its own URL, so styles, the shim's live updates
  and colour-scheme emulation reach frames without the top document doing
  anything. The inspection tools work on the top document; a framed page is
  inspected by opening it in a tab of its own.

**How the code expresses it.** The runtime is one bundle (built from
`extension/src/page/index.ts`), installed once in a page's userScripts
world as `__atelierPage` and reused: style registrations run it and call
`shim.add`, and tools call `tools.<name>` by name, injecting it first only
where it's missing. `page/core.ts` is the page model; `shim.ts`,
`tools.ts` and `emulation.ts` are built on it. Only core reaches into the
page's structure (`styleSheets`, `adoptedStyleSheets`, shadow roots,
`cssRules`, document-wide queries), and `npm run check` fails if anything
else does (`extension/check-layering.ts`). The page-world part
(`page/main.ts`, the `matchMedia` override) stays minimal, is built on its
own, and reads the same marker.

## State and recovery

Anything atelier creates that outlives a single call is a **resource**, and
every resource has an owner, a place where its desired state is recorded,
and a **reconcile** step that makes the actual state match. Reconcile runs
at startup, periodically, and after the events that usually change things;
events are a shortcut, never the only way a resource gets cleaned up. That
makes recovery the normal path rather than a special case: a crash, a
restart or a missed event leaves things for the next reconcile to set right.

**Durable changes are written as intents.** A change that touches several
things (landing a task: journal, files, task state) first records what it's
about to do, then does it, then records that it's done. Recovery at startup
finds intents without a completion and finishes them (or rolls them back,
when finishing isn't possible).

In the daemon, that's the journal: each entry is written first with copies
of every file before and after, marked incomplete, along with what follows
from it (a task landed, an entry undone, a proposal accepted). Finishing
writes the files, applies those follow-ups and marks the entry complete;
every step is idempotent, so a restart that finds an incomplete entry
simply finishes it, and runs the hooks it missed.

| Resource | Owner | Desired state lives in | Reconciled by |
|---|---|---|---|
| Owned-directory changes (landings, undos, accepted proposals) | daemon | journal intent records | startup: finish or roll back incomplete intents |
| Tasks, leases | daemon | task.json | listing (leases expire) |
| Task trees, calls, proposals, hook files, logs | daemon | the task's state | pruning: kept while useful, then removed |
| Spawned sessions | daemon | a record of the launch | startup: a launch counts until it times out |
| Registered user scripts | background | the bundle | every bundle load (already a diff) |
| Agent tabs, their bindings and emulation | background (`agenttabs.ts`) | records in `storage.session`, and a tab value (`sessions.setTabValue`, restored with the tab) carrying the browser session's epoch | startup, a few seconds after tabs appear, and every 5 minutes: tabs with an earlier epoch are closed; copies (current epoch, not ours) lose the value and are the user's |
| Agent windows (`[session] windows`) | background (`agenttabs.ts`) | agent session → window in `storage.session`; each agent tab's record names its session | when the session's `atelier mcp` connection closes, the daemon sends `agent/end` and its tabs close (the window with them); reconcile drops windows that are gone or hold no agent tabs |
| Throwaway containers | background (`containers.ts`) | the session's list in `storage.session`, and the tabs that use them | with agent tabs, and when a tab closes: unlisted containers are removed with their tabs, listed ones once no tab uses them |
| Page-side markers (sessionStorage) | page runtime | the background's tab state | the source marker on each shim connection (the background sends the tab's binding); the scheme marker on each load (the page asks); stale ones are dropped |

A resource that isn't in this table doesn't exist yet. Adding one means
adding a row: who owns it, where its desired state is, and what reconciles it.

## The agent-facing surface

(See PROMPTING.md and AGENT-EXPERIENCE.md for why.)

- Server instructions are short; the brief carries how to work. Every tool
  description and the instructions stay under the length harnesses show in
  full (a test checks).
- THEME.md records what the user wants; atelier's limits go in notes,
  summaries and feedback, marked as limits with a date.
- Tools report their own blind spots (see "Limits are reported").

## Dev tooling that keeps it honest

- **Fixtures per mechanism**, each reporting what it concluded
  (`dev/fixtures/color-scheme` is the model).
- **A fidelity harness** for emulations (`dev/fidelity.ts`): a page
  rendered for real and through atelier's emulation, side by side in one
  dev instance, diffed on every computed style of every element (shadow
  roots and pseudo-elements included), geometry, chosen images and pixels.
  Ground truth for the colour scheme is Firefox's own per-tab override
  (`BrowsingContext.prefersColorSchemeOverride`, through BiDi's chrome
  scope); for width it will be `browsingContext.setViewport`. Real pages
  vary between loads, so the real page is loaded twice and what differs
  between those is left out as noise (and counted); `--ignore` leaves out
  ad slots and the like. Differences that can't show (a page's offered
  schemes narrowed to one) are listed as equivalences, each with its
  reason. Pixel differences are attributed to the elements they're in.
  It's how subtle failures get noticed, and how fixes get measured:
  `dev/e2e/fidelity.ts` holds the fixtures to it in both directions, with
  a control run without emulation, and asserts the known gaps.
- **Crash tests**: kill points in the daemon (an environment variable in dev
  builds, e.g. "after the journal intent"), and e2e tests that kill Firefox
  or the daemon mid-operation and check that reconcile and recovery leave
  everything right.
- **Agent runs and interviews** (examples/DOGFOODING.md): the tools'
  real users find what tests don't.

## Getting there

In order, each step leaving everything working:

1. **State and recovery** (done): landing intents and startup recovery, with
   crash tests; tab values and reconcile for agent tabs, containers and
   markers; pruning. (The daemon's store and the background's resources.)
2. **The page runtime** (done): `pagefns.ts`, `shim.ts` and `scheme.ts`
   moved into `page/` on top of `page/core` (scopes, sheets, rules,
   elements), with the layering check. Moving them extended css_tokens,
   force_state and colour-scheme emulation to shadow roots, which they
   hadn't reached.
3. **The fidelity harness** (done), first on `color_scheme`. Its first run
   found that emulation forced `color-scheme` on every page, darkening
   default text on pages that don't offer dark; emulation now narrows what
   a page offers instead, as the browser does. The known gap it shows: SVG
   images with their own scheme rules (MDN's sidebar chevrons). Frames,
   first a gap, are now emulated, from the page's origin and others.
4. **Width emulation** (done), as a media feature in the emulation layer,
   measured by the harness against `setViewport`: media queries (with
   calc() in them, which MDN and GitHub use for breakpoints), viewport units,
   the root's percentage heights, matchMedia and the viewport's size as
   scripts see it. The root is sized to the emulated viewport, with an
   identity transform, so `position: fixed` elements lay out in it; while
   the page is scrolled they're moved by the scroll offset. The fixtures,
   MDN (ad slots left out) and GitHub match pixel for pixel at phone width.
