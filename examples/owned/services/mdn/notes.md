# MDN

## How the site works

- The frontend ("fred", 2025-) defines semantic colour tokens on `:root`
  (`--color-background-page/primary/secondary`, `--color-text-*`,
  `--color-border-*`, `--color-link-*`, `--color-area-*`), each as
  `light-dark(<light>, <dark>)` over a raw palette (`--color-gray-10`,
  `--color-blue-50` ...). The Theme menu sets `html[data-theme]` ("light
  dark" for OS default, "dark", "light") and `color-scheme` with it, so
  overriding tokens as `light-dark(<MDN light>, <ours>)` restyles dark mode
  only, with no media queries. Use `html:root` to beat MDN's `:root`.
- The stylesheet also carries csstools fallbacks (`@supports not
  (color: light-dark(...))` blocks with `--csstools-light-dark-toggle-*`).
  Firefox supports light-dark(), so those never apply; ignore them.
- Much of the chrome is Lit web components with open shadow roots:
  `mdn-code-example`, `mdn-live-sample-result`, `interactive-example`,
  `mdn-compat-table-lazy` > `mdn-compat-table`, `mdn-search-button`,
  `mdn-search-modal`, `mdn-site-search`, `mdn-sidebar-filter`,
  `mdn-color-theme`, `mdn-language-switcher`, `mdn-user-menu`,
  `mdn-content-feedback`, `mdn-button`, `mdn-copy-button`. No `::part()`s
  are reachable from the page (the few parts are on nested components).
  Tokens inherit into them, so setting a token on a host element restyles
  just that component (e.g. `mdn-search-modal { --color-background-primary
  }`). Some read the raw palette directly (buttons, the search button, the
  user menu), hence the palette overrides.
- Radius tokens: `--radius-normal` (0.25rem) and `--radius-full` (pill) are
  read by the search button and sidebar filter; `--elem-radius` by
  `interactive-example`; `--border-radius` by the sidebar ad. Hard-coded
  in shadow roots (token-proof, but `@shadow` reaches them): code examples
  and compat table frame (0.25rem), search
  dialog (0.5rem), the /search page's field (2rem), `mdn-button` (0.25rem).
- Syntax colours inside `mdn-code-example` are MDN's own Prism palette,
  hard-coded in the shadow root as `:is(.code-example, .css-formal-syntax)
  .token.*` (light-dark() pairs); reach them with `@shadow
  mdn-code-example`. The formal syntax block (`pre.css-formal-syntax`) is
  light DOM and uses the same rules from the global sheet.
- Interactive example editors are CodeMirror 6 (`mdn-play-editor`, nested
  in `interactive-example`'s shadow root; `@shadow mdn-play-editor` reaches
  it) with the One Dark theme, in dark and light mode alike (`.cm-editor`
  carries `ͼo`). Highlighting uses generated classes, one per One Dark
  colour, in the order One Dark's highlight style lists them: ͼp keyword,
  ͼq names/properties/attributes/variables, ͼr functions, ͼs
  colours/constants, ͼt definitions/punctuation, ͼu types/tags/numbers, ͼv
  operators/regexps/URLs, ͼw comments, ͼ10 links, ͼ11 headings, ͼ12
  atoms/booleans, ͼ13 strings, ͼ14 invalid (checked 2026-10 on CSS, JS and
  HTML pages). They'd shift if MDN's CodeMirror bundle changes. Minimal
  CSS choice editors parse `display: block;` as a selector, so both words
  are ͼu. The console (`mdn-play-console`) is plain text.
- Interactive examples and live samples render in iframes on
  `<hash>.mdnplay.dev`: separate documents, out of reach.
- The current item in the left sidebar is `li > em > a[aria-current=page]`
  (the `em` draws the fill and edge); in the TOC it's
  `.reference-toc a[aria-current=true]`, drawn with a box-shadow edge. Both
  read `--color-area-*`, which MDN re-tints on Learn pages
  (`html[data-current-area="learn"]`).
- Top menus: `.menu__tab-button[aria-expanded]` opens `.menu__panel`; each
  `.menu__tab[data-section]` sets `--menu-tab-background/-text` to its
  section colour.
- Content images get a `--color-white` backdrop, so transparent diagrams
  stay readable; a palette override of `--color-white` must be undone on
  `.content-section img`.
- The page carries ad slots (`mdn-placement-top/-sidebar/-bottom`): out of
  scope.

## tiled

- Files: `tokens` (MDN tokens plus this style's own `--tl-*` role tokens,
  each a light-dark() pair), `chrome` (header, menus, popovers, sidebars,
  footer, focus), `content` (article bodies), `syntax` (syntax colours in
  every kind of code block), `home`.
- Panes: the header (nav and breadcrumbs) is one mantle strip; the left
  sidebar and TOC are split from the article by 1px muted rules on their
  inner edges (they're sticky and viewport-high, so the rules run the
  window's height). The footer is a mantle pane.
- Code is crust (`--color-background-secondary`, which components read as
  their code background). Inline code is crust too, square.
- Syntax colours (`syntax`): Catppuccin Mocha everywhere. Prism (code
  examples, formal syntax) through `--tl-syn-*` tokens with MDN's light
  colours in the light arm, mapped token by token to Catppuccin's standard
  roles (tags blue, attributes yellow, properties lavender, keywords mauve,
  strings green, numbers peach, punctuation and comments overlay2). The
  CodeMirror editors map each One Dark colour to its Mocha role; One Dark
  lumps roles together, so there HTML tags are yellow (with types and
  numbers) and attributes lavender (with properties and variables), unlike
  Prism. Editor background crust, like other code.
- Semantic tints (`--color-background-red/green/blue/...`) are the page
  colour in dark mode: notecards, good/bad examples and menu tabs show their
  kind by edge or text colour. Yellow keeps a tint, as it marks search
  matches. Notecard edges: lavender notes, red deprecated/non-standard,
  yellow warnings, green tips.
- Current item (sidebar, TOC): 2px lavender edge and lavender text, no
  fill. Sidebar hover is lavender text, not a fill, because the links are
  inline-block and a fill would be text-wide.
- Popovers (top menus, Theme, language, user menu, search dialog): surface0
  with a surface1 border, hovered/selected entry surface1. The open top-menu
  trigger is surface0 with lavender text, joined to its panel.
- Baseline banner: no box; a 2px edge in the status colour (green widely,
  lavender newly, dim limited, red removing) and the status as a square
  badge of that colour with dark text.
- Home: the hero mandala is hidden as decoration; featured/news cards are
  plain blocks; recent contributions are rows between rules; dates in
  monospace fg-dim; "Get involved" is the one lavender-filled button.
- Lists where every title is a link (search dialog, /search results) use the
  text colour, dimmed once visited.
- Not yet done: hard-coded radii above (other than code examples', now
  square) and the Copy/Reset/Yes/No buttons (`mdn-button`), which keep
  MDN's fills and 0.25rem corners. All are in open shadow roots, so
  `@shadow` can reach them now. Iframe contents are out of reach.
