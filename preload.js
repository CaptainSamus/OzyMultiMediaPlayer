const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  pickVideos: () => ipcRenderer.invoke('pick-videos'),
  saveSessionAs: (data) => ipcRenderer.invoke('save-session-as', data),
  saveSessionTo: (filePath, data) => ipcRenderer.invoke('save-session-to', filePath, data),
  loadSession: (filePath) => ipcRenderer.invoke('load-session', filePath || null),
  fileExists: (p) => ipcRenderer.invoke('file-exists', p),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  videoUrl: (p) => 'localvideo://v/' + Buffer.from(p, 'utf8').toString('base64url'),
  onOpenSession: (cb) => ipcRenderer.on('open-session', (_e, p) => cb(p)),
  probe: (p) => ipcRenderer.invoke('probe', p),
  makeProxy: (p) => ipcRenderer.invoke('make-proxy', p),
  cancelProxy: (p) => ipcRenderer.send('cancel-proxy', p),
  onProxyProgress: (cb) => ipcRenderer.on('proxy-progress', (_e, p, frac) => cb(p, frac)),
  cacheInfo: () => ipcRenderer.invoke('cache-info'),
  clearCache: () => ipcRenderer.invoke('clear-cache'),
  parent: () => ipcRenderer.invoke('twitch-parent'),
  webThumb: (id) => ipcRenderer.invoke('web-thumb', id),
});
