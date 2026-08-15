# Floating Downloads Panel, context_v7

Supersedes v6, v5, v4, v3, v2, v1. All stay on disk as history. v1 records
the Swift dead end, v2 the Electron pivot, v3 the state through column view,
v4 the preview window, v5 feature completion and packaging, v6 the state
while the panel instability was still open.

Treat v7 as the source of truth.

Written as a handoff document. Anyone picking this project up cold should be
able to work from this file alone. See also HANDOFF.md, BUGS.md,
FINDINGS.md, TESTING.md, and CHANGELOG.md, which cover the session log side.
This file is the architecture source of truth; those cover what happened
when.

## Status

FEATURE COMPLETE, packaged, installed, in daily use.

The long-running instability that v6 carried as its one open issue is
RESOLVED. Root cause found, fixed, and confirmed by the author. See the next
section, which replaces v6's "THE OPEN ISSUE".

No feature work outstanding. No known open bugs. Two watch items, both
listed under Open items, neither blocking.

## Project
A macOS menu bar utility. A global keyboard shortcut toggles a floating,
always on top panel showing the contents of ~/Downloads and ~/Desktop.
Files drag straight out of the panel into whatever app is in focus. Same
shortcut hides it.

## Repo
github.com/rsm-msaad/floating-downloads. PUBLIC, deliberately.
Local path: ~/Desktop/Test 1/floating_downloads
Installed at /Applications/FloatingDownloads.app

## Reference implementation, note for a new contributor
~/Desktop/Test 1/todo_app/floating-todo (github.com/rsm-msaad/floating-todo)
An existing Electron always on top floating todo app by the same author.
This project reuses its architecture and styling.

IMPORTANT: that local path exists only on the original author's machine.
Everything needed from it is already copied into this repo. You do not need
the reference app to continue. It is cited so the provenance of those
patterns is clear, and so the "do not copy" list makes sense.

## THE RESOLVED ISSUE: the panel that stopped appearing

This replaces v6's open issue. Read it before touching window setup. The
conclusion is short but the reasoning matters, because the wrong diagnosis
survived two sessions.

### The symptom
A packaged instance that had been running a while stopped showing the panel.
Hotkey did nothing. Tray icon still worked, tray menu opened, Preferences
opened. Only the panel would not appear. A fresh instance was fine, so it
looked like a long-running instance degrading over time.

### The actual cause
Two bugs stacked, with a third consequence on top.

1. The wrong window level. createWindow() called

     win.setAlwaysOnTop(true, 'floating')

   'floating' is NSFloatingWindowLevel, level 3. A macOS fullscreen app
   stacks ABOVE that level. setVisibleOnAllWorkspaces with
   visibleOnFullScreen correctly put the panel on the fullscreen app's
   Space, and then the level rendered it underneath the fullscreen window.

   The two calls do different jobs and both are required.
   setVisibleOnAllWorkspaces decides WHICH Space the window is on. The level
   decides what it stacks above once it is there. Getting the first right
   and the second wrong produces a window that is genuinely present,
   genuinely visible by every API measure, and completely invisible to the
   user.

2. The settings were applied once, at creation, and never again. macOS
   quietly drops both across sleep/wake, display reconfiguration, and
   fullscreen transitions. This is what made the bug look time-dependent:
   the panel worked after launch and stopped working later in the session,
   which reads as "a long-running instance degraded" when it is really "the
   machine slept and the window server reset the level".

3. As a consequence, the hotkey then did the opposite of what was wanted.
   togglePanel branches on win.isVisible(). While the panel was covered but
   still reporting visible, every press called hidePanel(). The panel was
   already unseeable, so nothing appeared to happen, and the next press
   showed it again. Pressing twice was the workaround. This should be moot
   now that the level holds, but the reasoning is recorded because it
   explains the intermittent, every-other-press character of the symptom.

### Why the v6 diagnostic missed it
The v6 investigation was thorough and every finding in it was correct. It
checked that win was not null or destroyed, that togglePanel branched the
right way, that bounds were inside the work area, that opacity was 1 and the
window was not minimized, that the renderer loaded with no failures, that
the DOM was fully populated, and that CSP raised no violations.

