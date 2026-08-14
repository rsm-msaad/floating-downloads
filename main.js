const {
  app, BrowserWindow, Menu, Tray, screen, globalShortcut, ipcMain, nativeImage,
  shell, clipboard, protocol, net, crashReporter
} = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL, fileURLToPath } = require('url');

// Media and PDF previews stream through this scheme instead of being base64'd
// over IPC, which would mean holding an entire video in memory twice. It must
// be declared privileged BEFORE the app is ready, and `stream: true` is what
// makes range requests work — without it, video seeking breaks.
const PREVIEW_SCHEME = 'fdfile';
protocol.registerSchemesAsPrivileged([{
  scheme: PREVIEW_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
}]);

// ── Crash logging ─────────────────────────────────────────
// A SIGSEGV on CrBrowserMain kills the main process outright, so NO
// JavaScript handler can observe it — not child-process-gone, not
// render-process-gone, not uncaughtException. Three mechanisms are used
// together:
//   1. crashReporter writes a local minidump for main-process crashes.
//   2. A breadcrumb log: every session writes 'start', and a clean exit
//      writes 'clean-quit'. A 'start' with no matching 'clean-quit' is how
//      an abrupt death is detected — on the NEXT launch.
//   3. child-process-gone / render-process-gone for renderer and GPU
//      crashes, which the main process does survive.
// Must be started before the app is ready to catch early crashes.
crashReporter.start({ uploadToServer: false });

// A rolling breadcrumb, so a crash log says what the app was last doing
// rather than only that it died.
let lastAction = 'idle';

function note(action) {
  lastAction = action;
}

function crashLogFile() {
  return path.join(app.getPath('userData'), 'crash.log');
}

function logEvent(line) {
  try {
    fs.appendFileSync(crashLogFile(), `${new Date().toISOString()}  ${line}\n`);
  } catch (err) {
    console.error(`[crash] could not write crash.log: ${err.message}`);
  }
}

// ── Heartbeat ─────────────────────────────────────────────
// The app is meant to run for days in the menu bar, and the failure that
// prompted this was a long-running instance whose panel stopped appearing
// while a fresh one was fine. A periodic sample means the log can show
// whether the app was ALREADY in a bad state before the user noticed,
// rather than only recording the moment they complained.

const HEARTBEAT_MS = 5 * 60 * 1000;
let heartbeatTimer = null;

function describeWindow(target, label) {
  if (!target) return `${label}=null`;
  if (target.isDestroyed()) return `${label}=DESTROYED`;
  return `${label}=ok/${target.isVisible() ? 'visible' : 'hidden'}`;
}

function heartbeat() {
  const uptimeMinutes = Math.round(process.uptime() / 60);
  const rssMb = Math.round(process.memoryUsage().rss / 1048576);

  // Bounds are the other thing worth sampling: a window that drifts
  // off-screen would show up here before anyone noticed it visually.
  let bounds = 'n/a';
  if (win && !win.isDestroyed()) bounds = JSON.stringify(win.getBounds());

  logEvent(
    `heartbeat uptime=${uptimeMinutes}m rss=${rssMb}MB ` +
    `${describeWindow(win, 'panel')} bounds=${bounds} ` +
    `${describeWindow(previewWin, 'preview')} ${describeWindow(prefsWin, 'prefs')} ` +
    `watchers=${watchers.size} lastAction=${lastAction}`
  );
}

function startHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS);
  // Do not hold the event loop open on account of logging.
  if (heartbeatTimer.unref) heartbeatTimer.unref();
  heartbeat(); // one sample immediately, so a short session still logs one
}

// Called at startup, before this session's 'start' line is written.
function reportPreviousSession() {
  let text = '';
  try {
    text = fs.readFileSync(crashLogFile(), 'utf8').trimEnd();
  } catch (err) {
    return; // first run
  }
  if (!text) return;

  const last = text.split('\n').pop();
  if (last.includes('  start ')) {
    const message =
      'PREVIOUS SESSION ENDED ABRUPTLY — no clean-quit line. Most likely a ' +
      'native crash in the main process. Check ~/Library/Logs/DiagnosticReports ' +
      `and ${app.getPath('crashDumps')}. Last action before it died: ${last}`;
    logEvent(`!! ${message}`);
    console.error(`[crash] ${message}`);
  }
}

let win = null;
let tray = null;
let settings = { hotkey: 'CommandOrControl+Shift+D' };

const DEFAULT_HOTKEY = 'CommandOrControl+Shift+D';
const PANEL_WIDTH = 380;
const PANEL_HEIGHT = 520;

// ── Atomic JSON persistence ───────────────────────────────
// Write to a temp file in the same directory, then rename over the target.
// rename(2) is atomic within a filesystem, so a crash mid-write leaves the
// previous file intact instead of truncating it. The reference app used a
// bare writeFileSync inside an empty catch, which loses data silently.

