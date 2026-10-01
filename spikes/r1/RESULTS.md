# Spike R1: how should styles get into pages?

SPEC §6.1 and §16, R1. Run with `node spikes/r1/run.ts` from a `nix develop`
shell after `cargo build`. The last run's raw data is written to
`last-run.json` (not committed).

## Requirements

A mechanism for applying the default source's styles has to be:

1. **synchronous:** applied before first paint;
2. **removable per tab**, so agent tabs can be bound to a task's tree (§6.2);
3. **unaffected by strict CSP**;
4. **resilient** to site scripts that remove `<style>` elements, rebuild
   `<head>` or reset `document.adoptedStyleSheets` (e.g. SPA hydration);
5. **author-origin**, winning ties with the page's own rules, so UserCSS
   written for Stylus behaves the same;

and it has to accept CSS that arrives at runtime from the daemon, not just
files packaged with the extension.

## Candidates

All in one extension (`ext/`), each setting its own probe properties on
`<html>`, so they don't interfere:

| | Mechanism | Dynamic CSS? |
|---|---|---|
| S1 | `userScripts.register` (USER_SCRIPT world, `document_start`) with the CSS embedded in the code; inserts a `<style>` element kept as the last child of `<html>`, re-attached by a MutationObserver if removed | yes |
| S2 | as S1, but appending a constructed sheet to `document.adoptedStyleSheets` | yes |
| S3 | `scripting.insertCSS` from `webNavigation.onCommitted`, `origin: "AUTHOR"` | yes |
| S3u | as S3, `origin: "USER"` | yes |
| S4 | `scripting.registerContentScripts` with a packaged CSS file | **no** |
| S5 | Firefox's `contentScripts.register` with CSS code | yes |

## Method

Fixtures in `dev/fixtures` load `/_shared/probe.js` synchronously in
`<head>`. It records which probes are applied in the first animation frame,
which runs just before first paint, along with CSP violations. The cascade test
pits each strategy's `html { --atelier-cascade-X: ext }` against the page's
`html { --atelier-cascade-X: page }` at equal specificity. Fixtures:

- `plain`: an ordinary page;
- `strict-csp`: `default-src 'none'; style-src 'self'; script-src 'self'`;
- `slow-stream`: the server sends the start of the document, pauses 1.5 s,
  then sends the rest, so the browser paints early;
- `hostile-head`: after load, removes every `<style>`, rebuilds `<head>` and
  resets `adoptedStyleSheets`.

Per-tab removal: two tabs on the same page; the extension removes every
strategy's styles in one of them.

The userScripts permission is optional-only, and `permissions.request` needs a
real user gesture. BiDi can't drive privileged extension pages, so the harness
presses Enter on the grant page's autofocused button through the compositor
with `wtype`.

## Results (Firefox 156.0.1, 2026-09-30; two runs, identical)

```
strategy  applied  1st frame  1st frame (slow)  wins tie  strict CSP  survives hostile  removable per tab
--------  -------  ---------  ----------------  --------  ----------  ----------------  -----------------
s1        yes      yes        yes               yes       yes         yes               yes
s2        yes      yes        yes               yes       yes         NO                yes
s3        yes      NO         NO                yes       yes         yes               yes
s3u       yes      NO         NO                NO        yes         yes               yes
s4        yes      yes        yes               yes       yes         yes               NO
s5        NO       NO         NO                -         NO          NO                -
```

The only CSP violation recorded was the strict-csp fixture's own inline
`style=` attribute, which is meant to be blocked. None of the strategies
caused one.

- **S1 meets every requirement.** A `<style>` element inserted by a user
  script is applied before first paint, isn't blocked by the page's CSP, wins
  ties because it's kept last, survives the hostile page because it's put
  back, and can be removed in one tab.
- **S2** loses its sheet when the page reassigns `adoptedStyleSheets`, and
  there's no event to notice that.
- **S3/S3u are too late.** `insertCSS` on navigation commit missed the first
  frame on every fixture, including the plain one (first frame at about
  140 ms). That's a flash of unstyled content on every load. User origin also
  loses ties with the page, as expected.
- **S4** is the ideal on every other count, but it can only use packaged files
  and can't be removed per tab.
- **S5:** `browser.contentScripts` doesn't exist under MV3.

## Decision

Use **S1** for the default source.

Consequences and notes for the real implementation:

- **The userScripts permission is needed for styles, not just userscripts.**
  It's optional-only, so onboarding has to include a grant step with a real
  click.
- **Changing CSS** means updating the registration (for future page loads)
  and updating the `<style>` text in already-open tabs. The element is shared
  DOM, so the extension can find it from `scripting.executeScript` in the
  ISOLATED world.
- **Per-tab binding (§6.2):** the spike switched S1 off with an attribute on
  `<html>`, which pages can see and could interfere with. A better channel is
  user-script messaging (`userScripts.configureWorld({ messaging: true })`):
  the shim applies the default synchronously, then asks the background
  whether this tab is bound to another source and swaps if so. Agent tabs can
  tolerate that brief delay.
- **The MutationObserver** only needs `childList` on `<html>`, since the
  element is kept as a direct child of it. The spike observed the whole
  subtree, which costs a callback for every mutation in the page.
- **The element is visible to the page:** scripts can see it and could remove
  it in ways the observer doesn't catch, e.g. by replacing `<html>` entirely.
  Acceptable, but worth knowing.

## Not covered

- Frames and iframes (only top-level documents were tested).
- Performance of the observer on heavy pages.
- Signed permanent installs.
- Restricted pages (`about:`, AMO, other extensions' pages), where nothing can
  inject.
