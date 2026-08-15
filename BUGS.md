# BUGS

Open bugs first, then fixed. Architecture context is in
[`context_v7.md`](context_v7.md).

---

## OPEN

None.

---

## WATCHING

### SIGSEGV in the main process

**Found:** 2026-08-13. **Status:** no recurrence since crash logging was
armed. Downgraded from open blocker on 2026-08-14.

Downgraded because the evidence does not support an active crash problem:

- The Crashpad database is **empty** — no `.dmp` files in `pending/`,
  `completed/` or `new/`. A SIGSEGV would deposit one
- **Every** termination recorded in `crash.log` is a `clean-quit`
- The `child-process-gone ... reason=killed exitCode=15` lines are **not**
  crashes. 15 is SIGTERM — Electron tearing down its GPU, network and
  renderer helpers during an orderly shutdown. They appear immediately
  before each `clean-quit`, which is the signature of a normal exit

It was also previously assumed to be the same underlying problem as the
panel bug below. That link is now broken: the panel bug turned out to be a
window-level mistake with nothing to do with process stability.

**Caveat, so this is not overstated:** `crash.log` only begins at
`2026-08-14T04:11Z`. The original three occurrences predate it. This is
evidence of *no recurrence*, not evidence they never happened. Keep crash
logging armed.

Original detail, retained:

Three crash reports between 20:20 and 20:25, **two of them the packaged
app**, one `npm start`. All identical:

```
EXC_BAD_ACCESS / SIGSEGV
KERN_INVALID_ADDRESS at 0x00000000000000b8
faulting thread: CrBrowserMain   (main process, not a renderer)
```

`0xb8` is a null pointer plus a 184-byte field offset — the signature of
reading a field off a null object.

One instance survived **2m25s** before dying, which is why short
reproduction runs (18s, 35s) missed it.

**The stack in the `.ips` is not trustworthy.** Symbols read `ares_*`,
`fontations_*`, `v8::BackingStore` — nearest-symbol guesses inside a
stripped `Electron Framework`. What is reliable is the faulting thread.

Suspects, none confirmed: Tray (main-process native UI, and several
instances each held one during the crash window) · `app.getFileIcon`
(already proven to crash this build natively with `size:'large'`, and it
runs on hover) · `webContents.startDrag` · the `fdfile://` handler ·
`fs.watch` teardown.

Crash logging added in `d5be862`.

---

## FIXED

### The panel stopped appearing — wrong window level

**Found:** 2026-08-14. **Fixed:** 2026-08-14 in `e5a729e`. Previously
filed as "a long-running instance stops showing the panel" and wrongly
assumed to be the same problem as the SIGSEGV above.

The panel was created with `setAlwaysOnTop(true, 'floating')`.
`'floating'` is `NSFloatingWindowLevel`, level 3, and **a macOS fullscreen
app stacks above it**. `setVisibleOnAllWorkspaces` with
`visibleOnFullScreen` correctly put the panel on the fullscreen app's
Space, and then the level rendered it *underneath* the fullscreen window.

The two calls do different jobs and both are required:
`setVisibleOnAllWorkspaces` decides **which Space** the window is on; the
level decides **what it stacks above** once it is there. Right on the
first, wrong on the second, produces a window that is genuinely present,
visible by every API measure, and completely unseeable.

Two compounding factors:

1. The settings were applied **once, at creation**. macOS drops both across
   sleep/wake, display reconfiguration and fullscreen transitions. That is
   what made it look time-dependent — "a long-running instance degraded" was
   really "the machine slept and the window server reset the level"
2. `togglePanel` branches on `isVisible()`. While the panel was covered but
   still reporting visible, every hotkey press called `hidePanel()`. Nothing
   appeared to happen and the next press showed it. Pressing twice was the
   workaround, which is why it felt intermittent

**Why the original investigation missed it.** Every finding in it was
correct. It checked `win` was not null or destroyed, that `togglePanel`
branched right, that bounds were inside the work area, that `opacity=1` and
`minimized=false`, that the renderer loaded cleanly, that the DOM was fully
populated, and that CSP raised no violations.

Every one of those asks about the window's **own state**. Not one asks what
is stacked **above** it. A window can be healthy, correctly positioned,
fully painted, and simply covered. `isVisible()` cannot see that. The
fresh-instance test could not reproduce it for the same reason plus one
more: a fresh instance has not slept yet, so its level is still intact.

**What actually settled it:** a framebuffer screenshot (`screencapture -x`)
taken while the heartbeat reported `panel=ok/visible` showed no panel
anywhere on screen. That single contradiction killed every window-state
hypothesis at once. The screenshot also showed no menu bar, meaning a
fullscreen app was frontmost — which supplied the missing mechanism.

**The fix.** All level and Space configuration moved into one function,
`applyPanelLevel()`, using `'screen-saver'` — the level that actually
clears a fullscreen app. Called at four points, all of which matter:
`createWindow()`, `showPanel()` on every show, `powerMonitor` `'resume'`,
and `screen` `'display-metrics-changed'`. `showPanel()` also calls
`moveTop()`, which reorders without activating, so the no-focus-stealing
rule still holds.

The preview window and Preferences were raised to `'screen-saver'` too.
Preferences additionally gained the `setVisibleOnAllWorkspaces` call it
never had.

**Verification status:** the fullscreen case is **confirmed** — tested
directly by the author with repeated hotkey presses over fullscreen Chrome.
The sleep/wake case is **not yet observed**; it is reasoned from the
heartbeat gaps in `crash.log`. After the next real wake, `crash.log` should
contain `resume: re-applied panel level and workspace visibility`.

**Related gap, fixed earlier and still valid:** the off-screen clamp ran
only in `createWindow()`, never on show. Not the cause here, since bounds
were always valid, but a real hole once a display is detached mid-session.
`ensureOnScreen()` now re-clamps on every show and logs when it moves the
window.

**Note for next time, retained from the original entry:** the failing
instance was killed to run the instrumented test before its state was
captured. Do not do that again — take `lsof`, the window state, and **a
screenshot** from the FAILING process first. The screenshot is the one that
would have solved this immediately.

### A long-running instance stops showing the panel

**Superseded.** See the entry above — same symptom, actual cause found.
Retained here only so the original reasoning is not lost.

**Found:** 2026-08-14. **Status:** resolved. Originally believed to be the
same underlying stability problem as the SIGSEGV — it was not.

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
which is exactly the profile of the SIGSEGV: same build, packaged, and only
after hours of uptime. Treat them as one problem until evidence separates
them.

*(Both conclusions above were wrong. The failure was not state-dependent
degradation, and the two were unrelated. The reasoning was sound given what
had been measured — the flaw was that everything measured described the
window itself, and nothing described what was in front of it.)*

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