Every one of those questions is about the window's OWN state. Not one of
them asks what is stacked above the window. A window can be healthy,
positioned correctly, fully painted, and simply covered by something else.
isVisible() cannot see that, and neither could any of the instrumentation.

The fresh-instance test could not reproduce it for the same reason plus one
more: a fresh instance has not slept yet, so its level is still intact.

Lesson worth keeping: when a window is reported healthy but is not on
screen, the next question is not "what is wrong with the window" but "what
is in front of it". Verify against the screen, not against the window's
description of itself.

### What actually settled it
Three pieces of evidence, in order of decisiveness:

- A framebuffer screenshot (screencapture -x) taken while the heartbeat
  reported panel=ok/visible showed no panel anywhere on screen. That is the
  contradiction that killed every window-state hypothesis at once
- The heartbeat series showed panel=ok/visible for four and a half
  continuous hours, which no one was actually looking at a panel for
- The screenshot showed no menu bar, meaning a fullscreen app was frontmost,
  which supplied the missing mechanism

### The fix
All level and Space configuration for the panel now lives in one function:

  function applyPanelLevel() {
    if (!win || win.isDestroyed()) return;
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }

'screen-saver' is the level that actually clears a fullscreen app. Both
calls are idempotent, so re-applying costs nothing.

It is called at four points, and all four matter:
- createWindow(), as before
- showPanel(), on every single show, rather than trusting what creation set
- powerMonitor 'resume', because sleep is the main way the settings are lost
- screen 'display-metrics-changed', because plugging or unplugging a monitor
  reconfigures the window server and can drop them too

showPanel() also calls win.moveTop() after showInactive(), to raise above
other windows already at the same level. moveTop() reorders only, it does
not activate the app, so the no-focus-stealing rule in constraint 2 still
holds.

The resume and display-change handlers write a line to crash.log when they
fire, so a recurrence is visible in the log rather than guessed at.

The preview window and Preferences were raised to 'screen-saver' as well.
Preferences additionally gained the setVisibleOnAllWorkspaces call it never
had, without which it opens on the desktop Space when summoned from the tray
while a fullscreen app is frontmost.

Committed as e5a729e.

### Verification status, stated honestly
- The fullscreen case is CONFIRMED. The author tested it directly: fullscreen
  Chrome, repeated hotkey presses, every press shows or hides
- The sleep/wake case is NOT yet observed. It is reasoned from the heartbeat
  gaps in crash.log and from the settings being applied only once. It is the
  right fix for the evidence but it has not been watched surviving a real
  sleep cycle. After the next wake, crash.log should contain
  "resume: re-applied panel level and workspace visibility"

## The SIGSEGV, downgraded

v6 treated three SIGSEGV occurrences as part of one underlying stability
problem alongside the panel bug. With the panel bug explained as a window
level issue, that link no longer holds, and the crash evidence does not
support an active crash problem:

- The Crashpad database is empty. No .dmp files in pending, completed, or
  new. A SIGSEGV would deposit one
- Every termination recorded in crash.log is a clean-quit
- The child-process-gone lines with reason=killed exitCode=15 are NOT
  crashes. 15 is SIGTERM, which is Electron tearing down its GPU, network,
  and renderer helpers during an orderly shutdown. They appear immediately
  before each clean-quit, which is the signature of a normal exit

Caveat, so this is not overstated: crash.log only begins at 2026-08-14
04:11Z. The original three occurrences predate the log. This is evidence of
no recurrence, not evidence they never happened. Keep the crash logging
armed and treat it as a watch item rather than an open bug.

## Hard constraints

1. macOS provides no public API for one app to raise another app's window to
   a floating level. This is why we do not pin a real Finder window. Any
   idea starting with "just float the Finder window" is a dead end. It
   killed the original Swift plan's premise.