function readJson(filePath, fallback) {
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(filePath, 'utf8')) };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[state] could not read ${path.basename(filePath)}: ${err.message}`);
    }
    return { ...fallback };
  }
}

function writeJsonAtomic(filePath, data) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, filePath);
    return true;
  } catch (err) {
    console.error(`[state] could not write ${path.basename(filePath)}: ${err.message}`);
    try { fs.unlinkSync(tmp); } catch (cleanupErr) { /* temp file may not exist */ }
    return false;
  }
}

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function stateFile() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadSettings() {
  const file = settingsFile();
  settings = readJson(file, { hotkey: DEFAULT_HOTKEY, activeRoot: 'downloads' });

  // Materialise the file on first run so the hotkey is actually editable by
  // hand before a preferences UI exists, and so the failure message below
  // points at a path that really is there.
  if (!fs.existsSync(file)) writeJsonAtomic(file, settings);
}

function loadState() {
  const saved = readJson(stateFile(), {});
  return typeof saved.width === 'number' && typeof saved.height === 'number' ? saved : null;
}

function saveState() {
  if (!win || win.isDestroyed()) return;
  writeJsonAtomic(stateFile(), win.getBounds());
}

// ── Window ────────────────────────────────────────────────

// Pull a rectangle back onto a real display's work area. getDisplayMatching
// returns the NEAREST display when the rectangle is off all of them, so a
// window stranded by an unplugged monitor lands somewhere reachable rather
// than being clamped against a display it is nowhere near.
function clampToWorkArea(bounds) {
  const area = screen.getDisplayMatching(bounds).workArea;
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  return {
    width,
    height,
    x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height))
  };
}

// Called on every show, not only at creation. Displays can change while the
// app is running — it lives in the menu bar for days — so bounds validated
// once at launch are not validated forever. No-ops when nothing moves, so a
// normal show does not incur a setBounds.
function ensureOnScreen() {
  if (!win || win.isDestroyed()) return;
  const current = win.getBounds();
  const clamped = clampToWorkArea(current);
  if (
    clamped.x === current.x && clamped.y === current.y &&
    clamped.width === current.width && clamped.height === current.height
  ) return;

  win.setBounds(clamped);
  const message = `moved back on-screen ${JSON.stringify(current)} -> ${JSON.stringify(clamped)}`;
  console.log(`[window] ${message}`);
  logEvent(message);
}

function createWindow() {
  const saved = loadState();
  const area = screen.getPrimaryDisplay().workArea;

  // Clamp a restored position so the window never opens off-screen, e.g.
  // after a display is unplugged. ensureOnScreen() repeats this on every
  // show, since the display layout can change while the app runs.
  const start = saved ? clampToWorkArea(saved) : null;

  win = new BrowserWindow({
    width: start ? start.width : PANEL_WIDTH,
    height: start ? start.height : PANEL_HEIGHT,
    x: start ? start.x : area.x + area.width - PANEL_WIDTH - 40,
    y: start ? start.y : area.y + 60,
    minWidth: 280,
    minHeight: 200,
    frame: false,
    transparent: true,
    hasShadow: true,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    // The panel is summoned with showInactive(), so it is not the focused
    // window. Without this, macOS swallows the first click to activate the
    // window and the row never sees it — meaning the first click-drag after
    // pressing the hotkey would do nothing.
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Chromium's built-in PDF viewer is a plugin; without this an embedded
      // PDF renders as a blank frame.
      plugins: true
    }
  });

  win.loadFile(path.join(__dirname, 'index.html'));

  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.on('moved', saveState);
  win.on('resized', saveState);
}

// Show without stealing focus. See context_v2.md constraint #2: Electron has
// no equivalent of NSPanel's nonactivatingPanel, and focusable:false would
// disable keyboard input entirely. showInactive() is the resolution — never
// show() + focus(), which would redirect the user's typing mid-sentence.
function showPanel() {
  if (!win || win.isDestroyed()) {
    createWindow();
    win.once('ready-to-show', () => {
      ensureOnScreen();
      win.showInactive();
    });
    return;
  }
  // Displays may have changed since the last show.
  ensureOnScreen();
  win.showInactive();
  // The renderer re-reads the folder on this, so the list is current every
  // time the hotkey is pressed. Live watching is phase 5.
  if (!win.webContents.isDestroyed()) win.webContents.send('panel-shown');
}

function hidePanel() {
  if (!win || win.isDestroyed()) return;
  win.hide();
  // One-directional by design: hiding the panel hides the preview, but
  // showing the panel does NOT bring the preview back, and nothing the
  // preview does affects the panel. See the preview window section.
  hidePreviewWindow();
  // No point watching for a window nobody can see. The renderer re-arms
  // these on 'panel-shown', after it has refreshed.
  unwatchAll();
}

function togglePanel() {
  if (!win || win.isDestroyed()) {
    showPanel();
    return;
  }
  if (win.isVisible()) {
    hidePanel();
  } else {
    showPanel();
  }
}

// ── Global hotkey ─────────────────────────────────────────

// Returns true only if the accelerator is now live.
function tryRegister(accelerator) {
  try {
    // register() throws on a malformed accelerator string rather than
    // returning false, so both failure modes have to be handled.
    return globalShortcut.register(accelerator, togglePanel);
  } catch (err) {
    console.error(`[hotkey] "${accelerator}" is not a valid accelerator: ${err.message}`);
    return false;
  }
}

function registerHotkey() {
  const accelerator = settings.hotkey || DEFAULT_HOTKEY;

  if (tryRegister(accelerator)) {
    console.log(`[hotkey] registered ${accelerator}`);
    return;
  }

  console.error(
    `[hotkey] FAILED to register "${accelerator}" — another app has already ` +
    `claimed it, or macOS reserves it. The tray menu still toggles the panel. ` +
    `Change it in Preferences.`
  );

  // Never leave the app with no working hotkey if a fallback is available.
  if (accelerator !== DEFAULT_HOTKEY && tryRegister(DEFAULT_HOTKEY)) {
    settings.hotkey = DEFAULT_HOTKEY;
    writeJsonAtomic(settingsFile(), settings);
    console.log(`[hotkey] fell back to ${DEFAULT_HOTKEY}`);
  }
}

// Swap the global shortcut live, with no restart. The old one is released
// first — macOS will not hand the same combination to two registrations —
// and restored if the new one cannot be claimed, so the app is never left
// with no working hotkey.
function changeHotkey(accelerator) {
  const previous = settings.hotkey || DEFAULT_HOTKEY;

  if (typeof accelerator !== 'string' || accelerator.trim() === '') {
    return { ok: false, hotkey: previous, error: 'That is not a valid shortcut.' };
  }

  globalShortcut.unregister(previous);

  if (tryRegister(accelerator)) {
    settings = { ...settings, hotkey: accelerator };
    writeJsonAtomic(settingsFile(), settings);
    refreshTrayMenu();
    console.log(`[hotkey] changed to ${accelerator}`);
    return { ok: true, hotkey: accelerator };
  }

  // Put the previous one back rather than leaving the user with nothing.
  const restored = tryRegister(previous);
  if (!restored) {
    console.error(`[hotkey] could not restore "${previous}" after a failed change`);
  }
  console.error(`[hotkey] "${accelerator}" is unavailable — another app holds it`);

  return {
    ok: false,
    hotkey: previous,
    error: `${accelerator} is already used by another app. Still using ${previous}.`
  };
}

// ── Tray ──────────────────────────────────────────────────

// Rebuilt whenever the hotkey changes, so the menu's accelerator label stays
// truthful.
let trayMenu = null;

function refreshTrayMenu() {
  trayMenu = Menu.buildFromTemplate([
    { label: 'Toggle Panel', accelerator: settings.hotkey || DEFAULT_HOTKEY, click: togglePanel },
    { type: 'separator' },
    { label: 'Preferences…', click: () => openPreferences() },
    { type: 'separator' },
    { role: 'quit', label: 'Quit FloatingDownloads' }
  ]);
}

function createTray() {
  // trayTemplate.png + @2x: the "Template" suffix is the macOS convention
  // that makes the icon auto-invert for light and dark menu bars.
  tray = new Tray(path.join(__dirname, 'trayTemplate.png'));
  tray.setToolTip('FloatingDownloads');

  refreshTrayMenu();

  // Deliberately NOT tray.setContextMenu(menu). On macOS, assigning a
  // context menu makes a left-click open that menu and suppresses the
  // 'click' event, so left-click could never toggle the panel. Popping the
  // menu up by hand on right-click keeps both gestures working.
  tray.on('click', togglePanel);
  tray.on('right-click', () => tray.popUpContextMenu(trayMenu));
}

// ── Downloads listing ─────────────────────────────────────
// All filesystem access lives here in the main process. The renderer never
// sees fs or any Node API — it gets plain objects across the bridge.

// The allowed roots are the navigation ceiling. This is a security boundary,
// not a UI convenience: the renderer may ask for any path, so every request
// is resolved through realpath (which follows symlinks) and rejected unless
// the REAL path is one of the roots or lives beneath one. Resolving AFTER
// checking would let a symlink inside a root point anywhere on the disk.
//
// To add a third root, add one entry here. Everything else — reading,
// dragging, Quick Look, Reveal, Copy Path, Move to Trash — validates through
// containingRoot() and needs no change.
const ROOT_DEFS = [
  { key: 'downloads', label: 'Downloads', pathName: 'downloads' },
  { key: 'desktop', label: 'Desktop', pathName: 'desktop' }
];

let cachedRoots = null;

// Resolved synchronously: startDrag has to validate while the drag gesture is
// still live, so an async-only resolver would be unusable there. Both the
// sync and async call sites share this one cache, so they can never disagree
// about what is allowed.
function getRoots() {
  if (cachedRoots) return cachedRoots;
  cachedRoots = [];
  for (const def of ROOT_DEFS) {
    try {
      cachedRoots.push({ ...def, path: fs.realpathSync(app.getPath(def.pathName)) });
    } catch (err) {
      console.error(`[roots] cannot resolve ${def.label}: ${err.code || err.message}`);
    }
  }
  return cachedRoots;
}

// Returns the root containing realPath, or null. The separator matters:
// without it, "/Users/x/DownloadsElsewhere" would pass a naive startsWith
// check against "/Users/x/Downloads".
// Is `child` the same path as `parent`, or beneath it? The separator guard
// is the same one the root check relies on.
function isInside(child, parent) {
  return child === parent || child.startsWith(parent + path.sep);
}

function containingRoot(realPath) {
  return getRoots().find(
    (root) => realPath === root.path || realPath.startsWith(root.path + path.sep)
  ) || null;
}

ipcMain.handle('roots:list', () => ({
  roots: getRoots().map(({ key, label, path: rootPath }) => ({ key, label, path: rootPath })),
  activeRoot: settings.activeRoot || ROOT_DEFS[0].key
}));

ipcMain.on('settings:active-root', (event, key) => {
  if (!getRoots().some((root) => root.key === key)) return;
  settings = { ...settings, activeRoot: key };
  writeJsonAtomic(settingsFile(), settings);
});

async function readDirectory(requestedPath) {
  const roots = getRoots();
  if (roots.length === 0) return { ok: false, code: 'ENOROOT' };

  const target = typeof requestedPath === 'string' && requestedPath ? requestedPath : roots[0].path;

  let dir;
  try {
    dir = await fs.promises.realpath(target);
  } catch (err) {
    console.error(`[read] cannot resolve ${target}: ${err.code || 'UNKNOWN'}`);
    return { ok: false, code: err.code || 'UNKNOWN' };
  }

  if (!containingRoot(dir)) {
    console.error(`[security] blocked read outside all roots: ${target} resolved to ${dir}`);
    return { ok: false, code: 'EOUTSIDE' };
  }

  let dirents;
  try {
    dirents = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    // Most likely EPERM/EACCES from macOS TCC on first read, since this app
    // is unsigned, or ENOENT if the folder has been moved.
    console.error(`[downloads] cannot read ${dir}: ${err.code || 'UNKNOWN'} — ${err.message}`);
    return { ok: false, code: err.code || 'UNKNOWN', dir };
  }

  // Leading dot covers .DS_Store along with every other dotfile.
  const visible = dirents.filter((dirent) => !dirent.name.startsWith('.'));

  // Stat concurrently. This folder can hold thousands of entries and the
  // list is rebuilt on every panel show, so a sequential await here would
  // be thousands of serial round-trips.
  const settled = await Promise.all(visible.map(async (dirent) => {
    const fullPath = path.join(dir, dirent.name);
    let stats;
    try {
      // stat() follows symlinks, so an alias to a folder reads as a folder.
      stats = await fs.promises.stat(fullPath);
    } catch (err) {
      try {
        // Broken symlink: fall back to the link itself rather than dropping it.
        stats = await fs.promises.lstat(fullPath);
      } catch (lstatErr) {
        console.error(`[downloads] skipping ${dirent.name}: ${lstatErr.message}`);
        return null;
      }
    }
    const meta = entryFor(fullPath);
    return {
      name: dirent.name,
      path: fullPath,
      isDirectory: stats.isDirectory(),
      modified: stats.mtimeMs,
      tags: meta.tags,
      pinned: meta.pinned,
      // The note text itself is fetched on demand; a boolean is all the row
      // needs, and shipping every note with every listing would be wasteful.
      hasNote: meta.note.length > 0
    };
  }));

  const items = settled.filter(Boolean);
  // Pinned first, newest-first within each group.
  items.sort((a, b) => (b.pinned === true) - (a.pinned === true) || b.modified - a.modified);
  return {
    ok: true,
    items,
    dir,
    isRoot: getRoots().some((root) => root.path === dir),
    // Shipped with every listing so pills can never render with a stale
    // colour map.
    tagColors: metadata.tagColors
  };
}

ipcMain.handle('dir:read', (event, requestedPath) => readDirectory(requestedPath));

// ── Live watching ─────────────────────────────────────────
// Only while the panel is visible: a hidden window has no reason to burn
// cycles. Watchers are torn down on hide and re-established on show.

const WATCH_DEBOUNCE_MS = 300;

// A download in progress rewrites its temp file constantly. Ignoring these
// keeps the list from thrashing; the real file appearing on completion is a
// separate event that does trigger a refresh.
const IGNORED_SUFFIXES = ['.crdownload', '.part', '.download'];

// dirPath -> { watcher, timer }
const watchers = new Map();

function isNoisyChange(filename) {
  // fs.watch can report a null filename; with no name to judge, refresh.
  if (!filename) return false;
  if (filename.startsWith('.')) return true;
  const lower = filename.toLowerCase();
  return IGNORED_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function scheduleColumnRefresh(dirPath) {
  const entry = watchers.get(dirPath);
  if (!entry) return;

  // Debounced so a burst of events during a download collapses into one
  // read rather than one per event.
  clearTimeout(entry.timer);
  entry.timer = setTimeout(async () => {
    entry.timer = null;
    if (!watchers.has(dirPath)) return;
    const result = await readDirectory(dirPath);
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      // Only this directory's contents cross the bridge, never the whole trail.
      win.webContents.send('dir-changed', { path: dirPath, result });
    }
  }, WATCH_DEBOUNCE_MS);
}

function unwatchDir(dirPath) {
  const entry = watchers.get(dirPath);
  if (!entry) return;
  clearTimeout(entry.timer);
  try {
    entry.watcher.close();
  } catch (err) {
    // Already closed.
  }
  watchers.delete(dirPath);
}

function unwatchAll() {
  for (const dirPath of [...watchers.keys()]) unwatchDir(dirPath);
}

function watchDir(dirPath) {
  if (watchers.has(dirPath)) return;
  if (!isAllowedSync(dirPath)) {
    console.error('[security] refused to watch a path outside all roots');
    return;
  }

  let watcher;
  try {
    // fs.watch, not fs.watchFile: the latter polls.
    watcher = fs.watch(dirPath, { persistent: false });
  } catch (err) {
    console.error(`[watch] cannot watch ${path.basename(dirPath)}: ${err.code || err.message}`);
    return;
  }

  watchers.set(dirPath, { watcher, timer: null });

  watcher.on('change', (eventType, filename) => {
    if (isNoisyChange(filename)) return;
    scheduleColumnRefresh(dirPath);
  });

  watcher.on('error', (err) => {
    console.error(`[watch] ${path.basename(dirPath)} failed: ${err.message}`);
    unwatchDir(dirPath);
  });
}

// The renderer sends the current trail; this reconciles rather than
// rebuilding, so unchanged columns keep their existing watcher. Columns that
// have closed are unwatched here — that is what prevents leaks.
ipcMain.on('watch:set', (event, paths) => {
  const wanted = new Set(Array.isArray(paths) ? paths : []);
  note(`watch:set n=${wanted.size}`);
  for (const dirPath of [...watchers.keys()]) {
    if (!wanted.has(dirPath)) unwatchDir(dirPath);
  }
  for (const dirPath of wanted) watchDir(dirPath);
});

// ── Drag out ──────────────────────────────────────────────
// Dragging a file to another app is NOT HTML5 drag and drop. The renderer
// cancels the HTML5 drag and hands the paths here; webContents.startDrag
// runs the real macOS drag session.
//
// startDrag must be called synchronously while the drag gesture is live, so
// the icon cannot be awaited at that moment. app.getFileIcon is async, so
// icons are warmed ahead of time (on hover and on selection) and read from
// the cache here. A cache miss falls back to the generic icon rather than
// delaying the drag.

// app.getFileIcon(path, { size: 'large' }) CRASHES the whole app on
// Electron 32.3.3 / macOS — a native NOTREACHED check failure, SIGTRAP, no
// catchable JS error. 'small', 'normal', and omitting options all work.
// 'normal' returns 32x32, so that is the drag icon size. Do not "upgrade"
// this to 'large'.
const FILE_ICON_SIZE = 'normal';
const DRAG_ICON_PX = 32;
const ICON_CACHE_LIMIT = 500;

const iconCache = new Map();
let genericDragIcon = null;

function getGenericDragIcon() {
  if (!genericDragIcon || genericDragIcon.isEmpty()) {
    genericDragIcon = nativeImage
      .createFromPath(path.join(__dirname, 'dragIcon.png'))
      .resize({ width: DRAG_ICON_PX, height: DRAG_ICON_PX });
  }
  return genericDragIcon;
}

async function warmIcon(filePath) {
  if (iconCache.has(filePath)) return;
  note(`getFileIcon ${path.basename(filePath)}`);
  try {
    const image = await app.getFileIcon(filePath, { size: FILE_ICON_SIZE });
    if (image.isEmpty()) return;
    if (iconCache.size >= ICON_CACHE_LIMIT) iconCache.clear();
    iconCache.set(filePath, image.resize({ width: DRAG_ICON_PX, height: DRAG_ICON_PX }));
  } catch (err) {
    console.error(`[drag] icon lookup failed for ${path.basename(filePath)}: ${err.message}`);
  }
}

ipcMain.on('drag:warm', (event, paths) => {
  if (!Array.isArray(paths)) return;
  for (const filePath of paths.slice(0, 40)) {
    if (isAllowedSync(filePath)) warmIcon(filePath);
  }
});

// The same ceiling applies to dragging, not just reading: the renderer hands
// over paths, so they are re-validated here rather than trusted. Sync because
// startDrag has to be called while the drag gesture is still live.
function isAllowedSync(filePath) {
  try {
    // getRoots() resolves lazily and caches, so this never depends on an
    // async read having run first: a drag could otherwise be rejected purely
    // because of call ordering.
    return containingRoot(fs.realpathSync(filePath)) !== null;
  } catch (err) {
    return false;
  }
}

ipcMain.on('drag:start', (event, paths) => {
  if (!Array.isArray(paths) || paths.length === 0) return;
  note(`drag:start n=${paths.length}`);

  const allowed = paths.filter(isAllowedSync);
  if (allowed.length !== paths.length) {
    console.error(`[security] blocked drag of ${paths.length - allowed.length} path(s) outside Downloads`);
  }
  if (allowed.length === 0) return;
  paths = allowed;

  // Real file icon for a single drag, generic stack for a multi-file drag.
  let icon = paths.length === 1 ? iconCache.get(paths[0]) : null;
  if (!icon || icon.isEmpty()) icon = getGenericDragIcon();

  if (!icon || icon.isEmpty()) {
    // startDrag throws on an empty icon, so bail with a reason instead.
    console.error('[drag] no usable icon — is dragIcon.png missing? drag aborted');
    return;
  }

  try {
    event.sender.startDrag({ file: paths[0], files: paths, icon });
  } catch (err) {
    console.error(`[drag] startDrag failed: ${err.message}`);
  }
});

// ── File actions ──────────────────────────────────────────
// Every path is re-validated against the ~/Downloads ceiling before any
// operation. The renderer supplies these paths, so they are not trusted —
// least of all for Move to Trash.

ipcMain.on('file:open', async (event, filePath) => {
  if (!isAllowedSync(filePath)) {
    console.error('[security] blocked open outside Downloads');
    return;
  }
  // openPath resolves with an error STRING rather than rejecting.
  const problem = await shell.openPath(filePath);
  if (problem) console.error(`[open] ${path.basename(filePath)}: ${problem}`);
});

ipcMain.on('menu:show', (event, paths, destDir) => {
  if (!Array.isArray(paths)) return;
  const allowed = paths.filter(isAllowedSync);
  if (allowed.length !== paths.length) {
    console.error(`[security] blocked menu for ${paths.length - allowed.length} path(s) outside all roots`);
  }
  if (allowed.length === 0) return;

  const menu = Menu.buildFromTemplate([
    {
      label: 'Reveal in Finder',
      // Multi-selection reveals the first item only.
      click: () => shell.showItemInFolder(allowed[0])
    },
    {
      label: 'Copy',
      // The files themselves, so Cmd+V works in Finder. Distinct from
      // Copy Path below, which copies text.
      click: () => writeFilesToClipboard(allowed)
    },
    {
      label: 'Copy Path',
      // One full POSIX path per line for a multi-selection.
      click: () => clipboard.writeText(allowed.join('\n'))
    },
    {
      label: 'Paste',
      enabled: readFilesFromClipboard().length > 0 && !!destDir && isAllowedSync(destDir),
      click: async () => {
        const result = await copyInto(destDir, readFilesFromClipboard());
        if (result.errors.length > 0 && win && !win.isDestroyed()) {
          win.webContents.send('operation-error', result.errors);
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Add Tag…',
      // A native menu cannot host a text field, so the renderer opens its
      // tag popover for the row instead.
      click: () => event.sender.send('open-tag-editor', allowed[0])
    },
    {
      label: entryFor(allowed[0]).note ? 'Edit Note…' : 'Add Note…',
      click: () => event.sender.send('open-note-editor', allowed[0])
    },
    {
      label: entryFor(allowed[0]).pinned ? 'Unpin' : 'Pin',
      click: async () => {
        // Multi-selection pins all of them, matching the clicked row's
        // resulting state rather than toggling each independently.
        const pin = !entryFor(allowed[0]).pinned;
        for (const target of allowed) {
          updateEntry(target, (draft) => { draft.pinned = pin; });
        }
        await notifyDirOf(allowed[0]);
      }
    },
    { type: 'separator' },
    {
      label: 'Move to Trash',
      // No confirmation: trashItem is recoverable from the Finder Trash.
      // Shares one implementation with the Cmd+Delete shortcut.
      click: async () => {
        const result = await trashPaths(allowed);
        if (result.errors.length > 0 && win && !win.isDestroyed()) {
          win.webContents.send('operation-error', result.errors);
        }
      }
    }
  ]);

  menu.popup({ window: BrowserWindow.fromWebContents(event.sender) });
});


// ── Metadata: tags, notes, pins ───────────────────────────
// One layer keyed by absolute path, in a single JSON file.
//
// Orphans are dropped on load, deliberately: metadata is keyed by path, so
// renaming or moving a file loses its tags and note. That is the author's
// decision, made knowingly (context_v4.md). There is no path-following or
// recovery logic here on purpose — do not add any.

let metadata = { version: 1, entries: {}, knownTags: [], tagColors: {} };

// A fixed set rather than a full colour picker. Mid lightness and modest
// saturation so pills stay legible at 9px uppercase without glowing against
// the dark panel. Four are existing project tokens, so tagged rows look
// native rather than bolted on.
const TAG_PALETTE = [
  { name: 'Coral', value: '#F0736A' },
  { name: 'Amber', value: '#E8A54B' },
  { name: 'Mint', value: '#7EE0B0' },
  { name: 'Blue', value: '#7B94C4' },
  { name: 'Purple', value: '#A98BD1' },
  { name: 'Pink', value: '#DB86A8' },
  { name: 'Teal', value: '#6FC5C0' },
  { name: 'Lime', value: '#A8C46A' },
  { name: 'Grey', value: '#9A9AA4' }
];

function metadataFile() {
  return path.join(app.getPath('userData'), 'metadata.json');
}

function isEmptyEntry(entry) {
  return (!entry.tags || entry.tags.length === 0) && !entry.note && !entry.pinned;
}

function loadMetadata() {
  const loaded = readJson(metadataFile(), { version: 1, entries: {}, knownTags: [] });
  const entries = {};
  let pruned = 0;

  // Prune here rather than scanning constantly.
  for (const [filePath, entry] of Object.entries(loaded.entries || {})) {
    if (!entry || isEmptyEntry(entry)) continue;
    if (!fs.existsSync(filePath)) { pruned++; continue; }
    entries[filePath] = {
      tags: Array.isArray(entry.tags) ? entry.tags : [],
      note: typeof entry.note === 'string' ? entry.note : '',
      pinned: entry.pinned === true
    };
  }

  metadata = {
    version: 1,
    entries,
    // Every tag ever used is remembered, even once no file carries it.
    knownTags: Array.isArray(loaded.knownTags) ? loaded.knownTags : [],
    // Keyed by tag NAME, not by file: setting "urgent" to red makes every
    // urgent pill red everywhere. Never pruned, so reusing a tag months
    // later keeps the colour it was given.
    tagColors: loaded.tagColors && typeof loaded.tagColors === 'object' ? loaded.tagColors : {}
  };

  if (pruned > 0) {
    console.log(`[metadata] pruned ${pruned} orphaned entr${pruned === 1 ? 'y' : 'ies'}`);
    saveMetadata();
  }
}

function saveMetadata() {
  writeJsonAtomic(metadataFile(), metadata);
}

function entryFor(filePath) {
  return metadata.entries[filePath] || { tags: [], note: '', pinned: false };
}

function updateEntry(filePath, mutate) {
  const entry = { ...entryFor(filePath) };
  entry.tags = [...entry.tags];
  mutate(entry);

  if (isEmptyEntry(entry)) delete metadata.entries[filePath];
  else metadata.entries[filePath] = entry;

  saveMetadata();
  return entry;
}

// Tell the renderer to redraw the row's column.
async function notifyDirOf(filePath) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  const parent = path.dirname(filePath);
  const result = await readDirectory(parent);
  win.webContents.send('dir-changed', { path: parent, result });
}

function guardPath(filePath) {
  if (typeof filePath === 'string' && filePath && isAllowedSync(filePath)) return true;
  console.error('[security] blocked metadata write for a path outside all roots');
  return false;
}

ipcMain.handle('meta:known-tags', () => metadata.knownTags);

// The palette lives here so main and the renderer cannot drift apart about
// which colours are valid.
ipcMain.handle('meta:palette', () => TAG_PALETTE);

ipcMain.handle('meta:tag-colors', () => metadata.tagColors);

// color === null resets the tag to its automatic, name-derived colour.
ipcMain.handle('meta:set-tag-color', (event, tag, color) => {
  const label = String(tag || '').trim();
  if (!label) return metadata.tagColors;

  if (color === null || color === undefined) {
    delete metadata.tagColors[label];
  } else if (TAG_PALETTE.some((entry) => entry.value === color)) {
    metadata.tagColors[label] = color;
  } else {
    console.error(`[metadata] rejected off-palette colour ${color}`);
    return metadata.tagColors;
  }

  saveMetadata();

  // A tag's colour is global, so every open column may need repainting.
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send('tag-colors-changed', metadata.tagColors);
  }
  return metadata.tagColors;
});

ipcMain.handle('meta:note', (event, filePath) => {
  if (!guardPath(filePath)) return '';
  return entryFor(filePath).note;
});

ipcMain.handle('meta:add-tag', async (event, filePath, tag) => {
  if (!guardPath(filePath)) return null;
  const label = String(tag || '').trim();
  if (!label) return entryFor(filePath);

  const entry = updateEntry(filePath, (draft) => {
    if (!draft.tags.some((t) => t.toLowerCase() === label.toLowerCase())) draft.tags.push(label);
  });

  if (!metadata.knownTags.some((t) => t.toLowerCase() === label.toLowerCase())) {
    metadata.knownTags.push(label);
    metadata.knownTags.sort((a, b) => a.localeCompare(b));
    saveMetadata();
  }

  await notifyDirOf(filePath);
  return entry;
});

ipcMain.handle('meta:remove-tag', async (event, filePath, tag) => {
  if (!guardPath(filePath)) return null;
  const entry = updateEntry(filePath, (draft) => {
    draft.tags = draft.tags.filter((t) => t.toLowerCase() !== String(tag).toLowerCase());
  });
  await notifyDirOf(filePath);
  return entry;
});

ipcMain.handle('meta:set-note', async (event, filePath, note) => {
  if (!guardPath(filePath)) return null;
  const entry = updateEntry(filePath, (draft) => { draft.note = String(note || ''); });
  await notifyDirOf(filePath);
  return entry;
});

ipcMain.handle('meta:toggle-pin', async (event, filePath) => {
  if (!guardPath(filePath)) return null;
  const entry = updateEntry(filePath, (draft) => { draft.pinned = !draft.pinned; });
  await notifyDirOf(filePath);
  return entry;
});

// ── Move to Trash ─────────────────────────────────────────
// One implementation, shared by the context menu item and Cmd+Delete.
// Destructive, so the allow list matters most here: every path is
// revalidated with symlinks resolved before anything is touched.

async function trashPaths(paths) {
  note(`trash n=${Array.isArray(paths) ? paths.length : 0}`);
  if (!Array.isArray(paths) || paths.length === 0) {
    return { ok: true, trashed: [], errors: [] };
  }

  const allowed = paths.filter(isAllowedSync);
  if (allowed.length !== paths.length) {
    console.error(`[security] blocked trashing ${paths.length - allowed.length} path(s) outside all roots`);
  }

  const errors = [];
  const trashed = [];

  for (const target of allowed) {
    try {
      await shell.trashItem(target);
      trashed.push(target);
    } catch (err) {
      const reason = err.code === 'EACCES' ? 'permission denied'
        : err.code === 'ENOENT' ? 'no longer exists'
        : (err.code || err.message);
      console.error(`[trash] ${path.basename(target)}: ${reason}`);
      errors.push(`${path.basename(target)}: ${reason}`);
    }
  }

  // A trashed file that is currently being previewed leaves the preview
  // showing something that no longer exists.
  if (previewPath && trashed.some((target) => target === previewPath || isInside(previewPath, target))) {
    hidePreviewWindow();
  }

  // Update each affected column in place, so scroll position survives.
  const parents = [...new Set(trashed.map((target) => path.dirname(target)))];
  for (const parent of parents) {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) break;
    const result = await readDirectory(parent);
    win.webContents.send('dir-changed', { path: parent, result });
  }

  return { ok: errors.length === 0, trashed, errors };
}

ipcMain.handle('files:trash', (event, paths) => trashPaths(paths));

// ── Copying files in ──────────────────────────────────────
// Sources may legitimately come from anywhere — that is the point of a drop
// from Finder. The DESTINATION is what must be inside a root, and it is
// validated before any write.

// Finder-style collision handling: report.pdf -> "report 2.pdf". Never
// overwrite.
async function uniqueDestination(destDir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let candidate = name;
  let counter = 1;

  for (;;) {
    const full = path.join(destDir, candidate);
    try {
      await fs.promises.access(full);
    } catch (err) {
      return full; // nothing there: this name is free
    }
    counter++;
    candidate = `${base} ${counter}${ext}`;
  }
}

async function copyInto(destDir, sourcePaths) {
  note(`copyInto n=${sourcePaths.length}`);
  if (!isAllowedSync(destDir)) {
    console.error('[security] blocked copy to a destination outside all roots');
    return { ok: false, copied: 0, errors: ['That destination is outside Downloads and Desktop.'] };
  }

  let realDest;
  try {
    realDest = await fs.promises.realpath(destDir);
  } catch (err) {
    return { ok: false, copied: 0, errors: [`Destination unavailable (${err.code || 'UNKNOWN'}).`] };
  }

  const errors = [];
  let copied = 0;

  for (const source of sourcePaths) {
    if (typeof source !== 'string' || !source) continue;
    const name = path.basename(source);
    try {
      const target = await uniqueDestination(realDest, name);
      // recursive:true so dropping a folder copies its whole tree. Async
      // throughout, so a large copy never blocks the UI.
      await fs.promises.cp(source, target, { recursive: true, force: false, errorOnExist: true });
      copied++;
    } catch (err) {
      const reason = err.code === 'EACCES' ? 'permission denied'
        : err.code === 'ENOSPC' ? 'disk full'
        : err.code === 'ENOENT' ? 'source no longer exists'
        : (err.code || err.message);
      console.error(`[copy] ${name}: ${reason}`);
      errors.push(`${name}: ${reason}`);
    }
  }

  // Push the destination's new contents so an open column updates in place,
  // keeping its scroll position and selection.
  if (copied > 0 && win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    const result = await readDirectory(realDest);
    win.webContents.send('dir-changed', { path: realDest, result });
  }

  return { ok: errors.length === 0, copied, errors };
}

ipcMain.handle('files:copy-into', (event, destDir, sourcePaths) => {
  if (!Array.isArray(sourcePaths)) return { ok: false, copied: 0, errors: ['Nothing to copy.'] };
  return copyInto(destDir, sourcePaths);
});

// ── Clipboard ─────────────────────────────────────────────
// Electron's clipboard has no file-list API. On macOS the pasteboard carries
// file lists as NSFilenamesPboardType, whose payload is an XML plist array of
// POSIX paths, so it is written and read as a raw buffer.

const FILE_LIST_FORMAT = 'NSFilenamesPboardType';

function escapeXml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function unescapeXml(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function writeFilesToClipboard(paths) {
  const entries = paths.map((p) => `<string>${escapeXml(p)}</string>`).join('');
  const plist =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
    '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    `<plist version="1.0"><array>${entries}</array></plist>`;
  clipboard.writeBuffer(FILE_LIST_FORMAT, Buffer.from(plist, 'utf8'));
}

function readFilesFromClipboard() {
  const buffer = clipboard.readBuffer(FILE_LIST_FORMAT);
  if (buffer && buffer.length > 0) {
    const xml = buffer.toString('utf8');
    const paths = [];
    const pattern = /<string>([\s\S]*?)<\/string>/g;
    let match = pattern.exec(xml);
    while (match) {
      paths.push(unescapeXml(match[1]));
      match = pattern.exec(xml);
    }
    if (paths.length > 0) return paths;
  }

  // Newer macOS writes public.file-url for a single file, so fall back to it
  // rather than reporting an empty clipboard.
  try {
    const fileUrl = clipboard.read('public.file-url');
    if (fileUrl) return [fileURLToPath(fileUrl.trim())];
  } catch (err) {
    // Not a file URL.
  }
  return [];
}

ipcMain.on('clipboard:copy-files', (event, paths) => {
  if (!Array.isArray(paths)) return;
  const allowed = paths.filter(isAllowedSync);
  if (allowed.length !== paths.length) {
    console.error('[security] blocked clipboard copy of paths outside all roots');
  }
  if (allowed.length === 0) return;
  writeFilesToClipboard(allowed);
});

ipcMain.handle('clipboard:has-files', () => readFilesFromClipboard().length > 0);

ipcMain.handle('clipboard:paste', async (event, destDir) => {
  const sources = readFilesFromClipboard();
  if (sources.length === 0) return { ok: true, copied: 0, errors: [] };
  // Paste is always a copy, consistent with drop-in.
  return copyInto(destDir, sources);
});

// ── Preview ───────────────────────────────────────────────
// Replaces Quick Look. qlmanage opened a real macOS window on another
// screen and stole focus, which defeats the point of a floating overlay.

const TEXT_PREVIEW_BYTES = 100 * 1024;

const PREVIEW_KINDS = [
  ['image', ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp']],
  ['pdf', ['pdf']],
  ['video', ['mp4', 'mov', 'webm']],
  ['audio', ['mp3', 'wav', 'm4a']],
  ['text', ['txt', 'md', 'csv', 'json', 'js', 'ts', 'py', 'html', 'css', 'yml', 'yaml', 'log']]
];

function previewKind(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const match = PREVIEW_KINDS.find(([, exts]) => exts.includes(ext));
  return { kind: match ? match[0] : 'other', ext };
}

// The renderer never touches the filesystem, so it gets a URL for streamable
// content rather than a path.
function previewUrl(filePath) {
  return `${PREVIEW_SCHEME}://local/${encodeURIComponent(filePath)}`;
}

