# Spike R4: does an open native port keep an MV3 background alive?

SPEC §16, R4. Run with `node spikes/r4/run.ts [IDLE_S [VARIANT...]]` from a
`nix develop` shell after `cargo build`.

## Setup

Firefox 156.0.1 in `atelier-dev` instances (headless sway, bwrap jail),
extension installed as a temporary add-on over BiDi. Two variants of a
non-persistent MV3 background script (`background.scripts`):

- **port**: opens a `connectNative` port at startup and holds it, sending
  nothing after the first few lifecycle messages.
- **oneshot** (control): no persistent port. Each lifecycle event is logged
  with a one-shot `sendNativeMessage`.

Each variant runs in its own instance with the same timeline: install, sit
idle, open a tab (which wakes a suspended background through
`tabs.onCreated`), then read the native host's log.

## Results

### 90 s idle (2026-09-30)

```
== r4-port (tab opened at +93.2s)
  +   1.7s  host 284  connected
  +   1.7s  host 284  extension/hello (background started +1.7s)
  +   1.7s  host 284  extension/installed (background started +1.7s)
  +  93.5s  host 284  extension/tab-created (background started +1.7s)

== r4-oneshot (tab opened at +91.5s)
  +   1.5s  host 296  extension/hello (background started +1.5s)
  +   1.5s  host 297  extension/installed (background started +1.5s)
  +  31.8s  host 399  extension/suspending (background started +1.5s)
  +  92.0s  host 420  extension/hello (background started +92.0s)
  +  92.0s  host 421  extension/tab-created (background started +92.0s)
```

(`connected`/`disconnected` lines from the one-shot hosts omitted.)

- **Idle suspension is active in this environment.** The control was
  suspended about 30 s after startup, matching Firefox's default
  `extensions.background.idle.timeout`. So neither the temporary install nor
  the remote-agent prefs disable it, which was the open caveat from the first
  run.
- **An open native port keeps the background alive.** The port variant was
  never suspended. The same background instance handled the tab event at
  +93.5 s.
- **Waking is fast.** The suspended control restarted and handled the event
  well within a second of the tab opening.
- `onSuspend` fires early enough to complete a one-shot native message.

### 600 s idle, port variant only (2026-09-30)

```
== r4-port (tab opened at +601.8s)
  +   1.8s  host 281  connected
  +   1.8s  host 281  extension/hello (background started +1.7s)
  +   1.8s  host 281  extension/installed (background started +1.7s)
  + 602.1s  host 281  extension/tab-created (background started +1.7s)
```

There is no maximum lifetime within 10 minutes: the same background instance
and the same host process were still alive at +602 s.

## Implications

- MV3 holds up for the design in SPEC §4.2: while the extension keeps its
  port to the native host open, the background stays resident, and the daemon
  can push to it at any time.
- The background still has to be restartable. The port goes away whenever
  the host exits or crashes, and while it's down the background will be
  suspended after about 30 s like any other. Waking it again needs an event:
  a tab event, an alarm, or the user. The extension should reconnect when it
  wakes. While it's suspended, pushes from the daemon can't reach it.

## Not covered

- A signed, permanently installed build (only temporary installs were tested).
- Long runs beyond the 600 s test, sleep and resume, and memory pressure.
