# FINDINGS

Reusable lessons. Project-specific gotchas live in
[`context_v5.md`](context_v5.md); this file is what generalises.

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