// Read only the head of the file. This is the guard against rendering a
// 200MB log: the size on disk is irrelevant because at most 100KB is read.
async function readTextHead(filePath, size) {
  const length = Math.min(size, TEXT_PREVIEW_BYTES);
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return { text: buffer.subarray(0, bytesRead).toString('utf8'), truncated: size > bytesRead };
  } finally {
    await handle.close();
  }
}

// ── Folder preview ────────────────────────────────────────

const FOLDER_PREVIEW_ENTRIES = 20;

// Hard cap on the recursive size walk. A folder with tens of thousands of
// nested items must not hang the app, so the scan stops here and the size is
// reported as approximate rather than running to completion.
const SIZE_SCAN_CAP = 20000;

// Bumped on every folder preview, so a slow scan for a folder the user has
// already navigated away from cannot push a stale size.
let sizeScanId = 0;

async function folderSizeOnDisk(dir) {
  note(`folderSize ${path.basename(dir)}`);
  let bytes = 0;
  let visited = 0;
  let approximate = false;
  const stack = [dir];

  while (stack.length > 0) {
    const current = stack.pop();
    let dirents;
    try {
      dirents = await fs.promises.readdir(current, { withFileTypes: true });
    } catch (err) {
      continue; // unreadable subdirectory: skip rather than abort the walk
    }

    for (const dirent of dirents) {
      if (visited >= SIZE_SCAN_CAP) { approximate = true; break; }
      visited++;
      const full = path.join(current, dirent.name);
      // isDirectory() is false for symlinks, so links are counted by their
      // own size and never followed — which is also what stops cycles.
      if (dirent.isDirectory()) {
        stack.push(full);
      } else {
        try {
          const stats = await fs.promises.lstat(full);
          bytes += stats.size;
        } catch (err) {
          // Vanished mid-walk.
        }
      }
    }
    if (approximate) break;
  }

  return { bytes, approximate };
}

