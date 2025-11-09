const { contextBridge, ipcRenderer } = require('electron');

// Exponer API de configuración
contextBridge.exposeInMainWorld('config', {
  get: () => ipcRenderer.invoke('config:get')
});

// Exponer API de control del servidor biométrico
contextBridge.exposeInMainWorld('biometricServer', {
  start: () => ipcRenderer.invoke('biometric:start'),
  stop: () => ipcRenderer.invoke('biometric:stop'),
  status: () => ipcRenderer.invoke('biometric:status')
});
