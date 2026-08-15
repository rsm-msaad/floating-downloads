# Floating Downloads Panel, context_v6

Supersedes v5, v4, v3, v2, v1. All stay on disk as history. v1 records the
Swift dead end, v2 the Electron pivot, v3 the state through column view, v4
the preview window, v5 feature completion and packaging.

Treat v6 as the source of truth.

Written as a handoff document. Anyone picking this project up cold should be
able to work from this file alone. See also HANDOFF.md, BUGS.md,
FINDINGS.md, TESTING.md, and CHANGELOG.md, which cover the session log side.
This file is the architecture source of truth; those cover what happened
when.

## Status

FEATURE COMPLETE, packaged, installed, in daily use.

One open stability issue, under observation with instrumentation armed. No
feature work outstanding.

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

## THE OPEN ISSUE: long-running instability

This is the only thing outstanding. Read this before anything else.

### What happened
A packaged instance that had been running roughly three hours stopped
showing the panel. The tray icon still worked, the tray menu opened,
Preferences opened. Only the panel would not appear, via hotkey or the
Toggle Panel menu item.

### What was ruled out
A full instrumented diagnostic was run on a fresh instance and every layer
came back healthy:
- win was never null, never destroyed
- togglePanel branched correctly: visible then hide, hidden then show
- bounds constant at {888,123,304,421}, insideWorkArea true at every check
- opacity 1, not minimized
- renderer: did-finish-load fired, zero did-fail-load, zero console
  messages, so nothing threw
- DOM fully populated: 2.5MB of markup, 2442 rows, both tabs built, all 40
  preload methods exposed, panel background painted at full opacity, correct
  dimensions
- CSP: zero violations. The panel loads only renderer.js and inline style,
  both covered
- The recent tag colors, folder preview, and tooltip work all ran in the
  code path that produced that complete DOM

The author then confirmed visually that the fresh instance renders fine.

### What this means
Not a positioning bug. Not a rendering bug. Not the off-screen clamp. A
long-running instance degraded while a fresh one is healthy.

Combined with three SIGSEGV occurrences, two of them in the packaged build,
this is being treated as one underlying stability problem rather than two
separate bugs.

### What is armed
- Crash logging via Electron's child-process-gone and render-process-gone
  events, written to
  ~/Library/Application Support/floating-downloads/crash.log
- A heartbeat on a 5 minute interval (HEARTBEAT_MS, unref'd) logging uptime,
  RSS, whether the window exists and is visible, its bounds, watcher count,
  and last action

Sample output, healthy:
  07:20:35  uptime=0m rss=122MB panel=ok/visible bounds={...} watchers=0
  07:25:35  uptime=5m rss=106MB panel=ok/visible bounds={...} watchers=1

### If it recurs
Run this BEFORE quitting the app, since quitting loses the state:
  tail -20 ~/Library/Application\ Support/floating-downloads/crash.log

The heartbeat series should show whether the app was already degraded
before the symptom was noticed. Look for RSS growth, watcher count climbing,
panel state changing, or an abrupt end to the series.

### Suspects, none confirmed
The custom fdfile:// protocol handler, native image work in
app.getFileIcon, startDrag, and fs.watch cleanup. Watcher leaks are a
plausible mechanism given the app watches every open column and re-arms on
every panel show.

## Hard constraints

1. macOS provides no public API for one app to raise another app's window to
   a floating level. This is why we do not pin a real Finder window. Any
   idea starting with "just float the Finder window" is a dead end. It
   killed the original Swift plan's premise.

2. Electron has no equivalent of NSPanel's nonactivatingPanel style mask.
   focusable: false exists but disables keyboard input entirely.

   Resolution: showInactive(), never show() plus focus(). Applies to the
   panel and preview window. Preferences is the deliberate exception, it
   takes focus because it has a text input. Preferences is also alwaysOnTop
   at the floating level, otherwise it opens behind the panel and looks like
   the menu item did nothing.

   Correction to v1: drag out does NOT require a non-activating window.
   macOS delivers the drop regardless of which app is frontmost. Confirmed
   empirically.

3. globalShortcut.register does not reliably detect conflicts. Registering
   CommandOrControl+Space returns true even though Spotlight owns it. macOS
   hands a shortcut to whichever app is frontmost at press time, so
   successful registration says nothing about whether it will fire. There is
   no API to query the real owner. The Preferences hint text says so plainly
   rather than pretending collision detection works. Same phenomenon as the
   Chrome Cmd+Shift+D collision.

## Tech stack
- Electron 32.3.3, JavaScript, HTML, CSS
- @electron/packager 18.4.4
- Node.js via nvm
- Main process for OS integration, renderers for UI
- contextBridge + IPC via preload.js, contextIsolation on
- No renderer framework

## Files
- main.js: windows, tray, hotkey, filesystem operations, IPC, path
  validation, metadata, crash logging, heartbeat
- preload.js: contextBridge surface, shared by all windows, 40 methods
- index.html / renderer.js: panel, tabs, columns, selection, tags, notes,
  pins, tooltip
- preview.html / preview.js: preview window
- preferences.html / preferences.js: Preferences window
- icon.svg / build-icon.py: tray icon sources
- app-icon.svg: app icon source, builds icon.icns via iconutil
- extend-info.plist: LSUIElement and bundle metadata
- context_v1..v6.md: architecture history, v6 current
- HANDOFF.md, BUGS.md, FINDINGS.md, TESTING.md, CHANGELOG.md: session log
  side, added late in the project

## Built and verified

- Floating panel: frameless, transparent, CSS backdrop-filter blur, always
  on top, visible on all workspaces including fullscreen
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

The off-screen clamp (ensureOnScreen) now runs on every show, not only in
createWindow(). It previously ran only at creation, which was a real hole
even though it was not the cause of the panel bug.

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
  four commits once during development

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

- qlmanage was removed deliberately. spawn('qlmanage', ['-p', path]) is a
  developer binary, not a supported API. It opened a real Quick Look window
  on another display and stole focus, defeating the point of a floating
  overlay. Do not reintroduce it
- app.getFileIcon with 'large' caused a crash. It is prevented only by a
  code comment, with no test guarding it
- globalShortcut.register cannot detect real conflicts, see constraint 3
- Cmd+Shift+D collides with Chrome's bookmark-all-tabs. The frontmost app
  wins. Accepted, and changeable in Preferences
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
- The author's gh token has scopes gist, read:org, repo. No workflow scope,
  so CI under .github/workflows/ is rejected until
  gh auth refresh -h github.com -s workflow. No delete_repo scope
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

Technical debt:
- The long-running stability issue, above. The only active problem
- No automated tests. Everything verified by hand. Every diagnostic harness
  built during development was discarded
- CODEMAP.md was never built. Worth doing at the start of a session rather
  than the end
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
  actually says. This project's hardest bug was solved by diagnosis, and
  the wrong hypothesis (off-screen bounds) would have wasted real time if
  it had been acted on instead of tested
- Claude Code should flag judgment calls rather than burying them. This
  caught several real issues: a nearly-reported commit hash that did not
  exist, the globalShortcut conflict-detection finding, and a duplicate
  instruction that would have redone completed work
