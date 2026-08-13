const { app, BrowserWindow, Menu, Tray, screen, globalShortcut } = require('electron');
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
  settings = readJson(file, { hotkey: DEFAULT_HOTKEY });

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

  tray.setContextMenu(menu);
}

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
});

app.on('window-all-closed', () => {
  // With a tray icon, hiding the window must not quit the app on macOS.
  if (process.platform !== 'darwin') app.quit();
});
