const { contextBridge, ipcRenderer } = require('electron');

// contextIsolation is on and nodeIntegration is off, so the renderer sees
// only what is listed here. No fs, no path, no ipcRenderer itself — just
// functions that move plain data across the bridge.
contextBridge.exposeInMainWorld('api', {
  // The allowed roots, and which one was last active.
  // Resolves to { roots: [{key, label, path}], activeRoot }.
  listRoots: () => ipcRenderer.invoke('roots:list'),

  // Persist the active root so it survives a restart.
  setActiveRoot: (key) => ipcRenderer.send('settings:active-root', key),

  // Read one directory. Pass null for the first root. Any path outside every
  // allowed root is rejected in the main process with code 'EOUTSIDE'.
  // Resolves to { ok: true, items: [{name, path, isDirectory, modified}], dir, isRoot }
  // or { ok: false, code } when the folder cannot be read.
  readDir: (dirPath) => ipcRenderer.invoke('dir:read', dirPath),

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

  // Preview lives in its own floating window. The panel asks for a file to be
  // previewed; the preview window renders whatever it is handed. File
  // contents are never read in either renderer.
  showPreview: (filePath) => ipcRenderer.send('preview:show', filePath),
  closePreview: () => ipcRenderer.send('preview:close'),
  stepPreview: (delta) => ipcRenderer.send('preview:step', delta),

  // Preview window only: the payload to render.
  onPreviewData: (callback) => ipcRenderer.on('preview-data', (_event, info) => callback(info)),

  // Panel only: keeps its belief about the preview in sync.
  onPreviewClosed: (callback) => ipcRenderer.on('preview-closed', () => callback()),
  onPreviewStep: (callback) => ipcRenderer.on('preview-step', (_event, delta) => callback(delta)),

  // Fires after files are trashed, so the list can refresh.
  onFilesChanged: (callback) => ipcRenderer.on('files-changed', () => callback())
});
