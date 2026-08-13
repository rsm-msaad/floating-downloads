# Floating Downloads Panel, context_v2

Supersedes context_v1.md. v1 stays in the repo as a record of the Swift dead
end and the reasoning behind it. Treat v2 as the source of truth.

## Project
A macOS menu bar utility. One global keyboard shortcut toggles a floating,
always on top panel showing the contents of ~/Downloads. Files can be dragged
straight out of the panel into whatever app is currently in focus. Same
shortcut hides it.

## End goal
A HUD style panel that behaves like a lightweight Finder replacement for one
folder, living above every other window, summoned and dismissed instantly.

## Repo
github.com/rsm-msaad/floating-downloads, private.
Local path: ~/Desktop/Test 1/floating_downloads

## What changed since v1

### The Swift dead end
v1 specified Swift, SwiftUI, and a native NSPanel. That was abandoned. Full
Xcode is not installed on this machine and is not going to be. xcodebuild
cannot build an .xcodeproj with Command Line Tools alone, so the project was
never verifiable. The Swift artifacts (project.yml, Sources/, Supporting/,
FloatingDownloads.xcodeproj) have been deleted from the repo.

xcodegen is still installed via Homebrew. Harmless. Remove with
brew uninstall xcodegen if desired.

### The reference implementation
The decisive factor: a working Electron app already exists at
~/Desktop/Test 1/todo_app/floating-todo (github.com/rsm-msaad/floating-todo).
It is an always on top floating todo panel that already solves most of this
problem, and it is the visual reference the design direction was drawn from.
This project reuses its architecture and styling.

## Hard constraints discovered (both still binding)

1. macOS provides no public API for one app to raise another app's window to a
   floating level. This is why we are not pinning a real Finder window. Any
   idea that starts with "just float the Finder window" is a dead end.

2. Electron has no equivalent of NSPanel's nonactivatingPanel style mask. The
   focusable: false option exists but disables keyboard input entirely, which
   is unusable.

   Resolution for #2: use win.showInactive() rather than win.show() plus
   win.focus(). This shows the panel without pulling focus from the app you
   are working in, which is the behavior that actually matters day to day
   (pressing the hotkey mid sentence should not redirect your typing).
   The window stays focusable, so clicking into it works normally.

   Note: drag and drop out of the panel does NOT require a non-activating
   window. macOS delivers the drop to the target app regardless of which app
   is frontmost. v1 claimed non-activation was load bearing for drag out.
   That was wrong. It is a focus-behavior nicety, not a functional
   requirement.

## Tech stack
- Electron, JavaScript, HTML, CSS
- Node.js (already installed, managed by nvm)
- Main process for OS integration, renderer for the panel UI
- contextBridge + IPC via preload.js, contextIsolation on
- @electron/packager for building the .app
- No framework in the renderer. Plain HTML and CSS, matching floating-todo

## Standing decisions

### Carried over from v1
- Menu bar only. No Dock icon, no Cmd+Tab presence.
- Hotkey is user configurable, not hardcoded.
- Toggle semantics: one key, both directions. Visible hides, hidden shows.

### New or revised in v2
- showInactive() instead of show() + focus(). See constraint #2.
- Keep CSS backdrop-filter for the blur rather than switching to Electron's
  native vibrancy option. The reference app uses backdrop-filter, it looks
  right, and the user has confirmed they are happy with it. Native vibrancy
  would be cheaper on the GPU but is a change with no visible benefit.
- transparent: true is set at window construction and cannot be toggled
  later. Accepted, inherited from the reference app.
- Persistence should use write-temp-then-rename, NOT the reference app's
  non-atomic fs.writeFileSync wrapped in silent empty catches. A crash mid
  write truncates the file and the failure is silent.
- LSUIElement is applied via extend-info.plist at packaging time, plus
  app.dock.hide() at runtime. Both are needed. app.dock.hide() alone is not
  sufficient for a true menu bar only app.
- Add node_modules to .gitignore before the first npm install.

## What to copy from floating-todo
Lift nearly as-is:
- The CSS custom properties and the whole HUD recipe (colors, radii,
  spacing, typography)
- setAlwaysOnTop(true, 'floating')
- setVisibleOnAllWorkspaces
- Tray setup with the Template icon convention
- app.dock.hide() plus extend-info.plist
- Window state persistence including the off screen clamp
- The preload / contextIsolation posture
- The open-external protocol allow list (http, https, mailto, message).
  This was noted as genuinely well done.

Deliberately do NOT copy:
- Edge tucking. The most fragile subsystem in the reference app. Depends on
  two timing hacks (a 900ms/1200ms untuckCooldown and a 220ms tuckMoveTimer
  debounce) tuned by feel to stop the window fighting its own move events,
  and it entangles saveState with a preTuckBounds special case. A hotkey
  toggled panel does not need it.
- The tasks, attachments, and detail window subsystems.
- The two window visibility coupling, where the detail window and main window
  implicitly manage each other's visibility through a detailWin global.

## Net new, nothing to copy
- Global hotkey registration, plus a shortcut recorder UI
- Drag files OUT via webContents.startDrag. Note this is an Electron main
  process API, NOT HTML5 drag events. It requires an icon, and it is wired
  through IPC from a dragstart handler in the renderer.
- Reading and watching ~/Downloads

## Known gotchas

- The reference app calls e.preventDefault() on dragstart for its header and
  composer elements, to stop HTML5 drag hijacking the -webkit-app-region:
  drag window move zone. Our file rows MUST initiate drags, so a blanket
  preventDefault is off the table. Draggable file rows must stay clear of any
  app-region drag zone. This is a real interaction conflict, not just a
  stray line of code.
- Quick Look in the reference app is spawn('qlmanage', ['-p', path]).
  qlmanage is a developer/debug binary, not a supported API. It writes
  warnings to stderr, steals focus, and can only be dismissed by killing the
  process. It works, but inherit it knowing what it is. There are also
  leftover console.log('[QuickLook] ...') lines in the shipped code.
- macOS quarantines unsigned packaged apps. After building, run
  xattr -cr on the .app before first launch.
- The gh token has scopes gist, read:org, repo. No workflow scope, so CI
  under .github/workflows/ will be rejected until
  gh auth refresh -h github.com -s workflow is run. No delete_repo scope
  either.
- Terminal needed Full Disk Access to read ~/Desktop. Already resolved, but
  the app itself will likely trigger its own permission prompt for Downloads.

## Build order
1. Scaffold: Electron app, tray, floating window, hotkey toggle, placeholder
   content. CURRENT
2. Real file list from ~/Downloads with the HUD styling ported over
3. Drag out to other apps via webContents.startDrag
4. Interactions: double click to open, Quick Look, right click menu
5. Live folder watching, sort options, packaging, polish

## Open items
- Panel placement: fixed spot, remembered position, or near cursor. Undecided.
- Whether the panel should auto hide when it loses focus. Undecided.
- Icon and final app name. Undecided.
- Whether to show folders, hidden files, or filter by type. Undecided.

## Workflow conventions
- The chat session is the architecture and design brain. Claude Code in
  VS Code does the execution.
- One or two steps at a time, with confirmation between steps.
- Prompts for Claude Code are written as specs: behavior, constraints, files
  involved. Implementation is left to Claude Code.
- Slash commands in use: /bugfix, /review, /handoff.
- When something breaks, diagnose before rewriting. Ask what the error
  actually says.
