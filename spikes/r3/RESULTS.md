# Spike R3: screenshots of tabs that aren't visible

SPEC §6.3 and §16, R3. Run with `node spikes/r3/run.ts [BACKGROUNDED_S]` from
a `nix develop` shell after `cargo build`. Raw data goes to `last-run.json`
(not committed).

## Question

Agent tabs shouldn't take over the user's screen, so they'll usually be
hidden: background tabs, or windows the user's window manager keeps out of
sight. Can the extension screenshot them, and are the screenshots accurate?

## Method

`dev/fixtures/capture` has eight coloured boxes. Each starts grey and gets its
final colour through a different mechanism: static CSS, a timer, one
`requestAnimationFrame` callback, 30 rAF frames, a CSS animation, CSS injected
by the extension just before capture, a lazy-loaded image, and a fetch.
`?start=MS` delays the 30-frame and CSS-animation boxes, so they can start
after the tab is hidden. The spike extension (`ext/`) captures with
`tabs.captureTab` (and `tabs.captureVisibleTab` when the tab is active in its
window), then samples each box's pixels.

Situations:

- **A:** the active tab of the focused window (baseline);
- **B:** a tab opened in the background and never shown;
- **B (settle):** as B, but fast-forwarding animations first with
  `document.getAnimations().forEach(a => a.finish())`;
- **B':** shown for 0.5 s, then backgrounded for 40 s; animations start
  3 s after load, i.e. while hidden;
- **C:** the active tab of a window moved to another, invisible sway
  workspace; animations start 3 s after load, after the move.

## Results (Firefox 156.0.1, 2026-09-30)

```
== A-active  (visibility=visible)
  captureTab:        all boxes correct
  captureVisibleTab: all boxes correct
== B-never-shown  (visibility=hidden, rAF frames=1)
  captureTab: correct except raf30 and anim, which are still grey
== B-never-shown-settle
  captureTab: correct except raf30
== B-backgrounded-40s  (visibility=hidden; animations started while hidden)
  captureTab: correct except raf30
== C-other-workspace  (visibility=hidden; animations started while hidden)
  captureTab:        correct except raf30
  captureVisibleTab: correct except raf30
```

Captures took 70–110 ms. Every situation produced a full-viewport image
(1920×995), so failed captures were never the problem.

- **Capturing hidden tabs works**, including tabs that were never shown and
  windows on invisible workspaces. `captureTab` renders what's there.
- **DOM and CSS state is accurate** in every situation: static CSS, timers
  (even after 40 s in the background), fetches, lazy images, and CSS injected
  just before capture.
- **`requestAnimationFrame` stops while hidden.** A never-shown tab gets
  exactly one frame at load, and a hidden window stops too. Anything that
  needs a rAF loop (canvas rendering, some virtualised lists, JS animation
  libraries) can be stale or missing in a capture. Putting the window on
  another workspace doesn't help.
- **CSS animations don't run in never-shown tabs**, but do in tabs that have
  been shown at least once. Entrance animations such as fade-ins would leave
  elements at their starting state, often invisible, in a capture of a
  never-shown tab. **Fast-forwarding with `Animation.finish()` before
  capturing fixes this.**

## Decision

- **Agent tabs default to background tabs in the user's current window.**
  That's consistent with "atelier creates tabs, never windows" (§6.3). A new
  window gains nothing unless it's actually visible, so the "new window"
  preference stays off by default.
- **The screenshot tool uses `tabs.captureTab`**, and by default fast-forwards
  CSS animations and transitions before capturing (with an option not to).
- **The screenshot tool is honest about what it can't see.** When the tab is
  hidden, it checks whether rAF is running and returns a note with the image:
  something like "this tab is hidden, so content drawn by animation frames may
  be missing; use `tab_show` if it matters". An agent styling a canvas-heavy
  site needs to know that, not discover it.
- **`tab_show`** briefly brings an agent tab to the front, then puts things
  back. That takes focus away from the user, so it's gated by a user setting
  and is never the default.

## Not covered

- Captures beyond the viewport (full-page screenshots via `captureTab`'s
  `rect`), and device pixel ratios other than 1.
- Discarded tabs (`tab.discarded`), which have no document at all.
- Whether a minimised window behaves like a hidden workspace on other
  compositors and window managers.
