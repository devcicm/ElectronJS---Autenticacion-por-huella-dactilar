import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, ChildProcess } from 'node:child_process';
import { BIOMETRIC_PORT, BIOMETRIC_SERVER, fetchJson } from '../sistema-asistencia/shared/biometric-config.js';
import { logger } from '../sistema-asistencia/shared/logger.js';
import { safeParseInt, safeParseBoolean, safeParseJson, safeClone } from '../sistema-asistencia/shared/object-utils.js';
import { getLocalDateString, getLocalTimeString, timeToMinutes } from '../sistema-asistencia/shared/date-utils.js';

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
let touchModeServiceInstance: any = null;
let isManualServerStop = false;
let absentSchedulerInterval: ReturnType<typeof setInterval> | null = null;
let isAdminSessionUnlocked = false;

const ADMIN_PIN_PEPPER = 'dp4500_kiosk_salt_v1';

function hashAdminPin(pin: string): string {
  return crypto
    .createHash('sha256')
    .update(`${ADMIN_PIN_PEPPER}:${String(pin || '').trim()}`)
    .digest('hex');
}

function verifyAdminPinAgainstDb(rawDb: any, candidatePin?: string): { valid: boolean; hasPin: boolean } {
  const row = rawDb.prepare("SELECT value FROM system_config WHERE key = 'admin_pin_hash'").get() as { value?: string } | undefined;
  const storedHash = row?.value ? String(row.value).trim() : '';
  if (!storedHash) {
    return { valid: true, hasPin: false };
  }
  if (!candidatePin || typeof candidatePin !== 'string') {
    return { valid: false, hasPin: true };
  }
  const candidateHash = hashAdminPin(candidatePin);
  try {
    const a = Buffer.from(storedHash, 'hex');
    const b = Buffer.from(candidateHash, 'hex');
    if (a.length !== b.length) return { valid: false, hasPin: true };
    return { valid: crypto.timingSafeEqual(a, b), hasPin: true };
  } catch {
    return { valid: storedHash === candidateHash, hasPin: true };
  }
}

function getDatabaseFilePath(): string {
  return path.join(process.cwd(), 'sistema-asistencia', 'database', 'attendance.db');
}

function getAutoBackupsDir(): string {
  try {
    return path.join(app.getPath('userData'), 'backups');
  } catch {
    return path.join(os.tmpdir(), 'dp4500-attendance-backups');
  }
}

async function performAutomaticDailyBackup(): Promise<{ created: boolean; path?: string; totalBackups: number }> {
  try {
    const dbFile = getDatabaseFilePath();
    if (!fs.existsSync(dbFile)) {
      return { created: false, totalBackups: 0 };
    }

    const backupsDir = getAutoBackupsDir();
    if (!fs.existsSync(backupsDir)) {
      fs.mkdirSync(backupsDir, { recursive: true });
    }

    const todayStr = getLocalDateString();
    const targetPath = path.join(backupsDir, `attendance-auto-${todayStr}.db`);

    if (!fs.existsSync(targetPath)) {
      const { getDatabaseManager } = await import('../sistema-asistencia/database/init.js');
      const db = getDatabaseManager();
      const rawDb = db.getDatabase();
      try {
        rawDb.pragma('wal_checkpoint(TRUNCATE)');
      } catch {
        // continuar si checkpoint no aplica
      }
      fs.copyFileSync(dbFile, targetPath);
      logger.info(`💾 [Backup] Respaldo automático diario creado en ubicación segura: ${targetPath}`);
    }

    // Rotación: conservar los 7 respaldos automáticos más recientes
    const files = fs.readdirSync(backupsDir)
      .filter(f => f.startsWith('attendance-auto-') && f.endsWith('.db'))
      .sort()
      .reverse();

    for (const oldFile of files.slice(7)) {
      try {
        fs.unlinkSync(path.join(backupsDir, oldFile));
      } catch {}
    }

    return { created: true, path: targetPath, totalBackups: Math.min(files.length, 7) };
  } catch (err: any) {
    logger.warn('[Backup] No se pudo completar el respaldo automático diario:', err?.message || err);
    return { created: false, totalBackups: 0 };
  }
}


function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1366,
    height: 850,
    minWidth: 960,
    minHeight: 600,
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

  // A.1: forwarder de console del renderer → logger main (visible en stdout/terminal)
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    const fns = ['debug', 'info', 'warn', 'error'] as const;
    const fn = fns[level] || 'info';
    (logger as any)[fn](`[Renderer] ${message}`);
  });

  // Bloquear apertura de ventanas secundarias no autorizadas (previene phishing/popup exploits)
  mainWindow.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' };
  });

  // Prevenir navegación no intencionada fuera de la app
  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    try {
      const parsed = new URL(navigationUrl);
      if (parsed.protocol !== 'file:') {
        event.preventDefault();
        logger.warn(`[Security] Bloqueada navegación externa no autorizada hacia: ${navigationUrl}`);
      }
    } catch {
      event.preventDefault();
    }
  });

  // Crash detection: si el renderer muere, log + intentar notificar
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logger.error('❌ Renderer process gone:', details.reason);
  });

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