2. Electron has no equivalent of NSPanel's nonactivatingPanel style mask.
   focusable: false exists but disables keyboard input entirely.

   Resolution: showInactive(), never show() plus focus(). Applies to the
   panel and preview window. Preferences is the deliberate exception, it
   takes focus because it has a text input.

   Updated in v7: Preferences is alwaysOnTop at the 'screen-saver' level,
   not 'floating'. It has to match the panel's level or the panel covers it,
   which is the same failure its original alwaysOnTop call was added to
   prevent. It also needs setVisibleOnAllWorkspaces for the fullscreen case.

   moveTop() is safe here. It reorders without activating, so it does not
   violate this constraint.

   Correction to v1: drag out does NOT require a non-activating window.
   macOS delivers the drop regardless of which app is frontmost. Confirmed
   empirically.

3. globalShortcut.register does not reliably detect conflicts. Registering
   CommandOrControl+Space returns true even though Spotlight owns it. macOS
   hands a shortcut to whichever app is frontmost at press time, so
   successful registration says nothing about whether it will fire. There is
   no API to query the real owner. The Preferences hint text says so plainly
   rather than pretending collision detection works.

4. New in v7. A window reporting isVisible() true is not a claim that the
   user can see it. It says the window is not hidden. It says nothing about
   Space membership or what is stacked above. Any future diagnosis that
   rests on isVisible() has to be corroborated against the screen itself.

## Tech stack
- Electron 32.3.3, JavaScript, HTML, CSS
- @electron/packager 18.4.4
- Node.js via nvm
- Main process for OS integration, renderers for UI
- contextBridge + IPC via preload.js, contextIsolation on
- No renderer framework

## Files
- main.js: windows, tray, hotkey, filesystem operations, IPC, path
  validation, metadata, crash logging, heartbeat, applyPanelLevel
- preload.js: contextBridge surface, shared by all windows, 40 methods
- index.html / renderer.js: panel, tabs, columns, selection, tags, notes,
  pins, tooltip
- preview.html / preview.js: preview window
- preferences.html / preferences.js: Preferences window
- icon.svg / build-icon.py: tray icon sources
- app-icon.svg: app icon source, builds icon.icns via iconutil
- extend-info.plist: LSUIElement and bundle metadata
- context_v1..v7.md: architecture history, v7 current
- HANDOFF.md, BUGS.md, FINDINGS.md, TESTING.md, CHANGELOG.md: session log
  side, added late in the project

## Built and verified

- Floating panel: frameless, transparent, CSS backdrop-filter blur, always
  on top, visible on all workspaces INCLUDING fullscreen. As of v7 that last
  clause is actually true rather than merely intended
- Tray icon: downward arrow into an open tray, template form. Left click
  toggles the panel, right click opens the menu
- Global hotkey, default CommandOrControl+Shift+D, configurable
- Preferences window with a shortcut recorder and reset to default
- Two roots, DOWNLOADS and DESKTOP, as header tabs. Last active persists
- Column view navigation, Finder style
- File listing: name, date, newest first, folder icons, middle truncation,
  relative dates, dotfiles and .DS_Store skipped
- Custom tooltip on hover showing the full name, only when truncated
- Selection: click, Cmd-click, Shift-click
- Drag files OUT, multi-select. Verified from the packaged build
- Drop files IN from any app. Always copy, never move
- Cmd+C copies actual files (works in Finder), Cmd+V pastes
- Double click to open, right click context menu
- Cmd+Delete moves to Trash, no confirmation, matching Finder
- Preview in a separate floating window, opened with Space. Files and
  folders both. Folder preview shows a summary card with recursive size
  computed asynchronously and capped against pathological cases
- Live folder watching
- Tags (freeform, multiple per file, pill labels, suggestions), notes
  (popover), pins (sort to top)
- Tag colors: derived from the name by default, overridable per tag name
  from a fixed palette, resettable to automatic
- Packaged .app in /Applications, in the Dock

## Key implementation details

### Window level and Space membership
See the resolved issue section above for the full reasoning. The short
version, for anyone editing window setup:

- Never set the panel's level to anything below 'screen-saver'. 'floating'
  loses to fullscreen apps
- Never configure level or Space membership only at creation. macOS drops
  both, so they have to be re-asserted on show, on resume, and on display
  change
- Keep it in applyPanelLevel(). Do not inline the two calls at new call
  sites, or the next person will fix one and miss the others
