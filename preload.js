const { contextBridge, ipcRenderer } = require('electron');

// contextIsolation is on and nodeIntegration is off, so the renderer sees
// only what is listed here. No fs, no path, no ipcRenderer itself — just
// functions that move plain data across the bridge.
contextBridge.exposeInMainWorld('api', {
  // Read one directory. Pass null for ~/Downloads itself. Any path outside
  // ~/Downloads is rejected in the main process with code 'EOUTSIDE'.
  // Resolves to { ok: true, items: [{name, path, isDirectory, modified}], dir, isRoot }
  // or { ok: false, code } when the folder cannot be read.
  readDir: (dirPath) => ipcRenderer.invoke('downloads:read', dirPath),

  // Fires each time the panel is shown, so the list can refresh.
  onPanelShown: (callback) => ipcRenderer.on('panel-shown', () => callback()),

  // Hand off to webContents.startDrag in the main process. HTML5 drag and
  // drop cannot deliver a file to another macOS app; only startDrag can.
  startDrag: (paths) => ipcRenderer.send('drag:start', paths),

  // Pre-resolve macOS file icons so the drag has one ready synchronously.
  warmDragIcons: (paths) => ipcRenderer.send('drag:warm', paths),

  // Open a file in its default app. Folders are navigated, never opened.
  openFile: (filePath) => ipcRenderer.send('file:open', filePath),

  // Native context menu, built and popped up in the main process.
  showContextMenu: (paths) => ipcRenderer.send('menu:show', paths),

  // Quick Look, via qlmanage in the main process.
  quickLook: (paths) => ipcRenderer.send('ql:preview', paths),
  dismissQuickLook: () => ipcRenderer.send('ql:dismiss'),
  onQuickLookClosed: (callback) => ipcRenderer.on('ql-closed', () => callback()),

  // Fires after files are trashed, so the list can refresh.
  onFilesChanged: (callback) => ipcRenderer.on('files-changed', () => callback())
});