// B5-fix: esperar readiness con polling por evento spawn (helper reutilizable)
function waitForReady(proc: ChildProcess | null, maxAttempts: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        let resolved = false;
        let attempts = 0;
        const pollOnce = async () => {
            if (resolved) return;
            attempts++;
            if (await checkBiometricServerStatus()) { resolved = true; resolve(true); return; }
            if (attempts >= maxAttempts) { resolved = true; resolve(false); return; }
            if (attempts % 5 === 0) console.log(`⏳ Esperando servidor biométrico... (${attempts}/${maxAttempts})`);
            setTimeout(pollOnce, attempts < 4 ? 200 : 500);
        };
        if (proc) {
            proc.once('spawn', () => pollOnce());
        } else {
            pollOnce();
        }
    });
}

// Iniciar el servidor biométrico
async function startBiometricServer(): Promise<{ success: boolean; message: string }> {
  try {
    isManualServerStop = false;

    // Verificar si ya está corriendo
    const isRunning = await checkBiometricServerStatus();
    if (isRunning) {
      logger.info('ℹ️  Servidor biométrico ya está corriendo');
      if (touchModeServiceInstance) {
        await touchModeServiceInstance.notifyServerStatusChanged(true, true);
      }
      return { success: true, message: 'Servidor biométrico activo y sincronizado' };
    }

    // Verificar que el bridge C# esté compilado
    const csharpReady = await checkCSharpBridge();
    if (!csharpReady) {
      return { success: false, message: 'Bridge C# no está compilado. Compílalo primero.' };
    }

    const nodePath = path.join(__dirname, '../../biometric-engine/node');
    const serverScript = path.join(nodePath, 'dist', 'server.js');

    console.log('🚀 Iniciando servidor biométrico...');

    // B5-revert: usar 'node' del PATH (system node). edge-js 5.x trae un binario .node
    // precompilado para Node 20.x; bajo system Node funciona; bajo Electron's bundled
    // Node falla con ERR_DLOPEN_FAILED. Si en el futuro packaged apps no tienen 'node'
    // en PATH, se requerira edge-js rebuilt para el ABI de Electron (línea roja #7
    // prohibe upgrades en este changeset). Probado OK: ver REPORTE-REFACTOR.md.
    biometricServerProcess = spawn('node', [serverScript], {
      cwd: nodePath,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      windowsHide: true
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
      const wasManual = isManualServerStop;
      isManualServerStop = false;
      biometricServerProcess = null;
      logger.info(`⚠️  Servidor biométrico terminó. Código: ${code}, Señal: ${signal} (manual=${wasManual})`);

      if (!wasManual && touchModeServiceInstance) {
        touchModeServiceInstance.notifyServerStatusChanged(false, false).catch((err: any) =>
          logger.error('[Main] Error notificando caída inesperada del servidor biométrico:', err)
        );
      }
    });

    // Esperar a que el servidor esté listo (máximo 15 segundos).
    // B5-keep: arranque por evento 'spawn' del child process + backoff suave.
    const ready = await waitForReady(biometricServerProcess, 30);
    if (ready) {
      console.log(`✅ Servidor biométrico iniciado correctamente en http://localhost:${BIOMETRIC_PORT}`);
      if (touchModeServiceInstance) {
        await touchModeServiceInstance.notifyServerStatusChanged(true, true);
      }
      return { success: true, message: 'Servidor biométrico iniciado correctamente' };
    }

    if (biometricServerProcess) {
      isManualServerStop = true;
      biometricServerProcess.kill();
      biometricServerProcess = null;
    }

    return { success: false, message: 'Timeout: El servidor biométrico no respondió a tiempo' };

  } catch (error: any) {
    logger.error('❌ Error iniciando servidor biométrico:', error);
    return { success: false, message: `Error: ${error.message}` };
  }
}