- The preview window and Preferences must stay at the same level as the
  panel or the panel covers them

### Selection versus path highlighting
Two states, mirroring Finder. `.selected` is the active selection (accent
bar plus doubled --hover, and the drag source). `.path` is a parent folder
that opened the column to its right (single --hover tint plus --faint bar,
quieter). Only one column ever holds a real selection.

### Column interaction rules
- Only a plain click on a folder drills in. Cmd/Shift multi-select selects
  without opening, since it is ambiguous which folder would open
- Any click in a column discards columns to its right, for files as well as
  folders. Otherwise clicking a file would deselect the parent folder while
  its child column stayed open
- Columns are a fixed 240px EXCEPT the last, which grows to fill. Parent
  columns stay stable so they do not jump around during navigation. This is
  deliberate and matches Finder. It is also why the tooltip exists
- Refresh on panel-show re-reads every open column and truncates the trail
  at the first folder that has disappeared

### The preview window
- A separate BrowserWindow. An in-panel overlay was tried and rejected: it
  replaced the file list and could never exceed the panel size
- Reused, not recreated. Created lazily on first Space
- Sized to 60 percent of the workArea of the display the panel is on, via
  screen.getDisplayMatching. Independent of panel dimensions
- Recenters on every show. Position deliberately NOT persisted, matching
  Quick Look
- Arrows step through the column in place, switching card type between file
  and folder as needed. Arrows work in either window, but only the panel
  knows the column contents, so stepping resolves in the panel and returns
  as a fresh preview:show
- File rendering: images scaled to fit and never upscaled; PDF via Chrome's
  native viewer; text-ish monospace with a 100KB read guard; video and audio
  with native controls; everything else a fallback card
- Large media streams over a custom fdfile:// protocol handler rather than
  base64 over IPC
- At 'screen-saver' level, same as the panel. Within one level the most
  recently shown window wins, and the preview is always opened from the
  panel, so it still lands on top of it

### Window coupling, deliberately one directional
The reference app's two-window visibility coupling was identified as a
problem and not reproduced:
- Opening the preview or Preferences does NOT hide the panel
- Closing either does NOT show the panel
- Hiding the panel DOES hide the preview. The single permitted direction
- Re-summoning the panel does NOT resurrect the preview
- hidePreviewWindow has exactly two callers: hidePanel and the
  preview:close IPC handler. Panel visibility changes only via showPanel /
  hidePanel / togglePanel, and nothing in the preview path calls them
- The preview-closed message back to the panel is a notification only

Easy to accidentally reintroduce the reverse edge. Preserve this.

### Escape priority
1. Preview open, Escape closes it
2. More than one column open, Escape closes the rightmost
3. Otherwise Escape clears the selection

Backspace also closes the rightmost column and does nothing else.

### The security boundary
Every path is validated in the main process against an allow list of roots
(~/Downloads and ~/Desktop) before ANY operation. Symlinks resolved first,
so a symlink inside a root cannot escape. Applies to reads, Reveal in
Finder, Copy Path, Move to Trash, Cmd+Delete, preview reads, drag out,
paste, and drop-in destinations.

For drop-in and paste the SOURCE may be outside the roots, which is
expected. It is the DESTINATION that must be validated.

Structured so adding a third root is a one line change. A real boundary, not
a formality. Do not weaken it.

### Drag out and drop in coexisting
Drag out is webContents.startDrag in the MAIN process, NOT HTML5 drag and
drop. dataTransfer will not deliver a file to another macOS app. startDrag
requires an icon or it throws. Single file drags use app.getFileIcon.

Drop in uses HTML5 dragover / dragleave / drop with a types.includes
('Files') gate. They do not conflict: an outgoing drag calls preventDefault
on dragstart so native startDrag takes over and emits no DOM drag events,
making the incoming handlers structurally unreachable during a drag out.

No row or column sits inside a -webkit-app-region: drag zone. If one did,
dragging the row would move the window instead of starting a drag. In the
preview window the header is the only drag zone, with the close button
explicitly no-drag.

