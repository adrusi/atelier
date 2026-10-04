# crates.io

## How the site is built

- SvelteKit. Colours are compiled by lightningcss into
  `var(--lightningcss-light, x) var(--lightningcss-dark, y)` pairs; which side
  applies is switched by `data-color-scheme` on `<html>` ("light" or "dark",
  set by JS from the colour scheme menu, resolving "System" from
  `prefers-color-scheme`). Styles are scoped to
  `html:root[data-color-scheme="dark"]`, so the light scheme is untouched.
- Global rules are in `@layer global`; component rules are unlayered and
  scoped with hashed classes (`.box.svelte-124xg1a`). The hashes change when a
  component's CSS changes, so selectors use only the readable class, with
  `html:root[data-color-scheme="dark"]` in front for specificity. Generic
  readable names (`.row`, `.list`, `.link`, `.header`) are narrowed by a parent
  or `:has()`.
- Only a few colours are tokens on `:root` (`--main-bg`, `--main-color`,
  `--link-color`, `--yellow500`, `--gray-border`, ...): tokens.user.css.
  Most component colours are hard-coded: components.user.css. Component CSS
  is loaded per route, so check each page type (home, search, crate readme,
  versions, dependencies, categories, user) when the site changes.
- READMEs are highlighted by Shiki (github-light/github-dark) with inline
  `style="color:light-dark(#light, #dark)"` spans; readme.user.css matches the
  dark hex by substring and overrides with `!important`.
- The crate page's download chart is a canvas (Chart.js): CSS can't reach
  it, so it keeps crates.io's pastel series on the page's background.

## Decisions

- Surfaces: header/footer (body background) are mantle, the main column is
  base. crates.io's boxes (home page crate lists, crate header, README,
  search result rows, version/dependency rows, category panel) are darker
  than the page in its own design; they stay recessed (mantle) with a 1px
  surface0 border and the 8px container radius, and raise to surface0 on
  hover. Drop shadows and text shadows removed. This was asked of the user
  as a theme-level question; the answer given so far (keep a site's own
  recessed boxes; THEME.md's "cards are surface0" is for sites with no
  opinion) came from a developer standing in for the user while testing, so
  it's provisional until the user answers it themselves.
- Accent: crates.io's green links and yellow highlights (focus rings, search
  button, buttons, active tab) are lavender. Link hover goes to body text.
  Yellow `.button`s are flat lavender with dark text; `.button--tan`
  (secondary) is surface0; `.button--red` is Mocha red.
- Kept crates.io's pill shapes: the search field with its attached button
  and the hero/sidebar buttons. They're part of how the site draws controls.
- Lists whose every title is a link (search results, category list) show
  titles in body text, dimmed (fg-dim) once visited, per THEME.md.
- Version release tracks keep their meaning: latest green, prerelease
  yellow, yanked red, as tinted discs with the status colour as text.
- Alerts (note/tip/important/warning/caution) map to Mocha
  blue/green/mauve/yellow/red; toasts use the same colours with dark text.
- Syntax highlighting: github-dark's palette mapped to Catppuccin Mocha's
  standard scheme (keywords mauve, functions/types blue, constants peach,
  strings green, comments overlay2).
- The cargo-crate logo is left as it is (site imagery, recognisable).
