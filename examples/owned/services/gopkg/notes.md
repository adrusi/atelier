# pkg.go.dev

## How the site is built

- Server-rendered pages with hand-written BEM class names (`go-Header`,
  `go-Main-nav`, `go-Main-article`, `go-Main-aside`, `Documentation-*`,
  `UnitMeta-*`, `SearchSnippet*`, `Version-*`): stable, safe to select on.
- Dark scheme: tokens on `:root` (`--color-background`, `--color-text`,
  `--color-text-link`, `--color-brand-primary`, `--color-border`,
  `--color-background-accented`, ...), defined for `[data-theme="dark"]`
  and for `:root:not([data-theme="light"])` inside
  `@media (prefers-color-scheme: dark)`. The footer's Theme Toggle sets
  `data-theme` on `<html>` (auto = no attribute). Styles are scoped to
  `html:root:not([data-theme="light"])` (0,2,1), which beats both.
- `--color-background-accented` paints `pre`, example textareas, the tree's
  open section and, below 112rem, the details aside and the home page's FAQ
  band (`.go-Footer .Questions`). Making it crust for code means those
  other uses need their own rule (done for the aside and FAQ).
- Layout (`data-layout="responsive"`): one column below 80rem; outline +
  article from 80rem (aside a band above); outline | article | aside from
  112rem. The package header is sticky and switches to a compact one-row
  form (`.go-Main-headerTitle[data-fixed]`) once scrolled; after scrolling
  back up it can stay compact with empty space below — that's the site.
- Icons are grey SVG `<img class="go-Icon">` recoloured with CSS filter
  chains. The chains in shape.user.css (black → fg, black → lavender) were
  found by searching filter parameters against a canvas (`ctx.filter`)
  in the page.
- The README is collapsed with a gradient `mask-image` on
  `.UnitReadme-content`.
- The site's own focus rings are box-shadows via `--focus-box-shadow`.

## tiled

- Panes: site header and footer are mantle strips closed by muted rules;
  the package header is base with a rule below. From 112rem the outline
  and the details column meet the article at vertical rules running from
  the header's rule to the footer (the aside's top margin turned into
  padding so its rule reaches up). Below 112rem the aside is a mantle band
  — not seen in a browser yet (viewport was 1920px).
- Code blocks and example textareas: crust, 1px muted frame, square.
  Comments overlay2; links in code stay lavender (no other highlighting
  on this site).
- Outline: no grey bar on the open section; the current entry gets a 2px
  lavender left edge (inset box-shadow, so text doesn't shift); hover is
  surface0. The site's selected-dot is removed.
- Controls: go-Buttons and Share/Format are 1px outlined rectangles. Filled
  lavender: the home page's Search, each example's Run, the cookie notice's
  Okay. Inputs (search, jump-to, platform select) are crust-filled and
  outlined.
- Badges: "package"/"module"/"standard library" chips are dim text;
  "Latest" a square green rectangle; "deprecated" square yellow;
  vulnerability IDs red text.
- Lists of links in body text, dimmed when visited: the doc index, search
  result titles, jump-to results. Visited links elsewhere are mauve, except
  in-page anchors (otherwise a page turns mauve as you read it).
- Monospace metadata: header version and import counts, search result
  counts/versions/dates, "added in goX", versions tab.
- Callouts (`go-Message`): no fill, 2px left edge in the status colour.
- Dialogs, header menus and toggletips: surface0, surface1 border, square.
- The home page's gopher hero image is hidden (decorative). The footer
  gopher and Google logo stay.