async function buildFolderPreview(dirPath, stats) {
  let dirents = [];
  try {
    dirents = await fs.promises.readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    return { ok: false, code: err.code || 'UNKNOWN' };
  }

  const visible = dirents.filter((dirent) => !dirent.name.startsWith('.'));
  const entries = visible.slice(0, FOLDER_PREVIEW_ENTRIES).map((dirent) => ({
    name: dirent.name,
    isDirectory: dirent.isDirectory()
  }));

  const scan = ++sizeScanId;

  // Computed after the card is on screen, so opening never waits on a
  // recursive walk.
  folderSizeOnDisk(dirPath).then(({ bytes, approximate }) => {
    if (scan !== sizeScanId) return; // superseded by a newer preview
    if (previewWin && !previewWin.isDestroyed() && !previewWin.webContents.isDestroyed()) {
      previewWin.webContents.send('preview-size', { path: dirPath, bytes, approximate });
    }
  });

  return {
    ok: true,
    kind: 'folder',
    name: path.basename(dirPath),
    path: dirPath,
    modified: stats.mtimeMs,
    itemCount: visible.length,
    shownCount: entries.length,
    entries,
    size: null // filled in by the preview-size message
  };
}

async function buildPreviewInfo(filePath) {
  if (!isAllowedSync(filePath)) {
    console.error('[security] blocked preview outside all roots');
    return { ok: false, code: 'EOUTSIDE' };
  }

  let stats;
  try {
    stats = await fs.promises.stat(filePath);
  } catch (err) {
    return { ok: false, code: err.code || 'UNKNOWN' };
  }
  if (stats.isDirectory()) return buildFolderPreview(filePath, stats);

  const { kind, ext } = previewKind(filePath);
  const base = {
    ok: true,
    kind,
    ext,
    name: path.basename(filePath),
    path: filePath,
    size: stats.size,
    modified: stats.mtimeMs
  };

  if (kind === 'text') {
    try {
      return { ...base, ...(await readTextHead(filePath, stats.size)) };
    } catch (err) {
      console.error(`[preview] cannot read ${base.name}: ${err.message}`);
      return { ...base, kind: 'other' };
    }
  }

  if (kind === 'other') {
    // Fall back to the real macOS icon. 'normal' deliberately, not 'large':
    // 'large' is a native NOTREACHED crash on Electron 32.3.3.
    try {
      const icon = await app.getFileIcon(filePath, { size: FILE_ICON_SIZE });
      return { ...base, iconDataUrl: icon.isEmpty() ? null : icon.toDataURL() };
    } catch (err) {
      return { ...base, iconDataUrl: null };
    }
  }

  return { ...base, url: previewUrl(filePath) };
}

