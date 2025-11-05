import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

let edge: any;

try {
  edge = require('electron-edge-js');
} catch (error) {
  console.error('Error loading electron-edge-js:', error);
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../static/index.html'));

  // Open DevTools only in development
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }
}

// Initialize .NET Framework DLL
let fpBridge: any = null;

function initDotNetBridge() {
  try {
    if (!edge) {
      console.error('❌ electron-edge-js no está disponible');
      return false;
    }

    const dllPath = path.join(__dirname, '../dotnet/Dp4500FrameworkBridge/bin/Debug/Dp4500FrameworkBridge.dll');

    fpBridge = edge.func({
      assemblyFile: dllPath,
      typeName: 'Dp4500FrameworkBridge.EdgeUruBridge',
      methodName: 'Invoke'
    });

    console.log('✅ .NET Framework Bridge inicializado correctamente');
    return true;
  } catch (error) {
    console.error('❌ Error inicializando .NET Framework Bridge:', error);
    return false;
  }
}

// Initialize IPC handlers with .NET Framework DLL
function initIpcHandlers() {
  // Initialize fingerprint device
  ipcMain.handle('fp:init', async () => {
    try {
      if (!fpBridge) {
        throw new Error('Bridge no inicializado');
      }

      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Timeout: La inicialización tomó más de 30 segundos'));
        }, 30000);

        fpBridge({
          action: 'init',
          onEvent: (evt: any) => {
            console.log('🔔 Bridge Event:', evt);
            if (evt.type === 'error') {
              console.error('❌ Bridge Error:', evt.message);
            }
          }
        }, (error: any, result: any) => {
          clearTimeout(timeout);
          if (error) reject(error);
          else resolve(result);
        });
      });

      return result;
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  });

  // Capture fingerprint
  ipcMain.handle('fp:capture3', async () => {
    try {
      if (!fpBridge) {
        throw new Error('Bridge no inicializado');
      }

      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Timeout: La captura tomó más de 60 segundos'));
        }, 60000);

        fpBridge({
          action: 'capture',
          payload: { maxAttempts: 3 }
        }, (error: any, result: any) => {
          clearTimeout(timeout);
          if (error) reject(error);
          else resolve(result);
        });
      });

      return result;
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  });

  // Enroll and save template
  ipcMain.handle('fp:enrollSave', async (event, id: string, samples = 4) => {
    try {
      if (!fpBridge) {
        throw new Error('Bridge no inicializado');
      }

      // First enroll
      const enrollResult = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Timeout: El enrolamiento tomó más de 120 segundos'));
        }, 120000);

        fpBridge({
          action: 'enroll.captureN',
          payload: { samples }
        }, (error: any, result: any) => {
          clearTimeout(timeout);
          if (error) reject(error);
          else resolve(result);
        });
      }) as any;

      if (!enrollResult.ok) {
        throw new Error(enrollResult.error);
      }

      // Then store with 1 hour TTL
      const storeResult = await new Promise((resolve, reject) => {
        fpBridge({
          action: 'store.save',
          payload: {
            id,
            templateXml: enrollResult.templateXml,
            ttlSeconds: 3600
          }
        }, (error: any, result: any) => {
          if (error) reject(error);
          else resolve(result);
        });
      }) as any;

      if (!storeResult.ok) {
        throw new Error('Error guardando template');
      }

      return enrollResult.templateXml;
    } catch (error: any) {
      throw new Error(error.message);
    }
  });

  // Verify with stored template
  ipcMain.handle('fp:verifyWithStore', async (event, id: string, liveFmdXml: string, farDenominator = 100000) => {
    try {
      if (!fpBridge) {
        throw new Error('Bridge no inicializado');
      }

      // Get stored template
      const getResult = await new Promise((resolve, reject) => {
        fpBridge({
          action: 'store.get',
          payload: { id }
        }, (error: any, result: any) => {
          if (error) reject(error);
          else resolve(result);
        });
      }) as any;

      if (!getResult.ok) {
        throw new Error('Template no encontrado o expirado');
      }

      // Verify
      const verifyResult = await new Promise((resolve, reject) => {
        fpBridge({
          action: 'verify',
          payload: {
            enrolledXml: getResult.templateXml,
            liveXml: liveFmdXml,
            farDenominator
          }
        }, (error: any, result: any) => {
          if (error) reject(error);
          else resolve(result);
        });
      }) as any;

      return {
        ok: verifyResult.ok,
        matched: verifyResult.matched,
        score: verifyResult.score,
        threshold: verifyResult.threshold
      };
    } catch (error: any) {
      throw new Error(error.message);
    }
  });

  // Get reader info
  ipcMain.handle('fp:getReaderInfo', async () => {
    try {
      if (!fpBridge) {
        throw new Error('Bridge no inicializado');
      }

      const result = await new Promise((resolve, reject) => {
        fpBridge({ action: 'reader.info' }, (error: any, result: any) => {
          if (error) reject(error);
          else resolve(result);
        });
      });

      return result;
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  });

  // Cancel capture
  ipcMain.handle('fp:cancel', async () => {
    try {
      if (!fpBridge) {
        throw new Error('Bridge no inicializado');
      }

      const result = await new Promise((resolve, reject) => {
        fpBridge({ action: 'cancel' }, (error: any, result: any) => {
          if (error) reject(error);
          else resolve(result);
        });
      });

      return result;
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  });

  // Dispose
  ipcMain.handle('fp:dispose', async () => {
    try {
      if (!fpBridge) {
        return { ok: true };
      }

      const result = await new Promise((resolve, reject) => {
        fpBridge({ action: 'dispose' }, (error: any, result: any) => {
          if (error) reject(error);
          else resolve(result);
        });
      });

      return result;
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  });

  // ===== NUEVAS FUNCIONALIDADES AVANZADAS =====

  // Identificación 1:N en vivo
  ipcMain.handle('fp:identify1n', async (event, targetFarn = 21474, topK = 5) => {
    try {
      if (!fpBridge) {
        throw new Error('Bridge no inicializado');
      }

      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Timeout: La identificación tomó más de 45 segundos'));
        }, 45000);

        fpBridge({
          action: 'identify.1n',
          payload: { targetFarn, topK }
        }, (error: any, result: any) => {
          clearTimeout(timeout);
          if (error) reject(error);
          else resolve(result);
        });
      });

      return result;
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  });

  // Enrolamiento avanzado con múltiples estrategias
  ipcMain.handle('fp:enrollAdvanced', async (event, samples = 4, targetFarn = 21474, maxRetriesPerSample = 3) => {
    try {
      if (!fpBridge) {
        throw new Error('Bridge no inicializado');
      }

      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Timeout: El enrolamiento avanzado tomó más de 180 segundos'));
        }, 180000);

        fpBridge({
          action: 'enroll.advanced',
          payload: { samples, targetFarn, maxRetriesPerSample }
        }, (error: any, result: any) => {
          clearTimeout(timeout);
          if (error) reject(error);
          else resolve(result);
        });
      });

      return result;
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  });

  // Verificación en vivo optimizada
  ipcMain.handle('fp:verifyLive', async (event, templateXml: string, targetFarn = 21474) => {
    try {
      if (!fpBridge) {
        throw new Error('Bridge no inicializado');
      }

      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Timeout: La verificación en vivo tomó más de 30 segundos'));
        }, 30000);

        fpBridge({
          action: 'verify.live',
          payload: { templateXml, targetFarn }
        }, (error: any, result: any) => {
          clearTimeout(timeout);
          if (error) reject(error);
          else resolve(result);
        });
      });

      return result;
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  });

  // Captura simple para testing
  ipcMain.handle('fp:singleCapture', async () => {
    try {
      if (!fpBridge) {
        throw new Error('Bridge no inicializado');
      }

      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Timeout: La captura simple tomó más de 25 segundos'));
        }, 25000);

        fpBridge({
          action: 'capture.single'
        }, (error: any, result: any) => {
          clearTimeout(timeout);
          if (error) reject(error);
          else resolve(result);
        });
      });

      return result;
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  });

  // Listar plantillas almacenadas
  ipcMain.handle('fp:storeList', async () => {
    try {
      if (!fpBridge) {
        throw new Error('Bridge no inicializado');
      }

      const result = await new Promise((resolve, reject) => {
        fpBridge({
          action: 'store.list'
        }, (error: any, result: any) => {
          if (error) reject(error);
          else resolve(result);
        });
      });

      return result;
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  });
}

app.whenReady().then(() => {
  const bridgeInit = initDotNetBridge();
  if (!bridgeInit) {
    console.error('❌ No se pudo inicializar el bridge .NET Framework');
    console.log('📋 La aplicación continuará pero las funciones de huella dactilar no estarán disponibles');
    console.log('📋 Verifica que el archivo DLL esté en la ruta correcta y que el runtime .NET Framework 4.8 esté instalado');
  }

  initIpcHandlers();
  createWindow();

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

app.on('before-quit', async () => {
  try {
    if (fpBridge) {
      await new Promise((resolve) => {
        fpBridge({ action: 'dispose' }, () => resolve(null));
      });
    }
  } catch (error) {
    console.error('Error cleaning up bridge:', error);
  }
});