# Wikipedia

## How the site works

- Skin: Vector 2022. Colours are Codex design tokens on `:root`; dark values
  are under `html.skin-theme-clientpref-night` (Dark) and
  `html.skin-theme-clientpref-os` inside `@media (prefers-color-scheme: dark)`
  (Automatic). Light is `skin-theme-clientpref-day`. For logged-out users the
  default is Light, whatever the desktop prefers; the setting lives in the
  Appearance sidebar (and in local storage / a cookie when logged out).
- Codex doesn't define radius tokens on this skin: 2px corners are
  hard-coded on links, buttons and inputs, so squaring them takes a broad
  `border-radius: 0 !important`.
- Article furniture (infobox, navbox, ambox/tmbox/…mbox, quotebox, sidebar,
  documentation) is styled by TemplateStyles: `<style>` blocks inside the
  content, as `.mw-parser-output .x` rules, often with inline `style`
  attributes on top (tinted infobox headers, for one). Overrides need
  `!important`. The class names are stable template names.
- Thumbnails are Parsoid markup: `figure[typeof~="mw:File/Thumb"]` (or
  `/Frame`) with `figcaption`; older markup is `.thumbinner`/`.thumbcaption`.
  Images get `--background-color-base-fixed` (white) behind them so
  transparent diagrams stay readable.
- `<syntaxhighlight>` is Pygments output, `.mw-highlight` with the short
  token classes; Wikipedia's dark mode colours it Monokai.
- The sidebars are `.vector-column-start` (main menu, contents) and
  `.vector-column-end` (tools, appearance); what's pinned there is a child
  of a `.vector-pinned-container`, so `:has(.vector-pinned-container > *)`
  tells whether a column shows anything.
- `.vector-sticky-pinned-container::after` is a gradient fade at the foot of
  the sticky sidebars, from transparent *white*.
- Page previews and reference previews are `.mwe-popups`, with a pointer
  cut out by clip-path and a gradient fade on the extract.
- The English Main Page is `.mp-box` sections (`#mp-topbanner`, `#mp-left`,
  `#mp-right`, `#mp-lower`, `#mp-bottom`) with `.mp-h2` heading bars.
- CentralNotice campaign banners (`.cbnnr-*`, e.g. Wiki Loves Monuments)
  hard-code their own fonts and colours; they're occasional and dismissable.
- A background agent tab doesn't run CSS transitions to the end, so after a
  live style edit Codex controls (`transition: all`) can report stale
  computed values; reload to check.

## tiled

Files: `tokens` (Codex tokens and fonts), `chrome` (shapes, panes, menus,
controls, focus), `content` (article furniture), `syntax` (code),
`mainpage` (English Main Page). Everything is scoped to the two dark-mode
classes, so Light is untouched; the prerequisite asks for Dark or
Automatic.

Decisions:

- Panes: the header is a mantle strip across the window with a rule under
  it; the page column meets the mantle gutters at a rule each side; the
  sidebars are split from the article by full-height rules (only when
  something is pinned in them); the footer is a mantle pane under a rule,
  pulled out to the column's edges (its padding follows Vector's
  breakpoints: 1.5rem, 2.75rem from 1120px, 3.25rem from 1680px).
- Type: one family. An encyclopedia is reference writing, so Vector's serif
  h1/h2 become Noto Sans condensed too.
- Contents: entries in the text colour; the current section lavender with a
  2px lavender left edge. Page tabs: current one in fg, underlined lavender.
- Thumbnails lose frame and fill; the image keeps its white backdrop
  (theme: images aren't recoloured) and loses its border; captions are
  fg-dim, directly under the image.
- Infoboxes, sidebars and pull quotes: no frame or fill, a 1px rule on the
  edge facing the text; their header rows are mantle strips.
- Navboxes and template documentation keep a square 1px frame (they're
  panes spanning the column); navbox titles and group labels are mantle;
  the template's page-coloured gutters become 1px rules.
- Message boxes: no box, 2px left edge — red for speedy/delete, yellow for
  content/style, lavender for the rest. Codex messages likewise.
- Data tables (`.wikitable`) keep their grid in the rule colour, header
  cells mantle.
- Inputs recessed (crust); buttons outlined; the one primary button
  (Special:Search's Search) keeps Codex's progressive fill, now lavender.
- Search result titles: text colour, dimmed when visited.
- Inline `code` loses its little box; code blocks are crust panes with a
  surface1 frame.
- Wikipedia's own night-mode image inversion (`.skin-invert`, chosen per
  image by editors) is left as Wikipedia does it; asked the user.

Not seen: search suggestions (they don't open from scripted typing), the
sticky header (doesn't appear in a background tab), page/reference preview
popups, logged-in pages (watchlist, preferences, editing), other
languages' main pages, narrow widths.