// ── Preview window ────────────────────────────────────────
// A separate floating window, like Quick Look — not an overlay inside the
// panel. State is deliberately one-directional: the panel renderer owns the
// column/selection state and decides what to preview; this window only
// renders what it is given and forwards intent back.
//
// context_v3.md flags the reference app's two-window visibility coupling,
// where each window implicitly manages the other's visibility. That is NOT
// reproduced here:
//   - opening the preview never touches the panel
//   - closing the preview never shows the panel
//   - hiding the panel DOES hide the preview (one way only)

let previewWin = null;

// What the preview is currently showing, so a trashed file can close it.
let previewPath = null;

// Recentred on every show and never persisted, matching Quick Look. Sized
// against the display the panel is on, so it is independent of panel size.
function previewWindowBounds() {
  const display = win && !win.isDestroyed()
    ? screen.getDisplayMatching(win.getBounds())
    : screen.getPrimaryDisplay();
  const area = display.workArea;
  const width = Math.round(area.width * 0.6);
  const height = Math.round(area.height * 0.6);
  return {
    width,
    height,
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2)
  };
}

// One window, reused: shown, hidden and reloaded rather than recreated.
function ensurePreviewWindow() {
  if (previewWin && !previewWin.isDestroyed()) return previewWin;

  previewWin = new BrowserWindow({
    ...previewWindowBounds(),
    minWidth: 320,
    minHeight: 240,
    // Same treatment as the main panel.
    frame: false,
    transparent: true,
    hasShadow: true,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      plugins: true
    }
  });

  previewWin.loadFile(path.join(__dirname, 'preview.html'));
  previewWin.setAlwaysOnTop(true, 'floating');
  previewWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  previewWin.on('closed', () => { previewWin = null; });

  return previewWin;
}

