# Floating Downloads Panel, context_v4

Supersedes context_v3.md, which supersedes v2, which supersedes v1. All stay
on disk as history. v1 records the Swift dead end, v2 the Electron pivot, v3
the state through column view. Treat v4 as the source of truth.

This version is written as a handoff document. Anyone picking this project up
cold should be able to work from this file alone.

## Project
A macOS menu bar utility. A global keyboard shortcut toggles a floating,
always on top panel showing the contents of ~/Downloads and ~/Desktop. Files
can be dragged straight out of the panel into whatever app is currently in
focus. Same shortcut hides it.

## Repo
github.com/rsm-msaad/floating-downloads, public. Deliberately public.
Local path: ~/Desktop/Test 1/floating_downloads

## Reference implementation, and a note for anyone new
~/Desktop/Test 1/todo_app/floating-todo (github.com/rsm-msaad/floating-todo)
An existing working Electron always on top floating todo app by the same
author. This project reuses its architecture and styling.

IMPORTANT FOR A NEW CONTRIBUTOR: that local path exists only on the original
author's machine. Everything needed from it (CSS custom properties, window
option set, tray convention, persistence pattern) has already been copied
into this repo. You do not need the reference app to continue. It is cited
here so the provenance of those patterns is clear, and so the "do not copy"
list below makes sense.

## Hard constraints (both still binding)

1. macOS provides no public API for one app to raise another app's window to
   a floating level. This is why we are not pinning a real Finder window.
   Any idea starting with "just float the Finder window" is a dead end. This
   killed the original Swift plan's premise.

2. Electron has no equivalent of NSPanel's nonactivatingPanel style mask.
   focusable: false exists but disables keyboard input entirely.

   Resolution: use showInactive(), never show() plus focus(). Windows appear
   without pulling focus from the app in use. They stay focusable so
   clicking into them works. This applies to BOTH the panel and the preview
   window.

   Correction to v1: drag out does NOT require a non-activating window.
   macOS delivers the drop regardless of which app is frontmost. Confirmed
   empirically. Non-activation is a focus nicety, not a functional
   requirement.

## Tech stack
- Electron 32.3.3, JavaScript, HTML, CSS
- @electron/packager 18.4.4 (packaging not yet implemented)
- Node.js via nvm
- Main process for OS integration, renderers for UI
- contextBridge + IPC via preload.js, contextIsolation on
- No renderer framework. Plain HTML and CSS

## Files
- main.js: window creation, tray, hotkey, all filesystem operations, IPC
  handlers, path validation
- preload.js: contextBridge surface. Shared by both windows
- index.html / renderer.js: the main panel, tabs, columns, selection
- preview.html / preview.js: the preview window
- icon.svg / build-icon.py: tray icon sources. Regenerate with
  python3 build-icon.py
- context_v1..v4.md: project history, v4 is current

## Status: what is built and working

Verified by the author unless noted.

- Repo, private, pushed
- Electron scaffold: tray, frameless transparent floating panel, blur via
  CSS backdrop-filter, always on top, visible on all workspaces
- Global hotkey toggle, default CommandOrControl+Shift+D
- Custom tray icon: downward arrow into an open tray, macOS template icon
  form. Sources committed so the shape can be regenerated
- File listing: name, modification date, newest first, folder icons, middle
  truncation preserving extensions, relative dates (Today 2:30 PM,
  Yesterday, then dates), dotfiles and .DS_Store skipped
- Selection: plain click, Cmd-click to toggle, Shift-click for a range.
  Green left accent bar plus row highlight
- Drag files OUT to other apps via webContents.startDrag. Multi-select drag
  works. Verified by dragging into Finder
- Column view navigation, Finder style. Verified including drag from a
  non-first column
- Two roots: DOWNLOADS and DESKTOP, as tabs in the header. Switching
  discards the column trail and returns to a single root column. Last active
  tab persists
- Double click to open in the default app
- Right click context menu: Reveal in Finder, Copy Path, Move to Trash
- Preview in a separate floating window, opened with Space

## Key implementation details worth knowing

### Selection versus path highlighting
Two distinct states, mirroring Finder. `.selected` is the active selection
(accent bar plus doubled --hover, and the drag source). `.path` is a parent
folder that opened the column to its right (single --hover tint plus a
--faint bar, quieter). Only one column ever holds a real selection. The
trail is separate. No new color values were introduced for this.

### Column interaction rules
- Only a plain click on a folder drills in. Cmd/Shift multi-select selects
  without opening, because it is ambiguous which folder would open
- Any click in a column discards all columns to its right, for files as well
  as folders. Otherwise clicking a file would deselect the parent folder
  while its child column stayed open
