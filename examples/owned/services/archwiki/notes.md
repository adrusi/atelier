# ArchWiki

## How the site works

- MediaWiki with the Vector 2022 skin, so most of what's in
  services/wikipedia/notes.md holds: Codex colour tokens, dark under
  `html.skin-theme-clientpref-night` (Dark) or `html.skin-theme-clientpref-os`
  inside `@media (prefers-color-scheme: dark)` (Automatic, the default for
  logged-out users here, unlike Wikipedia); hard-coded 2px radii; the
  sidebars' `.vector-pinned-container`.
- On top of Codex, the ArchLinux extension (`zzz.ext.archLinux.styles`) and
  the site CSS (`site.styles`) define `--archwiki-*` tokens on `:root` with
  `light-dark()`: page and content backgrounds, text, links, code, the
  template boxes (note/tip/warning/highlight/message/navigation), table
  status cells, progress bars. They follow `color-scheme`, which Vector sets
  to dark in the dark modes.
- Link colours are set by the extension with id selectors and `!important`:
  `#content a:not([role="button"]):not(.new) { color: var(--archwiki-link-color-normal) !important }`,
  the same for `#mw-panel-toc`, `#mw-panel`, `header.mw-header li`, `#footer`,
  and `:visited` for `#content` and `#mw-panel`. Changing the tokens is
  enough for most links; a link that needs a *different* colour needs
  `#content` (or the matching id) in the selector and `!important`.
- The article (`main#content.mw-body`) is drawn as a bordered box on the
  page background; the selected page tab is drawn joined to that box.
- The Arch navbar (`#archnavbar`, `#archnavbarlist`, `li.anb-selected`) is
  shared with archlinux.org's other sites. All its CSS is `!important`, and
  its link colour rule has two ids. The logo is a background image (SVG).
- Section numbers are CSS counters drawn in `.mw-heading > hN::before`.
- Templates use stable classes: `div.archwiki-template-box` with
  `-note`/`-tip`/`-warning`/`-highlight` (a bold label as `strong:first-child`),
  `div.archwiki-template-message` (article status, with a 48px Tango icon as
  `p > span[typeof="mw:File"]` in a 74px left gutter),
  `div.archwiki-template-meta-related-articles` (floated right; becomes an
  inline box below 721px), `.archwiki-template-navigation`,
  `.archwiki-table-cell.archwiki-template-{r,o,y,g,b,v,grey}` (status cells),
  `span.archwiki-template-pkg` / `-man` (monospace links).
- No SyntaxHighlight: code is plain `<pre>` with `<i>` for placeholders.
- The main page's index is `.archwiki-main-page-columns > dl > dt/dd`.
- Below 1000px the page column loses its side padding (the extension's own
  breakpoint, beside Vector's 1120px and 1680px ones).

## tiled

Files: `tokens` (Codex and `--archwiki-*` tokens, fonts), `chrome` (navbar,
panes, sidebars, tabs, footer, search, controls, menus, focus), `content`
(callouts, related articles, headings, code, tables, figures, main page).
Everything is scoped to the two dark-mode classes, like on Wikipedia.

Decisions (following Wikipedia's where the situation is the same):

- Panes: the Arch navbar and the wiki header are two mantle strips across
  the window, each ruled off below; the navbar's 5px blue rule goes. The
  article loses its box; the page column meets mantle gutters at a rule
  each side; the sidebars are split from it by full-height rules; the
  footer is a mantle pane.
- Navbar links are a tab row: dim, the current site (Wiki) in the text
  colour underlined in lavender. The Arch logo is kept as it is (blue and
  white): it's the brand and reads well on mantle.
- Section numbers (the wiki's gold italic counters) go to fg-dim, italic
  kept.
- Contents, related articles and main-page entries are link lists: text
  colour, dimmed when visited, lavender on hover; the current section has
  the lavender edge, on its top-level entry when folded.
- Note/Tip/Warning: no frame or tint, 2px left edge (lavender / green /
  red), the label's underline gone. Highlight boxes and article-status
  messages: yellow edge; the status message's Tango icon is hidden (it
  repeats the heading).
- Inline code keeps a recessed crust fill (variant `inline-code`; Wikipedia
  dropped the box, but here inline code is commands and paths throughout
  the prose and blends in without one). Code blocks: crust panes with a
  surface1 frame.
- Status table cells keep their meaning: the Mocha hue mixed ~25% into the
  page background.
- Search profile tabs: text, current one underlined in lavender. The
  Special:Search Search button is the one lavender fill.

Left as drawn: the history page's "Filter revisions" panel (an OOUI
collapsible fieldset) keeps its square frame.

Not seen: logged-in pages (watchlist, preferences, editing, the edit
toolbar), diffs, the sticky header (doesn't show in a
background tab), search suggestions, page previews, narrow widths
(< 1000px), Dark (only Automatic was checked; both use the same tokens).
