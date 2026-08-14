# Floating Downloads Panel, context_v5

Supersedes v4, v3, v2, v1. All stay on disk as history. v1 records the Swift
dead end, v2 the Electron pivot, v3 the state through column view, v4 the
state through the preview window. Treat v5 as the source of truth.

Written as a handoff document. Anyone picking this project up cold should be
able to work from this file alone.

## Status: FEATURE COMPLETE

Everything originally specced is built, packaged, and verified working by
the author, including from the packaged build in /Applications. What remains
is polish and whatever the author wants next.

## Project
A macOS menu bar utility. A global keyboard shortcut toggles a floating,
always on top panel showing the contents of ~/Downloads and ~/Desktop. Files
drag straight out of the panel into whatever app is in focus. Same shortcut
hides it.

## Repo
github.com/rsm-msaad/floating-downloads. PUBLIC (deliberately made public by
the author).
Local path: ~/Desktop/Test 1/floating_downloads

## Reference implementation, and a note for a new contributor
~/Desktop/Test 1/todo_app/floating-todo (github.com/rsm-msaad/floating-todo)
An existing Electron always on top floating todo app by the same author.
This project reuses its architecture and styling.

IMPORTANT: that local path exists only on the original author's machine.
Everything needed from it has already been copied into this repo. You do not
need the reference app to continue. It is cited so the provenance of those
patterns is clear, and so the "do not copy" list below makes sense.

## Hard constraints (both still binding)

1. macOS provides no public API for one app to raise another app's window to
   a floating level. This is why we do not pin a real Finder window. Any
   idea starting with "just float the Finder window" is a dead end. This
   killed the original Swift plan's premise.

2. Electron has no equivalent of NSPanel's nonactivatingPanel style mask.
   focusable: false exists but disables keyboard input entirely.

   Resolution: showInactive(), never show() plus focus(). Applies to the
   panel and the preview window. The Preferences window is the deliberate
   exception, it takes focus because it has a text input.

   Correction to v1: drag out does NOT require a non-activating window.
   macOS delivers the drop regardless of which app is frontmost. Confirmed
   empirically. Non-activation is a focus nicety, not a functional
   requirement.

3. NEW IN V5: globalShortcut.register does not reliably detect conflicts.
   Registering CommandOrControl+Space returns true even though Spotlight
   owns it. macOS hands a shortcut to whichever app is frontmost at press
   time, so registration succeeding tells you nothing about whether the
   shortcut will actually fire. There is no API to query the real owner.
   The Preferences hint text says so plainly rather than pretending
   collision detection works. This is the same phenomenon as the Chrome
   Cmd+Shift+D collision.

## Tech stack
- Electron 32.3.3, JavaScript, HTML, CSS
- @electron/packager 18.4.4
- Node.js via nvm
- Main process for OS integration, renderers for UI
- contextBridge + IPC via preload.js, contextIsolation on
- No renderer framework. Plain HTML and CSS

## Files
- main.js: windows, tray, hotkey, all filesystem operations, IPC handlers,
  path validation, metadata storage
- preload.js: contextBridge surface, shared by all windows
- index.html / renderer.js: the main panel, tabs, columns, selection, tags,
  notes, pins
- preview.html / preview.js: the preview window
- icon.svg / build-icon.py: tray icon sources, regenerate with
  python3 build-icon.py
- app icon sources, generating icon.icns via iconutil
- extend-info.plist: LSUIElement and bundle metadata for packaging
- context_v1..v5.md: project history, v5 is current

## What is built, all verified

- Floating panel: frameless, transparent, blur via CSS backdrop-filter,
  always on top, visible on all workspaces including fullscreen
- Tray icon: downward arrow into an open tray, macOS template form. Left
  click toggles the panel, right click opens the menu
- Global hotkey, default CommandOrControl+Shift+D, configurable in
  Preferences
- Preferences window with a shortcut recorder and reset to default
- Two roots, DOWNLOADS and DESKTOP, as header tabs. Last active tab persists
- Column view navigation, Finder style
- File listing: name, modification date, newest first, folder icons, middle
  truncation preserving extensions, relative dates, dotfiles and .DS_Store
  skipped
- Selection: click, Cmd-click, Shift-click
- Drag files OUT to other apps, multi-select supported. Verified from the
  packaged build
- Drop files IN from Finder or any app. Always copy, never move
- Cmd+C copies actual files (works in Finder), Cmd+V pastes into the active
  column
- Double click opens in the default app
- Right click context menu: Reveal in Finder, Copy, Copy Path, Paste, Move
  to Trash, plus Add Tag, Add Note, Pin / Unpin
