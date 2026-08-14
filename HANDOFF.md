# HANDOFF

Most recent session first. Architecture and standing decisions live in
[`context_v5.md`](context_v5.md) — this file is the session log, not the
design doc.

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
