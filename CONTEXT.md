# CONTEXT — FloatingDownloads

updated-at: a305e6e

The living snapshot: how this project works **now**. HANDOFF.md is the diary of
what happened when; `context_v1..v7.md` are the frozen architecture history.
This file is regenerated in full each time, never patched, so nothing stale
sits next to anything fresh.

---

## What this is and why it exists

A macOS menu bar utility. One global keyboard shortcut (`⌘⇧D`) toggles a
floating panel showing `~/Downloads` and `~/Desktop`. Files drag straight out
of it into whatever app is in front.

**The author's actual reason for building it**, stated directly: *"to be able
to quickly access my downloads when I'm on a full screen without distracting
myself."* That sentence is the acceptance test. A build that does not appear
over a fullscreen app has failed at its only job, regardless of what else
works. Everything in the "fullscreen visibility" section below exists because
this requirement was not met for two days.

## Current status, honestly stated

Feature complete, packaged, installed at `/Applications/FloatingDownloads.app`.

**One open bug, actively being worked: the panel does not reliably appear over
a fullscreen app.** A fix is installed but **NOT yet verified** — see below.

No other known bugs. No feature work outstanding.

## Where things live

- Repo: `github.com/rsm-msaad/floating-downloads` — **PUBLIC, deliberately**
- Local: `~/Desktop/Test 1/personal_projects/floating_downloads`
  - **Moved 2026-08-15.** Was `~/Desktop/Test 1/floating_downloads`. Anything
    referencing the old path is stale
- Installed: `/Applications/FloatingDownloads.app`
- Runtime data: `~/Library/Application Support/floating-downloads/`
  (`settings.json`, `metadata.json`, `window-state.json`, `crash.log`,
  `Crashpad/`)

### The reference app, and why it matters more than usual

`~/Desktop/Test 1/personal_projects/todo_app/floating-todo`, packaged as
**Checklist** (`dist/Checklist-darwin-arm64/Checklist.app`). Same author, same
Electron floating-panel architecture, styling copied from it.

It is not just provenance. **It is the working control.** It floats over
fullscreen apps correctly and always has. When this app misbehaves, run both
side by side and diff the live window state — that is what finally solved the
fullscreen bug after two wrong diagnoses.

Note the author calls it "the checklist app". Same thing as floating-todo.

## THE FULLSCREEN BUG — read this before touching window code

This consumed most of 2026-08-14 and 2026-08-15 and produced three wrong
answers before the right one. The wrong turns are recorded because each one
looked well-evidenced at the time.

### The symptom
Press `⌘⇧D` while a fullscreen app (Chrome, VS Code) is frontmost. Nothing
appears. Intermittent — sometimes it works, sometimes two presses work, often
nothing.

### Wrong diagnosis 1: "the window level is too low"
Believed `setAlwaysOnTop(true, 'floating')` (NSFloatingWindowLevel, 3) was
outranked by fullscreen apps. Raised to `'screen-saver'` (1000).

**Disproved by** a `CGWindowListCopyWindowInfo` dump: the panel sat at layer
1000 while the fullscreen VS Code window it was supposedly hidden behind sat
at layer **0**. Stacking was never the problem. Raising the level fixed
nothing and plausibly made Space-joining less reliable. **Reverted.**

### Wrong diagnosis 2: "the settings are being reset"
Believed macOS dropped `setAlwaysOnTop` / `setVisibleOnAllWorkspaces` across
sleep and show, so they were moved into `applyPanelLevel()` and re-applied on
show, on `powerMonitor` resume, and on `display-metrics-changed`.

**Disproved by** per-press logging: `allWorkspaces=true alwaysOnTop=true` on
every single show and every single hide, without exception. Nothing was being
reset. (The re-application was kept anyway — it is idempotent, harmless, and
defensible. It is not the fix.)

### Wrong diagnosis 3: "showInactive() is the problem"
Believed `showInactive()` failed to re-join the fullscreen Space. Changed to
`show()`. Closer to the truth but incomplete on its own.

### The actual cause
Established by running **Checklist and FloatingDownloads side by side** and
measuring both at the same instant:

```
Checklist          layer=3  onscreen=True    ← visibly over fullscreen VS Code
FloatingDownloads  layer=3  onscreen=None    ← identical config, not on screen
```

Identical layer, identical settings, same machine, same second. So the window
configuration was never the variable.

**The difference is how each is summoned.** Checklist has **no global shortcut
at all** — it imports `globalShortcut` and never calls `register`. It is
toggled from `tray.on('click')`. Clicking the menu bar activates the app, so
`show()` lands on the Space the user is looking at.

This app uses a global shortcut. That fires while the app is in the
**background** and another app owns the fullscreen Space. `show()` on a
background app does not activate it, so macOS puts the window on the desktop
Space instead. Every flag reads correct, `isVisible()` is true, the layer is
right — and it is on the wrong desktop.

This also explains why the tray icon appeared broken early on: that build used
`showInactive()`, which explicitly avoids activating. Both routes were broken
for the same reason, which is what made "it's not the hotkey" so misleading.

