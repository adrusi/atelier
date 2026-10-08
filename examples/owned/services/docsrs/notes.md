# docs.rs

## How the site is built

- Two stylesheets, two token sets. Rustdoc's (`/-/rustdoc.static/rustdoc-*.css`)
  defines its theme as custom properties on `:root[data-theme="dark"|"light"|"ayu"]`;
  rustdoc's script picks one from its settings (default: follow the system).
  docs.rs's own (`/-/static/style.css`, `rustdoc-<date>.css`, `vendored.css`
  with Pure.css) uses `--color-*` tokens on `html[data-docs-rs-theme=...]`,
  which follows the same setting. Both are scoped to dark only; Light and Ayu
  are untouched.
- docs.rs pages have `body:not(.rustdoc-page)`; rustdoc pages have
  `body.rustdoc-page` and docs.rs's top bar (`div.nav-container`) on top.
  docs.rs's broad rules (`div .info`, `div .warning`, `body #search`) also
  reach into rustdoc pages: rustdoc's search results section is `#search`
  and the docblock warning is `.warning`. Scope accordingly.
- `div .info` on crate pages is the ⓘ size tooltip, not a notice.
- Rustdoc names Fira Sans / Source Serif in one rule and in `--font-family`;
  body type is set with the `font` shorthand, which resets font-stretch.
- Rustdoc's `:target` marker is a 3px border-right. The sidebar's links are
  pulled 4px past the pane edge (margin -28px, padding 28px within 24px of
  padding). Inset box-shadows on those rows render a hairline along the top
  at fractional y in Firefox; use a border.
- Some rustdoc settings (the source Files sidebar, collapsed sections) are
  saved in localStorage: try them in a throwaway tab.
- Old releases (rustdoc from before about 2023) have no tokens and keep their
  colours, apart from docs.rs's top bar.
- docs.rs deploys often (the style.css query string changed during one
  session); selectors here are its readable class names and ids.

## tiled

Started from roarke's token work (same Mocha mapping, icon filter chains,
syntax colours); the tiled files are rustdoc.user.css and docsrs.user.css.

- Panes: top bar, crate header and rustdoc sidebar are mantle, closed by
  muted rules; the crate page's left info column meets the README at a
  vertical rule pulled up to the header's.
- Current item: 2px lavender left edge (sidebar current crate/item, source
  file tree's open file, focused search result). The anchor target uses the
  same edge, moved from rustdoc's right side, with no tint.
- Code blocks and declarations: crust, square 1px muted frame. Scraped
  examples' fade gradient is flattened to the code background.
- Callouts ("Available on crate feature", deprecation/unstable, docs.rs
  notices): 2px left edge, lavender or yellow, no tint. The same stabs inline
  in item lists are dim monospace text.
- Search results (rustdoc and docs.rs): rows without rules, surface on hover;
  crate names in body text, dimmed once visited.
- Tabs (rustdoc search tabs, crate page tabs): text, current underlined
  lavender.
- Controls: outlined squares; inputs crust-filled and outlined. Primary
  fills: the crate page's Documentation button and the home page's Search.
- Popovers (settings, help, top-bar dropdowns, size tooltips, the site alert):
  surface with a surface1 border, square; the popover arrow is hidden.
- Item-kind link colours: types teal, traits mauve, functions green, macros
  sky (roarke had macros green too, the same as functions); everything else
  lavender. Syntax macros blue.
- Monospace metadata: crate version in the sidebar, versions list in the
  crate menu, release dates in lists, inline stab labels.
- The Rust logo's four drop-shadow outline is removed (a glow).
