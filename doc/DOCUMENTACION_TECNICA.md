# Documentación Técnica - Integración ElectronJS + Edge-URU-UI

## 📋 Tabla de Contenidos

1. [Arquitectura General](#arquitectura-general)
2. [Estructura de Archivos](#estructura-de-archivos)
3. [Flujo de Inicialización](#flujo-de-inicialización)
4. [Sistemas de Módulos](#sistemas-de-módulos)
5. [API Disponible](#api-disponible)
6. [Cadena de Trabajo y Llamadas](#cadena-de-trabajo-y-llamadas)
7. [Solución de URLs](#solución-de-urls)
8. [Ejemplos de Uso](#ejemplos-de-uso)
9. [Troubleshooting](#troubleshooting)

---

## 🏗️ Arquitectura General

### Diagrama de Componentes

```
┌─────────────────────────────────────────────────────────────┐
│                     ElectronJS Application                   │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  Main Process (dist/main.js)                           │ │
│  │  - Gestión de ventanas                                 │ │
│  │  - Spawn del servidor biométrico                       │ │
│  │  - IPC Handlers                                        │ │
│  └──────────────────┬─────────────────────────────────────┘ │
│                     │ IPC Communication                      │
│  ┌──────────────────▼─────────────────────────────────────┐ │
│  │  Preload Script (dist/preload.js)                      │ │
│  │  - contextBridge API                                   │ │
│  │  - window.config                                       │ │
│  │  - window.biometricServer                              │ │
│  └──────────────────┬─────────────────────────────────────┘ │
│                     │ Context Bridge                         │
│  ┌──────────────────▼─────────────────────────────────────┐ │
│  │  Renderer Process (dist/renderer/index.html)           │ │
│  │  - UI Controls                                         │ │
│  │  - BiometricAdapter (patched)                          │ │
│  │  - ComponentFactory                                    │ │
│  └──────────────────┬─────────────────────────────────────┘ │
└────────────────────┼──────────────────────────────────────┘
                     │ HTTP/SSE
        ┌────────────▼────────────┐
        │  Biometric Server       │
        │  (Node.js - Port 8080)  │
        │  - SSE Events           │
        │  - REST API             │
        │  - Static Files         │
        └────────────┬────────────┘
                     │ Edge.js
        ┌────────────▼────────────┐
        │  C# Bridge              │
        │  (bridge-csharp.dll)    │
        │  - DP4500 SDK Wrapper   │
        └────────────┬────────────┘
                     │
        ┌────────────▼────────────┐
        │  DP4500 Reader          │
        │  (Hardware)             │
        └─────────────────────────┘
```

### Flujo de Datos

```
Usuario → Electron UI → BiometricAdapter (HTTP) → Server Node.js → C# Bridge → DP4500
                                                          ↓
                                                    SSE Events
                                                          ↓
                                           BiometricAdapter ← UI Updates
```

---

## 📁 Estructura de Archivos

```
ElectronJS - Autenticacion por huella dactilar/
├── electron/                          # Código fuente TypeScript
│   ├── main.ts                       # Proceso principal Electron
│   ├── preload.ts                    # Script de preload
│   └── renderer/
│       └── index.html                # UI del renderizador
│
├── dist/                             # Código compilado
│   ├── main.js                       # Main compilado (ES Modules)
│   ├── preload.js                    # Preload compilado (CommonJS)
│   └── renderer/
│       └── index.html                # Copia del HTML
│
├── biometric-engine/                 # Engine biométrico
│   ├── bridge-csharp/               # Bridge C# para DP4500
│   │   └── out/net472/
│   │       ├── bridge-csharp.dll
│   │       └── DPUruNet.dll
│   └── node/                        # Servidor Node.js
│       ├── dist/server.js
│       └── public/js/               # Scripts del cliente
│           ├── adapter/BiometricAdapter.js
│           ├── components/
│           │   ├── BaseComponent.js
│           │   └── ComponentFactory.js
│           └── controls/
│               ├── ReaderControl.js
│               ├── SimpleCaptureControl.js
│               ├── EnrollmentControl.js
│               ├── VerificationControl.js
│               ├── TemplateManagerControl.js
│               ├── LogDeviceControl.js
│               ├── TechDeviceControl.js
│               └── FingerManagementControl.js
│
├── package.json                      # Dependencias y scripts
├── tsconfig.json                     # Config TypeScript (Main)
└── tsconfig.preload.json            # Config TypeScript (Preload)
```

---

## 🚀 Flujo de Inicialización

### 1. Inicio de Aplicación (main.ts)

```typescript
app.whenReady() → initIpcHandlers() → createWindow() → startBiometricServer()
```

**Secuencia detallada:**

```typescript
// 1. Electron inicia
app.whenReady().then(async () => {

    // 2. Registrar handlers IPC
    initIpcHandlers(); // Registra config:get, biometric:start/stop/status

    // 3. Crear ventana
    createWindow(); // BrowserWindow con preload.js

    // 4. Iniciar servidor biométrico
    const result = await startBiometricServer();
    // - Verifica si ya está corriendo
    // - Verifica C# DLLs compiladas
    // - Spawn proceso Node.js
    // - Espera hasta que responda (max 15 segundos)
});
```

### 2. Carga de Renderer (index.html)

```html
<!-- Orden crítico de carga -->

<!-- 1. Configurar URL base ANTES de cargar scripts -->
<script>
    window.BIOMETRIC_SERVER_URL = 'http://localhost:8080';
</script>

<!-- 2. Cargar scripts del servidor biométrico -->
<script src="http://localhost:8080/js/adapter/BiometricAdapter.js"></script>
<script src="http://localhost:8080/js/components/BaseComponent.js"></script>
<script src="http://localhost:8080/js/components/ComponentFactory.js"></script>
<!-- ... todos los controles ... -->

<!-- 3. Parchear BiometricAdapter ANTES de auto-conectarse -->
<script>
document.addEventListener('DOMContentLoaded', () => {
    // Parchear todos los métodos de BiometricAdapter
    // para usar URLs absolutas
}, { once: true });
</script>

<!-- 4. Inicializar controles -->
<script>
document.addEventListener('DOMContentLoaded', async () => {
    // Obtener config
    const config = await window.config.get();

    // Verificar servidor
    const status = await window.biometricServer.status();

    // Inicializar controles biométricos
    if (status.isRunning) {
        initializeBiometricControls();
    }
});
</script>
```

---

## 🔧 Sistemas de Módulos

### Main Process (ES Modules)

**tsconfig.json:**
```json
{
  "compilerOptions": {
    "module": "NodeNext",        // ES Modules
    "target": "ES2022",
    "moduleResolution": "NodeNext"
  },
  "exclude": ["electron/preload.ts"]  // ¡Importante!
}
```

**Uso en main.ts:**
```typescript
import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { spawn } from 'node:child_process';
```

### Preload Script (CommonJS)

**tsconfig.preload.json:**
```json
{
  "compilerOptions": {
    "module": "CommonJS",        // CommonJS requerido por Electron
    "target": "ES2020",
    "moduleResolution": "Node"
  },
  "include": ["electron/preload.ts"]
}
```

**Uso en preload.ts:**
```typescript
const { contextBridge, ipcRenderer } = require('electron');
```

### Renderer (Browser JavaScript)

Scripts cargados desde `http://localhost:8080` - JavaScript estándar del navegador.

---

## 🔌 API Disponible

### A. API Expuesta por Preload

#### window.config

```javascript
// Obtener configuración del sistema y estado de seguridad
const config = await window.config.get();
console.log(config.biometricPort); // 8080
console.log(config.systemConfig.has_admin_pin); // "1" | "0"
console.log(config.systemConfig.kiosk_lock_enabled); // "1" | "0"
console.log(config.systemConfig.work_days); // "1,2,3,4,5"
console.log(config.systemConfig.auto_backups_dir); // Directorio seguro OS

// Acciones polimórficas seguras (Contrato Golden Master GM2):
// 1. Verificar PIN de Administrador
const pinCheck = await window.config.get({ __action: 'verify_admin_pin', pin: '1234' });

// 2. Bloquear sesión de Administrador
await window.config.get({ __action: 'lock_admin_session' });

// 3. Configurar o cambiar PIN de Administrador (hash SHA-256 + pepper)
await window.config.get({ __action: 'set_admin_pin', currentPin: '1234', newPin: '5678', kioskLock: '1' });

// 4. Eliminar PIN de Administrador
await window.config.get({ __action: 'set_admin_pin', currentPin: '1234', remove: '1' });

// 5. Exportar copia de seguridad SQLite (con diálogo nativo y checkpoint WAL)
const backupRes = await window.config.get({ __action: 'backup_database', __pin: '' });

// 6. Restaurar copia de seguridad SQLite (validación binaria SQLite format 3, integridad y respaldo preventivo)
const restoreRes = await window.config.get({ __action: 'restore_database', __pin: '' });
```

#### window.attendance (Marcaciones y Milisegundos)

```javascript
// Check-in con huella y marca exacta en milisegundos (HH:MM:SS.mmm)
const inResult = await window.attendance.checkIn(employeeId, true);

// Check-out con validación de cooldown y tiempo transcurrido en milisegundos
const outResult = await window.attendance.checkOut(employeeId);

// Ejecutar corte de inasistencias bajo demanda
const absentResult = await window.attendance.getAttendanceRecords({ action: 'mark_absentees' });

// Resetear base de datos (protegido con PIN de Administrador y respaldo preventivo)
const resetResult = await window.attendance.resetDatabase();
```

#### window.biometricServer

```javascript
// Iniciar servidor (normalmente ya inicia automáticamente)
const result = await window.biometricServer.start();
// { success: true/false, message: "..." }

// Detener servidor
const result = await window.biometricServer.stop();

// Verificar estado
const status = await window.biometricServer.status();
// { isRunning: true/false }
```

### B. BiometricAdapter (Objeto Global)

Accesible como `window.BiometricAdapter` después de cargar los scripts.

#### Conexión SSE

```javascript
// Conectar al servidor (auto-ejecuta al cargar)
await BiometricAdapter.connect();

// Estado de conexión
BiometricAdapter.isConnected; // true/false
BiometricAdapter.eventSource; // EventSource instance
```

#### Eventos

```javascript
// Escuchar eventos
BiometricAdapter.on('READER_READY', (data) => {
    console.log('Lector listo:', data);
});

BiometricAdapter.on('IMAGE_CAPTURED', (data) => {
    console.log('Imagen capturada:', data.imageBase64);
});

BiometricAdapter.on('ENROLLMENT_COMPLETED', (data) => {
    console.log('Enrolamiento completado:', data);
});

BiometricAdapter.on('VERIFICATION_SUCCESS', (data) => {
    console.log('Verificación exitosa:', data);
});
```

**Eventos disponibles:**
- `READER_READY` - Lector inicializado
- `READER_DISPOSED` - Lector apagado
- `CAPTURE_STARTED` - Captura iniciada
- `IMAGE_CAPTURED` - Imagen capturada
- `CAPTURE_COMPLETED` - Captura completada
- `ENROLLMENT_STARTED` - Enrolamiento iniciado
- `SAMPLE_COLLECTED` - Muestra recolectada
- `ENROLLMENT_COMPLETED` - Enrolamiento completado
- `VERIFICATION_SUCCESS` - Verificación exitosa
- `VERIFICATION_FAILED` - Verificación fallida

> **Catálogo completo y contrato** (envelope `evt/eventType/message/severity/origin/timestamp/data`,
> hook mono-suscriptor edge-js, suscripción SSE `GET /events`):
> **[CONTRATO-EVENTOS-MOTOR-BIOMETRICO.md](./CONTRATO-EVENTOS-MOTOR-BIOMETRICO.md)**.
- `IDENTIFICATION_MATCH` - Identificación exitosa

#### Métodos API

```javascript
// GET request
const result = await BiometricAdapter.apiGet('/api/store');
// { ok: true, data: { users: [...] } }

// POST request
const result = await BiometricAdapter.apiPost('/api/enroll', {
    userId: 'user123',
    samples: [...]
});

// DELETE request
const success = await BiometricAdapter.apiDelete('/api/user/123');

// POST con datos (usado internamente)
const result = await BiometricAdapter.apiCall('/api/init', {
    readerType: 'DP4500'
});
```

### C. ComponentFactory (Objeto Global)

```javascript
// Crear controles
const control = window.ComponentFactory.create(
    'controlType',  // Tipo de control
    'containerId',  // ID del contenedor
    options         // Opciones del control
);
```

**Tipos de controles disponibles:**

1. **readercontrol** - Control del lector
```javascript
const readerControl = ComponentFactory.create('readercontrol', 'reader-control', {});
// Botones: Initialize Reader, Dispose Reader
```

2. **simplecapture** - Captura simple
```javascript
const captureControl = ComponentFactory.create('simplecapture', 'capture-control', {});
// Botón: Capture Fingerprint
```

3. **enrollment** - Enrolamiento
```javascript
const enrollmentControl = ComponentFactory.create('enrollment', 'enrollment-control', {
    maxSamples: 4  // Número de muestras requeridas
});
// Botones: Start Enrollment (captura múltiples muestras)
```

4. **verification** - Verificación (1:1)
```javascript
const verificationControl = ComponentFactory.create('verification', 'verification-control', {});
// Ingresar userId, capturar huella, verificar
```

5. **templatemanager** - Gestión de plantillas
```javascript
const templateControl = ComponentFactory.create('templatemanager', 'template-control', {});
// Ver usuarios almacenados, eliminar plantillas
```

6. **logdevice** - Logs del dispositivo
```javascript
const logControl = ComponentFactory.create('logdevice', 'log-control', {});
// Muestra eventos en tiempo real
```

---

## 🔗 Cadena de Trabajo y Llamadas

### Escenario 1: Captura Simple de Huella

```
Usuario → Click "Capture Fingerprint"
    ↓
ReaderControl.captureFingerprint()
    ↓
BiometricAdapter.apiCall('/api/capture')  [Patched con URL absoluta]
    ↓
HTTP POST http://localhost:8080/api/capture
    ↓
Server Node.js → C# Bridge → DP4500
    ↓
SSE Event: CAPTURE_STARTED
    ↓
BiometricAdapter.on('CAPTURE_STARTED') → UI: "Coloque su dedo"
    ↓
[Usuario coloca dedo]
    ↓
SSE Event: IMAGE_CAPTURED (con imageBase64)
    ↓
BiometricAdapter.on('IMAGE_CAPTURED') → UI: Mostrar imagen
    ↓
SSE Event: CAPTURE_COMPLETED
    ↓
BiometricAdapter.on('CAPTURE_COMPLETED') → UI: "Captura completada"
```

### Escenario 2: Enrolamiento (4 muestras)

```
Usuario → Ingresa userId "carlos123" → Click "Start Enrollment"
    ↓
EnrollmentControl.startEnrollment()
    ↓
BiometricAdapter.apiCall('/api/enroll/start', { userId: 'carlos123', maxSamples: 4 })
    ↓
HTTP POST http://localhost:8080/api/enroll/start
    ↓
SSE Event: ENROLLMENT_STARTED
    ↓
[Loop 4 veces:]
    SSE Event: CAPTURE_STARTED → "Coloque dedo (muestra 1/4)"
    SSE Event: SAMPLE_COLLECTED
    → Muestra 1/4 recolectada
    [Repetir para muestras 2, 3, 4]
    ↓
SSE Event: ENROLLMENT_COMPLETED
    ↓
BiometricAdapter.on('ENROLLMENT_COMPLETED', (data) => {
    // data.userId = 'carlos123'
    // data.template = base64_encoded_template
})
    ↓
UI: "Usuario carlos123 enrolado exitosamente"
```

### Escenario 3: Verificación (1:1)

```
Usuario → Ingresa userId "carlos123" → Click "Verify"
    ↓
VerificationControl.verify()
    ↓
BiometricAdapter.apiCall('/api/verify', { userId: 'carlos123' })
    ↓
HTTP POST http://localhost:8080/api/verify
    ↓
SSE Event: CAPTURE_STARTED
    ↓
[Usuario coloca dedo]
    ↓
SSE Event: IMAGE_CAPTURED
    ↓
Server compara con plantilla almacenada
    ↓
Si coincide:
    SSE Event: VERIFICATION_SUCCESS
    BiometricAdapter.on('VERIFICATION_SUCCESS', (data) => {
        // data.user.tag = 'carlos123'
        // data.score = 98
    })
    UI: "✓ Verificación exitosa (98% match)"

Si no coincide:
    SSE Event: VERIFICATION_FAILED
    UI: "✗ Verificación fallida"
```

---

## 🔧 Solución de URLs

### Problema Original

Los scripts de BiometricAdapter usan URLs relativas:

```javascript
// BiometricAdapter.js (ORIGINAL)
async connect() {
    this.eventSource = new EventSource('/events');  // ❌ Resuelve a file:///C:/events
}

async apiCall(endpoint, data) {
    const response = await fetch(endpoint);  // ❌ Resuelve a file:///C:/api/...
}
```

**Causa:** El HTML se carga desde `file://` protocol, por lo que URLs relativas se resuelven como `file:///`.

### Solución Implementada

**Paso 1:** Configurar URL base global

```html
<!-- index.html - ANTES de cargar scripts -->
<script>
    window.BIOMETRIC_SERVER_URL = 'http://localhost:8080';
</script>
```

**Paso 2:** Helper para URLs absolutas

```javascript
const makeAbsoluteUrl = (endpoint) => {
    if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
        return endpoint;  // Ya es absoluta
    }
    const serverUrl = window.BIOMETRIC_SERVER_URL || 'http://localhost:8080';
    return `${serverUrl}${endpoint.startsWith('/') ? endpoint : '/' + endpoint}`;
};
```

**Paso 3:** Parchear métodos de BiometricAdapter

```javascript
document.addEventListener('DOMContentLoaded', () => {
    if (window.BiometricAdapter) {
        const serverUrl = window.BIOMETRIC_SERVER_URL || 'http://localhost:8080';

        // Parchear connect() - SSE
        window.BiometricAdapter.connect = async function() {
            this.eventSource = new EventSource(`${serverUrl}/events`);  // ✓ Absoluta
            // ... resto del código
        };

        // Parchear apiGet()
        window.BiometricAdapter.apiGet = async function(endpoint) {
            const url = makeAbsoluteUrl(endpoint);  // ✓ Convierte a absoluta
            const response = await fetch(url);
            // ... resto del código
        };

        // Parchear apiPost()
        window.BiometricAdapter.apiPost = async function(endpoint, body = {}) {
            const url = makeAbsoluteUrl(endpoint);  // ✓ Convierte a absoluta
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            // ... resto del código
        };

        // Parchear apiDelete()
        window.BiometricAdapter.apiDelete = async function(endpoint) {
            const url = makeAbsoluteUrl(endpoint);  // ✓ Convierte a absoluta
            const response = await fetch(url, { method: 'DELETE' });
            // ... resto del código
        };

        // Parchear apiCall()
        window.BiometricAdapter.apiCall = async function(endpoint, data = null) {
            const url = makeAbsoluteUrl(endpoint);  // ✓ Convierte a absoluta
            const options = {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            };
            if (data) {
                options.body = JSON.stringify(data);
            }
            const response = await fetch(url, options);
            // ... resto del código
        };

        // Auto-conectar con URL correcta
        window.BiometricAdapter.connect().catch(console.error);
    }
}, { once: true });
```

**Resultado:**
```
ANTES:  file:///C:/events              ❌
DESPUÉS: http://localhost:8080/events  ✓

ANTES:  file:///C:/api/init            ❌
DESPUÉS: http://localhost:8080/api/init ✓
```

---

## 💡 Ejemplos de Uso

### Ejemplo 1: Escuchar Todos los Eventos

```javascript
// En index.html o archivo personalizado
const adapter = window.BiometricAdapter;

// Configurar listeners
adapter.on('READER_READY', (data) => {
    console.log('✓ Lector listo:', data.model);
    updateStatus('connected', '✓ Lector DP4500 listo');
});

adapter.on('READER_DISPOSED', () => {
    console.log('⚠ Lector apagado');
    updateStatus('disconnected', '⚠ Lector DP4500 apagado');
});

adapter.on('CAPTURE_STARTED', () => {
    console.log('📸 Captura iniciada');
    updateStatus('working', '📸 Coloque su dedo en el lector...');
});

adapter.on('IMAGE_CAPTURED', (data) => {
    console.log('✓ Imagen capturada');
    // Mostrar imagen si quieres
    const img = document.getElementById('fingerprint-image');
    img.src = `data:image/png;base64,${data.imageBase64}`;
});

adapter.on('SAMPLE_COLLECTED', (data) => {
    console.log(`✓ Muestra ${data.current}/${data.total} recolectada`);
    updateStatus('working', `📸 Muestra ${data.current}/${data.total} capturada`);
});

adapter.on('ENROLLMENT_COMPLETED', (data) => {
    console.log('✓ Enrolamiento completado:', data.userId);
    alert(`Usuario ${data.userId} enrolado exitosamente`);
});

adapter.on('VERIFICATION_SUCCESS', (data) => {
    console.log('✓ Verificación exitosa:', data.user.tag, `Score: ${data.score}`);
    alert(`Verificación exitosa: ${data.user.tag} (${data.score}% match)`);
});

adapter.on('VERIFICATION_FAILED', (data) => {
    console.log('✗ Verificación fallida');
    alert('Verificación fallida - Huella no coincide');
});

function updateStatus(status, message) {
    const statusBar = document.getElementById('status-bar');
    statusBar.className = `status-${status}`;
    statusBar.textContent = message;
}
```

### Ejemplo 2: Enrolamiento Programático

```javascript
async function enrollUser(userId, numSamples = 4) {
    const adapter = window.BiometricAdapter;

    // Listener para muestras
    let samplesCollected = 0;
    adapter.on('SAMPLE_COLLECTED', (data) => {
        samplesCollected = data.current;
        console.log(`Muestra ${data.current}/${data.total} recolectada`);
        updateProgress(data.current, data.total);
    });

    // Listener para completado
    adapter.on('ENROLLMENT_COMPLETED', (data) => {
        console.log('Enrolamiento completado:', data);
        showSuccess(`Usuario ${userId} enrolado`);
    });

    try {
        // Iniciar enrolamiento
        const result = await adapter.apiCall('/api/enroll/start', {
            userId: userId,
            maxSamples: numSamples
        });

        if (result.ok) {
            console.log('Enrolamiento iniciado, esperando muestras...');
        }
    } catch (error) {
        console.error('Error en enrolamiento:', error);
        showError('Error al iniciar enrolamiento');
    }
}

// Uso
enrollUser('carlos123', 4);
```

### Ejemplo 3: Verificación Programática

```javascript
async function verifyUser(userId) {
    const adapter = window.BiometricAdapter;

    return new Promise((resolve, reject) => {
        // Setup listeners
        const onSuccess = (data) => {
            cleanup();
            resolve({
                verified: true,
                user: data.user.tag,
                score: data.score
            });
        };

        const onFailed = () => {
            cleanup();
            resolve({ verified: false });
        };

        const cleanup = () => {
            adapter.off('VERIFICATION_SUCCESS', onSuccess);
            adapter.off('VERIFICATION_FAILED', onFailed);
        };

        adapter.on('VERIFICATION_SUCCESS', onSuccess);
        adapter.on('VERIFICATION_FAILED', onFailed);

        // Iniciar verificación
        adapter.apiCall('/api/verify', { userId: userId })
            .catch(error => {
                cleanup();
                reject(error);
            });
    });
}

// Uso
async function checkFingerprint() {
    try {
        const result = await verifyUser('carlos123');

        if (result.verified) {
            console.log(`✓ Usuario verificado: ${result.user} (${result.score}%)`);
            grantAccess();
        } else {
            console.log('✗ Verificación fallida');
            denyAccess();
        }
    } catch (error) {
        console.error('Error en verificación:', error);
    }
}
```

### Ejemplo 4: Listar Usuarios Almacenados

```javascript
async function listStoredUsers() {
    const adapter = window.BiometricAdapter;

    try {
        const result = await adapter.apiGet('/api/store');

        if (result.ok) {
            const users = result.data.users || [];
            console.log('Usuarios almacenados:', users);

            users.forEach(user => {
                console.log(`- ${user.tag} (${user.samples} muestras)`);
            });

            return users;
        }
    } catch (error) {
        console.error('Error obteniendo usuarios:', error);
    }
}

// Uso
const users = await listStoredUsers();
```

### Ejemplo 5: Eliminar Usuario

```javascript
async function deleteUser(userId) {
    const adapter = window.BiometricAdapter;

    try {
        const success = await adapter.apiDelete(`/api/user/${userId}`);

        if (success) {
            console.log(`Usuario ${userId} eliminado`);
            return true;
        } else {
            console.log('Error al eliminar usuario');
            return false;
        }
    } catch (error) {
        console.error('Error eliminando usuario:', error);
        return false;
    }
}

// Uso
await deleteUser('carlos123');
```

---

## 🐛 Troubleshooting

### Problema: "Unexpected token 'export'" en preload.js

**Causa:** Preload script compilado con ES Modules en lugar de CommonJS.

**Solución:**
```bash
# Verificar tsconfig.preload.json tiene module: "CommonJS"
npm run build
```

### Problema: "GET file:///C:/events net::ERR_FILE_NOT_FOUND"

**Causa:** BiometricAdapter usando URLs relativas que se resuelven como `file://`.

**Solución:** Ya implementada - Parcheo de BiometricAdapter en index.html.

### Problema: "ComponentFactory is not defined"

**Causa:** Scripts cargándose en orden incorrecto.

**Solución:** Verificar orden de carga en index.html:
```html
<!-- 1. BaseComponent.js primero -->
<script src="http://localhost:8080/js/components/BaseComponent.js"></script>
<!-- 2. ComponentFactory.js segundo -->
<script src="http://localhost:8080/js/components/ComponentFactory.js"></script>
<!-- 3. Controles después -->
<script src="http://localhost:8080/js/controls/ReaderControl.js"></script>
```

### Problema: "Servidor biométrico no responde"

**Diagnóstico:**
```bash
# Verificar que el servidor está corriendo
curl http://localhost:8080/api/store-stats

# Ver logs del proceso
npm run dev
```

**Solución:**
1. Verificar que C# Bridge está compilado (`bridge-csharp.dll`)
2. Verificar puerto 8080 no está en uso
3. Revisar logs del servidor en consola

### Problema: better-sqlite3 error

**Causa:** Dependencia antigua aún en node_modules.

**Solución:**
```bash
# Limpiar completamente
rm -rf node_modules package-lock.json dist
npm install
npm run build
```

### Problema: Lector DP4500 no detectado

**Causa:** Hardware no conectado o drivers faltantes.

**Solución:**
1. Conectar lector DP4500 por USB
2. Instalar drivers DigitalPersona
3. Verificar en Device Manager (Windows)
4. Reiniciar aplicación

---

## 📊 Endpoints API del Servidor

### GET /api/store-stats
Obtener estadísticas del almacenamiento.

**Response:**
```json
{
  "ok": true,
  "data": {
    "totalUsers": 5,
    "totalSamples": 20
  }
}
```

### GET /api/store
Obtener todos los usuarios almacenados.

**Response:**
```json
{
  "ok": true,
  "data": {
    "users": [
      { "tag": "carlos123", "samples": 4 },
      { "tag": "maria456", "samples": 4 }
    ]
  }
}
```

### POST /api/init
Inicializar el lector.

**Request:** (vacío o con opciones)
```json
{
  "readerType": "DP4500"
}
```

**Response:**
```json
{
  "ok": true,
  "message": "Lector inicializado"
}
```

### POST /api/dispose
Apagar el lector.

**Response:**
```json
{
  "ok": true,
  "message": "Lector apagado"
}
```

### POST /api/capture
Capturar huella (sin almacenar).

**Response:**
```json
{
  "ok": true,
  "data": {
    "imageBase64": "iVBORw0KGgoAAAANS...",
    "template": "base64_template"
  }
}
```

### POST /api/enroll/start
Iniciar proceso de enrolamiento.

**Request:**
```json
{
  "userId": "carlos123",
  "maxSamples": 4
}
```

**Response:**
```json
{
  "ok": true,
  "message": "Enrolamiento iniciado"
}
```

### POST /api/verify
Verificar huella contra usuario específico (1:1).

**Request:**
```json
{
  "userId": "carlos123"
}
```

**Response (vía SSE):**
```json
{
  "evt": "VERIFICATION_SUCCESS",
  "data": {
    "user": { "tag": "carlos123" },
    "score": 98
  }
}
```

### POST /api/identify
Identificar huella contra todos los usuarios (1:N).

**Response (vía SSE):**
```json
{
  "evt": "IDENTIFICATION_MATCH",
  "data": {
    "user": { "tag": "carlos123" },
    "score": 95
  }
}
```

### DELETE /api/user/:userId
Eliminar usuario del almacenamiento.

**Response:**
```json
{
  "ok": true,
  "message": "Usuario eliminado"
}
```

---

## 🎯 Resumen de Decisiones Técnicas

1. **Separación de módulos:** Main (ES) vs Preload (CommonJS)
   - Razón: Electron requiere CommonJS en preload

2. **Servidor biométrico externo:** Node.js independiente
   - Razón: Mejor aislamiento, reinicio sin afectar UI

3. **Parcheo de BiometricAdapter:** En lugar de modificar archivos originales
   - Razón: Mantener engine biométrico intacto, fácil actualización

4. **URLs absolutas:** http://localhost:8080 en lugar de relativas
   - Razón: Electron carga HTML desde file://, requiere URLs absolutas

5. **SSE para eventos:** En lugar de polling
   - Razón: Eventos en tiempo real, eficiente

6. **ComponentFactory global:** Instancia singleton
   - Razón: Todos los controles comparten mismo adaptador

---

## 📝 Notas Finales
 
 - **Puerto fijo:** Sistema usa puerto 8080 (configurable en main.ts)
 - **Almacenamiento Híbrido:** Persistencia transaccional en **SQLite** (`attendance.db`) con cifrado/protección en reposo y carga a memoria RAM en arranque para comparación 1:N de alta velocidad.
 - **Precisión Temporal:** Registros de asistencia con marcas de tiempo en formato `HH:MM:SS.mmm` (milisegundos) para exactitud forense y auditoría.
 - **Hardware requerido:** Lector DP4500 DigitalPersona
 - **Plataforma:** Windows (por C# Bridge .NET Framework 4.7.2)
 - **Seguridad y Resguardo:** Backups automáticos rotativos, protección mediante PIN SHA-256 y modo kiosco desatendido.
 
 ---
 
 **Documentación generada:** 2025-11-08  
 **Última actualización:** 2026-10-11  
 **Versión:** 1.0.0 (MVP Producción)  
 **Estado:** Producción Validado ✅

