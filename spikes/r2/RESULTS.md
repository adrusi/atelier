# Spike R2: one tab in dark mode, the rest of the browser untouched

SPEC §16, R2. Run with `node spikes/r2/run.ts` from a `nix develop` shell
after `cargo build`. Raw data goes to `last-run.json` (not committed).

## Question

Agents need to check a style in both light and dark, but WebExtensions can only
override `prefers-color-scheme` for the whole browser
(`browserSettings.overrideContentColorScheme`). That would flip the user's own
tabs. Can one tab be made to render as dark (or light) on its own, and how
faithfully?

## Method

`dev/fixtures/color-scheme` uses every common way a page picks light or dark,
and reports what each concluded:

- `@media (prefers-color-scheme)` in a same-origin stylesheet;
- the same in a **cross-origin** stylesheet (served from `localhost` while the
  page is on `127.0.0.1`), as with sites whose CSS is on a CDN;
- `<link media="(prefers-color-scheme: dark)">`;
- `light-dark()` under `color-scheme: light dark`;
- `matchMedia` from JS when the page loads, and again later;
- `<picture><source media="(prefers-color-scheme: dark)">`.

Two tabs load it: the "user" tab and the "agent" tab. Scenarios: baseline;
per-tab emulation enabled in the agent tab only; and the global override.

**Per-tab emulation** (`ext/`): a tab opts in through a `sessionStorage`
marker. `sessionStorage` is scoped to the tab (and origin), and readable
synchronously at `document_start`, so registered user scripts know at once
whether they're in an emulating tab. In such a tab:

- a page-world (`MAIN`) user script wraps `matchMedia` so
  `prefers-color-scheme` queries report the forced scheme;
- a `USER_SCRIPT`-world script rewrites `prefers-color-scheme` conditions
  through the CSSOM (`rule.media.mediaText`) in every readable stylesheet, and
  in `media` attributes on `<link>`, `<source>` and `<style>`. It does this at
  `document_start` and again whenever stylesheets arrive;
- it injects `:root { color-scheme: <forced> !important }`, which covers
  `light-dark()`, form controls and scrollbars;
- **cross-origin stylesheets** can't be read through the CSSOM, even from the
  user-script world (`SecurityError`). For those, the script asks the
  background (user-script messaging) to fetch the text. The background's fetch
  uses the extension's host permissions, so CORS doesn't apply. The script
  makes relative `url()`s absolute, rewrites the conditions, inserts the copy
  right after the original `<link>`, and disables the original.

## Results (Firefox 156.0.1, 2026-09-30)

```
scenario                   tab    mediaSame  mediaCross  linkMedia  lightDark  jsAtStartup  jsNow  picture
-------------------------  -----  ---------  ----------  ---------  ---------  -----------  -----  -------
baseline                   user   light      light       light      light      light        light  light
baseline                   agent  light      light       light      light      light        light  light
per-tab dark (agent only)  user   light      light       light      light      light        light  light
per-tab dark (agent only)  agent  dark       dark        dark       dark       dark         dark   dark
global dark, no reload     user   dark       dark        dark       dark       light        dark   dark
global dark, no reload     agent  dark       dark        dark       dark       light        dark   dark
global dark, reloaded      user   dark       dark        dark       dark       dark         dark   dark
global dark, reloaded      agent  dark       dark        dark       dark       dark         dark   dark
```

- **Per-tab emulation covers every mechanism in the fixture**, and the user's
  tab is unaffected. (A first run without the cross-origin copy left
  `mediaCross` light. That gap is closed now, and it matters, because many
  large sites serve their CSS from another origin.)
- **The `sessionStorage` marker is read synchronously.** The page's own first
  line of JS already saw the overridden `matchMedia` (`jsAtStartup: dark`).
- **The global override flips every tab**, including the user's, as expected.
  It updates CSS live, but JS that decided at load needs a reload.

## Decision

- Agent tabs use **per-tab emulation**. The agent's `color_scheme(tab,
  light|dark)` tool sets the marker and reloads the tab. Screenshots of an
  emulating tab say that the scheme is emulated.
- The **global override is not used**. It would change the user's own tabs.

## A finding that matters beyond R2

The `sessionStorage` marker gives **synchronous per-tab knowledge at
`document_start`**, which R1 assumed wasn't available. For source binding
(§6.2), the default-styles shim can check a marker and skip applying the
default styles in a tab bound elsewhere, instead of applying them and swapping
later. Limits: the marker is per origin, so the first page load after a
cross-origin navigation in that tab doesn't see it; page scripts can see and
clear `sessionStorage`; and it's unavailable where storage is blocked, such as
some sandboxed frames. The asynchronous swap stays as a fallback.

## Not covered

- CSS-in-JS that adds `prefers-color-scheme` rules later through
  `insertRule` on an existing sheet (the observer only sees new elements).
- `@import` inside cross-origin sheets, and `@import` without `url()` in
  copies.
- `change` events on `matchMedia` lists (the wrapper reports the forced value
  but never fires them).
- Iframes, especially cross-origin ones.
- The `<meta name="color-scheme">` tag (probably covered by the forced
  `color-scheme`, but not tested).
- Very large stylesheets and the cost of copying them.
