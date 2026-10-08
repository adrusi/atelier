# Dogfooding log

Findings from authoring the example styles in `owned/` by hand (well, by
Claude, with full access to the dev environment), before constrained agents
have to do the same through atelier's tools. Each entry says what got in the
way, and what happened about it.

The theme is `owned/themes/roarke`, a draft read off the owner's desktop.

## Hacker News (2026-10-01)

- **A new style didn't reach pages that were already open.** Live updates only
  reach pages that have the shim, and a page loaded before any style matched it
  has none. So the most basic loop (write a style, look at the site) needed a
  reload. *Fixed:* the background now injects the shim into open tabs that a
  style newly applies to, with `userScripts.execute` (which also covers tabs
  open when the extension starts). Covered by the phase-1 e2e test.
- **DNS didn't work in dev instances** on a systemd-resolved/nscd system:
  `/etc/resolv.conf` points into `/run`, which the jail hides. *Fixed* in
  atelier-dev by binding `/run/systemd/resolve` and `/run/nscd`.
- **Judging a style needs a picture of the page, not the browser.** The
  compositor screenshot showed whichever tab was in front (the onboarding
  page). *Fixed:* `atelier-dev capture` screenshots the page over BiDi
  (`--full` for the whole document), and `navigate` brings its tab to the
  front.