- Cmd+Delete moves the selection to Trash, no confirmation, matching Finder
- Preview in a separate floating window, opened with Space
- Live folder watching
- Tags, notes, pins
- Packaged .app in /Applications, added to the Dock

## Key implementation details

### Selection versus path highlighting
Two distinct states, mirroring Finder. `.selected` is the active selection
(accent bar plus doubled --hover, and the drag source). `.path` is a parent
folder that opened the column to its right (single --hover tint plus a
--faint bar, quieter). Only one column ever holds a real selection.

### Column interaction rules
- Only a plain click on a folder drills in. Cmd/Shift multi-select selects
  without opening, since it is ambiguous which folder would open
- Any click in a column discards all columns to its right, for files as well
  as folders. Otherwise clicking a file would deselect the parent folder
  while its child column stayed open
- Columns are a fixed 240px EXCEPT the last, which grows to fill the panel.
  Parent columns stay stable so they do not jump around while navigating.
  This matches Finder
- Refresh on panel-show re-reads every open column and truncates the trail
  at the first folder that has disappeared

### The preview window
- A separate BrowserWindow. An in-panel overlay was tried first and
  rejected: it replaced the file list and could never exceed the panel size
- Reused, not recreated. Created lazily on first Space
- Sized to 60 percent of the workArea of the display the panel is on, via
  screen.getDisplayMatching. Independent of panel dimensions
- Recenters on every show. Position deliberately NOT persisted, matching
  Quick Look
- Arrows step through files in the current column in place. Arrows work in
  either window, but only the panel knows the column contents, so stepping
  resolves in the panel and returns as a fresh preview:show
- Rendering: images scaled to fit and never upscaled; PDF via Chrome's
  native viewer; text-ish files monospace with a 100KB read guard; video and
  audio with native controls; everything else a fallback card with icon,
  name, size, type, date, and an open button
- Large media streams over a custom fdfile:// protocol handler rather than
  base64 over IPC

### Window coupling, deliberately one directional
The reference app's two-window visibility coupling was identified as a
problem and deliberately not reproduced. The rules:
- Opening the preview or Preferences does NOT hide the panel
- Closing either does NOT show the panel
- Hiding the panel DOES hide the preview. The single permitted direction
- Re-summoning the panel does NOT resurrect the preview
- hidePreviewWindow has exactly two callers: hidePanel, and the
  preview:close IPC handler. Panel visibility changes only via showPanel /
  hidePanel / togglePanel, and nothing in the preview path calls them
- The preview-closed message back to the panel is a notification only. It
  corrects the panel's stale belief about whether a preview is open and
  changes no window's visibility

Easy to accidentally reintroduce the reverse edge. Preserve this.

### Escape priority
1. Preview open, Escape closes it
2. More than one column open, Escape closes the rightmost
3. Otherwise Escape clears the selection

Backspace also closes the rightmost column and does nothing else.

### The security boundary
Every filesystem path is validated in the main process against an allow list
of roots (~/Downloads and ~/Desktop) before ANY operation. Symlinks resolved
first, so a symlink inside a root cannot escape. Applies to reads, Reveal in
Finder, Copy Path, Move to Trash, Cmd+Delete, preview reads, drag out,
paste, and drop-in destinations.

For drop-in and paste, the SOURCE may be outside the roots, which is
expected. It is the DESTINATION that must be validated.

Structured so adding a third root is a one line change. This is a real
boundary, not a formality. Do not weaken it.

### Drag out and drop in coexisting
Drag out is webContents.startDrag in the MAIN process, NOT HTML5 drag and
drop. dataTransfer will not deliver a file to another macOS app. startDrag
requires an icon or it throws. Single file drags use app.getFileIcon.

Drop in uses HTML5 dragover / dragleave / drop, with a types.includes
('Files') gate. These do not conflict, because an outgoing drag calls
preventDefault on dragstart so the native startDrag takes over and emits no
DOM drag events. The incoming handlers are structurally unreachable during a
drag out.

Also: no row or column sits inside a -webkit-app-region: drag zone. If one
did, dragging the row would move the window instead of starting a drag. In
the preview window the header is the only drag zone, with the close button
explicitly no-drag.

### Metadata: tags, notes, pins
One layer, keyed by absolute file path, in a JSON file in the app support
directory.
- Tags: freeform, multiple per file, rendered as uppercase pill labels.
  Previously used tags are offered as suggestions
- Tag colors: default to a color derived from the tag name, so the same tag
  is always the same color. The user can override per tag NAME via right
  click on a pill, from a fixed muted palette. An override applies
  everywhere that tag appears, survives when no file currently carries the
  tag, and can be reset to automatic
- Notes: opened from a row icon, shown in a popover. Not an inline
  expansion, not a separate window. Saves on close or blur
- Pins: pinned items sort above everything else, newest-first within the
  pinned group
