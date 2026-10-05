# GitHub

## How the styles work

- GitHub is Primer. Colours, radii, shadows and fonts are CSS custom
  properties; `tokens.user.css` overrides them on the plain "dark" theme's
  selectors (see the prerequisite in service.toml), so most of the work is
  in tokens and survives redesigns. `chrome.user.css` handles what tokens
  can't reach.
- The logged-out header is Primer Brand, reading `--brand-*` tokens in
  `@layer primer-brand`; unlayered overrides win regardless of specificity.
- Nested `[data-color-mode="dark"]` scopes (the marketing header) re-declare
  every token, so the token selector covers them too.
- React components use CSS-module classes (`Name-module__part__hash`,
  `prc-Component-part-hash`). Match them on the prefix
  (`[class*="Name-module__part__"]`), never on the hash. Prefer
  `data-testid`, `aria-*` and Rails class names (`.Box`, `.tabnav-tab`,
  `.Label`) where they exist.

## tiled

- Every radius token is 0, `--borderRadius-full` included: that squares
  labels, topic tags, state badges and counters in one place. Round-by-nature
  things are put back in chrome: user avatars (`.avatar-user`,
  `prc-Avatar` unless `data-square`), radios, notification dots, the header
  logo. Org avatars become squares.
- Controls are outlined: `--control-bgColor-rest` and the button/counter
  backgrounds are transparent, borders overlay0. Primary buttons are
  lavender with dark text.
- Rule colours: `--borderColor-default` (pane edges, outlines, controls) is
  overlay0, the theme's rule colour; `--borderColor-muted` (row dividers
  inside lists) is surface1, since overlay0 on every row was loud.
- Labels/badges are text: `.Label` and Primer Labels are fg-dim (or their
  status colour); counters are monospace fg-dim; state badges (Open, Merged,
  Closed) are a coloured word with icon. Issue labels are a dot in the
  label's own colour (`--label-r/g/b`, set inline by GitHub) and the name in
  fg-dim: label colours are per repository and tell labels apart.
- GitHub's unread marker (3px accent bar, `UnreadBorder-module`) became a
  2px fg-dim bar, since the lavender left edge means "current row" in the
  theme. Logged out, every issue is "unread".
- Boxes flattened: the repo file list, its latest-commit header, the README
  box and the React list views (issues, PRs) lose their side borders and
  fill, keeping rules between rows. Comments (React issue body/timeline,
  Rails `.timeline-comment`) become sections under a top rule with the
  header on the page background. Rails `.Box` keeps its outline (it's used
  for too many things to strip safely) but loses its fill.
- Pinned issues lose their card border; hover gives the surface.
- Rails `.tabnav` (PR Conversation/Commits/Files) is underlined text.
- Diff file boxes keep their frame and header: each file is a pane of code.
- Word-level diff highlights are 22% alpha; at 35% body text failed contrast.
  Comments on added lines are 4.4:1, left as standard Mocha overlay2.

Not done (yet): segmented controls (Clone's HTTPS / GitHub CLI) still look
like buttons in a tray; the logged-in dashboard, profile and Actions pages
weren't checked (logged-out session).