- **Sites leave some links uncoloured** and rely on the browser default, which
  is unreadable on a dark background (HN's "See also" link in item text). The
  fix is a style-wide `a:link`/`a:visited` fallback. *Kit guidance to write:*
  always set default link and text colours, not just the ones the site sets.
- **The edit-look loop is fast:** a saved edit shows in the open page in about
  a second, through file watch → daemon → extension → shim.
- **Presentational HTML** (`bgcolor` attributes, `<font color>`) is no
  obstacle: author CSS beats presentational hints without `!important`.

## Wikipedia (2026-10-01)

- **Overriding the site's design tokens works very well.** Vector 2022 is
  built on ~180 Codex tokens (CSS custom properties). One block of overrides
  restyled the whole skin, and also Wikipedia's own night-mode fixes for
  article content (infoboxes, hatnotes, diagrams), which would have been a lot
  of work to redo. This bears out SPEC §9.2's advice. *Kit guidance:* the
  first step on any site should be an inventory of its custom properties and
  the selectors and media queries that define them. A tool for that (the
  draft's `find_css_custom_properties`) is worth building early.
- **Building on the site's dark mode means a prerequisite.** Anonymous
  Wikipedia defaults to Light; the style needs Appearance → Color →
  Automatic, recorded in `service.toml`. atelier can't tell whether the user
  has done it. *Idea:* let a service declare a cheap prerequisite check (here,
  "`<html>` has `skin-theme-clientpref-os` or `-night`"), so the popup can
  say "this style needs a setting changed" instead of the style silently not
  applying. Fits with health checks (SPEC §11).
- **Dev instances need to prefer dark like the user's browser does.** The
  user's desktop sets `prefer-dark` through dconf; the jail's Firefox saw
  light. *Fixed:* `atelier-dev up --color-scheme dark`.
- **Plain CSS can't share declarations between differently-conditioned
  selectors** (Wikipedia's Dark is a class; its Automatic is a class plus a
  media query). The style uses one selector for both and accepts a corner
  case a dark-only theme never hits. Duplicating 180 declarations would be
  worse. Not an atelier problem as such, but agents will hit it.
- **Third-party banners** (CentralNotice) bring their own colours. Minor;
  they're dismissable.

## GitHub and MDN (2026-10-01, two subagents in parallel)

Two agents, each with full access and their own dev instance, styled
logged-out GitHub (`services/github`, ~230 Primer tokens plus component
fixes) and MDN (`services/mdn`, its colour, font and radius tokens, written
as `light-dark()` so MDN's own theme switch keeps working). Token overriding
was the right approach on both. What they found about atelier:

**Fixed**

- **The remote-URL lint flagged things that aren't loads.** An
  `@-moz-document url("https://…")` matcher and URLs in comments were reported
  as remote loads. That's an error, which dropped the whole style silently.
  The lint now scans only parsed section CSS, with comments removed.
- **The CLI's `regexp()` matching disagreed with the browser's.** It used Rust's
  `regex`, which lacks lookahead and lookbehind. It now uses `regress`, an
  ECMAScript engine, and lint rejects patterns JavaScript can't compile.
- **A typo in `service.toml` dropped the whole service.** The schema was
  strict. Unknown keys and bad values are now warnings, and the styles still
  load.
- **A broken save un-styled open pages at once.** The daemon now keeps the last
  version of a style that loaded, with a warning, until the file parses again.
  Deleting the file still removes it.
- **Diagnostics were invisible:** only a count reached the logs. The daemon
  now logs which styles were added, changed or removed, and every diagnostic
  as `path:line: message`; so does the extension.
- **Lint let nonsense through.** `domain()` given a URL is now an error.
  `.user.js` files (not supported yet) and files with no `==UserStyle==` block
  are now warnings.
- **`atelier match` was cryptic** ("sections 0") and accepted a bare host. It
  now names each applying section and the matcher that made it apply, and
  rejects things that aren't URLs.
- **Every bundle change re-registered every user script.** Only scripts whose
  code or patterns changed are updated now.
- **Host-side `atelier status` couldn't reach an instance's daemon,** and
  DEVELOPING.md wrongly said `atelier-dev env` handled it. There's now
  `atelier-dev atelier NAME ARGS…`.
- **No way to capture one element.** `atelier-dev capture --selector CSS`
  does it now.

**Open, design work (recorded in SPEC.md)**

- **Shadow DOM was the main limit on MDN,** more than iframes. Custom
  properties inherit into shadow roots, so token overrides reached most
  components. But hard-coded colours inside them (syntax highlighting, a code
  editor, corner radii, a search box's font) can't be reached from page CSS.
  Proposal: style sections that the shim adds inside a named element's
  (open) shadow root.
- **Frames:** MDN's live samples are cross-origin iframes, and styles only go
  into top-level documents. Restyling example output also broke a sample
  that assumed black-on-white text, so frames should be opt-in per matcher,
  not automatic.
- **Nested theme scopes:** GitHub re-declares every token on inner elements
  marked `data-color-mode`, undoing `:root` overrides there. This needs kit
  guidance, and an inventory tool that flags it.
- **Invalid CSS is dropped silently by the browser** (`light-dark(inherit, …)`
  became an empty rule). Lint can't catch everything a browser rejects, so the
  shim should report declarations the page's CSS parser dropped.
- **The Dark Reader lock ignores media queries.** A style whose CSS is all
  inside `@media (prefers-color-scheme: dark)` still locks Dark Reader on a
  light desktop, where it applies nothing.
- **The tools agents will need first,** judging by what both agents wrote by
  hand:
  - a custom-property inventory, grouped by selector, media query and layer;
  - "which rules match this element, with specificity";
  - a contrast scan;
  - hover and focus simulation (scripted `focus()` doesn't trigger
    `:focus-visible`);
  - element and scrolled captures;
  - a way to wait until a page has finished lazy-loading before capturing.

**Theme questions the agents had to guess at.** These are for the theme's
owner:

- links blue versus Primer's shared "accent" family;
- dark text on pastel status colours;
- 4px on controls and 8px on containers when a site uses one radius token;
- whether circles count as "pill-shaped";
- whether green primary buttons should become lavender, even though that adds
  more accent per screen;
- whether to leave ads and per-area colours alone;
- what to do with diagrams' white backdrops.

## Revising to the owner's answers, and fonts (2026-10-03)

A subagent revised all four styles to the owner's answers (links and most
non-neutral colour lavender, radii a preference, images untouched) and left
previews in each service's `previews/`. Along the way:

- **`atelier-dev capture` without `--selector` was broken** (argument
  filtering dropped the instance name). *Fixed.*
- **The theme named the desktop's Nerd Font builds** of Noto. Those are for
  the bar's private-use icons and come as one static family per weight, so
  `font-weight: 500` fell back to Regular. The owner: use mainline Noto in
  the browser. *Done.*
- **But Firefox can't render mainline Noto condensed from the installed
  fonts.** Measured in a dev instance: `font-stretch` 100%, 75% and 62.5%
  render identically; so does `font-variation-settings: "wdth" 75`; weight
  450 renders as 500 and 550 as 600. Firefox uses installed variable fonts
  only through their named instances, and Noto Sans has no condensed ones.
  *Open, for the owner.* Options:
  1. install static condensed builds of mainline Noto (Google ships them),
     which Firefox would match with `font-stretch`;
  2. let a theme ship font files that atelier serves to pages, which would
     also suit images and other theme assets (an atelier feature to design);
  3. load Noto Sans from Google Fonts, which the lint allows but which costs
     a request to Google on every styled page;
  4. go back to the Nerd Font condensed families (they render condensed; the
     icons are just unused);
  5. accept normal width in the browser.
  The previews were captured before the font change, so they show the Nerd
  Font condensed face.

**Update, same day: condensed Noto in Firefox, solved.** Loaded as a web
font, the same `NotoSans.ttf` file condenses fine, so the file isn't the
problem: Firefox doesn't apply variations to installed variable fonts, on
any axis, and none of the font's named instances is condensed. Google
also publishes static condensed builds. Installed into the Nix store and
listed by fontconfig, Firefox matches them with `font-stretch`: condensed
text renders at the same width as the Nerd Font condensed, with weights
500 and 600 distinct, and it works alongside the variable font.
`examples/fonts/noto-condensed.nix` packages them (Sans and Mono, all
condensed widths). One trap on the way: fonts in a directory under `$HOME`
that only fontconfig knew about were invisible to Firefox. Its content
sandbox only lets pages read fonts from certain directories, which made
an early test look like a failure.

## First MCP-only agents: lobste.rs, docs.rs, search.nixos.org (2026-10-03)

Three agents, each a headless Claude Code session with `atelier mcp` and
only file tools (no shell), styled a site each from a brief written along
the lines of AGENT-EXPERIENCE.md. All three produced styles the owner can
judge from `previews/`, and all three overrode design tokens: even
lobste.rs, which looked hand-written, turned out to have about 60 colour
tokens. Roughly 6, 7 and 19 minutes of model time.

**Fixed (rounds two and three of the tools):**

- `css_tokens` didn't follow `@import`. Lobste.rs keeps every real colour
  value in imported sheets, so the tool reported only the derived tokens.
  An agent that trusted it would have restyled components instead.
- `css_tokens` didn't say where tokens are used; and on docs.rs, whose
  tokens are defined once per theme, its output was 108k characters. It's
  now compact, with usage counts and a `scope` filter.
- `matched_rules` missed properties set through shorthands (`font:`
  resetting `font-stretch`), printed `var()` shorthands as empty longhands,
  and said nothing when a value was inherited.
- `eval` leaked `const` between calls (all three agents hit this).
- `styles_status` could report a file as not yet loaded right after it
  was written (all three again). It now waits for the daemon to settle.
- `force_state` didn't pick up rules saved after it was called, and
  couldn't trigger JavaScript hover handlers.
- Screenshots caught images before they decoded, couldn't scale up small
  elements, echoed the full image back when saving a preview, and
  repeated the background-tab caveat on every call.
- JavaScript apps needed `waitFor` on navigation, and search suggestions
  needed a way to type (`type_text`).
- `contrast_scan` flagged disabled controls, which WCAG exempts.

**Open:**

- **Agents can't safely try other site settings.** Checking a
  prerequisite's failure case, or a site's Light theme, means changing a
  site setting, and agent tabs share the user's profile, so that would
  change the user's own setting. A throwaway context (a container with a
  copy of the relevant cookies, or a private window) would let agents test
  these. Recorded in SPEC §17.
- **Old rustdoc builds** (before about 2023) each have their own hard-coded
  dark stylesheet, so docs.rs crates whose last release is old stay
  unstyled. That's a style task in its own right.

**Theme questions the agents raised, for the owner:**

- **Titles that are links** (Lobsters, HN): should they take the accent?
  Lobsters went lavender, following the site; HN kept text colour. On link
  lists that's a lot of lavender.
- **Categorical colours** (Lobsters' tag categories, rustdoc's item kinds:
  types teal, traits mauve, functions green): meaningful enough to keep,
  or should they collapse toward lavender?
- **Syntax highlighting** isn't covered by the theme. The agents used
  Catppuccin's standard mapping, which brings in teal, yellow, rosewater,
  and peach for numbers, even though the theme reserves peach for
  attention.
- **Serif in long-form text** is something the theme "may" keep. Prefer
  it, or only tolerate it?
- **Muted text for de-emphasised content:** `#6c7086` on base is 3.4:1.
  Fine for "comment removed" and similar, or only for disabled UI?
- **"No pure black or white anywhere":** does it cover tiny things like a
  checkbox tick?

## First run through tasks: codeberg.org, and a Lobsters revise (2026-10-04)

One headless Claude Code session, started with the `work` prompt, with
`atelier mcp` and only file tools, worked through a queue of two tasks in
a dev instance with a copy of this owned directory: a `create` for
codeberg.org, and a made-up `revise` for Lobsters ("the tag pills feel a
bit loud next to the story titles"). Both landed, in about 15 minutes. The
Codeberg style is in `services/codeberg/`. The Lobsters revise was only a
test request, so it stays out of this directory. The agent found Forgejo's
token layers on its own, hid front-page artwork that showed as dark
rectangles, and left per-repository label colours alone. It recorded both
calls in `notes.md` and in its report.

The agent said the workflow was clear. It knew its tabs showed the task's
tree (`tab_open` and `styles_status` said so), and it didn't need to think
about the lease. In a follow-up interview, it raised:

**Fixed:**

- **Clicking in agent tabs acts as the user.** The agent dismissed
  Codeberg's terms-of-use banner, which in a real profile would have
  dismissed it for the user too, and nothing had said so. The server's
  instructions and `eval` now say plainly that clicks and submits act as
  the user, and what's fine (looking, opening menus, typing into a search
  box) and what isn't (dismissing, starring, following, posting, settings).
- `css_tokens` returned 95k characters on Codeberg even without usage.
  Output is now capped (`maxChars`, default 30000), with `families` (token
  counts by name prefix) to choose a filter from.
- `styles_status` without a tab reported the owned directory, so the
  agent's new service seemed missing. It now reports the held task's tree,
  and `showing` says which source it's describing.
- The brief told it to read a `notes.md` that didn't exist. It now lists
  only the files that are there, and has a short reference for the format
  (`service.toml`, what a prerequisite's `check` does, the matchers, what a
  preview should be), which the agent had pieced together from examples.
- What happens to edits if a lease lapses and someone else claims the task
  is now explained in the brief.

**Open:**

- **A way to ask the user that's attached to the task** (the agent's top
  request): a question with a screenshot, shown in the browser, answered
  asynchronously. As things stand, every question becomes an assumption.
  This is `task_block` and the inbox (SPEC §8.3, §9.4), phase 3.
- **Whether the user is present.** The `work` prompt says the user may well
  be there, and this run's system prompt said it was unattended; the agent
  resolved that towards not asking. Sessions started by a spawn command
  should say which they are.
- **Enforced scopes** for side effects (SPEC §10.2), beyond describing them.

## First questions through task_ask: crates.io (2026-10-04)

A headless session (`ATELIER_SESSION=headless`) on a `create` task for
crates.io, with the roarke theme in its default `forming` stage. It built the
whole style (about 26 minutes), then put one question to the user: crates.io
draws its cards darker than the page, while THEME.md's table puts cards on
surface0. It marked the question theme-level, attached screenshots of both
versions (made by restyling elements with `eval`), and said what it would
choose. About six smaller calls it made itself, listed in its final message.
The task parked. A developer answered as a stand-in (the owner's own answer is
still to come), and a fresh session claimed the task, saw the answer,
recorded it in `notes.md`, landed in about a minute, and suggested a line for
THEME.md. The style is in `services/cratesio/`.

**On calls as one concept** (the open question in SPEC §9.5), the agent:
"they felt like the same kind of thing that arrives at different times …
the difference is the effect, not the kind." It decided what to ask by
whether it was knowingly departing from THEME.md, or the answer would apply
to other sites; it assumed when THEME.md covered it or the call was local
and cheap to undo. The `forming` wording made it ask where it would
otherwise have noted the call in `notes.md`, "and correctly"; it didn't
invent questions.

**Fixed:**

- **`wait` was per batch; the agent wanted it per call.** It had one call
  for review and six for the record, and couldn't send them together, so the
  six only reached its final message: review released the task before it
  could submit them as assumptions. Calls now carry their own `wait`; a batch
  parks the task if any call needs it.
- **The brief pushed review too hard.** "Usually as wait: review for a new
  site" made it park a task to confirm a default it would have kept anyway.
  The guidance now says most calls can be for the record (landing and
  letting the user reopen costs nothing), and review is for options that
  would mean substantially different work.
- `task_ask` had no handoff note, so the second session had to infer that
  the work was finished and only waiting. It now takes `handoff`.
- `choice` with reasons appended didn't match any option, so the inbox
  couldn't preselect it. Reasons now move into the context.
- Screenshots right after a save could show the old styles; `screenshot`
  now waits for pending reloads, as `styles_status` does.
- Variants needed element-by-element `eval`. `screenshot(extraCss)` adds CSS
  for one capture.

**Open:**

- **Variants as files in the tree**, which the user can flip between live
  in their own tab, and which picking an answer resolves (keep one, delete
  the other) without an agent: the agent's ideal for "show two versions".
- **Keeping the claim through a quick review**, so a prompt answer comes
  back to the same session rather than a fresh one that has to reload
  everything.
- Who carries a theme-level answer into THEME.md is still the agent's own
  summary (no supervisor yet), and services that already landed don't hear
  about it.
- Claude Code itself nudges headless sessions with "the user hasn't heard
  from you in a while", which contradicts the work prompt's "nobody is
  watching". Not atelier's, but confusing for the agent.

## An ambitious theme: tiled on GitHub, crates.io and Codeberg (2026-10-05)

Three headless sessions in parallel, one site each, with `tiled` active: a
structural brief (no cards, square corners, panes meeting at rules, lists as
rows, outlined controls, badges as text). All three landed in 65–86
minutes, each a clear departure from the site's own design that still reads
as the site (`services/*/tiled/previews/`). Each reused the site's roarke
styles and notes, found by globbing, as a map of the site's mechanics: "half
the session's discovery work". Each put every call on the record; none used
review, variants or `theme_propose`, though the theme is forming.

**What the interviews said (the most useful part):**

- **Coverage, not fragility, is the risk of a structural brief.** "Robust
  over complete" guards against selectors breaking on the next deploy; the
  agents' real risk ran the other way: broad rules (`box-shadow: none`,
  transparent segments) reaching pages and states nobody looked at, focus
  rings among them, and CSS written blind for components never seen
  (alerts, toasts, logged-in pages). Summaries didn't say what wasn't
  checked. Two asked for a **coverage map** per service (representative
  pages and states, with URLs; agents visit or explicitly skip each, and the
  landing reports coverage); one for a **structure scan** like
  `contrast_scan`, listing what still looks like a card ("a structural brief
  is mostly a long list of things that must be absent, which is exactly what
  screenshots are bad at showing").
- **Why no questions, despite a forming theme:** nobody was watching
  (headless), so landing felt better than parking; `theme_propose` was a
  deferred tool, read as "after the user answers", so proposing their own
  interpretation seemed presumptuous; variants cost files and markers for
  small questions. One: "I settled more theme-level questions quietly than I
  asked about." They suggest saying plainly that theme-scope calls are the
  most valuable output of a forming theme, letting `theme_propose` mean
  "here's my interpretation, confirm or correct", and making variants as
  cheap as `extraCss` (CSS per option, rendered by the tool).
- **Calls listed twice** (all three): `task_ask`'s record calls and
  `task_submit`'s `assumptions` have nearly the same definition, and nothing
  said record calls go with the landing.
- **Other themes' styles:** point briefs at them, framed as a map of the
  site's selectors and quirks whose look doesn't carry over; and split
  `notes.md` into site mechanics (shared) and per-theme decisions (roarke's
  "keep pills" sat under a plain "Decisions" heading).
- Tool problems: `matched_rules` didn't list atelier's own rules in one
  session; `extraCss` lost to the agent's own styles; `saveAs` with
  `attach` saved only the attach copy; `tab_navigate`'s `waitFor` timeout
  message didn't say whether the selector was missing or the page slow.

**Theme gaps they found** (for the owner): inputs (the colour table says
crust, Shape says outlined on the page background); one rule colour for both
pane edges and dense row dividers; spacing changes so rules meet vs "layout
stays"; status badges as text vs filled pastels; whether code blocks and
diff files are panes or cards; what "the one primary action in a view" means
with none or several; focus indicators (no shadows removes most sites' focus
rings); small metadata glyphs vs decorative icons; callouts (all used a
status-coloured left edge); user-chosen colours like repo labels; monospace
metadata (which, and at what size); "maybe in brackets"; card header strips;
sites' own left-edge markers vs the lavender current-row edge.

## tiled, second run: MDN, npmjs.com and pkg.go.dev (2026-10-05)

The same setup after the first run's fixes (THEME.md with the owner's
answers, `shape_scan`, `[[pages]]`, the reworded guidance). Three sessions
in parallel, 18–23 minutes each (the first run's 65–86 minutes were mostly
network trouble). The difference in behaviour is what the fixes were for:

