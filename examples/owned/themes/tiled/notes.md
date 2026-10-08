# tiled: design notes

How the theme has been worked out on particular sites: the situations that
came up, what was decided, and why. THEME.md is the theme in general terms;
these are precedents, not rules. Where a site's situation is the same,
decide the same way, so sites stay consistent; where it genuinely differs,
do what fits it, and add the distinction here. Agents add to this file with
theme_propose (file: notes.md); the owner reviews additions in the inbox.

## Regions and panes

- On a site that's one centred column, the header and footer strips run the
  full width of the window, with their contents kept on the column; the
  footer sits at the bottom of the window on short pages. Strips only as
  wide as the column read as floating cards. (lobste.rs, 2026-10-07)

## Current, selected, targeted

- Hover surface goes on dense lists of short rows (a story list, both of
  a story's rows together), not on comment threads: a comment is a long
  block of text, and a surface following the pointer while reading is
  noise. (Hacker News, 2026-10-07)
- What a link has just jumped to (a #anchor target in docs) counts as
  "current": the same 2px lavender left edge, without a tint. (docs.rs,
  2026-10-07)

## Images

- Figures (an image with its caption) lose their frame like any card; the
  caption sits directly under the image, as secondary text. An image's own
  backdrop (white behind a transparent diagram) stays. (Wikipedia,
  2026-10-07)
- A diagram the site itself inverts in its dark mode (an author-marked
  class, like Sphinx's img.invert-in-dark-mode) is left as the site draws
  it: that's the site's choice for that image, not a generic rule of ours.
  (docs.python.org, 2026-10-07)

## Tables and code

- Data tables in prose keep a full grid of muted 1px cell rules, square,
  with header cells in mantle: the grid is what makes a reference table
  read as one, so it isn't a card. (docs.python.org, 2026-10-07)
- In interactive examples (doctests, REPL sessions) the prompt is fg-dim
  and the output the text colour: the output is read as much as the
  input. (docs.python.org, 2026-10-07)
- Inline code loses its little box where it's occasional (Wikipedia), but
  keeps a recessed crust fill, square and unframed, where it's commands
  and paths to type throughout the prose (ArchWiki): there it blends into
  the text without one. (ArchWiki, 2026-10-07)

## Site signals

- A mark a site uses to say something (Hacker News's black bar above the
  header when someone notable has died) is content, not chrome: keep it,
  in the nearest Mocha colour (crust, set off by a muted rule), rather
  than restyling it away. (Hacker News, 2026-10-07)
