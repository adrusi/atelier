# Spike R5: keeping Dark Reader off pages atelier styles

SPEC §6.5 and §16, R5. Run with `node spikes/r5/run.ts [LOADS]` from a
`nix develop` shell after `cargo build`. Dark Reader is downloaded from AMO
into `vendor/` (not committed) on first run. Raw data goes to `last-run.json`.

## Question

atelier plans to add `<meta name="darkreader-lock">` to pages it styles, so a
user's Dark Reader steps aside there. Does that work when atelier's shim
(spike R1) adds the lock at `document_start`, before `<head>` exists? Is
there a flash of Dark Reader's styling first? And what happens when the lock
is added or removed later, as on single-page-app navigation?

## What Dark Reader does (4.9.133 source, `inject/index.js`)

- Its page-world script paints a `.darkreader--fallback` dark background
  immediately at `document_start`, before anything is decided.
- Its main content script waits for `<head>` to exist, then checks for a lock
  **anywhere in the document** (`document.querySelector`). If one is there, it
  removes the fallback and does nothing else.
- Otherwise it applies its theme and watches **only `<head>`** for a lock being
  added. When it sees one, it removes its theme and stops watching.

## Results (Firefox 156.0.1, Dark Reader 4.9.133, 2026-10-01; 5 loads each)

| Situation | First frame | 1.5 s later |
|---|---|---|
| No lock | Dark Reader active (fallback and 9 style elements) | active |
| Lock appended to `<html>` at `document_start` by a user script | **untouched** (no fallback either) | untouched |
| Lock appended to `<html>` after load | active | **still active** |
| Lock appended to `<head>` after load | active | **removed** |
| ...then lock removed | | **stays removed** until reload |

All five loads of each repeated case gave the same result.

## Decision

- **The style shim adds the lock at `document_start`** (appended to `<html>`,
  since `<head>` doesn't exist yet) whenever a bespoke style matches the
  page. Dark Reader then never acts, and there's no flash of its fallback.
- **When a style starts matching later** in the same document (single-page-app
  navigation), the shim adds the lock **to `<head>`**. Dark Reader removes its
  theme.
- **When a style stops matching** in the same document, the shim leaves the
  lock in place. Removing it wouldn't bring Dark Reader back until the next
  reload anyway, and keeping it makes the behaviour predictable: within one
  document, once atelier has styled a page, Dark Reader stays off until
  reload. For single-page apps, this is a reason for services to scope their
  styles to the whole app rather than individual routes.

## Not covered

- Other Dark Reader versions (the behaviour above is from reading 4.9.133's
  source and testing it).
- Dark Reader's static and filter modes, and its per-site settings.
- Iframes (Dark Reader runs in all frames).
