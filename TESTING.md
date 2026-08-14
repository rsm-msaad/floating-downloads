# TESTING

**There is no automated test suite.** No test runner, no CI. Everything below
was verified either by a one-off harness written during development or by hand.
This is the single largest gap in the project.

---

## Verified by harness

These were checked with throwaway Electron/Node harnesses that ran the real
shipped code under stubs. The harnesses were not kept — they were diagnostic,
not regression tests, which is itself a gap.

| What | How | Result |
|---|---|---|
| Path containment boundary | Extracted `ROOT_DEFS`/`getRoots`/`containingRoot`/`isAllowedSync` from `main.js` into a VM sandbox, stubbed only `app.getPath`. Planted real symlinks to `/etc` in both roots and created `~/DownloadsElsewhere` | Both roots allowed; symlink escape, `..`, `/`, home, `~/Documents` and the prefix decoy all rejected |
| CSP permits preview media | Read the real policy out of `index.html`, loaded a real image and PDF over `fdfile://`, captured renderer violations | Caught a missing `frame-src`; passes after the fix |
| `app.getFileIcon` size options | Bisected all options with synchronous file logging | `'large'` crashes; `'small'`/`'normal'`/omitted work. 120 real files at `'normal'`: ok=120 |
| `fs.watch` event delivery | Created/modified/renamed/deleted files and folders in a real directory, plus a 50-file burst and deleting the watched directory | Every case fires; `eventType` is almost always `'rename'` and unusable |
| Directory read timing | `~/Downloads`, 2437 items | 20.2ms cold, 13.5ms median warm |
| Folder size walk + cap | `~/Downloads`, `~/Desktop`, `node_modules` | Both roots hit the 20000 cap in <1s and report approximate; 3292 entries completes in 91ms |
| Clipboard round-trip | Wrote `NSFilenamesPboardType`, read pasteboard type via `osascript`; had the OS place a `furl` and read it back | Works both directions, including a filename with `&` and `<>` |
| Accelerator capture | Pure-function test with synthetic events | Correct strings; bare keys and modifier-only presses rejected |
| Hotkey fallback | Real register/unregister/restore sequence | Malformed accelerator throws; previous shortcut restored, app never left without one |
| Crash logging | Launched, killed, relaunched | All four line types written; Crashpad directory created |
| Packaged app is background-only | System Events foreground process list | Absent → no Dock icon, no Cmd-Tab |

## Verified by hand (author)

Per `context_v5.md`: drag out (including from the packaged build), column
navigation, multi-select drag, tray clicks, hotkey, preview window.

## Not verified by anyone

Everything below has only ever been reasoned about or checked structurally:

- Drop in from Finder — highlight, folder-row targeting, recursive folder copy,
  collision suffixes
- `Cmd+C` into Finder, `Cmd+V` from Finder, **multi-file** Finder copy
  (single-file is proven; the multi-file plist path is not)
- `Cmd+Delete` — the only destructive action in the app
- Tags, notes and pins end to end — pill rendering at 9px, popovers, tag
  suggestions, pin sorting
- Tag colour palette — right-click routing, creation-time swatches
- Folder preview card and its "Calculating…" → size transition
- Name tooltip — delay, placement, and that it does not interfere with drag
- Preferences window — recording a shortcut and it taking effect live

## Known gaps

1. **No regression tests.** Every finding above was proven once, by a harness
   that was then discarded. Nothing would catch a reintroduction — including
   the `getFileIcon` `'large'` crash, which is prevented only by a comment.
2. **No test for the security boundary in CI**, despite it being the most
   important invariant in the codebase.
3. **Long-running stability is untested**, which is how the `SIGSEGV` reached
   the packaged build. See `BUGS.md`.
