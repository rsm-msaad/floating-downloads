const { contextBridge, ipcRenderer } = require('electron');

// contextIsolation is on and nodeIntegration is off, so the renderer sees
// only what is listed here. No fs, no path, no ipcRenderer itself — just
// functions that move plain data across the bridge.
contextBridge.exposeInMainWorld('api', {
  // Resolves to { ok: true, items: [{name, path, isDirectory, modified}], dir }
  // or { ok: false, code, dir } when the folder cannot be read.
  listDownloads: () => ipcRenderer.invoke('downloads:list'),

  // Fires each time the panel is shown, so the list can refresh.
  onPanelShown: (callback) => ipcRenderer.on('panel-shown', () => callback()),

  // Hand off to webContents.startDrag in the main process. HTML5 drag and
  // drop cannot deliver a file to another macOS app; only startDrag can.
  startDrag: (paths) => ipcRenderer.send('drag:start', paths),

  // Pre-resolve macOS file icons so the drag has one ready synchronously.
  warmDragIcons: (paths) => ipcRenderer.send('drag:warm', paths)
});