// Detener el servidor biométrico (evento controlado manual)
async function stopBiometricServer(): Promise<{ success: boolean; message: string }> {
  isManualServerStop = true;

  // Liberar el lector en el backend antes de apagar
  try {
    await fetchJson(`${BIOMETRIC_SERVER}/api/dispose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
  } catch {
    // Ignorar si el proceso ya no respondía
  }

  let killedProcess = false;
  if (biometricServerProcess) {
    biometricServerProcess.kill();
    biometricServerProcess = null;
    killedProcess = true;
  }

  if (touchModeServiceInstance) {
    await touchModeServiceInstance.notifyServerStatusChanged(false, true);
  }

  logger.info(`🛑 Servicio biométrico detenido manualmente (proceso hijo terminado: ${killedProcess})`);
  return {
    success: true,
    message: killedProcess
      ? 'Servicio biométrico detenido manualmente'
      : 'Servicio biométrico desactivado manualmente'
  };
}

// Manejadores IPC para comunicación con el renderer
function initIpcHandlers() {
  // C: wrapper defensivo. Si un handler tira una excepción no atrapada, el IPC
  // reject silenciosamente y el renderer no recibe feedback. Lo logueamos + retornamos
  // error estructurado.
  const safeHandle = (channel: string, fn: (...args: any[]) => Promise<any> | any) => {
    ipcMain.handle(channel, async (event, ...args) => {
        try {
            const sanitizedArgs = args.map(arg => safeClone(arg));
            return await fn(event, ...sanitizedArgs);
        } catch (error: any) {
            logger.error(`[IPC ${channel}] failed:`, error);
            return { success: false, error: error.message || String(error) };
        }
    });
  };

  // Observabilidad: wrapper que loguea cada IPC (canal, args, tiempo, resultado/error)
  const withTrace = (channel: string, fn: (...args: any[]) => Promise<any> | any) => {
    return safeHandle(channel, async (event, ...args) => {
        const t0 = Date.now();
        try {
            const r = await fn(event, ...args);
            logger.info(`[IPC ${channel}] +${Date.now() - t0}ms ok`);
            return r;
        } catch (e) {
            logger.error(`[IPC ${channel}] +${Date.now() - t0}ms FAIL:`, e?.message || e);
            throw e;
        }
    });
  };

  // Observabilidad: handler que recibe el trace buffer del renderer y lo persiste
  safeHandle('trace:dump', (_event: any, json: string) => {
      try {
          if (typeof json !== 'string') {
              return { ok: false, error: 'Se esperaba una cadena JSON válida' };
          }
          if (json.length > 5 * 1024 * 1024) {
              return { ok: false, error: 'El tamaño del trace excede el límite permitido (5MB)' };
          }
          const dir = path.join(os.tmpdir(), 'electron-fingerprint-traces');
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          const ts = new Date().toISOString().replace(/[:.]/g, '-').replace(/[^a-zA-Z0-9_-]/g, '');
          const file = path.join(dir, `trace-electron-${ts}.json`);
          fs.writeFileSync(file, json, { encoding: 'utf8' });
          const events = safeParseJson<any>(json, null)?.events?.length || 0;
          logger.info(`[trace] dump OK → ${file} (${events} events)`);
          return { ok: true, path: file, events };
      } catch (e: any) {
          logger.error('[trace] dump FAIL:', e?.message || e);
          return { ok: false, error: e?.message || String(e) };
      }
  });

  // Servidor biométrico
  ipcMain.handle('biometric:start', async () => {
    return await startBiometricServer();
  });

  ipcMain.handle('biometric:stop', async () => {
    return await stopBiometricServer();
  });

  ipcMain.handle('biometric:status', async () => {
    const isRunning = await checkBiometricServerStatus();
    const localState = touchModeServiceInstance ? touchModeServiceInstance.getLocalState() : null;
    const manuallyStopped = localState?.stopReason === 'SERVICE_STOPPED_MANUALLY';
    return {
      isRunning: isRunning && !manuallyStopped,
      rawServerResponding: isRunning,
      stopReason: localState?.stopReason || 'NONE'
    };
  });

  // Importar servicios dinámicamente para evitar problemas de carga
  let attendanceServiceInstance: any = null;
  let biometricServiceInstance: any = null;

  ipcMain.handle('config:get', async (_event, updates?: Record<string, string>) => {
    const systemConfig: Record<string, string> = {};
    try {
      const { getDatabaseManager } = await import('../sistema-asistencia/database/init.js');
      const db = getDatabaseManager();
      const rawDb = db.getDatabase();

      const upsertStmt = rawDb.prepare(
        'INSERT INTO system_config (key, value, description) VALUES (?, ?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime(\'now\')'
      );

      // Acciones administrativas polimórficas sobre el canal existente config:get
      if (updates && typeof updates === 'object' && typeof updates.__action === 'string') {
        const action = updates.__action;

        if (action === 'verify_admin_pin') {
          const check = verifyAdminPinAgainstDb(rawDb, updates.pin);
          if (check.valid) {
            isAdminSessionUnlocked = true;
          }
          return {
            success: true,
            valid: check.valid,
            hasPin: check.hasPin,
            message: check.valid ? 'PIN verificado correctamente' : 'PIN de Administrador incorrecto'
          };
        }

        if (action === 'lock_admin_session') {
          isAdminSessionUnlocked = false;
          return { success: true, locked: true };
        }

        if (action === 'set_admin_pin') {
          const currentCheck = verifyAdminPinAgainstDb(rawDb, updates.currentPin);
          if (currentCheck.hasPin && !currentCheck.valid && !isAdminSessionUnlocked) {
            return {
              success: false,
              message: 'El PIN actual ingresado es incorrecto. No se autorizó el cambio.'
            };
          }

          if (updates.remove === '1') {
            rawDb.prepare("DELETE FROM system_config WHERE key = 'admin_pin_hash'").run();
            upsertStmt.run('kiosk_lock_enabled', '0', 'Bloqueo Modo Kiosco');
            isAdminSessionUnlocked = false;
            logger.info('🔓 [Security] PIN de Administrador eliminado y Modo Kiosco desactivado');
            return {
              success: true,
              hasPin: false,
              kioskLockEnabled: false,
              message: 'PIN de Administrador eliminado correctamente'
            };
          }

          const newPin = String(updates.newPin || '').trim();
          if (newPin.length < 4 || newPin.length > 16) {
            return {
              success: false,
              message: 'El PIN debe tener entre 4 y 16 caracteres'
            };
          }

          const hashed = hashAdminPin(newPin);
          const enableKiosk = updates.kioskLock === '0' ? '0' : '1';
          upsertStmt.run('admin_pin_hash', hashed, 'Hash SHA-256 del PIN de Administrador');
          upsertStmt.run('kiosk_lock_enabled', enableKiosk, 'Bloqueo Modo Kiosco activo');
          isAdminSessionUnlocked = true;
          logger.info('🔐 [Security] PIN de Administrador actualizado con hash SHA-256');
          return {
            success: true,
            hasPin: true,
            kioskLockEnabled: enableKiosk === '1',
            message: 'PIN de Administrador configurado exitosamente'
          };
        }

        if (action === 'backup_database') {
          const pinCheck = verifyAdminPinAgainstDb(rawDb, updates.__pin);
          if (pinCheck.hasPin && !pinCheck.valid && !isAdminSessionUnlocked) {
            return {
              success: false,
              requiresPin: true,
              message: 'Operación protegida: Verifique su PIN de Administrador para exportar la base de datos.'
            };
          }

          const dbFile = getDatabaseFilePath();
          if (!fs.existsSync(dbFile)) {
            return { success: false, message: 'No se encontró el archivo de base de datos activo.' };
          }

          const todayStr = getLocalDateString();
          const saveDialogResult = await dialog.showSaveDialog(mainWindow!, {
            title: 'Exportar Respaldo Seguro de Base de Datos SQLite',
            defaultPath: `respaldo-asistencia-${todayStr}.db`,
            filters: [
              { name: 'Base de Datos SQLite (*.db)', extensions: ['db', 'sqlite'] }
            ]
          });

          if (saveDialogResult.canceled || !saveDialogResult.filePath) {
            return { success: false, canceled: true, message: 'Exportación cancelada por el usuario' };
          }

          try {
            rawDb.pragma('wal_checkpoint(TRUNCATE)');
          } catch {}

          fs.copyFileSync(dbFile, saveDialogResult.filePath);
          logger.info(`💾 [Backup] Respaldo manual exportado por administrador a: ${saveDialogResult.filePath}`);
          return {
            success: true,
            filePath: saveDialogResult.filePath,
            message: 'Respaldo de base de datos exportado exitosamente'
          };
        }

        if (action === 'restore_database') {
          const pinCheck = verifyAdminPinAgainstDb(rawDb, updates.__pin);
          if (pinCheck.hasPin && !pinCheck.valid && !isAdminSessionUnlocked) {
            return {
              success: false,
              requiresPin: true,
              message: 'Operación protegida: Verifique su PIN de Administrador para restaurar la base de datos.'
            };
          }

          const openDialogResult = await dialog.showOpenDialog(mainWindow!, {
            title: 'Seleccionar Archivo de Respaldo SQLite para Restaurar',
            properties: ['openFile'],
            filters: [
              { name: 'Base de Datos SQLite (*.db, *.sqlite, *.bak)', extensions: ['db', 'sqlite', 'bak'] }
            ]
          });

          if (openDialogResult.canceled || openDialogResult.filePaths.length === 0) {
            return { success: false, canceled: true, message: 'Restauración cancelada por el usuario' };
          }

          const candidatePath = openDialogResult.filePaths[0];
          const stat = fs.statSync(candidatePath);
          if (stat.size < 4096) {
            return { success: false, message: 'El archivo seleccionado es demasiado pequeño o no es una base de datos SQLite válida.' };
          }

          const headerBuf = Buffer.alloc(16);
          const fd = fs.openSync(candidatePath, 'r');
          try {
            fs.readSync(fd, headerBuf, 0, 16, 0);
          } finally {
            fs.closeSync(fd);
          }

          if (headerBuf.toString('utf8', 0, 15) !== 'SQLite format 3') {
            return { success: false, message: 'Archivo rechazado: La cabecera binaria no corresponde a SQLite format 3.' };
          }

          // Validar integridad y tablas requeridas en modo solo lectura antes de tocar la BD activa
          try {
            const Database = (await import('better-sqlite3')).default;
            const testDb = new Database(candidatePath, { readonly: true });
            try {
              const integrity = testDb.pragma('integrity_check', { simple: true });
              if (integrity !== 'ok') {
                return { success: false, message: `El archivo de respaldo presenta daños de integridad (${integrity}).` };
              }
              const tables = (testDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
                .map(t => t.name);
              const requiredTables = ['employees', 'attendance_records', 'departments', 'shifts', 'fingerprints', 'system_config'];
              const missing = requiredTables.filter(req => !tables.includes(req));
              if (missing.length > 0) {
                return {
                  success: false,
                  message: `El archivo SQLite no pertenece a este sistema (faltan tablas: ${missing.join(', ')}).`
                };
              }
            } finally {
              testDb.close();
            }
          } catch (verifyErr: any) {
            return {
              success: false,
              message: `No se pudo validar el archivo de respaldo: ${verifyErr?.message || verifyErr}`
            };
          }

          // Crear copia de seguridad previa a la restauración
          const backupsDir = getAutoBackupsDir();
          if (!fs.existsSync(backupsDir)) {
            fs.mkdirSync(backupsDir, { recursive: true });
          }
          const dbFile = getDatabaseFilePath();
          if (fs.existsSync(dbFile)) {
            try {
              rawDb.pragma('wal_checkpoint(TRUNCATE)');
            } catch {}
            const preRestorePath = path.join(backupsDir, `attendance-pre-restore-${Date.now()}.db`);
            fs.copyFileSync(dbFile, preRestorePath);
            logger.info(`🛡️ [Restore] Respaldo preventivo pre-restauración guardado en: ${preRestorePath}`);
          }

          // Cerrar conexión activa, reemplazar archivo y limpiar posibles archivos WAL/SHM huérfanos
          // Se reutiliza la MISMA instancia de DatabaseManager (close + initialize) para que los
          // modelos que ya la referencian (AttendanceService, TouchModeService, BiometricService)
          // nunca queden apuntando a una conexión cerrada.
          db.close();

          for (const suffix of ['-wal', '-shm']) {
            const walFile = `${dbFile}${suffix}`;
            if (fs.existsSync(walFile)) {
              try { fs.unlinkSync(walFile); } catch {}
            }
          }

          try {
            fs.copyFileSync(candidatePath, dbFile);
          } finally {
            // Reabrir siempre (aunque la copia falle) para no dejar la app sin conexión
            db.initialize();
          }

          // Sincronizar plantillas biométricas en RAM
          if (touchModeServiceInstance) {
            await touchModeServiceInstance.syncFingerprintsStore();
          }

          logger.info(`✅ [Restore] Base de datos restaurada exitosamente desde: ${candidatePath}`);
          return {
            success: true,
            message: 'Base de datos restaurada, verificada y sincronizada exitosamente.'
          };
        }
      }

      if (updates && typeof updates === 'object' && Object.keys(updates).length > 0) {
        for (const [k, v] of Object.entries(updates)) {
          if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
          // Proteger claves sensibles contra sobrescritura directa sin acción autenticada
          if (k === 'admin_pin_hash' || k === 'has_admin_pin' || k.startsWith('__')) continue;
          if (!/^[a-zA-Z0-9_]{1,64}$/.test(k)) continue;
          if (v !== undefined && v !== null) {
            upsertStmt.run(k, String(v).slice(0, 500), `Configuración: ${k}`);
          }
        }
      }

      const rows = db.query<{ key: string; value: string }>('SELECT key, value FROM system_config');
      let hasPin = false;
      for (const row of rows) {
        if (row.key === 'admin_pin_hash') {
          hasPin = Boolean(row.value && row.value.trim().length > 0);
          continue; // NUNCA exponer el hash del PIN al proceso renderer
        }
        systemConfig[row.key] = row.value;
      }
      systemConfig.has_admin_pin = hasPin ? '1' : '0';
      if (!systemConfig.kiosk_lock_enabled) {
        systemConfig.kiosk_lock_enabled = '0';
      }
      if (!systemConfig.work_days) {
        systemConfig.work_days = '1,2,3,4,5';
      }
      systemConfig.auto_backups_dir = getAutoBackupsDir();
      try {
        const bDir = getAutoBackupsDir();
        const bFiles = fs.existsSync(bDir)
          ? fs.readdirSync(bDir).filter(f => f.endsWith('.db'))
          : [];
        systemConfig.auto_backups_count = String(bFiles.length);
      } catch {
        systemConfig.auto_backups_count = '0';
      }
    } catch (e: any) {
      logger.error('Error al sincronizar system_config en config:get:', e?.message || e);
    }

    return {
      biometricPort: BIOMETRIC_PORT,
      systemConfig
    };
  });
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

  // Check-in / Check-out (C: safeHandle)
  safeHandle('attendance:checkIn', async (_event, employeeId: number, fingerprintVerified: boolean) => {
    const service = await getAttendanceService();
    return await service.checkInWithFingerprint(safeParseInt(employeeId, 0), safeParseBoolean(fingerprintVerified, true));
  });

  safeHandle('attendance:checkOut', async (_event, employeeId: number) => {
    const service = await getAttendanceService();
    return await service.checkOut(safeParseInt(employeeId, 0));
  });

  ipcMain.handle('attendance:canCheckIn', async (_event, employeeId: number) => {
    const service = await getAttendanceService();
    return service.canCheckIn(safeParseInt(employeeId, 0));
  });

  ipcMain.handle('attendance:canCheckOut', async (_event, employeeId: number) => {
    const service = await getAttendanceService();
    return service.canCheckOut(safeParseInt(employeeId, 0));
  });

  // Empleados
  ipcMain.handle('attendance:getEmployees', async (_event, filters?: any) => {
    const { employeeModel } = await getModels();
    return employeeModel.getAllWithDetails(filters ? safeClone(filters) : undefined);
  });

  ipcMain.handle('attendance:getEmployeeById', async (_event, id: number) => {
    const { employeeModel } = await getModels();
    return employeeModel.getByIdWithDetails(safeParseInt(id, 0));
  });

  ipcMain.handle('attendance:getEmployeeDetails', async (_event, id: number) => {
    const service = await getAttendanceService();
    return service.getEmployeeDetails(safeParseInt(id, 0));
  });

  function mapEmployeeSqliteError(error: any, fallbackMessage: string): string {
    const msg = error?.message || '';
    if (msg.includes('UNIQUE constraint failed: employees.email')) {
      return 'Ya existe un empleado con ese correo electrónico';
    }
    if (msg.includes('UNIQUE constraint failed: employees.employee_code')) {
      return 'Ya existe un empleado con ese código';
    }
    if (msg.includes('FOREIGN KEY constraint failed') || msg.includes('inválido')) {
      return error?.message || 'Departamento o turno inválido';
    }
    return fallbackMessage;
  }

  ipcMain.handle('attendance:createEmployee', async (_event, data: any) => {
    try {
      const { employeeModel } = await getModels();
      const employee = employeeModel.create(safeClone(data));
      return { success: true, data: employee, message: 'Empleado creado exitosamente' };
    } catch (error: any) {
      logger.error('Error creando empleado:', error);
      return { success: false, message: mapEmployeeSqliteError(error, 'Error al crear empleado') };
    }
  });

  ipcMain.handle('attendance:updateEmployee', async (_event, data: any) => {
    try {
      const { employeeModel } = await getModels();
      const employee = employeeModel.update(safeClone(data));
      return { success: true, data: employee, message: 'Empleado actualizado exitosamente' };
    } catch (error: any) {
      logger.error('Error actualizando empleado:', error);
      return { success: false, message: mapEmployeeSqliteError(error, 'Error al actualizar empleado') };
    }
  });

  ipcMain.handle('attendance:deleteEmployee', async (_event, id: number) => {
    const { employeeModel } = await getModels();
    const deleted = employeeModel.delete(safeParseInt(id, 0));
    if (deleted && touchModeServiceInstance) {
      await touchModeServiceInstance.syncFingerprintsStore();
    }
    return deleted;
  });

  // Registros de asistencia
  ipcMain.handle('attendance:getAttendanceRecords', async (_event, filters?: any) => {
    const service = await getAttendanceService();
    return service.getAttendanceRecords(filters ? safeClone(filters) : undefined);
  });

  // Departamentos
  ipcMain.handle('attendance:getDepartments', async () => {
    const { departmentModel } = await getModels();
    return departmentModel.getAll();
  });

  ipcMain.handle('attendance:createDepartment', async (_event, data: any) => {
    const { departmentModel } = await getModels();
    return departmentModel.create(safeClone(data));
  });

  ipcMain.handle('attendance:updateDepartment', async (_event, data: any) => {
    const { departmentModel } = await getModels();
    return departmentModel.update(safeClone(data));
  });

  ipcMain.handle('attendance:deleteDepartment', async (_event, id: number) => {
    const { departmentModel } = await getModels();
    return departmentModel.delete(safeParseInt(id, 0));
  });

  // Turnos
  ipcMain.handle('attendance:getShifts', async () => {
    const { shiftModel } = await getModels();
    return shiftModel.getAll();
  });

  ipcMain.handle('attendance:createShift', async (_event, data: any) => {
    const { shiftModel } = await getModels();
    return shiftModel.create(safeClone(data));
  });

  ipcMain.handle('attendance:updateShift', async (_event, data: any) => {
    const { shiftModel } = await getModels();
    return shiftModel.update(safeClone(data));
  });

  ipcMain.handle('attendance:deleteShift', async (_event, id: number) => {
    const { shiftModel } = await getModels();
    return shiftModel.delete(safeParseInt(id, 0));
  });

  // Huellas
  ipcMain.handle('attendance:getEmployeeFingerprints', async (_event, employeeId: number) => {
    const { fingerprintModel } = await getModels();
    // Seguridad: la plantilla biométrica (template_data) nunca sale del proceso main
    return fingerprintModel.getByEmployee(safeParseInt(employeeId, 0))
      .map(({ template_data, ...meta }: any) => meta);
  });

  ipcMain.handle('attendance:deleteFingerprint', async (_event, id: number) => {
    const { fingerprintModel } = await getModels();
    const deleted = fingerprintModel.delete(safeParseInt(id, 0));
    if (deleted && touchModeServiceInstance) {
      await touchModeServiceInstance.syncFingerprintsStore();
    }
    return deleted;
  });

  ipcMain.handle('attendance:deleteAllEmployeeFingerprints', async (_event, employeeId: number) => {
    const { fingerprintModel } = await getModels();
    const deleted = fingerprintModel.deleteByEmployee(safeParseInt(employeeId, 0));
    if (touchModeServiceInstance) {
      await touchModeServiceInstance.syncFingerprintsStore();
    }
    return deleted;
  });

  // Resetear toda la base de datos
  ipcMain.handle('attendance:resetDatabase', async () => {
    try {
      const { getDatabaseManager } = await import('../sistema-asistencia/database/init.js');
      const db = getDatabaseManager();
      const database = db.getDatabase();

      // Protección: si existe PIN de Administrador, exigir sesión desbloqueada (verify_admin_pin previo)
      const pinState = verifyAdminPinAgainstDb(database);
      if (pinState.hasPin && !isAdminSessionUnlocked) {
        logger.warn('⛔ [RESET] Intento de reseteo bloqueado: sesión de administrador no verificada');
        return {
          success: false,
          requiresPin: true,
          message: 'Operación protegida: verifique su PIN de Administrador antes de resetear la base de datos.'
        };
      }

      // Respaldo preventivo antes de una operación destructiva
      try {
        const backupsDir = getAutoBackupsDir();
        if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });
        const dbFile = getDatabaseFilePath();
        if (fs.existsSync(dbFile)) {
          try { database.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
          fs.copyFileSync(dbFile, path.join(backupsDir, `attendance-pre-reset-${Date.now()}.db`));
        }
      } catch (bkErr: any) {
        logger.warn('[RESET] No se pudo crear respaldo preventivo:', bkErr?.message || bkErr);
      }

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

// 4. Eliminar departamentos personalizados (N1: is_default, no posicional)
            const result4 = database.prepare('DELETE FROM departments WHERE is_default = 0').run();
            logger.info(`✅ [RESET] ${result4.changes} departamentos personalizados eliminados`);

            // 5. Eliminar turnos personalizados (N1: is_default, no posicional)
            const result5 = database.prepare('DELETE FROM shifts WHERE is_default = 0').run();
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

      if (touchModeServiceInstance) {
        await touchModeServiceInstance.syncFingerprintsStore();
      }

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
    return service.generateMonthlyReport(
      year !== undefined ? safeParseInt(year, 0) : undefined,
      month !== undefined ? safeParseInt(month, 0) : undefined
    );
  });

  ipcMain.handle('reports:generateEmployee', async (_event, employeeId: number, startDate?: string, endDate?: string) => {
    const service = await getAttendanceService();
    return service.generateEmployeeReport(safeParseInt(employeeId, 0), startDate, endDate);
  });

  // === TOUCH MODE SERVICE & BIOMETRIC HARDWARE COORDINATION ===

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
              timestamp: data.timestamp,
              state: data.state
            });
          }
        }

        // Enviar eventos de asistencia, FSM, servicio y eventos Plug & Play del lector al renderer
        if (
          eventType === 'CHECK_IN_REGISTERED' ||
          eventType === 'CHECK_OUT_REGISTERED' ||
          eventType === 'READER_CONNECTED' ||
          eventType === 'READER_DISCONNECTED' ||
          eventType === 'STATE_CHANGED' ||
          eventType === 'SERVICE_STATUS_CHANGED' ||
          eventType === 'FINGER_TOUCHED' ||
          eventType === 'IDENTIFICATION_FAILED' ||
          eventType === 'CHECK_OUT_TOO_SOON' ||
          eventType === 'ALREADY_REGISTERED' ||
          eventType === 'AUTO_REGISTER_ERROR'
        ) {
          logger.info(`[Main] Evento biométrico hacia renderer: ${eventType}`, data);

          if (mainWindow && !mainWindow.isDestroyed()) {
            const payloadData =
              data && typeof data === 'object' && !data.state && touchModeServiceInstance
                ? { ...data, state: touchModeServiceInstance.getLocalState() }
                : data;
            mainWindow.webContents.send('touchMode:attendanceRegistered', {
              type: eventType,
              data: payloadData
            });
          }
        }
      });

      touchModeServiceInstance.ensureEventStreamConnected();
      logger.info('[Main] TouchModeService singleton creado e inicializado');
    }
    return touchModeServiceInstance;
  };

  const pauseTouchModeIfActive = async (): Promise<boolean> => {
    if (touchModeServiceInstance && touchModeServiceInstance.getLocalState().isActive) {
      logger.info('[Main] Pausando TouchMode temporalmente para operación biométrica');
      await touchModeServiceInstance.stop('OPERATION_PAUSE');
      return true;
    }
    return false;
  };

  const resumeTouchModeIfWasActive = async (wasActive: boolean) => {
    if (wasActive && touchModeServiceInstance) {
      logger.info('[Main] Reanudando TouchMode tras operación biométrica');
      await touchModeServiceInstance.start({ isAutoRecovery: true });
    }
  };

  // === BIOMETRIC SERVICE HANDLERS ===

  safeHandle('biometric:isServerAvailable', async () => {
    const service = await getBiometricService();
    return await service.isServerAvailable();
  });

  safeHandle('biometric:captureFingerprint', async () => {
    const wasActive = await pauseTouchModeIfActive();
    if (touchModeServiceInstance) {
      touchModeServiceInstance.setHardwareState('IDENTIFYING', 'Capturando huella dactilar');
    }
    try {
      const service = await getBiometricService();
      return await service.captureFingerprint();
    } finally {
      if (touchModeServiceInstance && !wasActive) {
        touchModeServiceInstance.setHardwareState('IDLE', 'Captura finalizada');
      }
      await resumeTouchModeIfWasActive(wasActive);
    }
  });

  safeHandle('biometric:enrollFingerprint', async (_event, employeeId: number, fingerPosition: string) => {
    const wasActive = await pauseTouchModeIfActive();
    if (touchModeServiceInstance) {
      touchModeServiceInstance.setHardwareState('ENROLLING', 'Enrolamiento iniciado');
    }
    try {
      const service = await getBiometricService();
      const result = await service.enrollFingerprint(employeeId, fingerPosition as any);
      if (result.success && touchModeServiceInstance) {
        if (!wasActive) {
          touchModeServiceInstance.setHardwareState('IDLE', 'Enrolamiento finalizado');
        }
        await touchModeServiceInstance.syncFingerprintsStore();
      }
      return result;
    } finally {
      if (touchModeServiceInstance && !wasActive && touchModeServiceInstance.getHardwareState() === 'ENROLLING') {
        touchModeServiceInstance.setHardwareState('IDLE', 'Enrolamiento finalizado');
      }
      await resumeTouchModeIfWasActive(wasActive);
    }
  });

  safeHandle('biometric:verifyFingerprint', async (_event, employeeId: number) => {
    const wasActive = await pauseTouchModeIfActive();
    if (touchModeServiceInstance) {
      touchModeServiceInstance.setHardwareState('IDENTIFYING', 'Verificando huella dactilar (1:1)');
    }
    try {
      const service = await getBiometricService();
      return await service.verifyFingerprint(employeeId);
    } finally {
      if (touchModeServiceInstance && !wasActive && touchModeServiceInstance.getHardwareState() === 'IDENTIFYING') {
        touchModeServiceInstance.setHardwareState('IDLE', 'Verificación finalizada');
      }
      await resumeTouchModeIfWasActive(wasActive);
    }
  });

  safeHandle('biometric:identifyEmployee', async () => {
    const wasActive = await pauseTouchModeIfActive();
    if (touchModeServiceInstance) {
      touchModeServiceInstance.setHardwareState('IDENTIFYING', 'Identificando huella dactilar (1:N)');
    }
    try {
      const service = await getBiometricService();
      return await service.identifyEmployee();
    } finally {
      if (touchModeServiceInstance && !wasActive && touchModeServiceInstance.getHardwareState() === 'IDENTIFYING') {
        touchModeServiceInstance.setHardwareState('IDLE', 'Identificación finalizada');
      }
      await resumeTouchModeIfWasActive(wasActive);
    }
  });

  safeHandle('biometric:getReaderStats', async () => {
    const service = await getBiometricService();
    return await service.getReaderStats();
  });

  safeHandle('biometric:getDeviceInfo', async () => {
    const service = await getBiometricService();
    return await service.getDeviceInfo();
  });

  // === TOUCH MODE SERVICE HANDLERS ===

  safeHandle('touchMode:start', async () => {
    const service = await getTouchModeService();
    return await service.start();
  });

  safeHandle('touchMode:stop', async () => {
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

// Scheduler de corte automático de faltas (cada 60 s). Idempotente: usa last_auto_absent_date.
async function runAbsentSchedulerTick(): Promise<void> {
  try {
    const { getDatabaseManager } = await import('../sistema-asistencia/database/init.js');
    const db = getDatabaseManager();
    const rows = db.query<{ key: string; value: string }>(
      "SELECT key, value FROM system_config WHERE key IN ('auto_mark_absent_time','work_days','last_auto_absent_date')"
    );
    const cfg: Record<string, string> = {};
    for (const r of rows) cfg[r.key] = r.value;

    const now = new Date();
    const today = getLocalDateString(now);
    if (cfg.last_auto_absent_date === today) return;

    const workDays = String(cfg.work_days || '1,2,3,4,5')
      .split(',')
      .map(s => safeParseInt(s.trim(), -1))
      .filter(n => n >= 0 && n <= 6);
    if (!workDays.includes(now.getDay())) return;

    const cutoff = timeToMinutes(cfg.auto_mark_absent_time || '09:00');
    const nowMinutes = timeToMinutes(getLocalTimeString(now));
    if (nowMinutes < cutoff) return;

    const { AttendanceModel } = await import('../sistema-asistencia/models/index.js');
    const marked = new AttendanceModel(db).markAbsentees(today);
    db.execute(
      'INSERT INTO system_config (key, value, description) VALUES (?, ?, ?) ' +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
      ['last_auto_absent_date', today, 'Última fecha de corte automático de faltas']
    );
    logger.info(`⏰ [Scheduler] Corte automático de faltas ejecutado (${today}): ${marked} ausente(s)`);

    if (marked > 0 && mainWindow && !mainWindow.isDestroyed()) {
      // Reutiliza el canal existente para que el renderer refresque dashboard/registros
      mainWindow.webContents.send('touchMode:attendanceRegistered', {
        type: 'ABSENTEES_MARKED',
        data: { date: today, markedCount: marked }
      });
    }
  } catch (err: any) {
    logger.warn('[Scheduler] Error en corte automático de faltas:', err?.message || err);
  }
}

// Inicialización de la aplicación
app.whenReady().then(async () => {
  logger.info('🚀 Iniciando aplicación ElectronJS con Engine Biométrico...');

  initIpcHandlers();
  createWindow();

  // Respaldo automático diario (fuera del repositorio, en userData/backups, rotación de 7)
  performAutomaticDailyBackup().catch(() => {});

  // Scheduler de corte de faltas
  if (absentSchedulerInterval) clearInterval(absentSchedulerInterval);
  setTimeout(() => { runAbsentSchedulerTick(); }, 15_000);
  absentSchedulerInterval = setInterval(() => {
    runAbsentSchedulerTick();
    performAutomaticDailyBackup().catch(() => {});
  }, 60_000);

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
  if (absentSchedulerInterval) {
    clearInterval(absentSchedulerInterval);
    absentSchedulerInterval = null;
  }
  // Detener servidor biométrico
  if (biometricServerProcess) {
    logger.info('🛑 Deteniendo servidor biométrico...');
    biometricServerProcess.kill();
    biometricServerProcess = null;
  }
});
