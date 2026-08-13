const {
  app, BrowserWindow, Menu, Tray, screen, globalShortcut, ipcMain, nativeImage,
  shell, clipboard
} = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

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
      nodeIntegration: false
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

ipcMain.handle('dir:read', async (event, requestedPath) => {
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

function notifyFilesChanged(webContents) {
  if (webContents && !webContents.isDestroyed()) webContents.send('files-changed');
}

ipcMain.on('file:open', async (event, filePath) => {
  if (!isAllowedSync(filePath)) {
    console.error('[security] blocked open outside Downloads');
    return;
  }
  // openPath resolves with an error STRING rather than rejecting.
  const problem = await shell.openPath(filePath);
  if (problem) console.error(`[open] ${path.basename(filePath)}: ${problem}`);
});

ipcMain.on('menu:show', (event, paths) => {
  if (!Array.isArray(paths)) return;
  const allowed = paths.filter(isAllowedSync);
  if (allowed.length !== paths.length) {
    console.error(`[security] blocked menu for ${paths.length - allowed.length} path(s) outside Downloads`);
  }
  if (allowed.length === 0) return;

  const menu = Menu.buildFromTemplate([
    {
      label: 'Reveal in Finder',
      // Multi-selection reveals the first item only.
      click: () => shell.showItemInFolder(allowed[0])
    },
    {
      label: 'Copy Path',
      // One full POSIX path per line for a multi-selection.
      click: () => clipboard.writeText(allowed.join('\n'))
    },
    {
      label: 'Move to Trash',
      // No confirmation: trashItem is recoverable from the Finder Trash.
      click: async () => {
        for (const target of allowed) {
          try {
            await shell.trashItem(target);
          } catch (err) {
            console.error(`[trash] ${path.basename(target)}: ${err.message}`);
          }
        }
        notifyFilesChanged(event.sender);
      }
    }
  ]);

  menu.popup({ window: BrowserWindow.fromWebContents(event.sender) });
});

// ── Quick Look ────────────────────────────────────────────
// qlmanage is a developer binary, not a supported API. It cannot be
// dismissed programmatically, so the only way to close the panel is to kill
// the child process — hence the tracking below. stdio is ignored because it
// writes warnings to stderr. See context_v2.md, "Known gotchas".

let quickLookProcess = null;

function dismissQuickLook() {
  if (!quickLookProcess) return;
  try {
    quickLookProcess.kill();
  } catch (err) {
    // Already gone.
  }
  quickLookProcess = null;
}

ipcMain.on('ql:preview', (event, paths) => {
  if (!Array.isArray(paths)) return;
  const allowed = paths.filter(isAllowedSync);
  if (allowed.length === 0) return;

  dismissQuickLook();

  try {
    quickLookProcess = spawn('qlmanage', ['-p', ...allowed], { stdio: 'ignore' });
  } catch (err) {
    console.error(`[quicklook] could not start qlmanage: ${err.message}`);
    quickLookProcess = null;
    return;
  }

  quickLookProcess.on('error', (err) => {
    console.error(`[quicklook] qlmanage failed: ${err.message}`);
    quickLookProcess = null;
    notifyQuickLookClosed(event.sender);
  });

  // Closing the panel any other way must not leave the renderer thinking it
  // is still open, or the next Space would try to dismiss nothing.
  quickLookProcess.on('exit', () => {
    quickLookProcess = null;
    notifyQuickLookClosed(event.sender);
  });
});

function notifyQuickLookClosed(webContents) {
  if (webContents && !webContents.isDestroyed()) webContents.send('ql-closed');
}

ipcMain.on('ql:dismiss', () => dismissQuickLook());

// ── Lifecycle ─────────────────────────────────────────────

app.whenReady().then(() => {
  // Menu bar only: no Dock icon, no Cmd+Tab presence. This covers `npm start`;
  // the packaged .app also needs LSUIElement via extend-info.plist.
  if (process.platform === 'darwin' && app.dock) {
    app.dock.hide();
  }

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
  // qlmanage is a detached child; without this a Quick Look panel would
  // outlive the app with no way left to close it.
  dismissQuickLook();
});

// will-quit does not fire on SIGINT/SIGTERM (e.g. Ctrl-C during `npm start`),
// so the child is reaped here too.
app.on('before-quit', () => dismissQuickLook());
process.on('exit', () => dismissQuickLook());

app.on('window-all-closed', () => {
  // With a tray icon, hiding the window must not quit the app on macOS.
  if (process.platform !== 'darwin') app.quit();
});
