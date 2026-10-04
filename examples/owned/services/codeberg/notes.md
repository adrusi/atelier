# Codeberg

Codeberg runs Forgejo (a Gitea fork) with Fomantic UI components and its
own "codeberg-*" themes on top.

## How the style works

- **tokens.user.css** overrides Forgejo's `--color-*` tokens (and the
  `--steel-*` grey ramp, which a few rules use directly) on
  `html:root[data-theme$="-auto"|"-dark"]` under prefers-color-scheme: dark.
  Forgejo's theme values are in `@layer forgejo-theme`, Codeberg's in
  `@layer codeberg-theme`, plus one unlayered `:root` block (0,1,0) with the
  blue primary scale; `html:root` (0,1,1, unlayered) beats them all.
- Codeberg re-declares nav tokens on `#navbar` (its bright blue bar, with a
  text-shadow and SVG glow for contrast). Those are overridden on `#navbar`
  too, and the shadow/glow removed in chrome.user.css.
- Forgejo's `--color-secondary*` family is mostly borders and dividers, so it
  maps to border colours, not a surface.
- **chrome.user.css**: Chroma syntax colours (literal colours in
  forgejo-theme, so any unlayered rule wins), Fomantic's literal
  `.ui.secondary.button` background, dark text on coloured Fomantic
  labels/buttons (the "Merged"/"Open" badges), lavender underline on the
  active tab.
- **home.user.css**: the logged-out landing page at `/` (homepage.css), which
  uses literal colours, not tokens.

## Decisions

- Primary (Codeberg blue) → lavender. Info messages and the ToU banner
  (`--color-info-*`) are lavender-tinted, as informational.
- Radius: Forgejo's `--border-radius` is already 4px, used by controls and
  containers alike, so it stays; `--border-radius-medium` → 8px. Pills
  (`-large`, `-full`) are Forgejo's and stay.
- Diff backgrounds are kept faint (row 0x12, word 0x2e alpha) because syntax
  colours sit on top; punctuation inside a changed word is lifted to
  `#bac2de` for the same reason.
- **Repository issue labels are left as they are.** Their colours are chosen
  per repository and set inline (`style="background-color: #…; color: …"`),
  so CSS can't map them to Mocha generically. Some are loud and a few
  (white on Forgejo's blue/red) fall just under 4.5:1; that's the repo's
  choice.
- The language bar on repo pages uses linguist's per-language colours
  (categorical data) and is left alone.
- Front page: the mountain/circuit artwork is drawn on its own near-black
  (#030c12), which showed as rectangles on any theme surface. It's hidden
  (Codeberg itself hides it on narrow screens), along with the blurred halo
  behind the logo. The yellow call-to-action buttons become lavender.
- Only codeberg.org is covered. Other Forgejo/Gitea instances share the
  token names, so these files would mostly work there with another domain.
