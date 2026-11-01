const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  newPin: () => ipcRenderer.invoke('settings:new-pin'),
  findTarget: (restoreMinimized) => ipcRenderer.invoke('target:find', restoreMinimized),
  setTarget: (hwnd) => ipcRenderer.send('target:set', hwnd),
  setCrop: (crop) => ipcRenderer.send('target:crop', crop),
  clientArea: (hwnd) => ipcRenderer.invoke('target:client-area', hwnd),
  input: (msg) => ipcRenderer.send('input', msg),
  releaseAll: () => ipcRenderer.send('input:release'),
  sessionState: (connected) => ipcRenderer.send('session:state', connected),
  kick: () => ipcRenderer.send('session:kick'),
  onKickRequest: (fn) => ipcRenderer.on('kick-request', () => fn()),
});
