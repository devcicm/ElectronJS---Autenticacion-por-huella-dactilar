import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, ChildProcess } from 'node:child_process';
import { BIOMETRIC_PORT } from '../sistema-asistencia/shared/biometric-config.js';
import { logger } from '../sistema-asistencia/shared/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configurar encoding UTF-8 para la consola en Windows
if (process.platform === 'win32') {
  process.stdout.setDefaultEncoding('utf8');
  process.stderr.setDefaultEncoding('utf8');
}

// Variables globales
let biometricServerProcess: ChildProcess | null = null;
let mainWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, '../preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // CARGAR SISTEMA DE ASISTENCIA
  mainWindow.loadFile(path.join(__dirname, '../sistema-asistencia/renderer', 'index.html'));

  // Abrir DevTools en modo desarrollo
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Verificar si el servidor biométrico está corriendo
async function checkBiometricServerStatus(): Promise<boolean> {
  try {
    const response = await fetch(`http://localhost:${BIOMETRIC_PORT}/api/store-stats`, {
      method: 'GET',
      signal: AbortSignal.timeout(3000)
    });
    return response.ok;
  } catch {
    return false;
  }
}

// Verificar si el bridge C# está compilado
async function checkCSharpBridge(): Promise<boolean> {
  try {
    const dllPath = path.join(__dirname, '../../biometric-engine/out/net472/bridge-csharp.dll');
    const dpuruPath = path.join(__dirname, '../../biometric-engine/out/net472/DPUruNet.dll');

    const fs = await import('node:fs/promises');
    await fs.access(dllPath);
    await fs.access(dpuruPath);

    logger.info('✅ Bridge C# ya está compilado');
    return true;
  } catch (error) {
    logger.error('❌ Bridge C# no encontrado o no compilado');
    logger.error('   Por favor ejecuta: msbuild biometric-engine/bridge-csharp/EdgeBridge.csproj /p:Configuration=Release');
    return false;
  }
}

// Iniciar el servidor biométrico
async function startBiometricServer(): Promise<{ success: boolean; message: string }> {
  try {
    // Verificar si ya está corriendo
    const isRunning = await checkBiometricServerStatus();
    if (isRunning) {
      logger.info('ℹ️  Servidor biométrico ya está corriendo');
      return { success: true, message: 'Servidor biométrico ya está activo' };
    }

    // Verificar que el bridge C# esté compilado
    const csharpReady = await checkCSharpBridge();
    if (!csharpReady) {
      return { success: false, message: 'Bridge C# no está compilado. Compílalo primero.' };
    }

const nodePath = path.join(__dirname, '../../biometric-engine/node');
    const serverScript = path.join(nodePath, 'dist', 'server.js');

    console.log('🚀 Iniciando servidor biométrico...');

    // B5: usar el binario actual de Electron como Node (ELECTRON_RUN_AS_NODE=1) para
    // que funcione empaquetado sin depender de `node` en PATH.
    biometricServerProcess = spawn(process.execPath, [serverScript], {
      cwd: nodePath,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    });

    // Capturar salida del proceso
    if (biometricServerProcess.stdout) {
      biometricServerProcess.stdout.on('data', (data) => {
        logger.info(`[Biometric Server]: ${data.toString().trim()}`);
      });
    }

    if (biometricServerProcess.stderr) {
      biometricServerProcess.stderr.on('data', (data) => {
        logger.error(`[Biometric Server Error]: ${data.toString().trim()}`);
      });
    }

    biometricServerProcess.on('error', (error) => {
      logger.error('❌ Error en servidor biométrico:', error);
    });

    biometricServerProcess.on('exit', (code, signal) => {
      logger.info(`⚠️  Servidor biométrico terminó. Código: ${code}, Señal: ${signal}`);
      biometricServerProcess = null;
    });

// Esperar a que el servidor esté listo (máximo 15 segundos).
    // B5: arrancar el primer chequeo desde el evento 'spawn' del child process
    // para reducir la latencia de inicio (backoff exponencial si el server tarda más).
    let attempts = 0;
    const maxAttempts = 30;
    const readyPromise = new Promise<boolean>((resolve) => {
      let resolved = false;
      const pollOnce = async () => {
        if (resolved) return;
        attempts++;
        if (await checkBiometricServerStatus()) { resolved = true; resolve(true); return; }
        if (attempts >= maxAttempts) { resolved = true; resolve(false); return; }
        if (attempts % 5 === 0) console.log(`⏳ Esperando servidor biométrico... (${attempts}/${maxAttempts})`);
        // backoff suave: 200ms los primeros 4, luego 500ms
        setTimeout(pollOnce, attempts < 4 ? 200 : 500);
      };
      if (biometricServerProcess) {
        biometricServerProcess.once('spawn', () => pollOnce());
      } else {
        pollOnce();
      }
    });
    const ready = await readyPromise;
    if (ready) {
      console.log(`✅ Servidor biométrico iniciado correctamente en http://localhost:${BIOMETRIC_PORT}`);
      return { success: true, message: 'Servidor biométrico iniciado correctamente' };
    }

    if (biometricServerProcess) {
      biometricServerProcess.kill();
      biometricServerProcess = null;
    }

    return { success: false, message: 'Timeout: El servidor biométrico no respondió a tiempo' };

  } catch (error: any) {
    logger.error('❌ Error iniciando servidor biométrico:', error);
    return { success: false, message: `Error: ${error.message}` };
  }
}

