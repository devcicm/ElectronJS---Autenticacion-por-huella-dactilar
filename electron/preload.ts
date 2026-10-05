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

// Exponer API del Sistema de Asistencia
contextBridge.exposeInMainWorld('attendance', {
  // Dashboard
  getDashboardSummary: () => ipcRenderer.invoke('attendance:getDashboardSummary'),
  getTodayStats: () => ipcRenderer.invoke('attendance:getTodayStats'),
  getTodayRecords: () => ipcRenderer.invoke('attendance:getTodayRecords'),

  // Check-in / Check-out
  checkIn: (employeeId: number, fingerprintVerified: boolean) =>
    ipcRenderer.invoke('attendance:checkIn', employeeId, fingerprintVerified),
  checkOut: (employeeId: number) =>
    ipcRenderer.invoke('attendance:checkOut', employeeId),
  canCheckIn: (employeeId: number) =>
    ipcRenderer.invoke('attendance:canCheckIn', employeeId),
  canCheckOut: (employeeId: number) =>
    ipcRenderer.invoke('attendance:canCheckOut', employeeId),

  // Empleados
  getEmployees: (filters?: any) =>
    ipcRenderer.invoke('attendance:getEmployees', filters),
  getEmployeeById: (id: number) =>
    ipcRenderer.invoke('attendance:getEmployeeById', id),
  getEmployeeDetails: (id: number) =>
    ipcRenderer.invoke('attendance:getEmployeeDetails', id),
  createEmployee: (data: any) =>
    ipcRenderer.invoke('attendance:createEmployee', data),
  updateEmployee: (data: any) =>
    ipcRenderer.invoke('attendance:updateEmployee', data),
  deleteEmployee: (id: number) =>
    ipcRenderer.invoke('attendance:deleteEmployee', id),

  // Registros de asistencia
  getAttendanceRecords: (filters?: any) =>
    ipcRenderer.invoke('attendance:getAttendanceRecords', filters),

  // Departamentos
  getDepartments: () =>
    ipcRenderer.invoke('attendance:getDepartments'),
  createDepartment: (data: any) =>
    ipcRenderer.invoke('attendance:createDepartment', data),
  updateDepartment: (data: any) =>
    ipcRenderer.invoke('attendance:updateDepartment', data),
  deleteDepartment: (id: number) =>
    ipcRenderer.invoke('attendance:deleteDepartment', id),

  // Turnos
  getShifts: () =>
    ipcRenderer.invoke('attendance:getShifts'),
  createShift: (data: any) =>
    ipcRenderer.invoke('attendance:createShift', data),
  updateShift: (data: any) =>
    ipcRenderer.invoke('attendance:updateShift', data),
  deleteShift: (id: number) =>
    ipcRenderer.invoke('attendance:deleteShift', id),

  // Huellas
  getEmployeeFingerprints: (employeeId: number) =>
    ipcRenderer.invoke('attendance:getEmployeeFingerprints', employeeId),
  deleteFingerprint: (id: number) =>
    ipcRenderer.invoke('attendance:deleteFingerprint', id),
  deleteAllEmployeeFingerprints: (employeeId: number) =>
    ipcRenderer.invoke('attendance:deleteAllEmployeeFingerprints', employeeId),

  // Reseteo de Base de Datos
  resetDatabase: () =>
    ipcRenderer.invoke('attendance:resetDatabase')
});

// Exponer API de Reportes
contextBridge.exposeInMainWorld('reports', {
  generateDaily: (date?: string) =>
    ipcRenderer.invoke('reports:generateDaily', date),
  generateWeekly: (endDate?: string) =>
    ipcRenderer.invoke('reports:generateWeekly', endDate),
  generateMonthly: (year?: number, month?: number) =>
    ipcRenderer.invoke('reports:generateMonthly', year, month),
  generateEmployee: (employeeId: number, startDate?: string, endDate?: string) =>
    ipcRenderer.invoke('reports:generateEmployee', employeeId, startDate, endDate)
});

// Exponer API Biométrica
contextBridge.exposeInMainWorld('biometric', {
  isServerAvailable: () =>
    ipcRenderer.invoke('biometric:isServerAvailable'),
  captureFingerprint: () =>
    ipcRenderer.invoke('biometric:captureFingerprint'),
  enrollFingerprint: (employeeId: number, fingerPosition: string) =>
    ipcRenderer.invoke('biometric:enrollFingerprint', employeeId, fingerPosition),
  verifyFingerprint: (employeeId: number) =>
    ipcRenderer.invoke('biometric:verifyFingerprint', employeeId),
  identifyEmployee: () =>
    ipcRenderer.invoke('biometric:identifyEmployee'),
  getReaderStats: () =>
    ipcRenderer.invoke('biometric:getReaderStats'),
  getDeviceInfo: () =>
    ipcRenderer.invoke('biometric:getDeviceInfo')
});

// Exponer API de Touch Mode (Captura Continua)
contextBridge.exposeInMainWorld('touchMode', {
  start: () =>
    ipcRenderer.invoke('touchMode:start'),
  stop: () =>
    ipcRenderer.invoke('touchMode:stop'),
  getStatus: () =>
    ipcRenderer.invoke('touchMode:getStatus'),
  getLocalState: () =>
    ipcRenderer.invoke('touchMode:getLocalState'),
  onCriticalError: (callback: (data: any) => void) => {
    const listener = (_event: any, data: any) => callback(data);
    ipcRenderer.on('touchMode:criticalError', listener);
    // Retornar función para desregistrar el listener
    return () => ipcRenderer.removeListener('touchMode:criticalError', listener);
  },
  onAttendanceRegistered: (callback: (data: any) => void) => {
    const listener = (_event: any, data: any) => callback(data);
    ipcRenderer.on('touchMode:attendanceRegistered', listener);
    // Retornar función para desregistrar el listener
    return () => ipcRenderer.removeListener('touchMode:attendanceRegistered', listener);
  }
});

// Observabilidad: dump del trace buffer del renderer al main process (archivo JSON)
contextBridge.exposeInMainWorld('electronBridge', {
  dumpTrace: (json: string) => ipcRenderer.invoke('trace:dump', json),
});
