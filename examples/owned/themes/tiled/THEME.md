# tiled

<!-- DRAFT, written by Claude as an experiment: a theme that departs much
further from sites' own design than roarke does, to find out what atelier
and its agents run into when the brief is structural rather than a recolour.
It shares roarke's palette and type, and changes the shapes. The owner
hasn't written or approved any of it yet. -->

## Vision

The browser should look like another tiled window on the desktop: the same
dark, flat surface as the terminal, with the page divided into panes by thin
rules, the way the window manager divides the screen. No floating cards and
no rounded boxes; nothing sits *on* the page. Structure comes from
alignment, spacing and hairlines, the way it does in a well-made terminal
UI.

Where roarke restyles a site's surfaces and keeps its shapes, tiled changes
the shapes too. A site should still be recognisable from its layout and
content, but not from its chrome.

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
  label for a control stay. Content images and logos stay (see roarke's
  rules on images; the same apply).

## How far to go

This is deliberately ambitious, and some of it won't be worth doing on every
site. The aim is the look, not completeness at any cost:

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

## Colour and type

Exactly roarke's: the Catppuccin Mocha palette, the roles in roarke's colour
table (`themes/roarke/THEME.md`), condensed Noto Sans and Noto Sans Mono,
and its rules on syntax highlighting, typography and images. Two changes:

- **No surface for cards.** roarke's "surface: raised areas: cards" doesn't
  apply. Surface is for hovered rows, menus and dialogs only.
- **Metadata can be monospace.** Timestamps, counts, hashes, version numbers
  and similar short machine-ish text may take the monospace face, in fg-dim,
  if it helps the page read like a terminal UI. It's optional; don't do it
  where the site mixes metadata into prose.

## Things to avoid

- Shadows, gradients, glows and blur, anywhere.
- Pure black or pure white.
- Hiding content or features to make a page look cleaner.
- Ads are out of scope, as in roarke.
