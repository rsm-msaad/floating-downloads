# FloatingDownloads

A macOS menu bar utility. A single global keyboard shortcut toggles a floating,
always-on-top panel showing the contents of `~/Downloads`, and the same shortcut
hides it again. The panel is a HUD-style, dark translucent window that sits above
every other window and never steals focus when summoned, so files can be dragged
straight out of it into whatever app you are currently working in. Think of it as
a lightweight Finder replacement for one folder, available instantly from
anywhere.

## Status

Early scaffolding, not yet functional.

## Build order

1. **Scaffold** — menu bar app, hotkey, empty floating panel that toggles. *(current)*
2. **File list** — real contents of `~/Downloads`, HUD styling to match the reference design.
3. **Drag out** — drag files from the panel into other apps.
4. **Interactions** — double-click to open, space for QuickLook, right-click menu.
5. **Polish** — live folder watching, sort options, refinement.

## Notes

Architecture, standing decisions, and constraints live in [`context_v1.md`](context_v1.md).