- Orphaned metadata is dropped immediately when a file no longer exists.
  AUTHOR'S DECISION, made knowingly. Consequence: renaming or moving a file
  permanently loses its tags and note, since metadata is keyed by path. Do
  not add path-following or recovery logic without asking

### Persistence
Window position and size, active tab, and hotkey live in
~/Library/Application Support/floating-downloads/settings.json. Metadata
lives in its own file alongside.

All writes use write-temp-then-rename with real console.error on failure.
Do NOT use the reference app's non-atomic fs.writeFileSync wrapped in silent
empty catches.

### CSP
index.html is strict: default-src 'none'; script-src 'self'; style-src
'unsafe-inline'. The panel renders no file content. The widened policy,
including frame-src fdfile: which testing proved necessary for PDFs, lives
only in preview.html.

### Packaging
- npm run build produces the .app via @electron/packager into dist/, which
  is gitignored. The script runs xattr -cr on the output
- LSUIElement is set in extend-info.plist AND app.dock.hide() runs at
  runtime. Both are needed. app.dock.hide() alone does not make a true menu
  bar only app
- The app icon is a full color rounded square version of the tray glyph,
  built as an .iconset and converted with iconutil. Sources committed
- Install: cp -R "dist/FloatingDownloads-darwin-arm64/FloatingDownloads.app"
  /Applications/ then drag it from Applications to the Dock
- The Dock tile is purely a launcher. No running indicator dot, and clicking
  it while running does nothing visible. The tray icon is the only sign it
  is running
- Packaging emits: WARNING: Could not find icon "./icon.icns" with extension
  ".icon", skipping this app icon format. This is harmless. macOS 26
  introduced a new .icon bundle format and packager checks for it alongside
  .icns. The icon inside the app was hash-verified as byte-identical to
  icon.icns
- Gatekeeper only bites when the quarantine flag is applied, which happens
  on arrival via browser, AirDrop, or an archive, not on a local build. If
  it does appear, right click the app then Open then Open in the dialog, or
  re-run xattr -cr

## Do not copy from the reference app
- Edge tucking. The most fragile subsystem there. Two timing hacks tuned by
  feel (900ms/1200ms untuckCooldown, 220ms tuckMoveTimer debounce) to stop
  the window fighting its own move events, and it entangles saveState with a
  preTuckBounds special case
- Tasks, attachments, the detail window
- The two window visibility coupling
- Non-atomic writeFileSync with silent empty catches
- qlmanage for previews. This WAS tried and removed, see gotchas

## Known gotchas

- qlmanage was removed deliberately. spawn('qlmanage', ['-p', path]) is a
  developer binary, not a supported API. It opened a real Quick Look window
  on another display and stole focus, defeating the point of a floating
  overlay. Do not reintroduce it
- globalShortcut.register cannot detect real conflicts, see constraint 3
- Cmd+Shift+D collides with Chrome's bookmark-all-tabs. The frontmost app
  wins. The author has accepted this and can change it in Preferences
- ~/Downloads on the author's machine has roughly 2400 items. Performance at
  that scale is a real constraint. Live watching debounces filesystem events
  around 300ms and ignores .crdownload and .part entirely, since in-progress
  downloads would otherwise thrash the list
- fs.watch, not fs.watchFile which polls. fs.watch is known to be unreliable
  for some event types on macOS
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
- Dropped maxWidth 640. A file list wants room to grow
- minWidth/minHeight 280/200, up from 240/150
- Dropped the --urgent / --soon / --later CSS vars. Everything else in :root
  is byte identical to floating-todo
- Added a CSP meta tag. The reference has none
- loadSettings() writes the settings file if absent

## Open items, genuinely undecided
- Should the panel auto hide when it loses focus
- Hidden files and type filtering. Currently dotfiles are skipped, no type
  filtering
- Roots beyond Downloads and Desktop
- Panel placement is currently remembered. Fixed or near-cursor were never
  ruled out
- Code signing and notarization. Currently unsigned, which is fine for
  personal use but would matter for distribution
- No automated tests exist. Everything has been verified by hand

## Workflow conventions
- The chat session is the architecture and design brain. Claude Code in
  VS Code does the execution
- One or two steps at a time, with confirmation between steps
- Prompts are written as specs: behavior, constraints, files involved.
  Implementation is left to Claude Code
- EVERY prompt ends with commit and push. The author wants frequent commits
- Slash commands in use: /bugfix, /review, /handoff
- When something breaks, diagnose before rewriting. Ask what the error
  actually says
- Claude Code should flag judgment calls rather than burying them. This has
  caught several real issues, including a nearly-reported commit hash that
  did not exist, and the globalShortcut conflict-detection finding