// Tell the panel the preview is gone so its belief stays in sync. This is a
// notification, not the reverse coupling: it changes no window's visibility.
function notifyPreviewClosed() {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send('preview-closed');
  }
}

function hidePreviewWindow() {
  if (previewWin && !previewWin.isDestroyed() && previewWin.isVisible()) {
    previewWin.hide();
  }
  previewPath = null;
  notifyPreviewClosed();
}

ipcMain.on('preview:show', async (event, filePath) => {
  const info = await buildPreviewInfo(filePath);
  if (!info.ok) {
    console.error(`[preview] cannot preview: ${info.code}`);
    return;
  }

  previewPath = info.path;

  const target = ensurePreviewWindow();
  const send = () => {
    if (!target.isDestroyed()) target.webContents.send('preview-data', info);
  };
  if (target.webContents.isLoading()) target.webContents.once('did-finish-load', send);
  else send();

  target.setBounds(previewWindowBounds());
  // Never show() + focus(): the preview must not steal focus either.
  target.showInactive();
});

ipcMain.on('preview:close', () => hidePreviewWindow());

// Arrow keys can be pressed in either window, but only the panel knows the
// column contents, so stepping is always resolved there.
ipcMain.on('preview:step', (event, delta) => {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send('preview-step', delta);
  }
});

