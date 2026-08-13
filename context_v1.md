# Floating Downloads Panel, context_v1

## Project
A small macOS menu bar utility. One global keyboard shortcut toggles a floating,
always on top panel showing the contents of ~/Downloads. Files can be dragged
straight out of the panel into whatever app is currently in focus. Same shortcut
hides it.

## End goal
A HUD style panel that behaves like a lightweight Finder replacement for one
folder, living above every other window, summoned and dismissed instantly.

## Why not off the shelf
Considered and rejected:
- Raycast Quicklink: shows a file list, but inside Raycast's own window, not a
  persistent floating panel.
- Hammerspoon: can toggle a Finder window, cannot make it float.
- BetterTouchTool: paid, and still cannot truly pin a Finder window.

## Hard constraint discovered
macOS provides no public API for one app to raise another app's window to a
floating level. Finder windows sit at normal window level. This is why we are
building a custom NSPanel instead of pinning a real Finder window. Any future
idea that starts with "just float the Finder window" is a dead end.

## Design direction
Reference: a dark, translucent, rounded HUD panel (user supplied screenshot of a
todo widget). Key traits to match:
- Dark translucent background with visible blur, not opaque
- Generously rounded corners, roughly 16pt
- Thin light border, low opacity
- Header row: title on the left, small controls on the right including a close X
- Comfortable row height, clear readable type, muted secondary text for metadata
- Subtle highlight on the selected or hovered row, with a left accent bar
- A quiet footer row for secondary actions

## Tech stack
- Swift, SwiftUI, macOS 14+
- Xcode project, App target
- MenuBarExtra for the status item
- NSPanel (nonactivatingPanel, .floating level) hosting a SwiftUI view
- SPM dependency: KeyboardShortcuts by Sindre Sorhus, for the global hotkey and
  its built in shortcut recorder UI
- FileManager plus DispatchSource or FSEvents for live folder watching

## Standing decisions
- App Sandbox is OFF. This is a personal app reading ~/Downloads. If it is ever
  distributed, revisit with security scoped bookmarks.
- LSUIElement is true. No Dock icon, no main window on launch.
- The panel is nonactivating, so summoning it does not steal focus from the app
  the user is working in. This matters for drag and drop.
- Default hotkey is user configurable via the KeyboardShortcuts recorder rather
  than hardcoded.
- Toggle semantics: if visible, hide. If hidden, show. Same key both ways.

## Workflow conventions
- This chat is the architecture and design brain. Claude Code in VS Code does
  the execution.
- Work proceeds one or two steps at a time, with confirmation between steps.
- Prompts for Claude Code are written as specs: behavior, constraints, files
  involved. Implementation details are left to Claude Code.
- Slash commands available and appropriate: /bugfix, /review, /handoff.

## File structure (planned)
FloatingDownloads/
  FloatingDownloadsApp.swift      app entry, MenuBarExtra, hotkey registration
  PanelController.swift           NSPanel lifecycle, show/hide/toggle
  DownloadsPanelView.swift        SwiftUI HUD content
  FileItem.swift                  model for one file row
  DownloadsWatcher.swift          folder contents plus live updates
  Theme.swift                     colors, radii, spacing constants

## Build order
1. Scaffold: menu bar app, hotkey, empty floating panel that toggles. CURRENT
2. Real file list from ~/Downloads, HUD styling to match the reference
3. Drag out to other apps
4. Interactions: double click to open, space for QuickLook, right click menu
5. Live folder watching, sort options, polish

## Open items
- Panel placement: fixed spot, remembered position, or near cursor. Undecided.
- Whether the panel should auto hide when it loses focus. Undecided.
- Icon and app name. Undecided.

## Personal context
User is on macOS, uses VS Code with Claude Code for execution, and prefers to
review and confirm each step rather than accept large rewrites.
