# HANDOFF

Most recent session first. Architecture and standing decisions live in
[`context_v7.md`](context_v7.md) — this file is the session log, not the
design doc.

---

## 2026-08-14 (evening) — the panel bug, solved

### What happened

Both blockers left open by the previous session were resolved. Neither was
what it looked like.

**The panel bug was a window level mistake, not instability.** The panel was
created with `setAlwaysOnTop(true, 'floating')`. `'floating'` is
`NSFloatingWindowLevel` (3), and a macOS fullscreen app stacks above it. So
`setVisibleOnAllWorkspaces` put the panel on the fullscreen Space and the
level then rendered it *underneath* Chrome. Every API said the window was
visible, because it was — just covered.

It also only ever applied those settings at creation, and macOS drops them
across sleep/wake, display changes and fullscreen transitions. That is what
made it look like a long-running instance degrading over hours.

Fixed in `e5a729e`: everything moved into `applyPanelLevel()` at
`'screen-saver'` level, re-applied on every show, on `powerMonitor`
`'resume'`, and on `display-metrics-changed`, plus `moveTop()` on show. The
preview window and Preferences were raised to the same level, and
Preferences gained the `setVisibleOnAllWorkspaces` call it never had.

**The SIGSEGV was downgraded, not fixed.** The Crashpad database is empty,
every recorded termination is a `clean-quit`, and the
`reason=killed exitCode=15` lines are SIGTERM during orderly shutdown, not
crashes. No recurrence since logging began. See BUGS.md for the caveat that
the log does not cover the original three occurrences.

### How it was found

One `screencapture -x` while the heartbeat reported `panel=ok/visible`
showed no panel anywhere on screen. That contradiction eliminated every
window-state hypothesis at once. The same screenshot showed no menu bar,
which meant a fullscreen app was frontmost and supplied the mechanism.

The previous session's instrumented investigation was thorough and every
finding in it was correct. It missed this because every probe asked the
window about itself — bounds, opacity, minimized, DOM, CSP, renderer health
— and none looked at what was in front of it. This is now hard constraint 4
in `context_v7.md`.

### Decisions made

- **`'screen-saver'` for all three windows**, not just the panel. Raising
  only the panel would have put it above Preferences, reintroducing the
  exact problem Preferences' original `alwaysOnTop` call was added to
  prevent
- **Fix the cause, not the symptom.** `togglePanel` trusting `isVisible()`
  meant every hotkey press hid an already-covered panel, which is why it
  felt intermittent. Left alone deliberately — once the level holds,
  `isVisible()` is trustworthy again, and a workaround on top would have
  hidden any regression
- **`moveTop()` is safe here.** It reorders without activating, so the
  no-focus-stealing rule in constraint 2 survives
- **SIGSEGV downgraded rather than closed.** The log postdates the original
  crashes, so "no recurrence" is the honest claim

### Blockers

None.

### Next priorities

1. Confirm the sleep/wake half of the fix. It is reasoned from the heartbeat
   gaps, not observed. After a real wake, `crash.log` should contain
   `resume: re-applied panel level and workspace visibility`
2. Route hotkey registration success/failure through `logEvent`. It is
   `console.log`/`console.error` only, so in a packaged app launched from
   the Dock a genuine registration failure is invisible
3. Build `CODEMAP.md`. Still never done

### Not done

- No automated tests, still. The window level fix ships without one, which
  is a real gap — a window level is not unit testable without a harness this
  repo does not have
- No lint. There is no eslint config and no `lint` script in `package.json`
- Code signing and notarisation. Still unsigned

### Corrections to the record

- An early claim this session that `/Applications` held a stale build was
  **wrong** and was retracted. Build timestamps showed the `.app` was
  packaged 32 seconds after the last `main.js` edit, matching `HEAD`
- The Cmd+Shift+D collision with Chrome's bookmark-all-tabs was long
  suspected of causing the panel bug. It did not. The collision is real but
  unrelated

---

## 2026-08-13 → 2026-08-14 — empty folder to packaged app

### What happened

The project went from `git init` to a packaged, installed `.app` in one
session, including a full stack change part-way through.

**Stack change.** Started as Swift/SwiftUI with an XcodeGen project. Abandoned
after discovering full Xcode is not installed on this machine and is not going
to be — `xcodebuild` cannot build an `.xcodeproj` with Command Line Tools
alone, so that project was never verifiable. Rebuilt as Electron, reusing the
architecture and styling of the author's existing `floating-todo` app. Recorded
in `f297a53`, with `context_v1.md` kept as the record of the dead end.

**Everything built, in order:** scaffold (tray, frameless floating panel,
hotkey) → file listing → drag out → column view → Desktop as a second root →
open/context menu/preview → preview moved to its own window → live watching →
drop in, copy, paste → `Cmd+Delete` → Preferences with a configurable hotkey →
tags, notes, pins → user-selectable tag colours → packaging → folder preview
and name tooltip → crash logging.

### Decisions made

- **Two visual states for selection.** `.selected` (active, accent bar) and
  `.path` (parent folder that opened the next column, quieter). The spec asked
  for both "selection stays visible in each column" and "selection does not
  span columns", which one state cannot satisfy.
- **Last column grows, parents stay 240px.** Fixed-width parents were
  deliberate so they do not jump during navigation; only the rightmost column
  absorbs slack.
- **Preview is a separate window, not an overlay.** The in-panel version was
  built first and rejected: it replaced the file list and could never be
  larger than the panel.
- **Window coupling is one-directional.** Hiding the panel hides the preview;
  nothing else propagates. Deliberately not the reference app's mutual
  coupling.
- **Repo made public** on purpose.
- **Custom tooltip over native `title`** for truncated names — a light system
  tooltip over the dark HUD looks foreign, and `title` fired on every row
  regardless of truncation.

### Blockers

> **Both resolved on 2026-08-14 (evening) — see the entry above.** Blocker 1
> was a window level mistake, not instability. Blocker 2 shows no recurrence
> and has been downgraded. Kept as written for the record.

1. **OPEN, actively blocking: the panel will not appear.** Hotkey and the
   Toggle Panel menu item both do nothing. Tray and Preferences work, so the
   main process is alive. Diagnosed but not fixed — see `BUGS.md`.
2. **OPEN: an unexplained `SIGSEGV`** in the main process, three occurrences,
   two of them the packaged app. Crash logging is now in place to catch a
   recurrence. See `BUGS.md`.

### Next priorities

1. Fix the panel-not-appearing bug. One instrumented run separates the three
   remaining hypotheses; the instrumentation was proposed and not yet added
   because the session was diagnostic-only at that point.
2. Watch `crash.log` for an abrupt-end line after any `SIGSEGV` recurrence.
3. Rebuild and reinstall after the fix — `/Applications` tracks `d5be862`.

### Not done

- No automated tests exist. Everything is verified by hand.
- `CODEMAP.md` was never built for this repo.
- Code signing and notarisation. The app is unsigned.