- Column width is a fixed 240px, EXCEPT the last column, which grows to fill
  the remaining panel width. Parent columns stay stable at 240px so they do
  not jump around as you navigate. This matches Finder
- Refresh on panel-show re-reads every open column and truncates the trail
  at the first folder that has disappeared, so navigation survives a
  hide/show instead of resetting to root

### The preview window
- A separate BrowserWindow, not an in-panel overlay. The first attempt was
  in-panel and was rejected: it replaced the file list and could never be
  larger than the panel
- Reused, not recreated per file. ensurePreviewWindow() creates it lazily on
  first Space
- Sized to 60 percent of the workArea of the display the panel is on, via
  screen.getDisplayMatching. Independent of panel dimensions
- Recenters on every show. Position is deliberately NOT persisted, matching
  Quick Look
- Arrow up and down step through files in the current column in place.
  Arrows work in either window, but only the panel knows the column
  contents, so stepping is always resolved in the panel and sent back as a
  fresh preview:show
- Rendering by type: images scaled to fit and never upscaled; PDF via
  Chrome's native viewer; text-ish files monospace and preformatted with a
  100KB read guard; video and audio with native controls; everything else a
  fallback card with icon, name, size, type, date, and an open button
- Large media streams over a custom fdfile:// protocol handler rather than
  base64 over IPC

### Window coupling, deliberately one directional
The reference app's two-window visibility coupling was identified as a
problem and deliberately not reproduced. The rules:
- Opening the preview does NOT hide the panel
- Closing the preview does NOT show the panel
- Hiding the panel DOES hide the preview. This is the single permitted
  direction
- Re-summoning the panel does NOT resurrect the preview
- hidePreviewWindow has exactly two callers: hidePanel, and the
  preview:close IPC handler. Panel visibility is changed only by showPanel /
  hidePanel / togglePanel, and nothing in the preview path calls them
- The preview-closed message back to the panel is a notification only. It
  corrects the panel's stale belief about whether a preview is open and
  changes no window's visibility

Anyone modifying window behavior should preserve this. It is easy to
accidentally reintroduce the reverse edge.

### Escape priority
1. If the preview window is open, Escape closes it
2. Otherwise, if more than one column is open, Escape closes the rightmost
3. Otherwise, Escape clears the selection

Backspace also closes the rightmost column but does nothing else.

### The security boundary
Every filesystem path is validated in the main process against an allow list
of roots (~/Downloads and ~/Desktop) before ANY operation. Symlinks are
resolved before the check, so a symlink inside a root cannot be used to
escape. This applies to directory reads, Reveal in Finder, Copy Path, Move
to Trash, preview reads, and drag out. It is structured so adding a third
root is a one line change.

This is a real boundary, not a formality. Move to Trash especially. Do not
weaken it.

### CSP
index.html has a strict policy: default-src 'none'; script-src 'self';
style-src 'unsafe-inline'. The panel renders no file content, so it needs
nothing more. The widened policy, including frame-src fdfile: which testing
proved necessary for PDFs, lives only in preview.html where it is used.

### Persistence
Window position and size, the active tab, and the hotkey live in
~/Library/Application Support/floating-downloads/settings.json.
Writes use write-temp-then-rename with real console.error on failure. Do NOT
use the reference app's non-atomic fs.writeFileSync wrapped in silent empty
catches.

## Queued work, all decided

1. Live folder watching. The driving use case: a file finishes downloading
   while the user is in a fullscreen app, and it should appear without
   switching spaces
2. Drop files in, copy, and paste. Spec written, all three decided:
   - Drop files from Finder or any other app onto the panel to copy them
     into the folder shown by the hovered column. ALWAYS a copy, never a
     move, deliberately breaking the macOS same-volume convention. The
     source file stays where it was
   - Dropping onto a folder row targets that folder, not the column's
     folder. The target highlights during the drag. Multiple files and
     recursive folder copies must work
   - Cmd+C copies the actual FILES to the clipboard, not their paths, so
     Cmd+V works in Finder and other apps. This is distinct from the
     existing Copy Path menu item, which stays as it is
   - Cmd+V pastes clipboard files into the active column's folder. Always a
     copy, consistent with drop-in
   - Copy and Paste both join the context menu. Paste is disabled when the
     clipboard holds no files
   - Collisions never overwrite: append a numeric suffix Finder-style, so
     report.pdf becomes "report 2.pdf"
   - The DESTINATION must pass the allow list. Sources legitimately come
     from outside the roots, which is expected and fine
3. Tags, notes, pins
4. Tray left click toggles the panel, right click opens the menu.
   Configurable hotkey
5. Package as a .app: extend-info.plist, build script, app icon

