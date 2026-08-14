# BUGS

Open bugs first, then fixed. Architecture context is in
[`context_v5.md`](context_v5.md).

---

## OPEN

### The panel will not appear — hotkey and menu item both do nothing

**Found:** 2026-08-14. **Status:** diagnosed, not fixed.

Tray icon and Preferences both work, so the main process is alive and IPC is
fine. The panel simply never shows.

Ruled out by diagnosis:

- **Not off-screen.** Saved bounds `888,123 304×421` are *fully inside* the
  only attached display (`0,0 1280×800`, workArea `0,30 1280×723`).
  `getDisplayMatching` returns that display.
- **Renderer has not crashed.** No `render-process-gone` line in `crash.log`
  for the running instance.
- **The app does not think it is visible.** `lsof` shows **zero** file
  descriptors for `~/Downloads` or `~/Desktop`. Watchers are armed on show and
  dropped on hide, so their absence implies `isVisible()` is false. The panel
  is not showing invisibly somewhere.

Remaining hypotheses, in order of fit:

1. `showPanel()` takes the `isDestroyed()` branch, creates a fresh window, and
   `ready-to-show` never fires — so `showInactive()` is never called. Fits
   every observation without needing hotkey and menu to fail independently.
2. `togglePanel()` is never reached at all.
3. The window was destroyed and re-creation fails silently — `createWindow()`
   has no error handling on `loadFile`.

**Next step:** one instrumented run logging `win === null`, `isDestroyed()`,
`isVisible()` and `getBounds()` at the top of `togglePanel` and after
`showInactive()`. That separates all three in a single toggle.

**Related gap found while diagnosing:** the off-screen clamp runs **only** in
`createWindow()`, never on show. Not the cause here, since bounds are valid,
but a real hole if a display is detached while the app runs.

### SIGSEGV in the main process

**Found:** 2026-08-13. **Status:** unresolved, not reproduced since.

Three crash reports between 20:20 and 20:25, **two of them the packaged app**,
one `npm start`. All identical:

```
EXC_BAD_ACCESS / SIGSEGV
KERN_INVALID_ADDRESS at 0x00000000000000b8
faulting thread: CrBrowserMain   (main process, not a renderer)
```

`0xb8` is a null pointer plus a 184-byte field offset — the signature of
reading a field off a null object.

One instance survived **2m25s** before dying, which is why short reproduction
runs (18s, 35s) missed it.

**The stack in the `.ips` is not trustworthy.** Symbols read `ares_*`,
`fontations_*`, `v8::BackingStore` — nearest-symbol guesses inside a stripped
`Electron Framework`. What is reliable is the faulting thread.

Suspects, none confirmed: Tray (main-process native UI, and several instances
each held one during the crash window) · `app.getFileIcon` (already proven to
crash this build natively with `size:'large'`, and it runs on hover) ·
`webContents.startDrag` · the `fdfile://` handler · `fs.watch` teardown.

Crash logging added in `d5be862` — if it recurs, the next launch reports an
abrupt-end line naming the last action.

---

## FIXED

### `app.getFileIcon(path, {size:'large'})` crashes Electron 32.3.3

Native `NOTREACHED` → `SIGTRAP`, no catchable JS error, so the `try/catch`
around it did nothing. Bisected: `'small'`, `'normal'` and omitting options
all work; only `'large'` dies. Triggered by *hovering* the list, since icons
are warmed on `mouseenter`. Fixed in `f389878` by pinning `'normal'`, with a
comment warning against "upgrading" it.

### Dead space to the right of a single column

Looked like a column-management bug — the second column appeared to linger
after clicking a file. It did not: `flex-grow: 0` plus default
`justify-content: flex-start` pooled all slack on the right, and it was
present from first launch whenever total column width was less than the panel.
Fixed in `54f0ce9` with `.column:last-child { flex: 1 0 240px }`.

### Cmd/Shift-click wiped the selection it was meant to extend

`clearAllSelections()` cleared the current column too. Caught in self-review
before shipping; fixed with `clearSelectionsExcept(columnIndex)` in `54f0ce9`.

### PDF preview rendered blank

`object-src fdfile:` is not enough — Chromium's PDF viewer loads in a nested
browsing context and needs **`frame-src`**. Failure mode was a silent blank
frame. Caught by a CSP harness that read the real policy out of `index.html`
and captured renderer violations. Fixed in `f389878`.

### Tray left-click opened the menu instead of toggling

Assigning a context menu to a `Tray` makes left-click open it and suppresses
the `click` event. Fixed in `7040e56` by dropping `setContextMenu` and calling
`popUpContextMenu` on right-click.

### `sips` rejected `drag-icon.svg`

`--text` and `--muted` inside an XML comment — double hyphens are illegal
there, and the parser rejected the whole file (exit 13). Reworded.
