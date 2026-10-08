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
  around it. A card's header strip counts as a region: a bg-deep strip, edge
  to edge. Code blocks and diff files are panes too: they keep a frame,
  square.
- **Square corners.** Radius 0 everywhere, controls included. The exceptions
  are things that are round by nature: avatars, radio buttons, spinners.
  Pills (tags, badges, segmented controls) become rectangles.
- **Lists are rows.** Repeated items (search results, issues, comments,
  files) become rows, not stacked boxes. In dense lists, spacing separates
  the rows, without hairline rules between them, unless leaving them out
  makes it unclear where one item ends and the next begins. A hovered row
  gets the surface colour; the current or selected row gets a 2px lavender
  left edge, the way the window manager marks the focused window. Left-edge
  markers of the site's own (an "unread" bar, say) use fg-dim, so lavender
  keeps meaning "current".
- **Controls are outlined, not filled.** Buttons are 1px outlined rectangles
  on the page background. At most one primary action per region of the page
  gets a fill (lavender, with dark text); a region with no clear primary
  action has none. Toggle groups and tabs are text with the current one
  underlined in lavender, not buttons in a tray.
- **Inputs must look different from buttons** at a glance. They can be
  outlined too, or recessed with the bg-deeper fill: whichever tells them
  apart better on that site. If it isn't clear, that's a good this-or-that
  question for the user, with screenshots of both.
- **Focus is always visible:** a 1px lavender outline. Sites often draw focus
  rings with box-shadow, which this theme otherwise removes, so put an
  outline in its place rather than losing it.
- **Badges.** Counts, tags and other labels lose their pill and become short
  text (fg-dim, or their colour). A coloured dot is fine where a site uses
  colour to tell many things apart. Status badges (open, closed, merged,
  failed and the like) are the exception: square rectangles of the status
  colour with dark text, since their colour is the point.
- **Colours chosen by a site's users** (a repository's issue labels, chat
  roles) can't be mapped to the palette. Keep them; show them as a dot of
  that colour with the name as text where that's possible, and leave them as
  the site draws them where it isn't.
- **Callouts** (notes, warnings, alerts) lose their box and tint, and show
  their kind with a 2px left edge in the status colour. Neutral ones
  (notes, info) use lavender.
- **No decorative imagery.** Hero illustrations, background art and large
  ornamental icons that repeat a text label go. Small inline glyphs before
  metadata (a calendar by a date, an arrow by a download count) stay, as do
  icons that are the only label for a control, logos and content images (see
  Images).

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
- **Layout stays, spacing can change.** Adjusting spacing is fine, and often
  needed: removing a card's padding, or moving a margin so that two rules
  meet. Changing the order of things, or moving them between columns, is
  risky: leave it alone unless there's a strong reason, and say what you did.
- **Build on a site's own dark mode** where it has one: retune its dark
  colours and ask me (as a prerequisite) to switch it on, rather than
  recolouring the light mode, which usually means many fragile rules.
- **Broad rules need broad checking.** A short selector can reach a long way
  (removing every shadow also removes focus rings drawn with them). Check
  broad rules on pages and states beyond the ones you started from, and say
  which you didn't see.

## Colour (Catppuccin Mocha, fixed)

A fixed palette, with no parameters: optimise for exactly these values.

| Role | Colour | Use |
|---|---|---|
| bg | `#1e1e2e` (base) | page background |
| bg-deep | `#181825` (mantle) | sidebars, headers, recessed areas |
| bg-deeper | `#11111b` (crust) | code blocks; inputs, where a fill sets them apart from buttons |
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

Visited mauve is for links that leave the page. Links to anchors on the
same page (a docs index, cross-references between identifiers) stay
lavender once visited, or the page turns mauve as it's read.

**Syntax highlighting** uses Catppuccin Mocha's standard syntax mapping
(mauve keywords, green strings, peach numbers and so on). Peach in code
isn't the "attention" peach. It applies to all of a site's code, wherever
it's drawn. Only if some of it truly can't be reached (drawn on a canvas,
say) does the rest stay in the site's own palette, so that one page doesn't
mix two.

**Muted text** (`#6c7086`) is fine for short de-emphasised text, like
"[comment removed]" or a disabled control, but not for anything meant to be
read at length.

## Typography

- UI and body text: `"Noto Sans", sans-serif` with `font-stretch: condensed`.
  Condensed is the point; it's what the whole desktop uses. It comes from
  static condensed faces, installed alongside, since Firefox doesn't apply
  variations to installed variable fonts. Weights work in steps of 100.
- Monospace: `"Noto Sans Mono", monospace`, condensed as well.
- **Metadata can be monospace,** in fg-dim, so the page reads a little like
  a terminal UI: counts, version numbers, hashes, and timestamps in lists
  and tables. Not large display figures (wide monospace numerals look heavy),
  and not times or numbers inside sentences.
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
