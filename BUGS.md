# BUGS

Open bugs first, then fixed. Architecture context is in
[`context_v5.md`](context_v5.md).

---

## OPEN

### A long-running instance stops showing the panel

**Found:** 2026-08-14. **Status:** open. **Almost certainly the same
underlying stability problem as the SIGSEGV below — not a separate bug.**

A packaged instance roughly 3 hours old stopped showing the panel entirely:
neither the hotkey nor the Toggle Panel menu item did anything. The tray and
Preferences kept working, so the main process was alive and IPC was fine.

**This is NOT a positioning bug and NOT a rendering bug.** Both were
investigated and excluded:

*Positioning — excluded.* An instrumented run logged state at eight
checkpoints across a full hide/show cycle. `win` was never null and never
destroyed; `opacity=1`; `minimized=false`; bounds were constant at
`888,123 304×421` with `insideWorkArea=true` every time, against
`workArea {0,30,1280,723}`. `togglePanel` took the correct branch each time
and `isVisible()` flipped correctly.

*Rendering — excluded.* On a fresh instance: no `did-fail-load`, **zero**
renderer console messages (uncaught exceptions would surface there), and a
DOM probe showing `readyState=complete`, 2.5MB of markup, **2442 rows
rendered**, both root tabs built, `panelRect 304×421`, background
`rgba(22,22,26,0.94)`, opacity 1, error element hidden, and all 40 preload
methods exposed. The CSP was also checked and is sufficient: the panel loads
only `renderer.js` and inline styles, with no image, font, `url()`, `data:`
or `fdfile:` resource anywhere.

*Fresh instances are fine.* Confirmed visually by the author.

So the failure is **state-dependent degradation in a long-running instance**,
which is exactly the profile of the SIGSEGV below: same build, packaged, and
only after hours of uptime. Treat them as one problem until evidence
separates them.

**What is now in place to catch it:** a heartbeat writes to `crash.log` every
5 minutes with uptime, RSS, whether each window exists and is visible, the
panel's bounds, the live watcher count, and the last action. If the panel
stops appearing again, the log will show whether the app was already in a bad
state beforehand — window destroyed, bounds drifted, watchers leaked, memory
climbing — rather than only recording the moment it was noticed.

**Note for next time:** the failing instance was killed to run the
instrumented test before its state was captured. Do not do that again — the
heartbeat now records passively, but `lsof`, the window state, and a
screenshot should be taken from the FAILING process first.

**Related gap, now fixed:** the off-screen clamp ran only in
`createWindow()`, never on show. Not the cause here, since bounds were valid,
but a real hole once a display is detached mid-session. `ensureOnScreen()`
now re-clamps on every show and logs when it moves the window.

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
