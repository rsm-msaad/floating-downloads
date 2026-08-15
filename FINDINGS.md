# FINDINGS

Reusable lessons. Project-specific gotchas live in
[`context_v7.md`](context_v7.md); this file is what generalises.

---

## 2026-08-14 (evening)

### "The program says it is fine" is a claim about the program, not the world

The panel bug survived a thorough instrumented investigation that checked
the window was not null or destroyed, that bounds were inside the work area,
that opacity was 1, that it was not minimized, that the renderer loaded
cleanly, that the DOM was fully populated, and that CSP raised no
violations. Every finding was correct and the bug was none of them.

Every one of those probes asks the object about **its own state**. None asks
what is **in front of it**. A window can be healthy, correctly positioned,
fully painted and simply covered by something else, and no amount of
interrogating the window will reveal that.

One `screencapture -x` ended it in seconds by contradicting `isVisible()`
directly. **When something reports healthy but the user says it is not
there, stop asking the component and go measure the outside world.**

### A "long-running instance degrades" story is often just sleep

The symptom looked time-dependent: fresh instances fine, hours-old ones
broken. The real mechanism was that macOS resets window settings across
sleep, and the machine slept between "working" and "broken". Uptime
correlated with the failure only because uptime correlates with having slept
at least once.

Heartbeat gaps are the tell — long stretches with no entry while `uptime`
still tracks wall clock means the process lived through a sleep. It also
means a heartbeat **cannot** distinguish "dead" from "asleep", which limits
its value as an abrupt-end detector.

### State that the OS can reset must be re-asserted, not set once

`setAlwaysOnTop` and `setVisibleOnAllWorkspaces` were configured at window
creation. macOS drops both across sleep/wake, display reconfiguration and
fullscreen transitions. Anything the window server owns should be re-applied
at every point where it matters, not assumed to persist. Both calls are
idempotent, so re-applying is free — the cost of getting this wrong is an
intermittent bug that looks like decay.

### Two calls that look redundant may be doing different jobs

`setVisibleOnAllWorkspaces({ visibleOnFullScreen: true })` decides **which
Space** a window is on. `setAlwaysOnTop(win, level)` decides **what it
stacks above** once it is there. Having the first without a high enough
level produces a window that is on the right Space and underneath
everything — present by every measure, invisible in fact. On macOS,
`'floating'` (level 3) loses to fullscreen apps; `'screen-saver'` clears
them.

### A toggle that reads live state will invert when that state lies

`togglePanel` branched on `isVisible()`. While the window was covered but
still reporting visible, every keypress took the *hide* branch. The user
sees nothing happen, presses again, and it works — which reads as a flaky
hotkey rather than a state bug. Symptoms that alternate on repeat attempts
are worth suspecting as a toggle reading a stale or wrong predicate.

---

## 2026-08-14

### A clean startup line is not proof of stability

A `SIGSEGV` was pushed because the launch printed `[hotkey] registered` and
looked fine. The instance died 2m25s later. Anything meant to run all day
needs to be watched for longer than its time-to-crash before being called
verified.

### Test harness artefacts can invent findings

A bisect reported three `getFileIcon` sizes as "hung". They were not — Node
fully buffers stdout to a file, and `kill -9` discarded it. Switching to
`fs.appendFileSync` showed all three resolving normally. Trusting that run
would have meant ripping out real file icons for no reason. **When a test
reports a suspicious result, suspect the harness before the code.**

### Verify against the shipped source, not a copy

For the path-containment boundary and the CSP, the harness extracted the real
lines out of `main.js` / `index.html` and ran *those* under stubs. A
hand-transcribed copy would only have proved the copy worked. This caught the
missing `frame-src` that a copy would likely have reproduced correctly.

### Test the guard, not just the happy path

`root + path.sep` containment was verified by creating a real
`~/DownloadsElsewhere` directory and showing that a naive `startsWith`
**allows** it while the separator version rejects it. Asserting the correct
behaviour without demonstrating the incorrect one proves much less.

### Native crashes are invisible to JavaScript

`NOTREACHED`/`SIGTRAP` and `SIGSEGV` in the main process kill it outright.
`try/catch`, `uncaughtException`, `child-process-gone` and
`render-process-gone` all miss them — the last two only fire when a *child*
dies and main survives. Catching a main-process crash needs `crashReporter`
minidumps plus a start/clean-quit breadcrumb log checked on the *next* launch.

### Symbols in a stripped framework's crash report are guesses

`.ips` frames for Electron read as nonsense call sequences (`ares_*`,
`fontations_*`). The faulting *thread* is reliable; the stack is not. Say so
rather than reasoning from it.

## Electron specifics

- **Drag out is `webContents.startDrag` in the main process**, not HTML5 drag
  and drop. `dataTransfer` cannot hand a real file to another macOS app.
  `startDrag` throws without an icon, and must be called while the gesture is
  live — so an async icon lookup has to be warmed ahead of time and read from
  cache, never awaited inside the handler.
- **Drag out and drop in do not conflict.** An outgoing drag calls
  `preventDefault` on `dragstart`, so no HTML5 drag session exists and the
  incoming `dragover`/`drop` handlers are structurally unreachable.
- **`globalShortcut.register` cannot detect conflicts.** It returns `true` for
  combinations macOS itself owns (`Cmd+Space` → Spotlight). It throws on a
  malformed accelerator rather than returning `false`. Handle both, and do not
  claim collision detection in the UI.
- **`fs.watch` on macOS reports almost everything as `'rename'`** — creates,
  writes and deletes alike. The event type is unusable for inferring what
  happened; re-read the directory instead. Every event type *does* fire,
  verified against a real directory.
- **`shell.openPath` resolves with an error *string*** rather than rejecting.
  `try/catch` alone silently swallows failures.
- **The macOS file clipboard is `NSFilenamesPboardType`** via
  `clipboard.writeBuffer`/`readBuffer`, payload an XML plist array of POSIX
  paths. macOS bridges it to the modern `«class furl»` in both directions.
  XML-escape the paths — a filename containing `&` breaks it otherwise.
- **`transparent: true` windows need `background: transparent`** on
  `html, body`, and the choice is fixed at construction.
- **A `Tray` cannot have both `setContextMenu` and a working `click` handler.**
  Pop the menu manually on `right-click`.
- **`acceptFirstMouse: true`** is required for a window shown with
  `showInactive()`, or macOS eats the first click to activate it.

## macOS / tooling

- **`sips` rasterises SVG**; `qlmanage -t` bakes an opaque grey background and
  is useless for template icons. Neither needs a third-party dependency.
- **Double hyphens are illegal in XML comments.** Writing `--custom-property`
  in an SVG comment makes the whole file unparseable.
- **Automating Finder via AppleScript hangs headlessly** on the Automation
  permission prompt. `osascript … as alias` writes a legacy `alias` record
  Electron cannot see; `POSIX file` without `as alias` writes a real `furl`.
- **`electron-packager` warns about a missing `.icon`** on macOS 26. That is
  the new icon *bundle* format, not `.icns`. Verify by hashing the icon inside
  the built app rather than trusting the warning.
