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
