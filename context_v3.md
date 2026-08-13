# Floating Downloads Panel, context_v3

Supersedes context_v2.md, which supersedes context_v1.md. Both stay on disk
as history. v1 records the Swift dead end, v2 records the Electron pivot.
Treat v3 as the source of truth.

## Project
A macOS menu bar utility. A global keyboard shortcut toggles a floating,
always on top panel showing the contents of ~/Downloads. Files can be
dragged straight out of the panel into whatever app is currently in focus.
Same shortcut hides it.

## Repo
github.com/rsm-msaad/floating-downloads, private.
Local path: ~/Desktop/Test 1/floating_downloads

## Reference implementation
~/Desktop/Test 1/todo_app/floating-todo (github.com/rsm-msaad/floating-todo)
An existing working Electron always on top floating todo app by the same
user. This project reuses its architecture and styling. See the copy / do
not copy lists below.

## Hard constraints (both still binding)

1. macOS provides no public API for one app to raise another app's window
   to a floating level. This is why we are not pinning a real Finder
   window. Any idea starting with "just float the Finder window" is a dead
   end. This killed the original Swift plan's premise.

2. Electron has no equivalent of NSPanel's nonactivatingPanel style mask.
   focusable: false exists but disables keyboard input entirely.

   Resolution: use win.showInactive(), never win.show() plus win.focus().
   The panel appears without pulling focus from the app you are working in.
   The window stays focusable so clicking into it works.

   Correction to v1: drag out does NOT require a non-activating window.
   macOS delivers the drop regardless of which app is frontmost. This was
   confirmed empirically in phase 3. Non-activation is a focus nicety, not
   a functional requirement.

## Tech stack
- Electron 32.3.3, JavaScript, HTML, CSS
- @electron/packager 18.4.4 for building the .app
- Node.js via nvm
- Main process for OS integration, renderer for UI
- contextBridge + IPC via preload.js, contextIsolation on
- No renderer framework. Plain HTML and CSS, matching floating-todo

## Status

### Built and working
- Repo initialized, private, pushed. Commits through the phase 1 scaffold
- Electron scaffold: tray, frameless transparent floating window, blur
- Global hotkey toggle, default CommandOrControl+Shift+D
- Custom tray icon: downward arrow into an open tray, template icon form.
  Sources committed as icon.svg and build-icon.py, so the shape can be
  regenerated without help
- File listing from ~/Downloads: name, modification date, newest first,
  folder icons, middle truncation preserving extensions, relative dates
  (Today 2:30 PM, Yesterday, then dates), dotfiles and .DS_Store skipped
- Selection: plain click, Cmd-click to toggle, Shift-click for a range.
  Green left accent bar plus row highlight
- Drag files OUT to other apps via webContents.startDrag. Multi-select
  drag works. Confirmed working by dragging into Finder

### In progress
- Phase 2b: column view folder navigation. Spec written, not yet run

### Queued, all decided
1. Column view navigation (2b)
2. Double click to open, Space for Quick Look, right click context menu
3. Live folder watching, auto refresh while the panel is open
4. Tags, notes, pin to top
5. Tray left click toggles the panel, right click opens the menu.
   Configurable hotkey
6. Package as a .app: extend-info.plist, build script, app icon

## Feature decisions

### Column view (phase 2b)
- Finder style. Clicking a folder opens a new column to its right
- Clicking a folder in a non-rightmost column discards columns to its
  right and opens a fresh one
- Selection does not span columns
- Navigation is locked to ~/Downloads. It is the ceiling. The main process
  must resolve real paths and reject anything outside, so a symlink in
  Downloads cannot be used to escape. This is a security boundary
- Fixed column width around 240px, horizontal scroll for overflow, auto
  scroll right when a new column opens
- Backspace or Escape closes the rightmost column
- Rows in every column stay draggable
- The panel does NOT auto widen. The user resizes manually and the size
  persists

### Opening files
- Double click opens in the default app
- Space opens Quick Look on the selected file
- Right click opens a context menu: Reveal in Finder, Open With, Copy
  Path, Move to Trash, and later Add Tag / Add Note

### Live watching
- The list auto refreshes while the panel is open. The driving use case:
  a file finishes downloading while the user is in a fullscreen app, and
  it should appear without switching spaces or reopening the panel

### Tags, notes, pins
All three are one metadata layer keyed by file path, stored in a single
JSON file.
- Tags: freeform text, the user types any label. Multiple tags per file.
  Rendered as pill labels on the row, styled after floating-todo's URGENT
  pill (rounded rect, colored fill, uppercase). The app should remember
  previously used tags and offer them for reuse
