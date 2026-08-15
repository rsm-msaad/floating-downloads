# FloatingDownloads

> **[`context_v7.md`](context_v7.md) is the current source of truth.** Earlier
> versions (`context_v1.md` … `context_v6.md`) are kept only as history — do not
> work from them. v1 records an abandoned Swift/AppKit approach, v2 the Electron
> pivot, v3 the state through column view, v4 the state through the preview
> window, v5 feature completion and packaging, v6 the state while the panel
> visibility bug was still open.

A macOS menu bar utility built with Electron. A single global keyboard shortcut
toggles a floating, always-on-top panel showing the contents of `~/Downloads`
and `~/Desktop`, and the same shortcut hides it again. The panel is a HUD-style,
dark translucent window that sits above every other window — including
fullscreen apps — and is summoned without pulling focus from whatever you are
typing in, so files can be dragged straight out of it into the app you are
working in. Think of it as a lightweight Finder replacement for the two folders
you actually use, available instantly from anywhere.

## Status

**Feature complete and packaged.** Everything originally specced is built and
running as a `.app`. What remains is polish.

- **Menu bar app** — tray icon, no Dock icon, no Cmd-Tab presence. Global hotkey
  toggles the panel; tray left-click does the same, right-click opens the menu.
- **Configurable hotkey** — Preferences window with a shortcut recorder and a
  reset to default. Defaults to `⌘⇧D`.
- **Two roots** — `DOWNLOADS` and `DESKTOP` as header tabs, last active persisted.
- **File listing** — newest first, folder icons, relative dates, middle
  truncation that keeps the extension visible, dotfiles and `.DS_Store` skipped.
- **Column navigation** — Finder-style, with the rightmost column filling the
  remaining width.
- **Selection** — click, `Cmd`-click, `Shift`-click. Does not span columns.
- **Drag out** — to any other app, multi-select, from any column.
- **Drop in** — from Finder or any app, onto a column or a folder row. Always a
  copy, never a move, with Finder-style numeric suffixes on collisions.
- **Copy and paste** — `Cmd+C` copies the actual files, so `Cmd+V` works in
  Finder. `Cmd+V` pastes into the active column.
- **Open and preview** — double-click opens in the default app; `Space` opens a
  separate floating preview window (images, PDF, text, video, audio, fallback).
- **Move to Trash** — `Cmd+Delete` or the context menu, no confirmation.
- **Tags, notes, and pins** — one metadata layer keyed by file path. Tag colours
  default to a name-derived colour and can be overridden per tag from a fixed
  palette.
- **Live watching** — the list stays current while the panel is visible, so a
  finished download appears without reopening the panel.
- **Packaged** — a real `.app` that lives in `/Applications` and launches from
  the Dock.

Every filesystem path is validated against an allow-list of roots in the main
process before any operation, with symlinks resolved first. See the security
boundary section of [`context_v7.md`](context_v7.md).

## Development

```sh
npm install
npm start
```

Requires Node.js and macOS. The app has no Dock icon — it lives in the menu bar.

## Building

```sh
npm run icons    # regenerate tray icon, drag icon and icon.icns from the SVGs
npm run build    # package the .app into dist/ and clear the quarantine flag
```

Install the result:

```sh
cp -R "dist/FloatingDownloads-darwin-arm64/FloatingDownloads.app" /Applications/
```

Then drag it from `/Applications` onto the Dock. Because the app is
`LSUIElement`, the Dock tile is a launcher only — there is no running indicator,
and the tray icon is the only sign it is running.

The build is unsigned. `npm run build` runs `xattr -cr`, so a locally built app
opens without a Gatekeeper prompt.

## Notes

Architecture, standing decisions, constraints, and known gotchas live in
[`context_v7.md`](context_v7.md).
