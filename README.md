# FloatingDownloads

> **[`context_v4.md`](context_v4.md) is the current source of truth.** Earlier
> versions (`context_v1.md` … `context_v3.md`) are kept only as history — do not
> work from them. v1 records an abandoned Swift/AppKit approach, v2 the Electron
> pivot, v3 the state through column view.

A macOS menu bar utility built with Electron. A single global keyboard shortcut
toggles a floating, always-on-top panel showing the contents of `~/Downloads`
and `~/Desktop`, and the same shortcut hides it again. The panel is a HUD-style,
dark translucent window that sits above every other window — including
fullscreen apps — and is summoned without pulling focus from whatever you are
typing in, so files can be dragged straight out of it into the app you are
working in. Think of it as a lightweight Finder replacement for the two folders
you actually use, available instantly from anywhere.

## Status

Working, and used daily by the author. Not yet packaged as a `.app` — it runs
from source via `npm start`.

Built and working:

- **Menu bar app** — tray icon, no Dock icon, no Cmd-Tab presence. Global hotkey
  (`⌘⇧D` by default) toggles the panel; tray left-click does the same, right-click
  opens the menu.
- **Two roots** — `DOWNLOADS` and `DESKTOP` as header tabs. The active tab persists
  across restarts.
- **File listing** — newest first, folder icons, relative dates (`Today 2:30 PM`,
  `Yesterday`, then dates), middle truncation that keeps the extension visible,
  dotfiles and `.DS_Store` skipped.
- **Column navigation** — Finder-style. Clicking a folder opens a column to its
  right; the rightmost column fills the remaining width.
- **Selection** — click, `Cmd`-click to toggle, `Shift`-click for a range.
  Selection does not span columns.
- **Drag out** — drag files to any other app via `webContents.startDrag`.
  Multi-select works, from any column.
- **Open and preview** — double-click opens in the default app; `Space` opens a
  separate floating preview window with per-type rendering (images, PDF, text,
  video, audio, and a fallback card).
- **Context menu** — Reveal in Finder, Copy Path, Move to Trash.
- **Live watching** — the list stays current while the panel is visible, so a
  finished download appears without reopening the panel.

Every filesystem path is validated against an allow-list of roots in the main
process before any operation, with symlinks resolved first. See the security
boundary section of [`context_v4.md`](context_v4.md).

## Build order

Phases 1–5 are complete. Remaining work, in order:

1. ~~Scaffold — tray, floating panel, hotkey toggle~~ ✅
2. ~~File listing from `~/Downloads`~~ ✅
3. ~~Drag out to other apps~~ ✅
4. ~~Open, Quick Look replacement, context menu~~ ✅
5. ~~Live folder watching~~ ✅
6. **Drop files in, copy, and paste** — drag files from other apps onto a column
   to copy them in (always a copy, never a move); `Cmd+C` copies the actual files
   so `Cmd+V` works in Finder; `Cmd+V` pastes files in. *(in progress)*
7. **Tags, notes, and pins** — one metadata layer keyed by file path.
8. **Configurable hotkey** — plus a preferences surface for it.
9. **Packaging** — `extend-info.plist`, build script, and an app icon matching
   the tray glyph.

## Development

```sh
npm install
npm start
```

Requires Node.js and macOS. The app has no Dock icon — it lives in the menu bar.

To regenerate the tray icon after editing `icon.svg`:

```sh
python3 build-icon.py
```

## Notes

Architecture, standing decisions, constraints, and known gotchas live in
[`context_v4.md`](context_v4.md).
