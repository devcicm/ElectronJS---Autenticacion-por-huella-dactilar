const { contextBridge, ipcRenderer } = require('electron');

// Expose fingerprint API to renderer process
contextBridge.exposeInMainWorld('fp', {
  // Initialize the fingerprint reader
  init: () => ipcRenderer.invoke('fp:init'),

  // Capture fingerprint (3 attempts)
  capture3: () => ipcRenderer.invoke('fp:capture3'),

  // Enroll and save template with ID
  enrollSave: (id: string, samples?: number) =>
    ipcRenderer.invoke('fp:enrollSave', id, samples ?? 4),

  // Verify against stored template
  verifyWithStore: (id: string, liveFmdXml: string, farDenominator?: number) =>
    ipcRenderer.invoke('fp:verifyWithStore', id, liveFmdXml, farDenominator ?? 100000),

  // Get reader information
  getReaderInfo: () => ipcRenderer.invoke('fp:getReaderInfo'),

  // Cancel current operation
  cancel: () => ipcRenderer.invoke('fp:cancel'),

  // Dispose resources
  dispose: () => ipcRenderer.invoke('fp:dispose'),

  // Event system implementation
  onEvent: (cb: (evt: any) => void) => {
    // Store callback for future use
    if (typeof cb === 'function') {
      // For now, just ensure the callback is valid
      // In a real implementation, this would register listeners
      console.log('Event callback registered');

      // Simulate a ready event after a short delay
      setTimeout(() => {
        cb({ type: 'ready', message: 'Sistema de eventos inicializado' });
      }, 100);
    }
  },

  // ===== NUEVAS FUNCIONALIDADES AVANZADAS =====

  // Identificación 1:N en vivo
  identify1N: (targetFarn?: number, topK?: number) =>
    ipcRenderer.invoke('fp:identify1n', targetFarn ?? 21474, topK ?? 5),

  // Enrolamiento avanzado con múltiples estrategias
  enrollAdvanced: (samples?: number, targetFarn?: number, maxRetriesPerSample?: number) =>
    ipcRenderer.invoke('fp:enrollAdvanced', samples ?? 4, targetFarn ?? 21474, maxRetriesPerSample ?? 3),

  // Verificación en vivo optimizada
  verifyLive: (templateXml: string, targetFarn?: number) =>
    ipcRenderer.invoke('fp:verifyLive', templateXml, targetFarn ?? 21474),

  // Captura simple para testing
  singleCapture: () => ipcRenderer.invoke('fp:singleCapture'),

  // Listar plantillas almacenadas
  storeList: () => ipcRenderer.invoke('fp:storeList')
});