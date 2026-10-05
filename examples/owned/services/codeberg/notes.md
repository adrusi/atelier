# Codeberg

Codeberg runs Forgejo (a Gitea fork) with Fomantic UI components and its
own "codeberg-*" themes on top.

## How the styles work

- **tokens.user.css** overrides Forgejo's `--color-*` tokens (and the
  `--steel-*` grey ramp, which a few rules use directly) on
  `html:root[data-theme$="-auto"|"-dark"]` under prefers-color-scheme: dark.
  Forgejo's theme values are in `@layer forgejo-theme`, Codeberg's in
  `@layer codeberg-theme`, plus one unlayered `:root` block (0,1,0) with the
  blue primary scale; `html:root` (0,1,1, unlayered) beats them all.
- Codeberg re-declares nav tokens on `#navbar` (its bright blue bar, with a
  text-shadow and SVG glow for contrast). Those are overridden on `#navbar`
  too, and the shadow/glow removed.
- Forgejo's `--color-secondary*` family is mostly borders and dividers, so it
  maps to border colours, not a surface.
- Some Forgejo rules are `!important` on a token (`.secondary-nav`'s
  background, the navbar's active item): change the token, not the rule.
- **roarke/chrome.user.css**, **tiled/syntax.user.css**: Chroma syntax
  colours (literal colours in forgejo-theme, so any unlayered rule wins).
- **home.user.css**: the logged-out landing page at `/` (homepage.css), which
  uses literal colours, not tokens. Its about box is pulled up over the
  header with a negative margin, so the header keeps its 10em bottom
  padding even with the artwork gone, or the two overlap.

### tiled only

- **tiled/shape.user.css** does the shapes. A blanket rule zeroes
  border-radius and removes box-/text-shadow (`!important`) on everything
  except avatars, radios, spinners and colour dots; the radius tokens are 0
  as well. Fomantic segments (Forgejo's boxes) lose background and border;
  `.ui.attached.header` strips stay as recessed (mantle) strips between
  rules. Buttons are outlined; `.ui.primary.button` is the filled one.
  Fomantic labels without an inline background become text in their
  colour.
- Underlines for the current tab/page/switch item are an `::after`, not an
  inset box-shadow: Firefox antialiases an inset shadow's hole on boxes at
  fractional positions, leaving a faint frame round the item.
- Comment bodies get the page background explicitly (not transparent): the
  issue timeline's vertical line runs behind them.
- The repo/org header (`.secondary-nav`) is a mantle pane meeting the page
  at one rule; the tab bar's own divider (`.ui.tabs.divider`) is hidden.

## Decisions

- Primary (Codeberg blue) → lavender. Info messages and the ToU banner
  (`--color-info-*`) are lavender-tinted (roarke) / mantle with a lavender
  edge (tiled), as informational.
- **Repository issue labels are left as they are.** Their colours are chosen
  per repository and set inline (`style="background-color: #…; color: …"`),
  so CSS can't map them to Mocha generically. Some are loud and a few
  (white on Forgejo's blue/red) fall just under 4.5:1; that's the repo's
  choice. In tiled they're the one remaining kind of pill, for the same
  reason: the colour is only available as the inline background.
- The language bar on repo pages uses linguist's per-language colours
  (categorical data) and is left alone.
- Front page: the mountain/circuit artwork is drawn on its own near-black
  (#030c12), which showed as rectangles on any theme surface. It's hidden
  (Codeberg itself hides it on narrow screens), along with the blurred halo
  behind the logo. In roarke all the yellow call-to-action buttons become
  lavender; in tiled only "Register now." is filled, the support buttons
  are outlined.
- The rainbow strip along the bottom of the footer is Codeberg's and stays.
- Only codeberg.org is covered. Other Forgejo/Gitea instances share the
  token names, so these files would mostly work there with another domain.
- Not checked logged in (the session that wrote tiled was logged out):
  the dashboard, settings forms, the comment editor and project boards are
  covered only by the generic rules.