// ── Preferences window ────────────────────────────────────
// A normal window, unlike the panel and the preview: it has a text input and
// the user is deliberately interacting with it, so it SHOULD take focus.
//
// The same one-directional rule as the preview window applies, per
// context_v4.md: opening this must not hide the panel, closing it must not
// show the panel. Nothing here touches win's visibility at all.

let prefsWin = null;

function openPreferences() {
  if (prefsWin && !prefsWin.isDestroyed()) {
    prefsWin.show();
    prefsWin.focus();
    return;
  }

  prefsWin = new BrowserWindow({
    width: 420,
    height: 300,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    title: 'Preferences',
    // Solid, because this window is not transparent. Matches --bg with the
    // alpha flattened, so it reads as the same surface as the panel.
    backgroundColor: '#16161A',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  prefsWin.loadFile(path.join(__dirname, 'preferences.html'));

  // The panel floats above normal windows, so without this Preferences can
  // open behind it and look like nothing happened. Not the 'floating' HUD
  // treatment otherwise — this is an ordinary window.
  prefsWin.setAlwaysOnTop(true, 'floating');

  prefsWin.once('ready-to-show', () => {
    // Unlike the panel and preview, this one takes focus on purpose.
    prefsWin.show();
    prefsWin.focus();
  });

  prefsWin.on('closed', () => { prefsWin = null; });
}

ipcMain.handle('prefs:get', () => ({
  hotkey: settings.hotkey || DEFAULT_HOTKEY,
  defaultHotkey: DEFAULT_HOTKEY
}));

ipcMain.handle('prefs:set-hotkey', (event, accelerator) => changeHotkey(accelerator));

ipcMain.handle('prefs:reset-hotkey', () => changeHotkey(DEFAULT_HOTKEY));

ipcMain.on('prefs:close', () => {
  if (prefsWin && !prefsWin.isDestroyed()) prefsWin.close();
});

// ── Lifecycle ─────────────────────────────────────────────

app.whenReady().then(() => {
  // Menu bar only: no Dock icon, no Cmd+Tab presence. This covers `npm start`;
  // the packaged .app also needs LSUIElement via extend-info.plist.
  if (process.platform === 'darwin' && app.dock) {
    app.dock.hide();
  }

  // Serve preview media. The path is re-validated here as well as in
  // preview:open — this handler is reachable from any renderer request, so it
  // cannot rely on the earlier check having happened.
  protocol.handle(PREVIEW_SCHEME, (request) => {
    note('fdfile stream');
    let filePath;
    try {
      filePath = decodeURIComponent(new URL(request.url).pathname.replace(/^\//, ''));
    } catch (err) {
      return new Response('Bad request', { status: 400 });
    }
    if (!isAllowedSync(filePath)) {
      console.error('[security] blocked preview stream outside all roots');
      return new Response('Forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(filePath).toString());
  });

  // Order matters: report the previous session BEFORE writing this one's
  // start line, or the check would always see its own.
  reportPreviousSession();
  logEvent(
    `start pid=${process.pid} electron=${process.versions.electron} ` +
    `version=${app.getVersion()} packaged=${app.isPackaged} dumps=${app.getPath('crashDumps')}`
  );

  loadSettings();
  loadMetadata();
  createWindow();
  createTray();
  registerHotkey();
  startHeartbeat();

  // Show once on launch so the scaffold is visibly working, without taking
  // focus from whatever is frontmost.
  win.once('ready-to-show', () => win.showInactive());
});

// Renderer and GPU crashes, which the main process DOES survive. These would
// not have caught the CrBrowserMain SIGSEGV, but they cover the cases where
// only a child dies — a blank panel or a dead preview window.
app.on('render-process-gone', (event, webContents, details) => {
  let which = 'unknown';
  if (win && !win.isDestroyed() && webContents === win.webContents) which = 'panel';
  else if (previewWin && !previewWin.isDestroyed() && webContents === previewWin.webContents) which = 'preview';
  else if (prefsWin && !prefsWin.isDestroyed() && webContents === prefsWin.webContents) which = 'preferences';

  logEvent(
    `render-process-gone window=${which} reason=${details.reason} ` +
    `exitCode=${details.exitCode} lastAction=${lastAction}`
  );
  console.error(`[crash] ${which} renderer gone: ${details.reason}`);
});

app.on('child-process-gone', (event, details) => {
  logEvent(
    `child-process-gone type=${details.type} reason=${details.reason} ` +
    `exitCode=${details.exitCode} name=${details.name || ''} ` +
    `service=${details.serviceName || ''} lastAction=${lastAction}`
  );
  console.error(`[crash] child process gone: ${details.type} — ${details.reason}`);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  // Leaked fs watchers hold file descriptors open.
  unwatchAll();
  clearInterval(heartbeatTimer);
  // The marker that distinguishes a clean exit from a crash on next launch.
  logEvent(`clean-quit uptime=${Math.round(process.uptime() / 60)}m lastAction=${lastAction}`);
});

app.on('window-all-closed', () => {
  // With a tray icon, hiding the window must not quit the app on macOS.
  if (process.platform !== 'darwin') app.quit();
});
