# roarke

<!-- DRAFT, written by Claude from the desktop's stylesheet
(~/jury/modules/stylesheet/roarke.nix) and a screenshot of the desktop
(not kept here: it showed personal window titles), for dogfooding atelier.
It's a reading of the desktop, not the owner's own statement of intent:
replace it with that. Revised 2026-10-03 with the owner's answers to questions
raised while styling GitHub and MDN (examples/DOGFOODING.md). -->

## Vision

The browser should look like it belongs to the same desktop as the terminal
and the window manager: a quiet, dark, flat workspace where content is the
only thing with any visual weight. Pages should feel like they were built for
a tiling WM: rectangles that sit edge to edge with consistent gaps, not cards
floating on a canvas.

## Visual language

- **Flat.** No shadows, gradients, glows or blur. Depth comes from small steps
  in surface colour and from borders, never from elevation.
- **Borders and shape.** Thin (1px) borders in a muted colour separate things.
  Focus and "you are here" get a lavender border or left edge, the way the
  window manager marks the focused window.
- **Corners.** The desktop's radius is 8px, and a good default is 8px on
  containers (cards, menus, dialogs, code blocks) and 4px on small controls
  (buttons, inputs, badges). This is a preference, not a rule: a site whose
  design leans on pills or circles (toggle switches, avatars, round icon
  buttons) can keep them. Fighting a site's design language to make radii
  uniform is usually the wrong trade-off.
- **Dense but not cramped.** Keep the site's information density; don't add
  padding for its own sake. Gaps between major regions are 10px.
- **Motion.** Keep existing transitions short, and don't add new animation.

## Colour (Catppuccin Mocha, fixed)

This theme has a fixed palette; there are no parameters. Optimise for exactly
these values.

| Role | Colour | Use |
|---|---|---|
| bg | `#1e1e2e` (base) | page background |
| bg-deep | `#181825` (mantle) | sidebars, headers, recessed areas |
| bg-deeper | `#11111b` (crust) | code blocks, inputs |
| surface | `#313244` (surface0) | raised areas: cards, menus, hovered rows |
| surface-2 | `#45475a` (surface1) | borders on raised areas, scrollbar track |
| muted | `#6c7086` (overlay0) | borders, disabled text, separators |
| fg-dim | `#9399b2` (overlay2) | secondary text, metadata, timestamps |
| fg | `#cdd6f4` (text) | body text |
| accent | `#b4befe` (lavender) | selected and active things: focus, current item, primary buttons, links |
| visited | `#cba6f7` (mauve) | visited links |
| attention | `#fab387` (peach) | the rare thing that really needs attention (the desktop's "urgent" colour) |
| selection | `#353749` | text selection background |
| error | `#f38ba8` (red), warning `#f9e2af` (yellow), success `#a6e3a1` (green) | status only |

On the desktop, the accent marks what is selected or active: the focused
window's border, the statusline in the editor. On a page, most of the colour
that isn't text, surface or a subtle border should be the accent (links,
primary buttons, current tab, focus), not a pastel rainbow. So a site's green
or blue primary button usually becomes lavender, unless its colour carries
meaning on that page. Something that really needs attention can stand out
precisely by not being lavender: use peach.

Keep colours whose meaning matters (errors, diff additions and deletions,
status badges) mapped to the matching Mocha colour, but use them sparingly.
Dark text (`#1e1e2e`) on these pastel colours is fine.

## Typography

- UI and body text: `"Noto Sans", sans-serif` with `font-stretch: condensed`.
  Condensed is the point; it's what the whole desktop uses. Use mainline Noto
  in the browser, not the Nerd Font builds the desktop has installed (those are
  for the private-use icons the bar needs, and come as separate static fonts).
  Firefox doesn't apply variations to *installed* variable fonts (only to web
  fonts), so condensed comes from static condensed faces, which need
  installing alongside: `examples/fonts/noto-condensed.nix`. Without them,
  `font-stretch: condensed` falls back to normal width. Weights work in steps
  of 100.
- Monospace: `"Noto Sans Mono", monospace`, condensed as well (it's also
  variable), matching the terminal.
- Don't change sizes much. The browser runs at the toolkit's 1.25 scale
  already.
- Where text is borderline on contrast or size (small metadata, text on
  coloured backgrounds), a slightly heavier weight (500 or 600) is the preferred fix, before
  changing colours.
- Long-form reading (articles, docs) may keep a serif if the site uses one,
  but in the Mocha text colour.

## Things to avoid

- Pure black or pure white anywhere.
- Recolouring **content images** (photos, diagrams and other images that differ
  from page to page, such as those in a Wikipedia article) by any generic means:
  inverting, filters, blend modes. A rule that has to work for every image on a
  site can't understand what each one depicts, and will sometimes get it wrong.
  A diagram with a white background stays as it is.

  **Site imagery** is different: logos, icons, illustrations and other images
  that are part of the site's own design, the same on every page. You can see
  what each one depicts, so recolouring it to suit the theme is fine, with
  judgement (keeping a logo recognisable, for example).
- Making the site unrecognisable: restyle its surfaces, keep its layout.

## Out of scope

- **Ads.** Hiding ads is an ad blocker's job, not a style's. Don't hide them.
  (Whether to make ads that do show match the theme is an open question.)
