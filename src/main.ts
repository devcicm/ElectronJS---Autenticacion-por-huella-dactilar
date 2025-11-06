import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import express from 'express';
import { DatabaseService } from './database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

// Servicios globales
let db: DatabaseService;
let expressServer: any;
let biometricBridge: any;
let mainWindow: BrowserWindow | null = null;

// Puerto del servidor Express interno
const EXPRESS_PORT = 3001;

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

  mainWindow.loadFile(path.join(__dirname, '../static/index.html'));

  // Abrir DevTools en modo desarrollo
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Inicializar servidor Express interno
function initExpressServer() {
  const server = express();
  server.use(express.json());

  // CORS para permitir comunicación con el biometric-engine
  server.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      return res.sendStatus(200);
    }
    next();
  });

  // API: Health check
  server.get('/api/health', (req, res) => {
    res.json({ ok: true, message: 'Servidor funcionando' });
  });

  // API: Obtener todos los empleados
  server.get('/api/employees', (req, res) => {
    try {
      const activeOnly = req.query.active === 'true';
      const employees = db.getAllEmployees(activeOnly);
      res.json({ ok: true, employees });
    } catch (error: any) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  // API: Obtener empleado por ID
  server.get('/api/employees/:id', (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const employee = db.getEmployeeById(id);
      if (employee) {
        res.json({ ok: true, employee });
      } else {
        res.status(404).json({ ok: false, error: 'Empleado no encontrado' });
      }
    } catch (error: any) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  // API: Crear nuevo empleado
  server.post('/api/employees', (req, res) => {
    try {
      const employee = req.body;
      const id = db.createEmployee(employee);
      res.json({ ok: true, id });
    } catch (error: any) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  // API: Actualizar empleado
  server.put('/api/employees/:id', (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const employee = req.body;
      const success = db.updateEmployee(id, employee);
      if (success) {
        res.json({ ok: true });
      } else {
        res.status(404).json({ ok: false, error: 'Empleado no encontrado' });
      }
    } catch (error: any) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  // API: Eliminar empleado
  server.delete('/api/employees/:id', (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const success = db.deleteEmployee(id);
      if (success) {
        res.json({ ok: true });
      } else {
        res.status(404).json({ ok: false, error: 'Empleado no encontrado' });
      }
    } catch (error: any) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  // API: Obtener huellas de un empleado
  server.get('/api/employees/:id/fingerprints', (req, res) => {
    try {
      const employeeId = parseInt(req.params.id);
      const fingerprints = db.getFingerprintsByEmployee(employeeId);
      res.json({ ok: true, fingerprints });
    } catch (error: any) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  // API: Guardar huella digital en base de datos
  server.post('/api/fingerprints', (req, res) => {
    try {
      const fingerprint = req.body;
      const id = db.createFingerprint(fingerprint);
      res.json({ ok: true, id });
    } catch (error: any) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  // API: Obtener asistencias de hoy
  server.get('/api/attendance/today', (req, res) => {
    try {
      const records = db.getTodayAttendance();
      res.json({ ok: true, records });
    } catch (error: any) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  // API: Obtener asistencias de un empleado
  server.get('/api/attendance/employee/:id', (req, res) => {
    try {
      const employeeId = parseInt(req.params.id);
      const limit = parseInt(req.query.limit as string) || 50;
      const records = db.getAttendanceByEmployee(employeeId, limit);
      res.json({ ok: true, records });
    } catch (error: any) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  // API: Registrar asistencia
  server.post('/api/attendance/clock', async (req, res) => {
    try {
      const { employeeCode, fingerUsed, notes } = req.body;

      // Buscar empleado
      const employee = db.getEmployeeByCode(employeeCode);
      if (!employee) {
        return res.status(404).json({ ok: false, error: 'Empleado no encontrado' });
      }

      // Determinar tipo de registro (entrada o salida)
      const lastRecord = db.getLastAttendanceByEmployee(employee.id!);
      const recordType = (!lastRecord || lastRecord.recordType === 'EXIT') ? 'ENTRY' : 'EXIT';

      // Crear registro
      const recordId = db.createAttendanceRecord({
        employeeId: employee.id!,
        recordType,
        recordedAt: new Date().toISOString(),
        fingerUsed,
        notes
      });

      res.json({
        ok: true,
        record: {
          id: recordId,
          employeeId: employee.id,
          recordType,
          recordedAt: new Date().toISOString()
        },
        employee: {
          code: employee.employeeCode,
          name: `${employee.firstName} ${employee.lastName}`,
          position: employee.position,
          photoUrl: employee.photoUrl
        }
      });
    } catch (error: any) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  // API: Estadísticas generales
  server.get('/api/stats', (req, res) => {
    try {
      const totalEmployees = db.getAllEmployees(true).length;
      const todayRecords = db.getTodayAttendance();
      const totalFingerprints = db.getAllFingerprints().length;

      res.json({
        ok: true,
        stats: {
          totalEmployees,
          todayAttendance: todayRecords.length,
          totalFingerprints
        }
      });
    } catch (error: any) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  expressServer = server.listen(EXPRESS_PORT, () => {
    console.log(`✅ Servidor Express iniciado en http://localhost:${EXPRESS_PORT}`);
  });
}

// Inicializar Base de Datos
function initDatabase() {
  db = new DatabaseService();

  // Insertar datos de prueba si está en modo dev
  if (process.argv.includes('--seed')) {
    db.seedDemoData();
  }

  console.log('✅ Base de datos SQLite inicializada');
}

// Inicializar Bridge Biométrico (edge-uru-ui)
async function initBiometricBridge() {
  try {
    // El biometric-engine se ejecutará en su propio puerto (8080)
    // Este main.ts simplemente se comunica con él vía HTTP
    console.log('ℹ️  Para usar el lector biométrico, ejecuta:');
    console.log('   cd biometric-engine/node && npm start');
    console.log('   El servidor biométrico debe estar en http://localhost:8080');
  } catch (error) {
    console.error('❌ Error inicializando bridge biométrico:', error);
  }
}

// Manejadores IPC para comunicación con el renderer
function initIpcHandlers() {
  // Obtener configuración
  ipcMain.handle('config:get', () => {
    return {
      expressPort: EXPRESS_PORT,
      biometricPort: 8080
    };
  });

  // Obtener stats
  ipcMain.handle('stats:get', () => {
    const totalEmployees = db.getAllEmployees(true).length;
    const todayRecords = db.getTodayAttendance();
    const totalFingerprints = db.getAllFingerprints().length;

    return {
      totalEmployees,
      todayAttendance: todayRecords.length,
      totalFingerprints
    };
  });

  // CRUD Empleados
  ipcMain.handle('employees:getAll', (event, activeOnly = false) => {
    return db.getAllEmployees(activeOnly);
  });

  ipcMain.handle('employees:getById', (event, id: number) => {
    return db.getEmployeeById(id);
  });

  ipcMain.handle('employees:create', (event, employee) => {
    return db.createEmployee(employee);
  });

  ipcMain.handle('employees:update', (event, id: number, employee) => {
    return db.updateEmployee(id, employee);
  });

  ipcMain.handle('employees:delete', (event, id: number) => {
    return db.deleteEmployee(id);
  });

  // Huellas
  ipcMain.handle('fingerprints:getByEmployee', (event, employeeId: number) => {
    return db.getFingerprintsByEmployee(employeeId);
  });

  ipcMain.handle('fingerprints:create', (event, fingerprint) => {
    return db.createFingerprint(fingerprint);
  });

  // Asistencia
  ipcMain.handle('attendance:today', () => {
    return db.getTodayAttendance();
  });

  ipcMain.handle('attendance:getByEmployee', (event, employeeId: number, limit = 50) => {
    return db.getAttendanceByEmployee(employeeId, limit);
  });
}

// Inicialización de la aplicación
app.whenReady().then(async () => {
  console.log('🚀 Iniciando aplicación...');

  initDatabase();
  initExpressServer();
  await initBiometricBridge();
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

app.on('before-quit', () => {
  if (db) {
    db.close();
  }
  if (expressServer) {
    expressServer.close();
  }
});
