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