### Live watching requirements
- Watch the active root and every open column, not just the root
- Selection and scroll position must survive a refresh
- If a folder in the trail is deleted, truncate the trail there
- Stop watching when the panel is hidden, re-establish and refresh on show
- Debounce events around 300ms
- Ignore .crdownload and .part entirely. In-progress downloads generate
  constant events and would thrash the list. The real file appearing on
  completion is what should trigger the update
- Send only the changed column over IPC
- fs.watch, not fs.watchFile which polls. fs.watch is known to be unreliable
  for some event types on macOS. If renames or deletes do not fire
  reliably, say so rather than working around it silently
- Clean up every watcher on quit and when a column closes

### Tags, notes, pins
All three are one metadata layer keyed by file path, in a single JSON file.
- Tags: freeform text, the user types any label. MULTIPLE tags per file.
  Rendered as pill labels on the row, styled after floating-todo's URGENT
  pill (rounded rect, colored fill, uppercase). The app should remember
  previously used tags and offer them for reuse
- Notes: opened from an icon on the row, shown in a popover, NOT an inline
  row expansion
- Pins: pinned items sort above the newest-first ordering
- Orphaned metadata is dropped immediately when a file leaves a root.
  AUTHOR'S DECISION, made knowingly. Consequence: moving a file out and
  back, or renaming it, permanently loses its tags and notes, because
  metadata is keyed by path. Do not silently change this

### Packaging
- Keep LSUIElement. The app stays out of the Dock and Cmd+Tab
- The built .app is dragged to the Dock as a launcher. This is what Dropover
  and floating-todo do, and it is the intended behavior
- App icon: the same downward-arrow-into-tray glyph as the tray icon,
  rendered as a full color rounded square app icon so the two read as one
  app
- extend-info.plist is REQUIRED alongside app.dock.hide(). Both are needed.
  app.dock.hide() alone does not make a true menu bar only app

## Do not copy from the reference app
- Edge tucking. The most fragile subsystem there. Two timing hacks tuned by
  feel (900ms/1200ms untuckCooldown, 220ms tuckMoveTimer debounce) to stop
  the window fighting its own move events, and it entangles saveState with a
  preTuckBounds special case
- Tasks, attachments, the detail window
- The two window visibility coupling
- Non-atomic writeFileSync with silent empty catches
- qlmanage for previews. This WAS tried and removed. See gotchas

## Known gotchas

- qlmanage was removed deliberately. spawn('qlmanage', ['-p', path]) is a
  developer binary, not a supported API. It opened a real Quick Look window
  on another display and stole focus, which defeats the point of a floating
  overlay. Do not reintroduce it. The custom preview window replaced it
- The reference app calls preventDefault on dragstart for its header and
  composer to protect -webkit-app-region: drag zones. File rows MUST NOT get
  this treatment and must not overlap an app-region drag zone, or the row
  will move the window instead of starting a drag. In the preview window,
  the header is the only drag zone and the close button is explicitly
  no-drag
- Drag out is webContents.startDrag in the MAIN process, NOT HTML5 drag and
  drop. dataTransfer will not deliver a file to another macOS app. startDrag
  requires an icon or it throws. Single file drags use app.getFileIcon
- Cmd+Shift+D collides with Chrome's bookmark-all-tabs. The frontmost app
  wins, so the hotkey does nothing while Chrome is focused. The author has
  accepted this. The configurable hotkey work will make it changeable
- ~/Downloads on the author's machine has roughly 2400 items. Performance at
  that scale is a real constraint, especially for live watching
- macOS quarantines unsigned packaged apps. Run xattr -cr on the .app before
  first launch
- The author's gh token has scopes gist, read:org, repo. No workflow scope,
  so CI under .github/workflows/ will be rejected until
  gh auth refresh -h github.com -s workflow. No delete_repo scope either
- npm audit reports 3 high severity vulnerabilities, all in the
  @electron/packager devDependency tree. They never ship in the packaged
  app. Do NOT run npm audit fix --force, it would bump packager across a
  major version
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
- Whether to add roots beyond Downloads and Desktop
- Panel placement is currently remembered. Fixed or near-cursor were never
  ruled out

## Workflow conventions
- The chat session is the architecture and design brain. Claude Code in
  VS Code does the execution
- One or two steps at a time, with confirmation between steps
- Prompts for Claude Code are written as specs: behavior, constraints, files
  involved. Implementation is left to Claude Code
- EVERY prompt ends with commit and push. The author wants frequent commits
- Slash commands in use: /bugfix, /review, /handoff
- When something breaks, diagnose before rewriting. Ask what the error
  actually says
- Claude Code should flag judgment calls it makes rather than burying them.
  This has caught several real issues, including a nearly-reported commit
  hash that did not exist