// Detener el servidor biométrico
function stopBiometricServer(): { success: boolean; message: string } {
  if (biometricServerProcess) {
    biometricServerProcess.kill();
    biometricServerProcess = null;
    logger.info('🛑 Servidor biométrico detenido');
    return { success: true, message: 'Servidor biométrico detenido' };
  }
  return { success: false, message: 'El servidor biométrico no está corriendo' };
}

// Manejadores IPC para comunicación con el renderer
function initIpcHandlers() {
  // Servidor biométrico
  ipcMain.handle('biometric:start', async () => {
    return await startBiometricServer();
  });

  ipcMain.handle('biometric:stop', () => {
    return stopBiometricServer();
  });

  ipcMain.handle('biometric:status', async () => {
    const isRunning = await checkBiometricServerStatus();
    return { isRunning };
  });

  ipcMain.handle('config:get', () => {
    return {
      biometricPort: BIOMETRIC_PORT
    };
  });

  // Importar servicios dinámicamente para evitar problemas de carga
  let attendanceServiceInstance: any = null;
  let biometricServiceInstance: any = null;
  const getAttendanceService = async () => {
    if (!attendanceServiceInstance) {
      // @ts-ignore - Module will be available at runtime after compilation
      const { AttendanceService } = await import('../sistema-asistencia/services/AttendanceService.js');
      attendanceServiceInstance = new AttendanceService();
    }
    return attendanceServiceInstance;
  };

  const getBiometricService = async () => {
    if (!biometricServiceInstance) {
      // @ts-ignore - Module will be available at runtime after compilation
      const { BiometricService } = await import('../sistema-asistencia/services/BiometricService.js');
      biometricServiceInstance = new BiometricService();
    }
    return biometricServiceInstance;
  };

  const getModels = async () => {
    // @ts-ignore - Module will be available at runtime after compilation
    const { getDatabaseManager } = await import('../sistema-asistencia/database/init.js');
    // @ts-ignore - Module will be available at runtime after compilation
    const models = await import('../sistema-asistencia/models/index.js');
    const { EmployeeModel, DepartmentModel, ShiftModel, FingerprintModel } = models;

    const db = getDatabaseManager();
    return {
      db,
      employeeModel: new EmployeeModel(db),
      departmentModel: new DepartmentModel(db),
      shiftModel: new ShiftModel(db),
      fingerprintModel: new FingerprintModel(db)
    };
  };

  // === ATTENDANCE SYSTEM HANDLERS ===

  // Dashboard
  ipcMain.handle('attendance:getDashboardSummary', async () => {
    const service = await getAttendanceService();
    return service.getDashboardSummary();
  });

  ipcMain.handle('attendance:getTodayStats', async () => {
    const service = await getAttendanceService();
    return service.getTodayStats();
  });

  ipcMain.handle('attendance:getTodayRecords', async () => {
    const service = await getAttendanceService();
    return service.getTodayRecords();
  });

  // Check-in / Check-out
  ipcMain.handle('attendance:checkIn', async (_event, employeeId: number, fingerprintVerified: boolean) => {
    const service = await getAttendanceService();
    return await service.checkInWithFingerprint(employeeId, fingerprintVerified);
  });

  ipcMain.handle('attendance:checkOut', async (_event, employeeId: number) => {
    const service = await getAttendanceService();
    return await service.checkOut(employeeId);
  });

  ipcMain.handle('attendance:canCheckIn', async (_event, employeeId: number) => {
    const service = await getAttendanceService();
    return service.canCheckIn(employeeId);
  });

  ipcMain.handle('attendance:canCheckOut', async (_event, employeeId: number) => {
    const service = await getAttendanceService();
    return service.canCheckOut(employeeId);
  });

  // Empleados
  ipcMain.handle('attendance:getEmployees', async (_event, filters?: any) => {
    const { employeeModel } = await getModels();
    return employeeModel.getAllWithDetails(filters);
  });

  ipcMain.handle('attendance:getEmployeeById', async (_event, id: number) => {
    const { employeeModel } = await getModels();
    return employeeModel.getByIdWithDetails(id);
  });

  ipcMain.handle('attendance:getEmployeeDetails', async (_event, id: number) => {
    const service = await getAttendanceService();
    return service.getEmployeeDetails(id);
  });

  ipcMain.handle('attendance:createEmployee', async (_event, data: any) => {
    try {
      const { employeeModel } = await getModels();
      const employee = employeeModel.create(data);
      return { success: true, data: employee, message: 'Empleado creado exitosamente' };
    } catch (error: any) {
      logger.error('Error creando empleado:', error);

      // Parsear errores de SQLite para dar mensajes amigables
      let message = 'Error al crear empleado';
      if (error.message?.includes('UNIQUE constraint failed: employees.email')) {
        message = 'Ya existe un empleado con ese correo electrónico';
      } else if (error.message?.includes('UNIQUE constraint failed: employees.employee_code')) {
        message = 'Ya existe un empleado con ese código';
      } else if (error.message?.includes('FOREIGN KEY constraint failed')) {
        message = 'Departamento o turno inválido';
      }

      return { success: false, message };
    }
  });

  ipcMain.handle('attendance:updateEmployee', async (_event, data: any) => {
    try {
      const { employeeModel } = await getModels();
      const employee = employeeModel.update(data);
      return { success: true, data: employee, message: 'Empleado actualizado exitosamente' };
    } catch (error: any) {
      logger.error('Error actualizando empleado:', error);

      let message = 'Error al actualizar empleado';
      if (error.message?.includes('UNIQUE constraint failed: employees.email')) {
        message = 'Ya existe un empleado con ese correo electrónico';
      } else if (error.message?.includes('UNIQUE constraint failed: employees.employee_code')) {
        message = 'Ya existe un empleado con ese código';
      } else if (error.message?.includes('FOREIGN KEY constraint failed')) {
        message = 'Departamento o turno inválido';
      }

      return { success: false, message };
    }
  });

  ipcMain.handle('attendance:deleteEmployee', async (_event, id: number) => {
    const { employeeModel } = await getModels();
    return employeeModel.delete(id);
  });

  // Registros de asistencia
  ipcMain.handle('attendance:getAttendanceRecords', async (_event, filters?: any) => {
    const service = await getAttendanceService();
    return service.getAttendanceRecords(filters);
  });

  // Departamentos
  ipcMain.handle('attendance:getDepartments', async () => {
    const { departmentModel } = await getModels();
    return departmentModel.getAll();
  });

  ipcMain.handle('attendance:createDepartment', async (_event, data: any) => {
    const { departmentModel } = await getModels();
    return departmentModel.create(data);
  });

  ipcMain.handle('attendance:updateDepartment', async (_event, data: any) => {
    const { departmentModel } = await getModels();
    return departmentModel.update(data);
  });

  ipcMain.handle('attendance:deleteDepartment', async (_event, id: number) => {
    const { departmentModel } = await getModels();
    return departmentModel.delete(id);
  });

  // Turnos
  ipcMain.handle('attendance:getShifts', async () => {
    const { shiftModel } = await getModels();
    return shiftModel.getAll();
  });

  ipcMain.handle('attendance:createShift', async (_event, data: any) => {
    const { shiftModel } = await getModels();
    return shiftModel.create(data);
  });

  ipcMain.handle('attendance:updateShift', async (_event, data: any) => {
    const { shiftModel } = await getModels();
    return shiftModel.update(data);
  });

  ipcMain.handle('attendance:deleteShift', async (_event, id: number) => {
    const { shiftModel } = await getModels();
    return shiftModel.delete(id);
  });

  // Huellas
  ipcMain.handle('attendance:getEmployeeFingerprints', async (_event, employeeId: number) => {
    const { fingerprintModel } = await getModels();
    return fingerprintModel.getByEmployee(employeeId);
  });

  ipcMain.handle('attendance:deleteFingerprint', async (_event, id: number) => {
    const { fingerprintModel } = await getModels();
    return fingerprintModel.delete(id);
  });

  ipcMain.handle('attendance:deleteAllEmployeeFingerprints', async (_event, employeeId: number) => {
    const { fingerprintModel } = await getModels();
    return fingerprintModel.deleteByEmployee(employeeId);
  });

  // Resetear toda la base de datos
  ipcMain.handle('attendance:resetDatabase', async () => {
    try {
      const { getDatabaseManager } = await import('../sistema-asistencia/database/init.js');
      const db = getDatabaseManager();
      const database = db.getDatabase();

      logger.info('🗑️ [RESET] Iniciando reseteo completo de base de datos...');

      // Ejecutar todo en una transacción
      const resetTransaction = database.transaction(() => {
        // Desactivar foreign keys temporalmente
        database.pragma('foreign_keys = OFF');
        logger.info('🔓 [RESET] Foreign keys desactivadas');

        // 1. Eliminar todos los registros de asistencia
        const result1 = database.prepare('DELETE FROM attendance_records').run();
        logger.info(`✅ [RESET] ${result1.changes} registros de asistencia eliminados`);

        // 2. Eliminar todas las huellas
        const result2 = database.prepare('DELETE FROM fingerprints').run();
        logger.info(`✅ [RESET] ${result2.changes} huellas dactilares eliminadas`);

        // 3. Eliminar todos los empleados
        const result3 = database.prepare('DELETE FROM employees').run();
        logger.info(`✅ [RESET] ${result3.changes} empleados eliminados`);

        // 4. Eliminar departamentos personalizados (mantener solo los 5 por defecto)
        const result4 = database.prepare('DELETE FROM departments WHERE id > 5').run();
        logger.info(`✅ [RESET] ${result4.changes} departamentos personalizados eliminados`);

        // 5. Eliminar turnos personalizados (mantener solo los 4 por defecto)
        const result5 = database.prepare('DELETE FROM shifts WHERE id > 4').run();
        logger.info(`✅ [RESET] ${result5.changes} turnos personalizados eliminados`);

        // 6. Resetear secuencias de autoincremento
        const result6 = database.prepare(`DELETE FROM sqlite_sequence WHERE name IN ('attendance_records', 'fingerprints', 'employees', 'departments', 'shifts')`).run();
        logger.info(`✅ [RESET] ${result6.changes} secuencias de autoincremento reseteadas`);

        // 7. Resetear valores de configuración a por defecto
        database.prepare("UPDATE system_config SET value = '09:00' WHERE key = 'auto_mark_absent_time'").run();
        database.prepare("UPDATE system_config SET value = '1' WHERE key = 'require_checkout'").run();
        database.prepare("UPDATE system_config SET value = '1' WHERE key = 'allow_manual_entry'").run();
        database.prepare("UPDATE system_config SET value = '10' WHERE key = 'grace_period_minutes'").run();
        database.prepare("UPDATE system_config SET value = '1' WHERE key = 'notification_enabled'").run();
        logger.info('✅ [RESET] Configuración reseteada a valores por defecto');

        // Reactivar foreign keys
        database.pragma('foreign_keys = ON');
        logger.info('🔒 [RESET] Foreign keys reactivadas');
      });

      // Ejecutar la transacción
      resetTransaction();

      logger.info('✅ [RESET] Base de datos reseteada completamente');

      return {
        success: true,
        message: 'Base de datos reseteada exitosamente. Los departamentos y turnos por defecto se han mantenido.'
      };
    } catch (error) {
      logger.error('❌ [RESET] Error al resetear base de datos:', error);
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Error desconocido al resetear base de datos'
      };
    }
  });

  // === REPORTS HANDLERS ===

  ipcMain.handle('reports:generateDaily', async (_event, date?: string) => {
    const service = await getAttendanceService();
    return service.generateDailyReport(date);
  });

  ipcMain.handle('reports:generateWeekly', async (_event, endDate?: string) => {
    const service = await getAttendanceService();
    return service.generateWeeklyReport(endDate);
  });

  ipcMain.handle('reports:generateMonthly', async (_event, year?: number, month?: number) => {
    const service = await getAttendanceService();
    return service.generateMonthlyReport(year, month);
  });

  ipcMain.handle('reports:generateEmployee', async (_event, employeeId: number, startDate?: string, endDate?: string) => {
    const service = await getAttendanceService();
    return service.generateEmployeeReport(employeeId, startDate, endDate);
  });

  // === BIOMETRIC SERVICE HANDLERS ===

  ipcMain.handle('biometric:isServerAvailable', async () => {
    const service = await getBiometricService();
    return await service.isServerAvailable();
  });

  ipcMain.handle('biometric:captureFingerprint', async () => {
    const service = await getBiometricService();
    return await service.captureFingerprint();
  });

  ipcMain.handle('biometric:enrollFingerprint', async (_event, employeeId: number, fingerPosition: string) => {
    const service = await getBiometricService();
    return await service.enrollFingerprint(employeeId, fingerPosition as any);
  });

  ipcMain.handle('biometric:verifyFingerprint', async (_event, employeeId: number) => {
    const service = await getBiometricService();
    return await service.verifyFingerprint(employeeId);
  });

  ipcMain.handle('biometric:identifyEmployee', async () => {
    const service = await getBiometricService();
    return await service.identifyEmployee();
  });

  ipcMain.handle('biometric:getReaderStats', async () => {
    const service = await getBiometricService();
    return await service.getReaderStats();
  });

  ipcMain.handle('biometric:getDeviceInfo', async () => {
    const service = await getBiometricService();
    return await service.getDeviceInfo();
  });

  // === TOUCH MODE SERVICE HANDLERS ===

  // Singleton instance de TouchModeService
  let touchModeServiceInstance: any = null;

  const getTouchModeService = async () => {
    if (!touchModeServiceInstance) {
      const { TouchModeService } = await import('../sistema-asistencia/services/TouchModeService.js');
      touchModeServiceInstance = new TouchModeService();

      // Configurar event listener para eventos del TouchModeService
      touchModeServiceInstance.onEvent((eventType: string, data: any) => {
        if (eventType === 'CRITICAL_ERROR') {
          logger.error('[Main] Error crítico detectado en TouchModeService:', data.message);

          // Enviar evento al renderer para actualizar UI
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('touchMode:criticalError', {
              message: data.message,
              timestamp: data.timestamp
            });
          }
        }

        // Enviar eventos de asistencia registrada al renderer
        if (eventType === 'CHECK_IN_REGISTERED' || eventType === 'CHECK_OUT_REGISTERED') {
          logger.info(`[Main] Asistencia registrada: ${eventType}`, data);

          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('touchMode:attendanceRegistered', {
              type: eventType,
              data: data
            });
          }
        }
      });

      logger.info('[Main] TouchModeService singleton creado e inicializado');
    }
    return touchModeServiceInstance;
  };

  ipcMain.handle('touchMode:start', async () => {
    const service = await getTouchModeService();
    return await service.start();
  });

  ipcMain.handle('touchMode:stop', async () => {
    const service = await getTouchModeService();
    return await service.stop();
  });

  ipcMain.handle('touchMode:getStatus', async () => {
    const service = await getTouchModeService();
    return await service.getStatus();
  });

  ipcMain.handle('touchMode:getLocalState', async () => {
    const service = await getTouchModeService();
    return service.getLocalState();
  });
}

// Inicialización de la aplicación
app.whenReady().then(async () => {
  logger.info('🚀 Iniciando aplicación ElectronJS con Engine Biométrico...');

  initIpcHandlers();
  createWindow();

  // Iniciar el servidor biométrico automáticamente
  const result = await startBiometricServer();
  if (result.success) {
    logger.info('✅ Sistema listo para capturar huellas');
  } else {
    logger.error('❌ No se pudo iniciar el servidor biométrico:', result.message);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  // Detener servidor biométrico
  if (biometricServerProcess) {
    logger.info('🛑 Deteniendo servidor biométrico...');
    biometricServerProcess.kill();
    biometricServerProcess = null;
  }
});
