const {
  app, BrowserWindow, Menu, Tray, screen, globalShortcut, ipcMain, nativeImage,
  shell, clipboard, protocol, net
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

function createWindow() {
  const saved = loadState();
  const area = screen.getPrimaryDisplay().workArea;

  // Clamp a restored position so the window never opens off-screen, e.g.
  // after a display is unplugged.
  if (saved) {
    saved.x = Math.max(area.x, Math.min(saved.x, area.x + area.width - saved.width));
    saved.y = Math.max(area.y, Math.min(saved.y, area.y + area.height - saved.height));
  }

  win = new BrowserWindow({
    width: saved ? saved.width : PANEL_WIDTH,
    height: saved ? saved.height : PANEL_HEIGHT,
    x: saved ? saved.x : area.x + area.width - PANEL_WIDTH - 40,
    y: saved ? saved.y : area.y + 60,
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
    win.once('ready-to-show', () => win.showInactive());
    return;
  }
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

function registerHotkey() {
  const accelerator = settings.hotkey || DEFAULT_HOTKEY;

  let registered = false;
  try {
    registered = globalShortcut.register(accelerator, togglePanel);
  } catch (err) {
    // register() throws on a malformed accelerator string rather than
    // returning false.
    console.error(`[hotkey] "${accelerator}" is not a valid accelerator: ${err.message}`);
    return;
  }

  if (registered) {
    console.log(`[hotkey] registered ${accelerator}`);
  } else {
    console.error(
      `[hotkey] FAILED to register "${accelerator}" — another app has already ` +
      `claimed it, or macOS reserves it. The tray menu still toggles the panel. ` +
      `Change "hotkey" in ${settingsFile()} and restart.`
    );
  }
}

// ── Tray ──────────────────────────────────────────────────

function createTray() {
  // trayTemplate.png + @2x: the "Template" suffix is the macOS convention
  // that makes the icon auto-invert for light and dark menu bars.
  tray = new Tray(path.join(__dirname, 'trayTemplate.png'));
  tray.setToolTip('FloatingDownloads');

  const menu = Menu.buildFromTemplate([
    { label: 'Toggle Panel', accelerator: settings.hotkey || DEFAULT_HOTKEY, click: togglePanel },
    { type: 'separator' },
    { label: 'Preferences…', enabled: false }, // no-op until phase 5
    { type: 'separator' },
    { role: 'quit', label: 'Quit FloatingDownloads' }
  ]);

  // Deliberately NOT tray.setContextMenu(menu). On macOS, assigning a
  // context menu makes a left-click open that menu and suppresses the
  // 'click' event, so left-click could never toggle the panel. Popping the
  // menu up by hand on right-click keeps both gestures working.
  tray.on('click', togglePanel);
  tray.on('right-click', () => tray.popUpContextMenu(menu));
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
    return {
      name: dirent.name,
      path: fullPath,
      isDirectory: stats.isDirectory(),
      modified: stats.mtimeMs
    };
  }));

  const items = settled.filter(Boolean);
  items.sort((a, b) => b.modified - a.modified);
  return { ok: true, items, dir, isRoot: getRoots().some((root) => root.path === dir) };
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


// ── Move to Trash ─────────────────────────────────────────
// One implementation, shared by the context menu item and Cmd+Delete.
// Destructive, so the allow list matters most here: every path is
// revalidated with symlinks resolved before anything is touched.

async function trashPaths(paths) {
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
  if (stats.isDirectory()) return { ok: false, code: 'EISDIR' };

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

  loadSettings();
  createWindow();
  createTray();
  registerHotkey();

  // Show once on launch so the scaffold is visibly working, without taking
  // focus from whatever is frontmost.
  win.once('ready-to-show', () => win.showInactive());
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  // Leaked fs watchers hold file descriptors open.
  unwatchAll();
});

app.on('window-all-closed', () => {
  // With a tray icon, hiding the window must not quit the app on macOS.
  if (process.platform !== 'darwin') app.quit();
});
