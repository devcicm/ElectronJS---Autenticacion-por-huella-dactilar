import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, ChildProcess } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Variables globales
let biometricServerProcess: ChildProcess | null = null;
let mainWindow: BrowserWindow | null = null;

const BIOMETRIC_PORT = 8080;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
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
    const dllPath = path.join(__dirname, '../biometric-engine/out/net472/bridge-csharp.dll');
    const dpuruPath = path.join(__dirname, '../biometric-engine/out/net472/DPUruNet.dll');

    const fs = await import('node:fs/promises');
    await fs.access(dllPath);
    await fs.access(dpuruPath);

    console.log('✅ Bridge C# ya está compilado');
    return true;
  } catch (error) {
    console.error('❌ Bridge C# no encontrado o no compilado');
    console.error('   Por favor ejecuta: msbuild biometric-engine/bridge-csharp/EdgeBridge.csproj /p:Configuration=Release');
    return false;
  }
}

// Iniciar el servidor biométrico
async function startBiometricServer(): Promise<{ success: boolean; message: string }> {
  try {
    // Verificar si ya está corriendo
    const isRunning = await checkBiometricServerStatus();
    if (isRunning) {
      console.log('ℹ️  Servidor biométrico ya está corriendo');
      return { success: true, message: 'Servidor biométrico ya está activo' };
    }

    // Verificar que el bridge C# esté compilado
    const csharpReady = await checkCSharpBridge();
    if (!csharpReady) {
      return { success: false, message: 'Bridge C# no está compilado. Compílalo primero.' };
    }

    const nodePath = path.join(__dirname, '../biometric-engine/node');
    const serverScript = path.join(nodePath, 'dist', 'server.js');

    console.log('🚀 Iniciando servidor biométrico...');

    // Iniciar el proceso
    biometricServerProcess = spawn('node', [serverScript], {
      cwd: nodePath,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      windowsHide: true
    });

    // Capturar salida del proceso
    if (biometricServerProcess.stdout) {
      biometricServerProcess.stdout.on('data', (data) => {
        console.log(`[Biometric Server]: ${data.toString().trim()}`);
      });
    }

    if (biometricServerProcess.stderr) {
      biometricServerProcess.stderr.on('data', (data) => {
        console.error(`[Biometric Server Error]: ${data.toString().trim()}`);
      });
    }

    biometricServerProcess.on('error', (error) => {
      console.error('❌ Error en servidor biométrico:', error);
    });

    biometricServerProcess.on('exit', (code, signal) => {
      console.log(`⚠️  Servidor biométrico terminó. Código: ${code}, Señal: ${signal}`);
      biometricServerProcess = null;
    });

    // Esperar a que el servidor esté listo (máximo 15 segundos)
    let attempts = 0;
    const maxAttempts = 30;

    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 500));
      const isReady = await checkBiometricServerStatus();

      if (isReady) {
        console.log(`✅ Servidor biométrico iniciado correctamente en http://localhost:${BIOMETRIC_PORT}`);
        return { success: true, message: 'Servidor biométrico iniciado correctamente' };
      }

      attempts++;

      if (attempts % 5 === 0) {
        console.log(`⏳ Esperando servidor biométrico... (${attempts}/${maxAttempts})`);
      }
    }

    // Si llegamos aquí, el servidor no respondió a tiempo
    if (biometricServerProcess) {
      biometricServerProcess.kill();
      biometricServerProcess = null;
    }

    return { success: false, message: 'Timeout: El servidor biométrico no respondió a tiempo' };

  } catch (error: any) {
    console.error('❌ Error iniciando servidor biométrico:', error);
    return { success: false, message: `Error: ${error.message}` };
  }
}

// Detener el servidor biométrico
function stopBiometricServer(): { success: boolean; message: string } {
  if (biometricServerProcess) {
    biometricServerProcess.kill();
    biometricServerProcess = null;
    console.log('🛑 Servidor biométrico detenido');
    return { success: true, message: 'Servidor biométrico detenido' };
  }
  return { success: false, message: 'El servidor biométrico no está corriendo' };
}

// Manejadores IPC para comunicación con el renderer
function initIpcHandlers() {
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
}

// Inicialización de la aplicación
app.whenReady().then(async () => {
  console.log('🚀 Iniciando aplicación ElectronJS con Engine Biométrico...');

  initIpcHandlers();
  createWindow();

  // Iniciar el servidor biométrico automáticamente
  const result = await startBiometricServer();
  if (result.success) {
    console.log('✅ Sistema listo para capturar huellas');
  } else {
    console.error('❌ No se pudo iniciar el servidor biométrico:', result.message);
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
    console.log('🛑 Deteniendo servidor biométrico...');
    biometricServerProcess.kill();
    biometricServerProcess = null;
  }
});
