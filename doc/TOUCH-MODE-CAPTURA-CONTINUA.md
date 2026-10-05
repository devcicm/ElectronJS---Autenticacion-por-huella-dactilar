# Sistema de Captura Continua (Touch Mode) - Documentación Técnica

## Índice
1. [Introducción](#introducción)
2. [Arquitectura General](#arquitectura-general)
3. [Componentes Backend](#componentes-backend)
4. [Componentes Frontend](#componentes-frontend)
5. [Flujo de Datos](#flujo-de-datos)
6. [Implementación Detallada](#implementación-detallada)
7. [Eventos y Comunicación](#eventos-y-comunicación)
8. [Manejo de Errores](#manejo-de-errores)

---

## Introducción

El **Sistema de Captura Continua** (Touch Mode) es una funcionalidad que permite el registro automático de asistencia mediante la identificación biométrica en tiempo real. El sistema detecta cuando un empleado coloca su dedo en el lector y automáticamente:

1. Captura la huella dactilar
2. Identifica al empleado (1:N matching)
3. Determina si es entrada o salida
4. Registra la asistencia en la base de datos
5. Notifica al usuario en tiempo real

### Características Principales

- ✅ **Captura automática**: No requiere interacción manual
- ✅ **Identificación 1:N**: Compara contra todas las huellas registradas
- ✅ **Comunicación en tiempo real**: Usa Server-Sent Events (SSE)
- ✅ **Multi-hilo**: Backend con hilos independientes para cada funcionalidad
- ✅ **Auto-recuperación**: Manejo robusto de errores con desactivación automática
- ✅ **Validaciones inteligentes**: Previene registros duplicados y tiempo mínimo entre entrada/salida

---

## Arquitectura General

```
┌─────────────────────────────────────────────────────────────────┐
│                        FRONTEND (Electron)                       │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  app.js - Interfaz Usuario                               │  │
│  │  - Inicialización automática                             │  │
│  │  - Event Listeners (SSE + IPC)                          │  │
│  │  - UI Updates en tiempo real                            │  │
│  └──────────────────────────────────────────────────────────┘  │
│                              ↕ IPC                              │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  TouchModeService.ts - Servicio Principal               │  │
│  │  - Coordinador de eventos                               │  │
│  │  - Lógica de negocio (entrada/salida)                   │  │
│  │  - Manejo de errores                                    │  │
│  └──────────────────────────────────────────────────────────┘  │
│                        ↕ HTTP/SSE                               │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                    BACKEND (Node.js + C#)                        │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  server.js (Node.js)                                     │  │
│  │  - API REST endpoints                                    │  │
│  │  - SSE Event Streaming                                   │  │
│  │  - Bridge Edge.js ↔ C#                                   │  │
│  └──────────────────────────────────────────────────────────┘  │
│                        ↕ Edge.js                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  BiometricCore.cs (C# .NET)                             │  │
│  │  - Modo Touch Continuo                                   │  │
│  │  - Manejo de hilos                                       │  │
│  │  - Interacción con SDK DigitalPersona                    │  │
│  └──────────────────────────────────────────────────────────┘  │
│                     ↕ DPUruNet.dll                              │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Hardware - Lector DigitalPersona U.are.U 4500          │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Componentes Backend

### 1. BiometricCore.cs - Motor Principal (C#)

**Ubicación**: `biometric-engine/bridge-csharp/src/Core/BiometricCore.cs`

#### Arquitectura de Hilos

El backend utiliza **múltiples hilos independientes** para manejar diferentes responsabilidades:

```csharp
// Hilo principal del lector
private Thread _readerThread;

// Hilo para modo touch continuo
private Thread _touchModeThread;

// Eventos de sincronización
private AutoResetEvent _touchEvent = new AutoResetEvent(false);
```

#### Modo Touch Continuo

El modo touch se activa mediante el método `StartTouchMode()`:

```csharp
public dynamic StartTouchMode()
{
    if (_touchModeActive)
        return new { ok = true, message = "Touch mode ya activo" };

    _touchModeActive = true;
    _touchModeThread = new Thread(TouchModeWorker);
    _touchModeThread.IsBackground = true;
    _touchModeThread.Start();

    EmitEvent("TOUCH_MODE_STARTED", "Modo de eventos touch ACTIVADO", ...);
    return new { ok = true, mode = "Continuous" };
}
```

#### Worker del Modo Touch

El `TouchModeWorker` es el hilo que escucha continuamente el lector:

```csharp
private void TouchModeWorker()
{
    while (_touchModeActive && _readerSelected != null)
    {
        try
        {
            // Espera a que se coloque un dedo
            _readerSelected.On += OnFingerTouch;

            // Thread permanece vivo esperando eventos
            Thread.Sleep(100);
        }
        catch (Exception ex)
        {
            EmitEvent("TOUCH_MODE_ERROR", ex.Message, "ERROR");
        }
    }
}
```

#### Eventos del SDK

Cuando se detecta un dedo, el SDK dispara eventos:

```csharp
private void OnFingerTouch(object sender, DataEventArgs<CaptureResult> e)
{
    if (!_touchModeActive) return;

    var captureResult = e.Data;

    // Emitir evento de dedo detectado
    EmitEvent("FINGER_TOUCHED", "Dedo detectado en el lector", "INFO");

    // Capturar imagen
    var imageData = ProcessFingerImage(captureResult);
    EmitEvent("IMAGE_CAPTURED", "Imagen capturada", "SUCCESS");

    // Crear FMD (Feature Minutiae Data)
    Fmd fmd = CreateFmd(captureResult.Data);
    _lastCapturedFmd = fmd;

    EmitEvent("FINGERPRINT_READY", "Huella lista para comparación", "SUCCESS");
}
```

#### Sistema de Eventos

El backend emite eventos que son escuchados por el frontend vía SSE:

```csharp
private void EmitEvent(string eventType, string message, string severity, object data = null)
{
    var evt = new
    {
        evt = eventType,
        eventType = eventType,
        message = message,
        severity = severity,
        timestamp = DateTime.UtcNow.ToString("o"),
        origin = "dp4500",
        data = data
    };

    _eventQueue.Enqueue(evt);
    OnEventEmitted?.Invoke(evt);
}
```

### 2. server.js - Servidor Node.js

**Ubicación**: `biometric-engine/node/server.js`

#### Endpoint de Identificación Touch

```javascript
app.post('/api/touch/identify-last', async (req, res) => {
  try {
    const targetFarn = req.body?.targetFarn ?? 21474;
    const result = await call({ op: 'identifyLastCapture', targetFarn });
    res.json(result);
  } catch (e) {
    respondInternal(res, e);
  }
});
```

> Los eventos `TOUCH_IDENTIFICATION_MATCH` / `TOUCH_IDENTIFICATION_NO_MATCH` **no** los emite este
> handler HTTP: los genera el bridge C# con `SendEvent(...)` dentro de `identifyLastCapture`
> (`EdgeUruBridge.cs:593-637`) y llegan por SSE (ver abajo).

#### Server-Sent Events (SSE)

El backend mantiene conexiones SSE abiertas para enviar eventos en tiempo real:

```javascript
// Un único endpoint SSE. El fan-out lo realiza la clase SseBridge (Map de clientes + flush).
app.get('/events', (req, res) => {
  const detach = sseBridge.attachClient(res);
  req.on('close', detach);
  req.on('error', detach);
});

// El bridge C# empuja cada evento por el callback registrado una sola vez:
await call({
  op: 'registerCallback',
  callback: async (eventData) => { sseBridge.emit(eventData); return null; }
});
```

> **Contrato completo**: catálogo de eventos, envelope (`evt/eventType/message/severity/origin/timestamp/data`)
> y hook edge-js (mono-suscriptor) en
> **[CONTRATO-EVENTOS-MOTOR-BIOMETRICO.md](./CONTRATO-EVENTOS-MOTOR-BIOMETRICO.md)**.
> Formato de wire: `data: <json>\n\n` (sin `event:`), endpoint **`GET /events`** (no `/api/events`).

---

## Componentes Frontend

### 1. TouchModeService.ts - Servicio Principal

**Ubicación**: `sistema-asistencia/services/TouchModeService.ts`

Este servicio coordina toda la lógica del modo de captura continua.

#### Inicialización

```typescript
async start(): Promise<TouchModeResult> {
    if (this.isActive) {
        return { success: false, message: 'Touch mode ya está activo' };
    }

    // 1. Verificar servidor
    const isAvailable = await this.checkServerAvailability();
    if (!isAvailable) {
        return { success: false, message: 'Servidor biométrico no disponible' };
    }

    // 2. Inicializar lector
    await this.initializeReader();

    // 3. Activar modo continuo
    await this.activateTouchMode();

    // 4. Cargar huellas de BD
    await this.loadFingerprintsFromDatabase();

    // 5. Conectar a eventos SSE
    this.connectToSSE();

    this.isActive = true;
    return { success: true, message: 'Touch mode activado' };
}
```

#### Manejo de Eventos SSE

```typescript
private connectToSSE(): void {
    this.eventSource = new EventSource(`${BIOMETRIC_SERVER}/events`);

    // Evento: Dedo detectado
    this.eventSource.addEventListener('FINGER_TOUCHED', (e) => {
        const data = JSON.parse(e.data);
        this.state.totalTouches++;
        console.log(`👆 Dedo detectado (total: ${this.state.totalTouches})`);
    });

    // Evento: Huella lista
    this.eventSource.addEventListener('FINGERPRINT_READY', (e) => {
        this.state.totalFingerprints++;
        console.log(`✅ Huella capturada (total: ${this.state.totalFingerprints})`);

        // Iniciar identificación automáticamente
        this.identifyAndRegister();
    });

    // Evento: Errores
    this.eventSource.onerror = (error) => {
        this.handleSSEError(error);
    };
}
```

#### Lógica de Identificación y Registro

```typescript
private async identifyAndRegister(): Promise<void> {
    try {
        // 1. Identificar huella
        const identifyResult = await this.identifyLastCaptured();

        if (!identifyResult.matched) {
            console.log('❌ No se pudo identificar al empleado');
            return;
        }

        const { employeeId, score } = identifyResult;

        // Validar score estricto
        if (score !== 0) {
            console.log(`⚠️ Score no perfecto: ${score}`);
            return;
        }

        // 2. Obtener registro del día
        const today = new Date().toISOString().split('T')[0];
        const todayRecord = this.attendanceModel.getByEmployeeAndDate(employeeId, today);

        const hasCheckedIn = todayRecord && todayRecord.check_in_time !== null;
        const hasCheckedOut = todayRecord && todayRecord.check_out_time !== null;

        // 3. Determinar acción (entrada o salida)
        if (!hasCheckedIn) {
            // Registrar ENTRADA
            const record = this.attendanceModel.checkIn(employeeId, true);

            this.emitEvent('CHECK_IN_REGISTERED', {
                employeeId,
                timestamp: new Date(),
                record,
                score
            });

        } else if (!hasCheckedOut) {
            // Validar tiempo mínimo (1 minuto)
            const now = new Date();
            const checkInDateTime = new Date(`${today} ${todayRecord.check_in_time}`);
            const diffMinutes = (now.getTime() - checkInDateTime.getTime()) / (1000 * 60);

            if (diffMinutes < 1) {
                console.log('⏱️ Debe esperar al menos 1 minuto entre entrada y salida');
                return;
            }

            // Registrar SALIDA
            const record = this.attendanceModel.checkOut(employeeId);

            this.emitEvent('CHECK_OUT_REGISTERED', {
                employeeId,
                timestamp: new Date(),
                record,
                score
            });
        }

    } catch (error) {
        this.handleError(error);
    }
}
```

#### Manejo de Errores con Auto-Desactivación

```typescript
private consecutiveErrors: number = 0;
private readonly MAX_CONSECUTIVE_ERRORS = 5;

private async handleError(error: any): Promise<void> {
    this.consecutiveErrors++;
    console.error(`❌ Error #${this.consecutiveErrors}:`, error);

    if (this.consecutiveErrors >= this.MAX_CONSECUTIVE_ERRORS) {
        await this.handleCriticalError('Demasiados errores consecutivos');
    }
}

private async handleCriticalError(message: string): Promise<void> {
    console.error('❌❌❌ ERROR CRÍTICO DETECTADO ❌❌❌');

    // Emitir evento crítico
    this.emitEvent('CRITICAL_ERROR', {
        message,
        timestamp: new Date()
    });

    // Detener servicio automáticamente
    await this.stop();
}
```

### 2. main.ts - Proceso Principal Electron

**Ubicación**: `electron/main.ts`

#### Singleton del TouchModeService

```typescript
let touchModeServiceInstance: any = null;

const getTouchModeService = async () => {
    if (!touchModeServiceInstance) {
        const { TouchModeService } = await import('../sistema-asistencia/services/TouchModeService.js');
        touchModeServiceInstance = new TouchModeService();

        // Configurar forwarding de eventos
        touchModeServiceInstance.onEvent((eventType: string, data: any) => {
            if (eventType === 'CRITICAL_ERROR') {
                mainWindow?.webContents.send('touchMode:criticalError', {
                    message: data.message,
                    timestamp: data.timestamp
                });
            }

            if (eventType === 'CHECK_IN_REGISTERED' || eventType === 'CHECK_OUT_REGISTERED') {
                mainWindow?.webContents.send('touchMode:attendanceRegistered', {
                    type: eventType,
                    data: data
                });
            }
        });
    }
    return touchModeServiceInstance;
};
```

#### IPC Handlers

```typescript
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
    return service.getStatus();
});
```

### 3. app.js - Interfaz de Usuario

**Ubicación**: `sistema-asistencia/renderer/app.js`

#### Auto-Inicialización

```javascript
async function initializeTouchMode() {
    console.log('🚀 Inicializando Touch Mode...');

    // 1. Configurar listener de errores críticos
    if (window.touchMode.onCriticalError) {
        window.touchMode.onCriticalError((data) => {
            console.error('❌ ERROR CRÍTICO:', data.message);
            showNotification(`🔴 Error Crítico: ${data.message}`, 'error');

            // Actualizar UI
            touchModeState.isActive = false;
            updateTouchModeUI();
            stopTouchModePolling();
        });
    }

    // 2. Configurar listener de asistencias registradas
    if (window.touchMode.onAttendanceRegistered) {
        window.touchMode.onAttendanceRegistered((eventData) => {
            const { type, data } = eventData;

            // Mostrar notificación SOLO si score = 0
            if (data.score === 0) {
                if (type === 'CHECK_IN_REGISTERED') {
                    showNotification(
                        `✅ Huella capturada e identificada - Entrada registrada a las ${data.record.check_in_time}`,
                        data.record.status === 'late' ? 'warning' : 'success'
                    );
                } else if (type === 'CHECK_OUT_REGISTERED') {
                    showNotification(
                        `✅ Huella capturada e identificada - Salida registrada a las ${data.record.check_out_time}`,
                        'success'
                    );
                }
            }

            // Recargar vista
            setTimeout(async () => {
                await loadInitialData();
                if (currentSection === 'dashboard') {
                    loadDashboard();
                } else if (currentSection === 'records') {
                    loadRecordsSection();
                }
            }, 500);
        });
    }

    // 3. Auto-iniciar el modo automático
    const result = await window.touchMode.start();
    if (result.success) {
        showNotification('Modo Automático de Asistencia activado', 'success');
        startTouchModePolling();
    }
}

// Inicializar al cargar la aplicación
document.addEventListener('DOMContentLoaded', async () => {
    await loadInitialData();
    await initializeTouchMode();  // ← Auto-inicio
    loadDashboard();
});
```

---

## Flujo de Datos Completo

### Flujo de Captura y Registro

```
1. USUARIO COLOCA EL DEDO
   │
   ↓
2. SDK DIGITALP ERSONA (Hardware)
   - Captura imagen
   - Genera señal eléctrica
   │
   ↓
3. BIOMETRICCORE.CS (C# - Hilo Touch)
   - OnFingerTouch() detecta evento
   - Procesa imagen
   - Crea FMD (Feature Minutiae Data)
   - Emite evento "FINGER_TOUCHED"
   - Emite evento "FINGERPRINT_READY"
   │
   ↓
4. SERVER.JS (Node.js)
   - Recibe eventos de C# vía Edge.js
   - Transmite vía SSE a todos los clientes conectados
   │
   ↓
5. TOUCHMODESERVICE.TS (Frontend - Main Process)
   - EventSource recibe evento SSE
   - Listener "FINGERPRINT_READY" detecta huella capturada
   - Llama automáticamente a identifyAndRegister()
   │
   ↓
6. IDENTIFICACIÓN 1:N (Backend)
   - POST /api/touch/identify-last
   - Compara FMD contra todas las huellas en RAM
   - targetFarn = 5000 (matching estricto)
   - Retorna: { matched: true, userId, score: 0 }
   │
   ↓
7. LÓGICA DE NEGOCIO (TouchModeService)
   - Valida score === 0
   - Consulta registro del día en BD
   - Determina: ¿Es entrada o salida?
   - Valida tiempo mínimo (1 min entre entrada/salida)
   │
   ↓
8. REGISTRO EN BASE DE DATOS (AttendanceModel)
   - checkIn() o checkOut()
   - Valida turno del empleado
   - Calcula minutos de retraso
   - Inserta/actualiza registro
   │
   ↓
9. EMISIÓN DE EVENTOS (TouchModeService)
   - emitEvent('CHECK_IN_REGISTERED' o 'CHECK_OUT_REGISTERED')
   - Incluye: employeeId, timestamp, record, score
   │
   ↓
10. MAIN.TS (IPC Forwarding)
    - Escucha eventos del servicio
    - Forward vía IPC: mainWindow.webContents.send()
    │
    ↓
11. APP.JS (Renderer Process)
    - onAttendanceRegistered() recibe evento
    - Valida score === 0
    - Muestra notificación al usuario
    - Recarga dashboard/registros
    │
    ↓
12. ACTUALIZACIÓN UI
    - Dashboard muestra nuevo registro
    - "Registros de Hoy" actualizado
    - Contador de asistencias actualizado
```

---

## Eventos y Comunicación

### Eventos del Backend (C# → Node.js)

| Evento | Descripción | Datos |
|--------|-------------|-------|
| `FINGER_TOUCHED` | Dedo detectado en el lector | `{ width, height, timestamp }` |
| `IMAGE_CAPTURED` | Imagen de huella capturada | `{ imageBase64, imageSize }` |
| `FINGERPRINT_READY` | FMD creado y listo | `{ fmdSize, format, timestamp }` |
| `TOUCH_IDENTIFICATION_STARTED` | Inicio de identificación 1:N | `{ gallerySize }` |
| `TOUCH_IDENTIFICATION_MATCH` | Empleado identificado | `{ userId, score, gallerySize }` |
| `TOUCH_IDENTIFICATION_NO_MATCH` | No se encontró coincidencia | `{ score, gallerySize }` |
| `TOUCH_MODE_ERROR` | Error en modo touch | `{ message, error }` |

### Eventos del Frontend (IPC Electron)

| Canal IPC | Dirección | Propósito |
|-----------|-----------|-----------|
| `touchMode:start` | Renderer → Main | Iniciar modo touch |
| `touchMode:stop` | Renderer → Main | Detener modo touch |
| `touchMode:getStatus` | Renderer → Main | Obtener estado |
| `touchMode:criticalError` | Main → Renderer | Notificar error crítico |
| `touchMode:attendanceRegistered` | Main → Renderer | Notificar registro de asistencia |

### Eventos SSE (Server-Sent Events)

```javascript
// Conexión SSE
const eventSource = new EventSource('http://localhost:8080/events');

// Escuchar eventos específicos
eventSource.addEventListener('FINGER_TOUCHED', (e) => {
    const data = JSON.parse(e.data);
    console.log('👆 Dedo detectado:', data);
});

eventSource.addEventListener('FINGERPRINT_READY', (e) => {
    const data = JSON.parse(e.data);
    console.log('✅ Huella lista:', data);
    // Iniciar identificación
});
```

---

## Manejo de Errores

### Estrategias de Recuperación

#### 1. Errores Transitorios (Auto-Recuperación)

```typescript
// Reintentos automáticos
private async withRetry<T>(
    operation: () => Promise<T>,
    maxRetries: number = 3
): Promise<T> {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await operation();
        } catch (error) {
            if (i === maxRetries - 1) throw error;
            await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
        }
    }
    throw new Error('Max retries reached');
}
```

#### 2. Errores Consecutivos (Auto-Desactivación)

```typescript
private consecutiveErrors: number = 0;
private readonly MAX_CONSECUTIVE_ERRORS = 5;

private async handleError(error: any): Promise<void> {
    this.consecutiveErrors++;

    if (this.consecutiveErrors >= this.MAX_CONSECUTIVE_ERRORS) {
        // Desactivar modo automático
        await this.handleCriticalError('Demasiados errores consecutivos');
    }
}
```

#### 3. Errores de Conexión SSE

```typescript
this.eventSource.onerror = (error) => {
    console.error('❌ Error en conexión SSE');

    // Intentar reconectar
    setTimeout(() => {
        if (this.isActive) {
            this.connectToSSE();
        }
    }, 5000);
};
```

### Estados de Error

| Estado | Descripción | Acción |
|--------|-------------|--------|
| `SERVER_UNAVAILABLE` | Servidor biométrico no responde | Mostrar error, no iniciar |
| `READER_NOT_FOUND` | Lector no conectado | Mostrar error, desactivar |
| `INITIALIZATION_ERROR` | Fallo al inicializar | Reintentar 3 veces |
| `SSE_CONNECTION_ERROR` | Pérdida de conexión SSE | Reconectar automáticamente |
| `CONSECUTIVE_ERRORS` | 5+ errores consecutivos | Auto-desactivar y notificar |
| `CRITICAL_ERROR` | Error irrecuperable | Desactivar inmediatamente |

---

## Archivos Clave del Sistema

### Backend

1. **BiometricCore.cs**
   - Ruta: `biometric-engine/bridge-csharp/src/Core/BiometricCore.cs`
   - Función: Motor principal C#, manejo de hilos, SDK DigitalPersona
   - Líneas clave:
     - `StartTouchMode()`: línea ~450
     - `TouchModeWorker()`: línea ~470
     - `OnFingerTouch()`: línea ~490

2. **server.js**
   - Ruta: `biometric-engine/node/server.js`
   - Función: API REST, SSE streaming, bridge Node-C#
   - Endpoints clave:
     - `/api/touch/start`: Iniciar modo touch
     - `/api/touch/identify-last`: Identificar última huella
     - `/events`: Stream SSE

### Frontend

3. **TouchModeService.ts**
   - Ruta: `sistema-asistencia/services/TouchModeService.ts`
   - Función: Coordinador principal, lógica de negocio
   - Métodos clave:
     - `start()`: línea ~100
     - `connectToSSE()`: línea ~350
     - `identifyAndRegister()`: línea ~420

4. **main.ts**
   - Ruta: `electron/main.ts`
   - Función: Proceso principal Electron, IPC handlers
   - Sección clave: líneas 453-490 (Singleton + Event Forwarding)

5. **preload.ts**
   - Ruta: `electron/preload.ts`
   - Función: Exponer APIs al renderer
   - APIs Touch Mode: líneas 109-131

6. **app.js**
   - Ruta: `sistema-asistencia/renderer/app.js`
   - Función: UI, event listeners, auto-inicialización
   - Función clave: `initializeTouchMode()`: línea ~2700

### Modelos

7. **AttendanceModel.ts**
   - Ruta: `sistema-asistencia/models/AttendanceModel.ts`
   - Función: Lógica de base de datos para asistencia
   - Métodos:
     - `checkIn()`: Registrar entrada
     - `checkOut()`: Registrar salida
     - `getByEmployeeAndDate()`: Consultar registro del día

---

## Configuración y Parámetros

### Variables Críticas

```typescript
// TouchModeService.ts
const BIOMETRIC_SERVER = 'http://localhost:8080';  // URL del backend
const MAX_CONSECUTIVE_ERRORS = 5;                   // Errores antes de desactivar
const MIN_TIME_BETWEEN_CHECKIN_CHECKOUT = 60000;   // 1 minuto en ms

// Threshold de matching
const TARGET_FARN = 5000;  // Más bajo = más estricto (0 = perfecto)
```

### Configuración del Lector

```csharp
// BiometricCore.cs
private const int IMAGE_WIDTH = 500;
private const int IMAGE_HEIGHT = 550;
private const Fmd.Format FMD_FORMAT = Fmd.Format.ANSI_378_2004;
```

---

## Por Qué Funciona Esta Implementación

### 1. Arquitectura Multi-Hilo

**Problema**: El lector biométrico es un dispositivo hardware que genera eventos de forma asíncrona. Si usáramos un solo hilo, bloquearíamos la ejecución.

**Solución**: Hilo dedicado (`_touchModeThread`) que espera eventos del SDK sin bloquear otros procesos.

### 2. Server-Sent Events (SSE)

**Problema**: Necesitamos comunicación en tiempo real del backend al frontend sin polling constante.

**Solución**: SSE mantiene una conexión HTTP abierta por la que el servidor "empuja" eventos al cliente automáticamente.

```
Polling (❌ Ineficiente):
Cliente: ¿Hay eventos? → Servidor: No
Cliente: ¿Hay eventos? → Servidor: No
Cliente: ¿Hay eventos? → Servidor: Sí, aquí están

SSE (✅ Eficiente):
Cliente: [Conexión abierta]
Servidor: → [Envía evento cuando ocurre]
Servidor: → [Envía otro evento cuando ocurre]
```

### 3. Singleton Service

**Problema**: Si creamos múltiples instancias de `TouchModeService`, tendríamos múltiples conexiones SSE y registros duplicados.

**Solución**: Patrón Singleton garantiza una única instancia compartida en todo el proceso Main.

### 4. IPC Event Forwarding

**Problema**: Los eventos del servicio (Main Process) no son accesibles directamente desde el Renderer Process por seguridad de Electron.

**Solución**: El Main Process escucha eventos del servicio y los "reenvía" al Renderer vía `webContents.send()`.

### 5. Validación de Score Estricto

**Problema**: Con threshold permisivo (targetFarn = 21474), se aceptaban huellas con score 3, 4, etc., causando falsos positivos.

**Solución**:
- targetFarn = 5000 (más estricto en el matching)
- Validación adicional `score === 0` antes de registrar

### 6. Tiempo Mínimo Entre Entrada/Salida

**Problema**: Errores en la captura podían registrar entrada y salida en el mismo segundo.

**Solución**: Validar que hayan transcurrido al menos 60 segundos entre check-in y check-out.

### 7. Auto-Desactivación por Errores

**Problema**: Errores continuos podían hacer que el sistema siguiera intentando operar en mal estado.

**Solución**: Contador de errores consecutivos. Al llegar a 5, se desactiva automáticamente y notifica al usuario.

---

## Flujo de Inicialización del Sistema

```
1. APLICACIÓN ELECTRON INICIA
   main.ts: app.whenReady()
   │
   ↓
2. VENTANA PRINCIPAL CREADA
   BrowserWindow creado
   Carga index.html
   │
   ↓
3. RENDERER PROCESS CARGA
   app.js: DOMContentLoaded
   │
   ↓
4. INICIALIZACIÓN AUTOMÁTICA
   initializeTouchMode() ejecutado
   │
   ├─→ Configurar listeners IPC
   │   - onCriticalError
   │   - onAttendanceRegistered
   │
   ├─→ Llamar window.touchMode.start()
   │   │
   │   ↓ IPC: touchMode:start
   │   │
   │   ↓ MAIN PROCESS (main.ts)
   │   │ getTouchModeService() - Singleton
   │   │
   │   ↓ TouchModeService.start()
   │   │
   │   ├─→ checkServerAvailability()
   │   │   HTTP GET http://localhost:8080/api/health
   │   │
   │   ├─→ initializeReader()
   │   │   HTTP POST /api/initialize-reader
   │   │   │
   │   │   ↓ BACKEND (server.js)
   │   │   ↓ edge_initializeReader()
   │   │   │
   │   │   ↓ C# (BiometricCore.cs)
   │   │   ↓ InitializeReader()
   │   │   ↓ - Enumerar lectores
   │   │   ↓ - Seleccionar DP4500
   │   │   ↓ - Iniciar _readerThread
   │   │
   │   ├─→ activateTouchMode()
   │   │   HTTP POST /api/touch/start
   │   │   │
   │   │   ↓ BACKEND
   │   │   ↓ StartTouchMode()
   │   │   │
   │   │   ↓ C#
   │   │   ↓ - Activar _touchModeActive = true
   │   │   ↓ - Iniciar _touchModeThread
   │   │   ↓ - Suscribir eventos del lector
   │   │
   │   ├─→ loadFingerprintsFromDatabase()
   │   │   - Consultar BD: SELECT * FROM fingerprints
   │   │   - HTTP POST /api/load-template (por cada huella)
   │   │   - Cargar FMDs en RAM del backend
   │   │
   │   └─→ connectToSSE()
   │       EventSource('http://localhost:8080/events')
   │       - Listener: FINGER_TOUCHED
   │       - Listener: FINGERPRINT_READY
   │       - Listener: errores
   │
   └─→ startTouchModePolling()
       setInterval cada 1 segundo
       - Actualizar UI
       - Detectar cambios de estado
```

---

## Conclusión

El Sistema de Captura Continua es una implementación robusta que combina:

- ✅ **Multi-threading** en C# para operaciones asíncronas del hardware
- ✅ **Server-Sent Events** para comunicación en tiempo real
- ✅ **Arquitectura de microservicios** (Frontend ↔ Backend separados)
- ✅ **Patrón Singleton** para evitar duplicaciones
- ✅ **Manejo robusto de errores** con auto-recuperación y auto-desactivación
- ✅ **Validaciones estrictas** para evitar falsos positivos
- ✅ **Lógica de negocio inteligente** (entrada/salida automática)

Esta arquitectura permite un sistema escalable, mantenible y confiable para el registro automático de asistencia mediante identificación biométrica.

---

**Última actualización**: 17 de noviembre de 2025
**Autor**: Sistema de Asistencia Biométrica
