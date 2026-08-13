# FloatingDownloads

A macOS menu bar utility built with Electron. A single global keyboard
shortcut toggles a floating, always-on-top panel showing the contents of
`~/Downloads`, and the same shortcut hides it again. The panel is a HUD-style,
dark translucent window that sits above every other window — including
fullscreen apps — and is summoned without pulling focus from whatever you are
typing in, so files can be dragged straight out of it into the app you are
working in. Think of it as a lightweight Finder replacement for one folder,
available instantly from anywhere.

## Status

Early scaffolding, not yet functional.

Phase 1 in progress: tray app, floating window, and hotkey toggle with
placeholder content. No file listing yet.

## Build order

1. **Scaffold** — Electron app, tray, floating window, hotkey toggle, placeholder content. *(current)*
2. **File list** — real contents of `~/Downloads` with the HUD styling ported over.
3. **Drag out** — drag files to other apps via `webContents.startDrag`.
4. **Interactions** — double-click to open, Quick Look, right-click menu.
5. **Polish** — live folder watching, sort options, packaging.

## Development

```sh
npm install
npm start
```

Requires Node.js and macOS. The app has no Dock icon — it lives in the menu
bar. Default hotkey is `⌘⇧D`.

## Notes

Architecture, standing decisions, and constraints live in
[`context_v2.md`](context_v2.md), which is the source of truth.
[`context_v1.md`](context_v1.md) is retained only as a record of the abandoned
Swift/AppKit approach and why it was abandoned.