### Metadata
One layer keyed by absolute file path, in a JSON file in the app support
directory. Tag colors live in a separate map keyed by tag NAME, not inside
per-file entries, so a color survives when no file currently carries the
tag.

Orphaned metadata is dropped immediately when a file no longer exists.
AUTHOR'S DECISION, made knowingly. Consequence: renaming or moving a file
permanently loses its tags and note, since metadata is keyed by path. Do not
add path-following or recovery logic without asking.

### Persistence
Window position and size, active tab, and hotkey in
~/Library/Application Support/floating-downloads/settings.json. Metadata in
its own file alongside. crash.log in the same directory.

All writes use write-temp-then-rename with real console.error on failure.
Do NOT use the reference app's non-atomic fs.writeFileSync wrapped in silent
empty catches.

The off-screen clamp (ensureOnScreen) runs on every show, not only in
createWindow(). It previously ran only at creation, which was a real hole
even though it was not the cause of the panel bug. Because it clamps to
workArea, which already excludes the menu bar and Dock, raising the panel to
'screen-saver' cannot let it cover the menu bar.

### Crash logging and the heartbeat
- Crash logging via Electron's child-process-gone and render-process-gone
  events, written to
  ~/Library/Application Support/floating-downloads/crash.log
- A heartbeat on a 5 minute interval (HEARTBEAT_MS, unref'd) logging uptime,
  RSS, whether the window exists and is visible, its bounds, watcher count,
  and last action
- v7 adds resume and display-metrics-changed lines

Reading the heartbeat, learned the hard way:
- panel=ok/visible means the window is not hidden. It does NOT mean the user
  can see it. See constraint 4
- Long gaps in the series with uptime still tracking wall clock mean the Mac
  slept. The timer did not fire; the process did not die. The heartbeat
  therefore cannot distinguish "dead" from "asleep", which limits its value
  as an abrupt-end detector

### CSP
index.html is strict: default-src 'none'; script-src 'self'; style-src
'unsafe-inline'. The panel renders no file content. The widened policy,
including frame-src fdfile: which testing proved necessary for PDFs, lives
only in preview.html.

### Packaging
- npm run build produces the .app via @electron/packager into dist/, which
  is gitignored. The script runs xattr -cr
- LSUIElement is in extend-info.plist AND app.dock.hide() runs at runtime.
  Both are needed
- Install: cp -R "dist/FloatingDownloads-darwin-arm64/FloatingDownloads.app"
  /Applications/ then drag from Applications to the Dock
- The Dock tile is purely a launcher. No running indicator, and clicking it
  while running does nothing visible. The tray icon is the only sign it is
  running
- Packaging emits: WARNING: Could not find icon "./icon.icns" with extension
  ".icon". Harmless. macOS 26 introduced a new .icon bundle format and
  packager checks for it alongside .icns. The icon inside the app was
  hash-verified as byte-identical to icon.icns
- Gatekeeper only bites when the quarantine flag is applied, which happens
  on arrival via browser, AirDrop, or archive, not on a local build. If it
  appears: right click, Open, Open, or re-run xattr -cr
- REMEMBER TO REBUILD after code changes. The installed app went stale by
  four commits once during development. Quit the running instance first, or
  the copy into /Applications races a live process

## Do not copy from the reference app
- Edge tucking. The most fragile subsystem there. Two timing hacks tuned by
  feel (900ms/1200ms untuckCooldown, 220ms tuckMoveTimer debounce) to stop
  the window fighting its own move events, entangled with saveState via a
  preTuckBounds special case
- Tasks, attachments, the detail window
- The two window visibility coupling
- Non-atomic writeFileSync with silent empty catches
- qlmanage for previews. Tried and removed, see gotchas

## Known gotchas

- A window can report itself visible, correctly positioned, opaque, and
  fully painted while being completely invisible to the user because
  something is stacked above it. This cost two sessions. See constraint 4
- qlmanage was removed deliberately. spawn('qlmanage', ['-p', path]) is a
  developer binary, not a supported API. It opened a real Quick Look window
  on another display and stole focus, defeating the point of a floating
  overlay. Do not reintroduce it
- app.getFileIcon with 'large' caused a crash. It is prevented only by a
  code comment, with no test guarding it
- globalShortcut.register cannot detect real conflicts, see constraint 3
- Cmd+Shift+D also triggers Chrome's bookmark-all-tabs when Chrome is
  frontmost. Note for v7: this collision was long suspected of being the
  cause of the panel bug and was NOT. The panel bug was the window level.
  The collision is real but separate, accepted, and changeable in
  Preferences
- The hotkey registration result is written with console.log and
  console.error only. In a packaged app launched from the Dock there is no
  console, so a genuine registration failure is invisible. Worth routing
  through logEvent. Not yet done
- ~/Downloads on the author's machine has roughly 2440 items. Performance at
  that scale is a real constraint. Live watching debounces around 300ms and
  ignores .crdownload and .part entirely, since in-progress downloads would
  otherwise thrash the list
- fs.watch, not fs.watchFile which polls. fs.watch is unreliable for some
  event types on macOS
- Text inputs must guard against Cmd+Delete, Escape, and Space triggering
  the file operations bound to those keys
- npm audit reports 3 high severity vulnerabilities, all in the
  @electron/packager devDependency tree. They never ship in the packaged
  app. Do NOT run npm audit fix --force, it would bump packager across a
  major version
- The author's gh token has no workflow scope, so CI under
  .github/workflows/ is rejected until
  gh auth refresh -h github.com -s workflow. No delete_repo scope either
- xcodegen may still be installed via Homebrew from the abandoned Swift
  attempt. Harmless

## Deviations from the reference made in phase 1, all deliberate
- show: false at construction, then showInactive() on ready-to-show. The
  reference constructs visible, which flashes a focused window at launch
- Dropped maxWidth 640
- minWidth/minHeight 280/200, up from 240/150
- Dropped the --urgent / --soon / --later CSS vars. Everything else in :root
  is byte identical to floating-todo
- Added a CSP meta tag. The reference has none
- loadSettings() writes the settings file if absent

## Open items

Watch items, neither blocking:
- The sleep/wake half of the panel fix is unobserved. Confirm by checking
  crash.log for a "resume: re-applied panel level" line after a real wake
- The SIGSEGV. No recurrence since logging began, Crashpad empty, but the
  log does not cover the original occurrences. Keep crash logging armed

Technical debt:
- No automated tests. Everything verified by hand. Every diagnostic harness
  built during development was discarded. The v7 window level fix ships
  without a test, which is a real gap: a window level is not unit testable
  without a harness that does not exist here
- No lint. There is no eslint config and no lint script in package.json
- CODEMAP.md was never built. Worth doing at the start of a session rather
  than the end
- Hotkey registration failures are invisible in a packaged build, see
  gotchas
- Code signing and notarization. Unsigned, fine for personal use, would
  matter for distribution

Never decided:
- Should the panel auto hide when it loses focus
- Hidden files and type filtering. Currently dotfiles skipped, no filtering
- Roots beyond Downloads and Desktop
- Panel placement is remembered. Fixed or near-cursor were never ruled out

## Workflow conventions
- The chat session is the architecture and design brain. Claude Code in
  VS Code does the execution
- One or two steps at a time, with confirmation between steps
- Prompts are written as specs: behavior, constraints, files involved.
  Implementation is left to Claude Code
- EVERY prompt ends with commit and push. The author wants frequent commits
- Slash commands in use: /bugfix, /review, /handoff
- When something breaks, diagnose before rewriting. Ask what the error
  actually says. This project's hardest bug was solved by diagnosis, and the
  wrong hypothesis (off-screen bounds) would have wasted real time if it had
  been acted on instead of tested
- v7 addition: diagnosis has to be checked against reality, not only against
  the program's self-report. The panel bug survived a thorough instrumented
  investigation because every probe asked the window how it was doing and
  none looked at the screen. One screencapture ended it
- Claude Code should flag judgment calls rather than burying them. This
  caught several real issues: a nearly-reported commit hash that did not
  exist, the globalShortcut conflict-detection finding, a duplicate
  instruction that would have redone completed work, and an incorrect
  "the installed app is stale" claim in this session that was retracted
  once the build timestamps were actually compared