### The fix, currently installed and UNVERIFIED
```js
app.focus({ steal: true });   // activate first — this is the fix
win.show();                    // not showInactive()
```
in both `showPanel()` paths, with the level back at `'floating'`.

**Status: not confirmed working.** Every attempt to capture proof has been
contaminated — the author toggles the panel off within ~0.4s, faster than the
screenshot watcher polls. A fast-polling watcher is the current approach.

### Cost of the fix, accepted
The panel now takes focus when summoned. This **overrides hard constraint 2**
(never steal focus) and contradicts the README's "summoned without pulling
focus". Accepted because appearing at all is the app's entire purpose, and
because Checklist already makes the same trade and the author is happy with it.

### Rules that follow from this
- **Do not raise the window level above `'floating'`.** It does not help and
  degrades Space-joining. This was tried and reverted
- **Never trust `isVisible()`, `isVisibleOnAllWorkspaces()` or
  `isAlwaysOnTop()` as evidence the user can see the panel.** All three read
  correct throughout a total failure
- **Verify against `CGWindowListCopyWindowInfo` and a `screencapture`**, not
  against Electron's self-report
- **When in doubt, run Checklist beside it and diff.** One works, one does not,
  same machine — that comparison cannot lie

## Diagnostics available

A pyobjc venv for reading macOS's real window list lives in the session
scratchpad (`qvenv`, `pip install pyobjc-framework-Quartz`). Neither `python3`
nor `/usr/bin/python3` has Quartz by default. `osascript` against System Events
is blocked — Terminal lacks assistive access.

`crash.log` currently records:
- `start` / `clean-quit` breadcrumbs, `child-process-gone`,
  `render-process-gone`
- A 5-minute heartbeat: uptime, RSS, panel exists/visible, bounds, watcher
  count, last action
- `toggle: visible=… allWorkspaces=… -> show|hide` — one line per keypress
- `panel-state show|before-hide|first-show …` — what the window server believes
- `resume:` and `display-metrics-changed:` re-application lines

Heartbeat caveat: long gaps with `uptime` still tracking wall clock mean the
Mac slept. The heartbeat therefore **cannot** distinguish "dead" from "asleep".

`display-metrics-changed` fires in ~100ms bursts after a wake; the log line is
coalesced to one entry per burst because an earlier version wrote 58 identical
lines per wake.

## Tech stack

Electron 32.3.3, plain JavaScript, HTML, CSS. `@electron/packager` 18.4.4.
Node via nvm. Main process for OS integration, renderers for UI,
`contextBridge` + IPC via `preload.js`, `contextIsolation` on. No renderer
framework.

## Files

- `main.js` — windows, tray, hotkey, filesystem ops, IPC, path validation,
  metadata, crash logging, heartbeat, `applyPanelLevel`, `logPanelState`
- `preload.js` — contextBridge surface, 40 methods, shared by all windows
- `index.html` / `renderer.js` — panel: tabs, columns, selection, tags, notes,
  pins, tooltip
- `preview.html` / `preview.js` — preview window
- `preferences.html` / `preferences.js` — Preferences window
- `icon.svg`, `app-icon.svg`, `build-icon.py`, `extend-info.plist`
- `context_v1..v7.md` — frozen architecture history
- `CONTEXT.md` (this), `HANDOFF.md`, `BUGS.md`, `FINDINGS.md`, `TESTING.md`,
  `CHANGELOG.md`, `README.md`

**`CODEMAP.md` has never been built.** Long-standing loose end.

## Standing decisions

### Windows
- Panel: frameless, transparent, `backdrop-filter` blur, `'floating'` level,
  `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`,
  `fullscreenable: false`, `skipTaskbar: true`, `show: false` at construction,
  `acceptFirstMouse: true`
- Preview: separate BrowserWindow, reused not recreated, lazily created on
  first Space press, sized to 60% of the workArea of the display the panel is
  on, recentred every show, position deliberately not persisted (matches Quick
  Look)
- Preferences: takes focus **on purpose** (it has a text input). Must sit at
  the same level as the panel or the panel covers it
- **Window coupling is one-directional.** Hiding the panel hides the preview.
  Nothing else propagates. The reference app's mutual coupling was identified
  as a problem and deliberately not reproduced. Easy to reintroduce by
  accident — preserve it
- `ensureOnScreen()` clamps to workArea on every show, so the panel can never
  cover the menu bar or Dock

### Interaction
- Columns fixed 240px except the last, which grows. Parents stay stable so they
  do not jump during navigation. This is why the truncation tooltip exists
- Only a plain click on a folder drills in; Cmd/Shift multi-select does not
- Any click in a column discards columns to its right, files included
- Selection: `.selected` (active, accent bar, drag source) vs `.path` (parent
  that opened the next column, quieter). Never spans columns
- Escape priority: close preview → close rightmost column → clear selection.
  Backspace closes the rightmost column only
- `Cmd+Delete` trashes with no confirmation, matching Finder

