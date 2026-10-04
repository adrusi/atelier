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