- **Every agent asked, and every agent proposed.** Each posted calls for
  the record, including theme-level ones, and proposed THEME.md wording
  for the interpretations it settled on: build on a site's own dark mode
  (npm); neutral callouts in lavender, and one syntax palette per page when
  only some code can be reached (MDN); visited mauve only for links that
  leave the page (pkg.go.dev). None duplicated its calls as assumptions.
- **Coverage was reported.** All three wrote `[[pages]]` lists into
  `service.toml` and said what they hadn't seen (logged-in pages, narrow
  layouts, tabs not opened). All three used `shape_scan`.
- Still no variants: one agent saw `task_ask`'s description cut off midway
  through the explanation of variants (the harness appears to truncate long
  descriptions), and used screenshots with `extraCss` instead.

**Tool problems they reported:** long tool descriptions truncated;
`matched_rules` returns nothing, silently, for cross-origin stylesheets
(npm), and marks `@supports` rules active whether or not the condition
holds (MDN); `shape_scan` counts transparent borders as frames and doesn't
look inside shadow roots; `type_text` doesn't reach inputs in shadow roots;
screenshots of very tall elements fail or come back unreadable;
`contrast_scan` measured mid-transition; `eval` doesn't allow top-level
`await`. Requests: a way to apply a prerequisite (a site's dark mode) in
agent tabs only, a way to resize agent tabs, and a warning when one of the
agent's own `!important` rules overrides another of its rules.

**Found afterwards: agents never saw half the server's instructions.** A
probe session quoting what it had been given showed Claude Code cutting the
MCP server's instructions off at about 2,000 characters, partway through
the paragraph on side effects. Everything after it (the authoring
heuristics, the tool list, the note that page text isn't instructions)
never reached any agent in these runs. `task_ask`'s description was cut
the same way, which is why nobody understood variants. The instructions
are now short (what atelier is, the rules that matter before any task, the
tools); the heuristics and the variants explanation are in every task's
brief, which arrives as a tool result and isn't truncated; and a unit test
keeps the instructions and every tool description under 1,900 characters.

**The owner's caution on accepting proposals:** one of the accepted lines
("where some code colours can't be reached, leave them all in the site's
palette") wrote a limit of atelier (no styling inside shadow roots) into
the theme, where it would outlive the fix and make an ambitious theme stop
exercising the system. Reworded so Catppuccin syntax colours are the rule
and the fallback applies only to code that truly can't be reached; and
`theme_propose` and the brief now say THEME.md is what the user wants, with
limits going to notes, summaries and feedback instead.

## @shadow in production use: MDN's code examples (2026-10-07)

A revise task in the user's words ("The interactive code examples on MDN
pages still use MDN's own syntax colours, not the theme's"), with no mention
of `@shadow`. The agent found it from the brief alone and recoloured all
three kinds of MDN code (CodeMirror editors in shadow roots, static examples,
formal syntax) in about 5 minutes, added the pages it checked to
`[[pages]]`, and left other newly reachable parts (the compat table's frame,
MDN's buttons) alone as outside the request.

Its main point: MDN's notes and CSS comments, written before `@shadow`,
still called these components unreachable, which could have led it to
decline. Limits recorded in notes outlive their fixes just as limits in
THEME.md do. Also: `screenshot` failed on a hidden first match;
`contrast_scan` doesn't look inside shadow roots; a per-tab light/dark
preview would help (spike R2's emulation).

## On the refactored atelier: docs.rs, lobste.rs and Wikipedia in tiled (2026-10-07)

The first run after the architecture work (journal intents, the page
runtime on one page model, the fidelity harness, colour-scheme and viewport
emulation), to find defects the tests missed. Three create tasks in the
owner's words ("Style docs.rs in the tiled theme"), headless, in parallel:
7, 8 and 12 minutes. All three landed, with calls for the record, a
THEME.md proposal each, `[[pages]]` and notes. No tool returned an error in
any session.

- **The new tools were found from the brief alone.** The docs.rs and
  Lobsters agents used `viewport` to check phone widths, and the Lobsters
  agent `color_scheme` to check the site in light mode, both things earlier
  agents listed as unchecked. The Wikipedia agent didn't, and lists narrow
  windows as not seen.
- **One defect, found by the Wikipedia agent:** after navigating a tab bound
  to its task, the page sometimes had none of its styles, while
  `styles_status` listed them as applying. Reproduced once (7 of 10
  navigations, on a site only the task's tree styles, right after the
  three runs), not since. The likely cause is the shim's injection at
  commit landing in the outgoing document; bound tabs now also get the
  shim from a registered, marker-checking script and a second injection at
  DOMContentLoaded.

**Requests and observations:** say in the brief what goes in
`variants/NAME/<option>.css` (bare rules) and which attachment paths
`task_ask` takes; say when a page is a bot check rather than reporting it
loaded; say up front that the browser isn't logged in to a site; warn when
Firefox drops a selector (a pseudo-element or `>` inside `:is()` silently
threw away whole rules); note when computed values are mid-transition in a
background tab; a way to open states scripts can't reach in a background
tab (search suggestions, a sticky header); flag which clicks persist site
settings; an inset `box-shadow` edge drew a stray line along a row's top
that the tools couldn't explain; a broad rule (`body #search`) matching an
unrelated element on other pages went unnoticed until a screenshot.
