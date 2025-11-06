const { contextBridge, ipcRenderer } = require('electron');

// Exponer API de empleados
contextBridge.exposeInMainWorld('employees', {
  getAll: (activeOnly = false) => ipcRenderer.invoke('employees:getAll', activeOnly),
  getById: (id: number) => ipcRenderer.invoke('employees:getById', id),
  create: (employee: any) => ipcRenderer.invoke('employees:create', employee),
  update: (id: number, employee: any) => ipcRenderer.invoke('employees:update', id, employee),
  delete: (id: number) => ipcRenderer.invoke('employees:delete', id)
});

// Exponer API de huellas
contextBridge.exposeInMainWorld('fingerprints', {
  getByEmployee: (employeeId: number) => ipcRenderer.invoke('fingerprints:getByEmployee', employeeId),
  create: (fingerprint: any) => ipcRenderer.invoke('fingerprints:create', fingerprint)
});

// Exponer API de asistencia
contextBridge.exposeInMainWorld('attendance', {
  today: () => ipcRenderer.invoke('attendance:today'),
  getByEmployee: (employeeId: number, limit?: number) =>
    ipcRenderer.invoke('attendance:getByEmployee', employeeId, limit)
});

// Exponer API de estadísticas
contextBridge.exposeInMainWorld('stats', {
  get: () => ipcRenderer.invoke('stats:get')
});

// Exponer API de configuración
contextBridge.exposeInMainWorld('config', {
  get: () => ipcRenderer.invoke('config:get')
});
