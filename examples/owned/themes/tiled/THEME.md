# tiled

## Vision

The browser should look like another tiled window on the desktop: the same
dark, flat surface as the terminal, with the page divided into panes by thin
rules, the way the window manager divides the screen. No floating cards and
no rounded boxes; nothing sits *on* the page. Structure comes from
alignment, spacing and hairlines, the way it does in a well-made terminal
UI.

A site should still be recognisable from its layout and content, but not
from its chrome: restyle the shapes as well as the colours.

## Shape

- **No cards.** Boxes that group content (cards, panels, tiles, "boxed"
  list items, callouts) lose their background, border, radius and shadow.
  What they grouped stays grouped, by spacing and alignment, with a 1px rule
  between groups where the grouping would otherwise be lost. A grid of cards
  becomes a grid of plain blocks, or rows separated by rules.
- **Panes, not islands.** The page's major regions (header, sidebars, main
  column, footer) are panes that meet at a 1px rule, like tiled windows. A
  region set off by its own background (a sidebar in a darker tone, say) is
  fine, as long as it runs edge to edge rather than floating with a margin
  around it.
- **Square corners.** Radius 0 everywhere, controls included. The exceptions
  are things that are round by nature: avatars, radio buttons, spinners.
  Pills (tags, badges, segmented controls) become rectangles.
- **Lists are rows.** Repeated items (search results, issues, comments,
  files) become rows separated by rules, not stacked boxes. A hovered row
  gets the surface colour; the current or selected row gets a 2px lavender
  left edge, the way the window manager marks the focused window.
- **Controls are outlined, not filled.** Buttons and inputs are 1px outlined
  rectangles on the page background. Only the one primary action in a view
  gets a fill (lavender, with dark text). Toggle groups and tabs are text
  with the current one underlined in lavender, not buttons in a tray.
- **Badges become text.** Status badges, counts and labels lose their pill:
  they're short text in the status colour (or fg-dim), maybe in brackets
  where they'd otherwise run into the text around them. A coloured dot is
  fine where a site uses colour to tell many things apart (labels, tags).
- **No decorative imagery.** Hero illustrations, background art and
  decorative icons that repeat a text label go. Icons that are the only
  label for a control stay, and so do logos and content images (see Images).

## How far to go

Some of this won't be worth doing on every site. The aim is the look, not
completeness at any cost:

- **Robust over complete.** If flattening a component would take many
  fragile selectors (generated class names, deep structural chains), it's
  better to leave that component as the site draws it and say so, than to
  ship something that breaks on the site's next deploy.
- **Don't break function.** Menus, dialogs and popovers still need to read
  as on top of the page: give them a 1px border in the muted colour and the
  surface background, square, with no shadow. Anything that loses an
  affordance (a box that showed it was clickable) needs another one: the
  hover surface, an underline, an outline.
- **Layout stays.** Change the shapes inside the layout, not the layout:
  don't move things between columns, reorder content, or change widths
  beyond removing a card's padding and margins.

## Colour (Catppuccin Mocha, fixed)

A fixed palette, with no parameters: optimise for exactly these values.

| Role | Colour | Use |
|---|---|---|
| bg | `#1e1e2e` (base) | page background |
| bg-deep | `#181825` (mantle) | sidebars, headers, recessed areas |
| bg-deeper | `#11111b` (crust) | code blocks, inputs |
| surface | `#313244` (surface0) | hovered rows, menus, dialogs (never cards) |
| surface-2 | `#45475a` (surface1) | borders on menus and dialogs, scrollbar track |
| muted | `#6c7086` (overlay0) | rules, borders, disabled text |
| fg-dim | `#9399b2` (overlay2) | secondary text, metadata, timestamps |
| fg | `#cdd6f4` (text) | body text |
| accent | `#b4befe` (lavender) | selected and active things: focus, current item, the primary action, links |
| visited | `#cba6f7` (mauve) | visited links |
| attention | `#fab387` (peach) | the rare thing that really needs attention |
| selection | `#353749` | text selection background |
| error | `#f38ba8` (red), warning `#f9e2af` (yellow), success `#a6e3a1` (green) | status only |

Most of the colour on a page that isn't text, background or a rule should
be the accent: links, the primary action, the current tab, focus. A site's
green or blue primary button becomes lavender, unless its colour carries
meaning on that page. Something that really needs attention can stand out
by not being lavender: use peach.

Colours whose meaning matters (errors, diff additions and deletions,
status) map to the matching Mocha colour, used sparingly. Categorical colours
that tell things apart (a site's tag categories, item kinds in API docs) map
to distinct Mocha colours rather than collapsing into lavender. Dark text
(`#1e1e2e`) on these pastels is fine.

Where a list's every item title is a link, titles read better in the text
colour, with visited ones dimmed, than all in lavender.

**Syntax highlighting** uses Catppuccin Mocha's standard syntax mapping
(mauve keywords, green strings, peach numbers and so on). Peach in code
isn't the "attention" peach.

**Muted text** (`#6c7086`) is fine for short de-emphasised text, like
"[comment removed]" or a disabled control, but not for anything meant to be
read at length.

## Typography

- UI and body text: `"Noto Sans", sans-serif` with `font-stretch: condensed`.
  Condensed is the point; it's what the whole desktop uses. It comes from
  static condensed faces, installed alongside, since Firefox doesn't apply
  variations to installed variable fonts. Weights work in steps of 100.
- Monospace: `"Noto Sans Mono", monospace`, condensed as well.
- **Metadata can be monospace.** Timestamps, counts, hashes, version
  numbers and similar short machine-ish text may take the monospace face, in
  fg-dim, where it helps the page read like a terminal UI. Not where a site
  mixes metadata into prose.
- Don't change sizes much; the browser already runs at a 1.25 scale.
- Where text is borderline on contrast or size, a slightly heavier weight
  (500 or 600) is the preferred fix, before changing colours.
- One family across the screen is the default. Application UI and technical
  writing meant to be skimmed use the theme's fonts. A page that's like a
  magazine article can keep the publisher's type, serif included (in the
  text colour). Where a site uses typography to *mean* something, like a
  chat UI setting one speaker in serif and the other in sans, keep the
  distinction.

## Images

- **Content images** (photos, diagrams and other images that differ from
  page to page) are never recoloured by generic means: inverting, filters,
  blend modes. A rule that has to work for every image can't understand what
  each one depicts. A diagram with a white background stays as it is.
- **Site imagery** (logos, icons and other images that are part of the
  site's own design, the same on every page) can be recoloured to suit the
  theme, with judgement: keep a logo recognisable.

## Things to avoid

- Shadows, gradients, glows and blur, anywhere.
- Pure black or pure white.
- Hiding content or features to make a page look cleaner.

## Out of scope

- **Ads.** Hiding ads is an ad blocker's job, not a style's. Don't hide them.
