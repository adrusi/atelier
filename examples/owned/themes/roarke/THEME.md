# roarke

<!-- DRAFT, written by Claude from the desktop's stylesheet
(~/jury/modules/stylesheet/roarke.nix) and a screenshot of the desktop
(not kept here: it showed personal window titles), for dogfooding atelier.
It's a reading of the desktop, not the owner's own statement of intent:
replace it with that. -->

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
  window manager marks the focused window. Corners are 8px on containers
  (cards, menus, dialogs, code blocks) and 4px on small controls (buttons,
  inputs, badges); never pill-shaped.
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
| accent | `#b4befe` (lavender) | focus, current item, primary buttons |
| link | `#89b4fa` (blue) | links; visited links `#cba6f7` (mauve) |
| selection | `#353749` | text selection background |
| error | `#f38ba8` (red), warning `#f9e2af` (yellow), success `#a6e3a1` (green) | status only |

Accent colour is scarce: one or two things per screen. Most of the page should
be bg, surface and text. Keep semantic colours (errors, diffs, votes, status
badges) semantic: map them to the matching Mocha colour rather than to the
accent.

## Typography

- UI and body text: `"NotoSans NFP Cond", "Noto Sans", sans-serif`. Condensed
  is the point; it's what the whole desktop uses.
- Monospace: `"NotoSansM NFM ExtCond", "NotoSansM Nerd Font Mono", monospace`.
- Don't change sizes much. The browser runs at the toolkit's 1.25 scale
  already.
- Long-form reading (articles, docs) may keep a serif if the site uses one,
  but in the Mocha text colour.

## Things to avoid

- Pure black or pure white anywhere.
- Inverting images, logos or photos. Dark-mode by recolouring, not by filter.
- Making the site unrecognisable: restyle its surfaces, keep its layout.
