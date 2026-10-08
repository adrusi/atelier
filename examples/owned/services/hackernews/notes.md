# Hacker News

## How the site works

- No design tokens. Colours come from `bgcolor` attributes, `<font color>`
  and a few classes in news.css (`.c00`, `.c5a`…`.cdd` for comment fading,
  `.subtext`, `.comhead`, `.pagetop`, `.topsel`). CSS backgrounds beat
  `bgcolor`, so plain rules work.
- Layout is one table, `center > table#hnmain` (85% wide, min-width 796px;
  100% under 750px). Rows: optional black bar (`td[bgcolor="#000000"]`, a
  5px strip HN shows when someone notable to the community has died), the
  header (`td` holding `.pagetop`; its colour is a logged-in user's
  `topcolor` setting, so find it by contents, not by `bgcolor`), a 10px
  spacer, `tr#bigbox` (the page), and the footer row (`.yclinks`, an orange
  rule drawn as a tiny `table` with `td[bgcolor]`, the YC line and the
  Algolia search form).
- Stories: `tr.athing.submission` (rank, `.votelinks`, `.titleline`), then a
  `tr` with `.subtext > .subline`, then a spacer `tr.spacer`. The item
  page's story is the same inside `table.fatitem`.
- Comments: `tr.athing.comtr` > nested table with `td.ind` (indent image),
  `td.votelinks`, `td.default` (`.comhead`, `.commtext.cXX`, `.reply`).
  parent/next/prev/root links are `#id` anchors, so `:target` works.
- Vote arrows are `div.votearrow` with a `triangle.svg` background image;
  downvote is `.rotate180`.
- Content-Security-Policy refuses `data:` images, so a replacement image
  via `content: url(data:…)` doesn't load.
- `/login` (and `/submit` logged out) is a bare page with no `#hnmain`.

## tiled

- `#hnmain` goes full width and at least 100vh tall; header, page and
  footer cells are padded by `--gutter` (7.5vw, matching HN's 85% column;
  4px under 750px). `tr#bigbox { height: 100% }` makes it take the slack
  so the footer meets the window's foot on short pages (rows with
  `height: 0` didn't stop Firefox sharing the slack among all rows).
- Header and footer: bg-deep panes with a muted rule. Nav: fg-dim text,
  current page (`.topsel`) underlined in lavender.
- Logo: a crust "Y" letter on a peach square, drawn on the link
  (`::before`), since the SVG can't be swapped (CSP).
- Black mourning bar: kept, as a crust band over a muted rule (asked the
  user whether it should be more visible).
- Titles fg / visited fg-dim / hover lavender; ranks monospace. Scores
  stay sans: "117 points" in mono read gappy.
- Meta lines 8pt weight 500 (HN's 7pt is too small condensed).
- A hovered story (both rows) gets the surface. Comments don't get a
  hover surface: they're long blocks of text, and it would flicker
  across the page while reading.
- Downvoted comments keep HN's fading steps, mapped to Mocha greys of
  similar contrast (overlay2 → surface0). The faint ones fail contrast
  on purpose, as on HN.
- Targeted comment: 2px lavender inset edge on its `td.votelinks`.
- Forms: inputs recessed in crust with a surface-2 border; buttons
  outlined; "add comment", reply and login are the filled primary.
- Not seen (agent browser logged out, 2026-10-07): logged-in header
  (username, karma, logout), user settings form, submit form, flagged/dead
  items, polls, unvote links. Their rules are unchecked. The black bar was
  up on 2026-10-07, so a day without it is the unseen case (nothing keys
  on it, but worth a glance).
