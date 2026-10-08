# tiled: design notes

How the theme has been applied, so work on every site makes the same calls.
THEME.md says what's wanted; these are interpretations of it that came up on
particular sites and hold for all of them. Agents add to this file with
theme_propose (file: notes.md); the owner reviews additions in the inbox.

## Regions and panes

- On a site that's one centred column, the header and footer strips run the
  full width of the window, with their contents kept on the column; the
  footer sits at the bottom of the window on short pages. Strips only as
  wide as the column read as floating cards. (lobste.rs, 2026-10-07)

## Current, selected, targeted

- What a link has just jumped to (a #anchor target in docs) counts as
  "current": the same 2px lavender left edge, without a tint. (docs.rs,
  2026-10-07)

## Images

- Figures (an image with its caption) lose their frame like any card; the
  caption sits directly under the image, as secondary text. An image's own
  backdrop (white behind a transparent diagram) stays. (Wikipedia,
  2026-10-07)
