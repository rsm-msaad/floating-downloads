# CHANGELOG

Most recent first.

---

## 2026-08-14 (evening) — panel visibility bug solved

### What changed

- **Panel window level fixed** (`e5a729e`). The panel used
  `setAlwaysOnTop(true, 'floating')`, which a macOS fullscreen app stacks
  above, so `setVisibleOnAllWorkspaces` put it on the fullscreen Space and
  the level then rendered it underneath. Raised the panel, preview and
  Preferences to `'screen-saver'`, and gave Preferences the
  `setVisibleOnAllWorkspaces` call it never had.
- **Level and Space membership now re-asserted, not set once.** Moved into
  `applyPanelLevel()` and called from `createWindow()`, `showPanel()`,
  `powerMonitor` `'resume'` and `screen` `'display-metrics-changed'`, since
  macOS drops both across sleep, display changes and fullscreen
  transitions. `showPanel()` also calls `moveTop()`, which reorders without
  activating.
- **`context_v7.md` added** (`ea486e9`). New source of truth, superseding
  v6. Records the resolution, adds hard constraint 4 (`isVisible()` true is
  not a claim the user can see the window), and downgrades the SIGSEGV.
- **README repointed at v7** (`b644d18`). Its source-of-truth links still
  referenced v5, two versions behind.
- **BUGS.md, HANDOFF.md and CHANGELOG.md brought in line.** All three still
  described the panel bug as open and undiagnosed.

### PRs merged

None. Committed directly to `main`, per the project's existing convention.

### Known issues

- The sleep/wake half of the fix is **unverified**. It is reasoned from the
  heartbeat gaps in `crash.log`, not observed. After a real wake the log
  should contain `resume: re-applied panel level and workspace visibility`
- The SIGSEGV is downgraded, not closed. Crashpad is empty and every
  recorded termination is a clean quit, but `crash.log` only begins
  `2026-08-14T04:11Z` and does not cover the original three occurrences
- Hotkey registration success/failure is written to the console only, so in
  a packaged app a genuine registration failure is invisible
- Still no automated tests and no lint config. This fix shipped without a
  test

### Next priorities

1. Confirm the sleep/wake fix after a real wake
2. Route hotkey registration through `logEvent`
3. Build `CODEMAP.md`

---

## 2026-08-13 → 2026-08-14 — empty folder to packaged app

### What changed

- **Stack changed from Swift/AppKit to Electron** (`f297a53`). Full Xcode is
  not installed and is not going to be, so `xcodebuild` could never build the
  `.xcodeproj` and that project was never verifiable. Rebuilt on Electron,
  reusing the architecture and styling of the author's `floating-todo`.
- **Scaffold** (`6c446db`): tray, frameless transparent floating panel at the
  `floating` level, global hotkey, custom template tray icon with committed
  sources.
- **File listing and column navigation** (`f389878`, `54f0ce9`): `~/Downloads`
  newest-first, middle truncation preserving extensions, relative dates,
  Finder-style columns with a fixed 240px parent width.
- **Drag out** (`f389878`) via `webContents.startDrag`, multi-select, from any
  column.
- **Desktop as a second root** (`f4baacd`), with the security boundary
  generalised from one root to an allow-list.
- **Open, context menu, preview** (`b871e8f`), then the preview **moved into
  its own floating window** (`cd24e42`) after the in-panel overlay was
  rejected.
- **Live folder watching** (`791175a`): debounced 300ms, `.crdownload`/`.part`
  ignored, per-column updates preserving scroll and selection.
- **Drop in, copy, paste** (`f31c49e`): always a copy, Finder-style numeric
  suffixes, `NSFilenamesPboardType` for real file copy/paste.
- **`Cmd+Delete` to Trash** (`f0022e5`), sharing one implementation with the
  context menu item.
- **Preferences window and configurable hotkey** (`473a955`).
- **Tags, notes and pins** (`a04526b`), then **user-selectable tag colours**
  (`2670a11`).
- **Packaged as a `.app`** (`be77bbb`): full-colour app icon built from the
  tray glyph via `iconutil`, `extend-info.plist` with `LSUIElement`, build
  script into gitignored `dist/`. **232 MB**, installed to `/Applications`.
- **Folder preview and name tooltip** (`0218aa4`).
- **Crash logging** (`d5be862`): `crashReporter` minidumps, a start/clean-quit
  breadcrumb log, and renderer/child crash handlers.

### Docs

`context_v1.md` … `context_v5.md` record the project's evolution; v5 is the
source of truth. README rewritten to point at it. This session added
`HANDOFF.md`, `BUGS.md`, `FINDINGS.md`, `TESTING.md` and this file.

### Known issues

- **The panel will not appear** via hotkey or menu item. Diagnosed, not fixed.
  Bounds are valid and on-screen; the app does not believe it is visible. See
  `BUGS.md`.
- **Unexplained `SIGSEGV`** in the main process, three occurrences, two in the
  packaged app. Not reproduced since. Crash logging now in place.
- The off-screen clamp runs only in `createWindow()`, never on show.
- No automated tests.

### Next priorities

1. Fix the panel-not-appearing bug — one instrumented run distinguishes the
   three remaining hypotheses.
2. Rebuild and reinstall; `/Applications` currently tracks `d5be862`.
3. Watch `crash.log` for an abrupt-end line if the `SIGSEGV` recurs.