- Notes: opened from an icon on the row, shown in a popover over the
  panel, not an inline row expansion
- Pins: pinned files and folders sort to the top, above the newest first
  ordering
- Orphaned metadata is dropped immediately when a file leaves Downloads.
  USER DECISION, made knowingly. Consequence: moving a file out and back,
  or renaming it, permanently loses its tags and notes, because metadata
  is keyed by path. The user accepted this. Do not silently change it

### Packaging
- Keep LSUIElement. The app stays out of the Dock and Cmd+Tab
- The built .app is dragged to the Dock as a launcher. This is exactly what
  Dropover and floating-todo do, and the user confirmed that behavior is
  what they want
- App icon: the same downward arrow into a tray glyph as the tray icon,
  rendered as a full color rounded square app icon so the two read as the
  same app
- extend-info.plist is required alongside app.dock.hide(). Both are
  needed. app.dock.hide() alone does not make a true menu bar only app

## What to copy from floating-todo
Lift nearly as is:
- CSS custom properties and the whole HUD recipe
- setAlwaysOnTop(true, 'floating')
- setVisibleOnAllWorkspaces
- Tray setup with the Template icon convention
- app.dock.hide() plus extend-info.plist
- Window state persistence including the off screen clamp
- The preload / contextIsolation posture
- The open-external protocol allow list (http, https, mailto, message)

Deliberately do NOT copy:
- Edge tucking. The most fragile subsystem in the reference app. Two
  timing hacks tuned by feel (900ms/1200ms untuckCooldown, 220ms
  tuckMoveTimer debounce) to stop the window fighting its own move events,
  and it entangles saveState with a preTuckBounds special case
- Tasks, attachments, and the detail window
- The two window visibility coupling via a detailWin global
- Non-atomic fs.writeFileSync with silent empty catches. Use write temp
  then rename, which phase 1 already does

## Deviations from the reference made in phase 1 (all deliberate)
- show: false at construction, then showInactive() on ready-to-show. The
  reference constructs visible, which flashes a focused window at launch
- Dropped maxWidth 640. A file list wants room to grow
- minWidth/minHeight 280/200, up from the reference's 240/150, to fit
  filename plus date
- Dropped the --urgent / --soon / --later CSS vars. Everything else in
  :root is byte identical to floating-todo
- Added a CSP meta tag to index.html. The reference has none
- loadSettings() writes the settings file if absent

## Known gotchas

- Cmd+Shift+D collides with Chrome's bookmark-all-tabs. The frontmost app
  wins, so the hotkey does nothing in Chrome. User has accepted this and
  does not consider it a problem. The configurable hotkey work will make
  it changeable anyway
- The reference app calls preventDefault on dragstart for its header and
  composer, to protect -webkit-app-region: drag zones. File rows MUST NOT
  get this treatment, and must not overlap an app-region drag zone, or the
  row will move the window instead of starting a drag
- Drag out is webContents.startDrag in the main process, NOT HTML5 drag
  and drop. dataTransfer will not deliver a file to another macOS app.
  startDrag requires an icon or it throws. Single file drags use
  app.getFileIcon
- Quick Look via spawn('qlmanage', ['-p', path]) is a developer binary,
  not a supported API. It writes to stderr, steals focus, and can only be
  dismissed by killing the process. Accepted as the pragmatic option
- macOS quarantines unsigned packaged apps. Run xattr -cr on the .app
  before first launch
- The gh token has scopes gist, read:org, repo. No workflow scope, so CI
  under .github/workflows/ will be rejected until
  gh auth refresh -h github.com -s workflow. No delete_repo scope either
- npm audit reports 3 high severity vulnerabilities, all in the
  @electron/packager devDependency tree. They never ship in the packaged
  app. Do not run npm audit fix --force, it would bump packager across a
  major version
- xcodegen is still installed via Homebrew from the abandoned Swift
  attempt. Harmless. brew uninstall xcodegen to remove
- ~/Downloads on this machine has roughly 2400 items. Performance at that
  scale matters. Watch for it when adding live watching

## Open items
- Panel placement: fixed, remembered, or near cursor. Currently remembered
- Whether the panel should auto hide when it loses focus. Undecided
- Whether to show hidden files or filter by type. Currently dotfiles are
  skipped, no type filtering

## Workflow conventions
- The chat session is the architecture and design brain. Claude Code in
  VS Code does the execution
- One or two steps at a time, with confirmation between steps
- Prompts for Claude Code are written as specs: behavior, constraints,
  files involved. Implementation is left to Claude Code
- Slash commands in use: /bugfix, /review, /handoff
- When something breaks, diagnose before rewriting. Ask what the error
  actually says
