# npm (npmjs.com)

## How the site is built

- Server-rendered React with Tachyons utility classes (`.bb`, `.b--black-10`,
  `.br2`, `.code`, `.button`) plus hashed CSS-module classes (`._8055e658`).
  The stylesheet (static-production.npmjs.com/styles.*.css) is cross-origin
  without CORS, so css_tokens and matched_rules can't read it; fetch() from
  eval in a tab can.
- Colour mode: `data-color-mode="dark"` on `<html>`, set by an inline script
  from localStorage `npm-color-mode` (light / dark / system; default light).
  The moon/sun button in the header cycles it. `data-theme-setting` holds the
  setting itself.
- Dark mode is a Primer-style token set on `[data-color-mode='dark']`
  (`--color-fg-*`, `--color-bg-*`, `--color-border-*`, legacy `--wombat-*`,
  `--color-syntax-*`) plus ~700 `[data-color-mode='dark'] .hash` rules, many
  `!important` but nearly all written with the tokens. Retuning the tokens
  (tokens.user.css) does most of the colour work. The light mode has no
  equivalent token layer, so restyling it would mean copying those 700
  rules: not attempted.
- To preview the dark mode in an agent tab without touching the user's
  setting, set the attribute from eval:
  `document.documentElement.setAttribute('data-color-mode','dark')`
  (lost on navigation). Colours transition, so wait a moment before
  contrast_scan.
- Stable hooks: `#readme`, `#tabpanel-{readme,explore,dependencies,
  dependents,versions}`, `#package-tab-*`, `ul[role=tablist]`,
  `aside[aria-label="Package sidebar"]`, `form#search`,
  `[data-test-id=alert-banner]`, `#user-content-provenance`,
  keyword links `a[href^="/search?q=keywords:"]`, `#pkg-list-exact-match`.
- `.white` text maps to `--color-fg-on-emphasis` in dark mode (used on the
  Search button and similar fills), so that token is dark (#1e1e2e) here;
  the home hero, which also uses `.white`, is recoloured explicitly.
- READMEs are GitHub-rendered markdown with `.pl-*` highlighting. The Code
  tab's viewer is react-syntax-highlighter with Atom One Dark as inline
  `style="color: rgb(...)"` (both colour modes), matched by substring in
  code.user.css.
- The header's rainbow stripe is a 10px `border-image` gradient on its first
  strip; the same stripe is `footer::after`. On the home page an empty div
  comes before the first strip.
- The weekly downloads sparkline is SVG, left in npm's purple.

## tiled

- Dark mode only, with a prerequisite (npm defaults to Light).
- Panes: the site notice, both header strips and the footer are mantle,
  meeting the page at muted rules; the rainbow stripes are removed. On
  package pages the sidebar is split from the tab content by a vertical rule
  running up to the tabs' rule.
- Broad rules (tokens.user.css): radius 0 and no box-/text-shadows on every
  element except images and radios; focus is a 1px lavender outline.
- Search: recessed (crust) field with a muted outline; Search is the one
  filled control in the header (lavender). Sign Up and sidebar buttons are
  outlined; Report malware keeps red as outline and text. On the home page,
  "Sign up for free" is the hero's filled action, "Learn about Pro" outlined.
- Package tabs: text, fg-dim, the current one fg with a 2px lavender
  underline; npm's per-tab colours (and icon colours) dropped. "Beta" is
  plain text.
- The site notice is a callout: a 2px yellow left edge, no tint.
- Provenance box: unframed, between two rules.
- Search results: rows between npm's own rules (surface0 on hover); titles
  in the text colour, visited dim; keywords and "exact match" lose their
  pills; metadata (version, age, dependents, downloads) in dim monospace.
- Versions tables: versions in mono, text colour (dim once visited);
  downloads, tags and dates in dim mono; row hover surface0.
- Version line under the package name: dim mono.
- README: links lavender (mauve visited), code blocks crust with a surface1
  frame, inline code crust, alerts as a 2px status edge, `.pl-*` mapped to
  Catppuccin Mocha. A heading that's all code loses the code fill.
- Home hero: gradient and shapes removed (decoration), text in fg; the
  glossy blob image above "Bring the best of open source" is hidden.
