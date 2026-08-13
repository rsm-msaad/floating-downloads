const { contextBridge } = require('electron');

// Placeholder bridge. contextIsolation is on and nodeIntegration is off, so
// the renderer sees only what is explicitly exposed here. Nothing is needed
// yet — the file listing, drag-out, and folder watching arrive in phases 2-5.
contextBridge.exposeInMainWorld('api', {
  version: () => process.versions.electron
});
