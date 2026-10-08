# lobste.rs

## How the site works

- Colours: four palette sheets (light/dark x normal/high contrast) are
  @imported with media conditions and each set the same tokens on `:root`;
  application.css derives `--color-fg-contrast-*` from `--base-fg` at
  opacities. Overriding on `html:root` beats all four, so a token style
  works whatever appearance the site (or a logged-in user's setting) picks.
  Nearly every colour goes through a token. `--input-outline-width` sets
  focus outline width.
- Layout: `body` is a centred 960px column with `header#header`,
  `main#inside` and `footer` as children; `body` has `gap: 1rem`. Below 481px
  the header becomes a shaded bar whose nav scrolls sideways, with gradient
  fades (`#header-top ul::before`, `.inbox::before`), and each story row
  gets a speech-bubble comment count (`.mobile_comments span`, drawn with
  borders and pseudo-elements).
- Stories: `li.story > .story_liner` with `.voters .upvoter` (a △ glyph in
  `::before`, the score as text) and `.details` (`.link a.u-url`,
  `ul.tags a.tag`, `a.domain`, `.byline`). Tag categories are classes:
  `tag_is_media`, `tag_meta`, and `tag_ask`/`tag_show`/`tag_announce`/
  `tag_interview`; the rest are topics.
- Caches menu: `details.caches` (shared `name`, so one open at a time).
- Pagination: `nav#page-link-buttons`; the site's rule for non-current
  links is `#page-link-buttons a:not([aria-current="page"])` (1,1,1), so
  overrides need to match it.
- Logo: an SVG L on a square whose red is set inline from traffic, hence
  `!important` to recolour it.
- Search is behind an Anubis bot check on first load; wait it out.

## tiled

- Header and footer are bg-deep panes running edge to edge with a muted
  rule; the body is made full width, and their contents (and `#inside`) are
  put back on the 960px column with `--column` padding. The body is a flex
  column with `#inside` growing, so the footer meets the window's foot on
  short pages.
- Header nav and pagination are tabs: text, the current one underlined in
  lavender. Upvoted / hovered arrows use the accent token (lavender).
- Story titles: text colour, visited fg-dim, hover lavender. Links in
  comment and story text: lavender / mauve.
- Tags are text, 13px, weight 500, coloured by category (variant
  `tag-colours`: plain fg-dim topics, or Lobsters' yellow topics).
- Scores, page numbers and phone comment counts are monospace; timestamps
  in bylines aren't: "15 hours ago" in mono read as a gappy phrase.
- Inputs recessed in crust with a surface-2 border; buttons outlined;
  the comment form's Post and the login button are the filled primary.
- Linked comment (`:target`): a 2px lavender left edge, no tint.
- Not yet seen (logged out in the agent browser, as of 2026-10-07): the
  submit form and its tag picker, messages, settings, flash notices, hats,
  moderator UI. Their rules come from the roarke style's map and are
  unchecked.