### Data
- Metadata keyed by absolute path, JSON in app support. Tag colours in a
  separate map keyed by tag **name**, so a colour survives with no files
  carrying the tag
- **Orphaned metadata is dropped immediately** when a file disappears.
  Deliberate. Consequence: renaming or moving a file loses its tags and note.
  **Do not add path-following without asking**
- All writes are write-temp-then-rename with real `console.error` on failure.
  Never the reference app's silent-catch `writeFileSync`

### Security boundary — do not weaken
Every path is validated in the main process against an allow-list of roots
(`~/Downloads`, `~/Desktop`) before **any** operation, symlinks resolved first.
Covers reads, Reveal, Copy Path, Trash, preview reads, drag out, paste and
drop-in destinations. For drop-in and paste the **source** may be outside the
roots — it is the **destination** that must be validated. Adding a third root
is a one-line change.

### Drag out and drop in
Drag out is `webContents.startDrag` in the main process, not HTML5 DnD —
`dataTransfer` cannot hand a file to another macOS app. `startDrag` throws
without an icon, and must be called while the gesture is live, so the icon is
warmed ahead of time and read from cache. Drop in uses HTML5
`dragover`/`drop`. They cannot conflict: an outgoing drag calls
`preventDefault` on `dragstart`, so no HTML5 session exists.

No row or column may sit inside a `-webkit-app-region: drag` zone.

## Known gotchas

- `app.getFileIcon` with `size:'large'` crashes Electron 32.3.3 natively.
  Pinned to `'normal'`, guarded only by a comment, no test
- `globalShortcut.register` cannot detect real conflicts — returns `true` for
  combinations macOS owns. No API to query the real owner. Preferences says so
  plainly rather than pretending
- Hotkey registration success/failure goes to `console.log`/`console.error`
  only. In a packaged app launched from the Dock there is no console, so a
  genuine failure is **invisible**. Should be routed through `logEvent`
- `⌘⇧D` also triggers Chrome's bookmark-all-tabs when Chrome is frontmost.
  Real, but **was not** the cause of the fullscreen bug despite being suspected
- `~/Downloads` holds ~2440 items. Watching debounces ~300ms and ignores
  `.crdownload` / `.part`
- `fs.watch` on macOS reports almost everything as `'rename'` — re-read the
  directory rather than trusting the event type
- `npm audit` reports 3 high-severity issues, all in the packager devDependency
  tree, never shipped. **Do not run `npm audit fix --force`**
- The author's gh token has no `workflow` scope, so CI under
  `.github/workflows/` is rejected until `gh auth refresh -s workflow`
- Packaging warns `Could not find icon "./icon.icns" with extension ".icon"` —
  harmless, macOS 26's new icon bundle format
- **Rebuild and reinstall after every code change**, quitting the running
  instance first. The installed app went stale by four commits once

## Conventions

- Conventional commits (`fix:`, `docs:`, `feat:`), small and frequent, one
  logical unit each. Committed directly to `main`, no PRs
- **Never** add Claude attribution or `Co-Authored-By` to commits
- `secret.md` and `*.env` are gitignored. The repo is public — check before
  pushing. `context_v6.md` enumerated the gh token's scopes; trimmed in v7
- No automated tests exist anywhere in this repo, and no lint config or `lint`
  script. Every fix ships unverified by machine. This is a real, known gap
- Docs are appended, not regenerated — **except this file**, which is always
  rewritten whole

## About the author

MSBA student. Prefers plain English over jargon and says so repeatedly —
when an explanation gets technical, restate it plainly without being asked.
Wants numbered multiple-choice options, not open questions. Wants to be told
directly when something is wrong or unverified rather than reassured.

Types with occasional typos (broken screen); read charitably. Gets
understandably frustrated by repeated failed fixes on the same bug — under
those conditions lead with the finding, not the process, and keep it short.

Was right about the thing that solved this bug: comparing against the working
Checklist app was the author's suggestion, after two of my diagnoses failed.

## Open loose ends

1. **Verify the fullscreen fix.** Nothing else matters until this is confirmed
2. **The preview window still uses `showInactive()`** (`main.js`, `target.showInactive()`).
   It almost certainly has the identical bug over fullscreen. Left untouched to
   keep the current test to one variable
3. **`context_v7.md`, `BUGS.md`, `HANDOFF.md` and `FINDINGS.md` all record
   wrong diagnosis 1 as established fact.** They are actively misleading and
   must be corrected once the real fix is confirmed
4. Route hotkey registration through `logEvent`
5. Build `CODEMAP.md`
6. The SIGSEGV — no recurrence since logging began, Crashpad empty, every
   termination a clean quit. But `crash.log` starts `2026-08-14T04:11Z` and
   does not cover the original three. Watch item, not an open bug
7. Never decided: auto-hide on focus loss; hidden-file filtering; roots beyond
   Downloads and Desktop; fixed vs remembered panel placement
8. Unsigned and un-notarised. Fine personally, matters for distribution
