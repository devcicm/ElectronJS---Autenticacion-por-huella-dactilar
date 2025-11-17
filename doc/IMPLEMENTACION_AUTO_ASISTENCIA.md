# Implementación de Sistema de Auto-Asistencia con Captura Continua

## 📋 Requerimiento Original

**Fecha**: 2025-01-13
**Solicitud del Usuario**:
> "necesito tener la opcion funcionalidad de estar prendido el lector de huellas y este escuchando las capturas y este verificando quien es el empleado y tome registro de su asistencia"

### Descripción Detallada del Requerimiento

Implementar un sistema de asistencia automática que funcione en modo continuo con las siguientes características:

1. **Modo Escucha Continua**: El lector de huellas debe estar en un loop constante esperando capturas
2. **Identificación Automática**: Cuando se capture una huella, identificar automáticamente al empleado
3. **Registro Automático**: Registrar la asistencia (entrada/salida) sin intervención manual
4. **Cache de Templates**: Mantener todos los templates de empleados en memoria para comparación rápida
5. **Auto-Reload**: Recargar cache cuando se detecten cambios en empleados
6. **Prevención de Conflictos**: Evitar que el modo automático interfiera con enrollment manual
7. **Configuración**: Permitir auto-inicio del modo automático al arrancar la aplicación
8. **UI Controls**: Botones para iniciar/pausar el modo automático

---

## 🎯 Intención y Propósito

### Problema a Resolver
Actualmente, el sistema de asistencia requiere que el usuario:
1. Navegue a la sección "Registrar Asistencia"
2. Seleccione manualmente al empleado
3. Capture la huella
4. Confirme el registro

Este proceso es lento y requiere intervención manual para cada registro.

### Solución Propuesta
Un sistema automático donde:
- El empleado solo necesita poner su dedo en el lector
- El sistema identifica automáticamente quién es
- Registra la asistencia sin intervención
- Notifica al usuario del registro exitoso
- Similar a sistemas modernos de control de acceso biométrico

### Beneficios
1. **Rapidez**: Registro en ~2-5 segundos vs 20-30 segundos manual
2. **Sin Errores**: Elimina selección incorrecta de empleado
3. **Escalabilidad**: Soporta múltiples empleados sin complicación
4. **UX Mejorada**: Experiencia similar a sistemas comerciales
5. **Productividad**: Personal de RH no necesita supervisar cada registro

---

## 🏗️ Arquitectura Propuesta

### Componentes Necesarios

#### 1. Backend (edge-uru-ui) - **REQUIERE IMPLEMENTACIÓN**
```
/api/store-load (POST)
├── Recibe array de templates desde frontend
├── Formato: [{ userId, hand, finger, templateBase64 }]
├── Deserializa cada template XML
├── Carga al FingerprintTempStore en RAM
└── Retorna estadísticas de éxito/error

/api/identify (POST) - **YA EXISTE**
├── Captura del lector físico
├── Compara contra TODO el store (1:N)
├── Retorna bestTag del match
└── Usado para identificación automática
```

#### 2. Frontend (Electron App)
```
AutoAttendanceService.ts
├── loadEmployeeCache()
│   ├── Lee empleados activos de SQLite
│   ├── Obtiene sus templates
│   ├── Los envía a /api/store-load
│   └── Mantiene cache local de empleados
│
├── identifyEmployee()
│   ├── Llama a /api/identify
│   ├── Backend captura y compara
│   ├── Parsea bestTag → employeeId
│   └── Retorna datos del empleado
│
├── registerAutoAttendance()
│   ├── Verifica si puede check-in o check-out
│   ├── Registra asistencia en SQLite
│   └── Notifica al usuario
│
└── listeningLoopFunction()
    ├── Loop cada ~12 segundos
    ├── Llama a identifyEmployee()
    ├── Si hay match, registra asistencia
    └── Continúa hasta que se detenga
```

---

## 🔧 Pasos de Implementación Realizados

### 1. Análisis del Backend Existente (edge-uru-ui)
**Archivo**: `biometric-engine/bridge-csharp/src/Bridge/EdgeUruBridge.cs`

**Descubrimientos**:
- ✅ Existe `FingerprintTempStore` en RAM (volátil)
- ✅ Existe `/api/identify` para identificación 1:N
- ❌ NO existe endpoint para cargar templates externos
- ❌ Templates se agregan solo durante enrollment
- ✅ Store se limpia al reiniciar servidor

**Problema Identificado**:
```csharp
// El store solo se llena cuando haces enroll:
case "enroll":
    // ... captura del lector ...
    FingerprintTempStore.AddFingerprint(userId, hand, finger, fmd, ...);
```

**Solución Necesaria**: Crear operación para cargar templates existentes sin capturar.

### 2. Implementación de `/api/store-load` en Backend

**Ubicación**: `biometric-engine/bridge-csharp/src/Bridge/EdgeUruBridge.cs`

**Código Agregado** (líneas 923-1009):
```csharp
case "storeLoadTemplates":
{
    var templates = (object[])input?.templates;

    foreach (dynamic template in templates)
    {
        string userId = (string)template.userId;
        string handStr = (string)template.hand;
        string fingerStr = (string)template.finger;
        string templateBase64 = (string)template.templateBase64;

        // Parsear hand y finger a enums
        Hand hand = handStr.ToUpper() switch { ... };
        Finger finger = fingerStr.ToUpper() switch { ... };

        // Deserializar template XML desde base64
        var xmlBytes = Convert.FromBase64String(templateBase64);
        var xmlString = System.Text.Encoding.UTF8.GetString(xmlBytes);
        var fmd = DPUruNet.Fmd.DeserializeXml(xmlString);

        // Agregar al store
        FingerprintTempStore.AddFingerprint(userId, hand, finger, fmd, ...);
    }

    return new { ok = true, successCount, errorCount, ... };
}
```

**Exposición en Node.js** (`biometric-engine/node/server.ts`, líneas 198-208):
```typescript
app.post("/api/store-load", async (req, res) => {
  const { templates } = req.body;
  res.json(await call({ op: "storeLoadTemplates", templates }));
});
```

### 3. Creación de AutoAttendanceService

**Archivo**: `sistema-asistencia/services/AutoAttendanceService.ts`

**Responsabilidades**:
1. **Gestión de Estado**: isListening, isEnrolling, employeeCount
2. **Cache Management**:
   - Cargar empleados de SQLite
   - Enviar templates al backend store
   - Recargar cada 5 minutos o cuando cambie número de empleados
3. **Loop de Identificación**:
   - Llamar a `/api/identify` cada ~12 segundos
   - Parsear tag retornado para obtener employeeId
   - Buscar empleado en cache local
4. **Registro de Asistencia**:
   - Verificar si puede check-in o check-out
   - Llamar a AttendanceService
   - Notificar al usuario con callbacks

**Métodos Principales**:
```typescript
class AutoAttendanceService {
    // Inicialización
    async start(): Promise<{ success, message }>
    async stop(): Promise<{ success, message }>

    // Cache
    private async loadEmployeeCache(): Promise<void>
    private async loadTemplatesToBackendStore(): Promise<void>
    private shouldReloadCache(): boolean

    // Identificación
    private async identifyEmployee(): Promise<EmployeeCache | null>

    // Registro
    private async registerAutoAttendance(employee): Promise<void>

    // Loop
    private async listeningLoopFunction(): Promise<void>

    // Callbacks
    onStateChange(callback): void
    onAttendanceRegistration(callback): void
}
```

### 4. Integración con Electron Main Process

**Archivo**: `electron/main.ts`

**IPC Handlers Agregados**:
```typescript
// Singleton del servicio
let autoAttendanceServiceInstance: any = null;

const getAutoAttendanceService = async () => {
    if (!autoAttendanceServiceInstance) {
        autoAttendanceServiceInstance = new AutoAttendanceService(...);

        // Registrar callbacks para comunicación con renderer
        autoAttendanceServiceInstance.onStateChange((state) => {
            mainWindow.webContents.send('auto-attendance:state-changed', state);
        });

        autoAttendanceServiceInstance.onAttendanceRegistration((data) => {
            mainWindow.webContents.send('auto-attendance:registered', data);
        });
    }
    return autoAttendanceServiceInstance;
};

// Handlers
ipcMain.handle('autoAttendance:start', async () => { ... });
ipcMain.handle('autoAttendance:stop', async () => { ... });
ipcMain.handle('autoAttendance:getState', async () => { ... });
ipcMain.handle('autoAttendance:reloadCache', async () => { ... });
```

### 5. Exposición de API al Renderer

**Archivo**: `electron/preload.ts`

```typescript
contextBridge.exposeInMainWorld('autoAttendance', {
    start: () => ipcRenderer.invoke('autoAttendance:start'),
    stop: () => ipcRenderer.invoke('autoAttendance:stop'),
    getState: () => ipcRenderer.invoke('autoAttendance:getState'),
    reloadCache: () => ipcRenderer.invoke('autoAttendance:reloadCache'),

    // Event listeners
    onStateChanged: (callback) => {
        ipcRenderer.on('auto-attendance:state-changed', (_event, state) =>
            callback(state));
    },
    onAttendanceRegistered: (callback) => {
        ipcRenderer.on('auto-attendance:registered', (_event, data) =>
            callback(data));
    }
});
```

### 6. Interfaz de Usuario

**Archivo**: `sistema-asistencia/renderer/index.html`

**UI Agregada en Sección "Registrar Asistencia"**:
```html
<div class="card">
    <div class="card-header">
        <h3>🎧 Modo Automático de Asistencia</h3>
    </div>
    <div class="card-body">
        <div id="auto-attendance-status">
            <!-- Estado dinámico -->
        </div>
        <button id="toggle-auto-attendance-btn"
                onclick="toggleAutoAttendance()">
            🟢 Iniciar Modo Automático
        </button>
    </div>
</div>
```

**Archivo**: `sistema-asistencia/renderer/app.js`

**Funciones JavaScript**:
```javascript
// Estado global
let autoAttendanceState = { isListening: false, ... };

// Toggle modo automático
async function toggleAutoAttendance() {
    if (autoAttendanceState.isListening) {
        await window.autoAttendance.stop();
    } else {
        await window.autoAttendance.start();
    }
}

// Actualizar UI según estado
function updateAutoAttendanceUI() {
    const statusDiv = document.getElementById('auto-attendance-status');
    const btn = document.getElementById('toggle-auto-attendance-btn');

    if (autoAttendanceState.isListening) {
        statusDiv.innerHTML = '🟢 ACTIVO - Escuchando...';
        btn.textContent = '🛑 Detener';
        btn.className = 'btn btn-danger';
    } else {
        statusDiv.innerHTML = '⚪ INACTIVO';
        btn.textContent = '🟢 Iniciar';
        btn.className = 'btn btn-success';
    }
}

// Manejar registro automático
async function handleAutoAttendanceRegistration(data) {
    const { type, employee, result } = data;

    if (type === 'check-in') {
        showNotification(`✅ ${employee.first_name} - Entrada registrada`);
    } else if (type === 'check-out') {
        showNotification(`✅ ${employee.first_name} - Salida registrada`);
    } else if (type === 'not-identified') {
        showNotification(`❌ Huella no identificada`, 'error');
    }

    // Recargar dashboard
    await loadInitialData();
    loadDashboard();
}

// Setup listeners
window.autoAttendance.onStateChanged((state) => {
    autoAttendanceState = state;
    updateAutoAttendanceUI();
});

window.autoAttendance.onAttendanceRegistered((data) => {
    handleAutoAttendanceRegistration(data);
});
```

### 7. Actualización de BiometricService

**Archivo**: `sistema-asistencia/services/BiometricService.ts`

**Cambios**:
- Marcado `compareTemplates()` como deprecated
- Actualizado `verifyFingerprint()` para usar `/api/identify` en lugar de comparación manual
- Actualizado `identifyEmployee()` para usar identificación 1:N del backend

**Razón**: El backend no soporta comparación directa de templates (template1 vs template2). Usa identificación 1:N con el store.

---

## ❌ Problemas Encontrados Durante la Implementación

### 1. Template Deserialización Falla (0/1 templates cargados)
**Error**: `Cargados 0/1 templates al store`

**Causa Raíz (Hipótesis)**:
El template guardado en SQLite no está en el formato XML esperado por `DPUruNet.Fmd.DeserializeXml()`.

**Posibles Razones**:
1. Template guardado es binario raw en lugar de XML serializado
2. Template está en formato ISO/ANSI en lugar de DP_REGISTRATION
3. Template está corrupto o incompleto
4. Encoding incorrecto al guardar/cargar

**Verificación Necesaria**:
```typescript
// En BiometricService.ts, cuando se enrolla:
const regXml = DPUruNet.Fmd.SerializeXml(result.fmdReg);
const templateBase64 = Convert.ToBase64String(
    System.Text.Encoding.UTF8.GetBytes(regXml)
);
// ¿Se está guardando correctamente regXml o result.fmdReg?
```

### 2. Reader Not Initialized
**Error**: `Reader not initialized. Call 'init' first.`

**Causa**: El endpoint `/api/identify` requiere que el lector esté inicializado con `/api/init` primero.

**Solución Implementada**: Llamar a `/api/init` antes de iniciar el modo automático.

**Código**:
```typescript
// En AutoAttendanceService.start()
const initResponse = await fetch(`${BIOMETRIC_SERVER}/api/init`, {
    method: 'POST'
});
```

### 3. Loop Demasiado Agresivo
**Problema**: Loop cada 1 segundo + timeout de 12 segundos en `/api/identify` = overlapping requests.

**Solución**: Cambiar loop para ejecutarse solo después de que termine la identificación anterior.

---

## 🔍 Logging y Debugging Agregado

### Backend C# (EdgeUruBridge.cs)
```csharp
Console.WriteLine($"[STORE_LOAD] Procesando template: userId={userId}, hand={handStr}, finger={fingerStr}");
Console.WriteLine($"[STORE_LOAD] Template length: {templateBase64?.Length ?? 0} chars");
Console.WriteLine($"[STORE_LOAD] XML preview (first 200 chars): {xmlString.Substring(0, Math.Min(200, xmlString.Length))}");
Console.WriteLine($"[STORE_LOAD] ✅ FMD deserialized successfully, bytes: {fmd.Bytes?.Length ?? 0}");
Console.WriteLine($"[STORE_LOAD] ✅ Added to store with tag: {storedFp.Tag}");
```

### Frontend TypeScript
```typescript
console.log('🔄 Cargando cache de empleados y templates al backend store...');
console.log(`📦 ${this.employeeCache.length} empleados con ${templatesForBackend.length} templates`);
console.log(`📤 Enviando ${templates.length} templates al backend store...`);
console.log(`✅ ${result.successCount}/${result.total} templates cargados al backend store`);
console.log(`🔍 Identificando empleado (${this.employeeCache.length} empleados en cache)...`);
console.log(`🔍 Match encontrado: tag = ${result.bestTag}, employee_id = ${employeeId}, score = ${result.bestScore}`);
console.log(`✅✅✅ Empleado identificado: ${employee.first_name} ${employee.last_name}`);
```

---

## 📦 Archivos Modificados/Creados

### Archivos Nuevos
1. `sistema-asistencia/services/AutoAttendanceService.ts` - Servicio principal
2. `IMPLEMENTACION_AUTO_ASISTENCIA.md` - Este documento

### Archivos Modificados

#### Backend (edge-uru-ui / biometric-engine)
1. `biometric-engine/bridge-csharp/src/Bridge/EdgeUruBridge.cs`
   - Agregado caso `storeLoadTemplates` (líneas 923-1009)
   - Agregado logging detallado

2. `biometric-engine/node/server.ts`
   - Agregado endpoint `POST /api/store-load` (líneas 198-208)

#### Frontend (Electron App)
3. `electron/main.ts`
   - Agregado singleton de AutoAttendanceService
   - Agregados IPC handlers para auto-attendance
   - Agregados callbacks para comunicación con renderer

4. `electron/preload.ts`
   - Expuesto `window.autoAttendance` API
   - Agregados event listeners

5. `sistema-asistencia/renderer/index.html`
   - Agregada sección UI "Modo Automático de Asistencia"

6. `sistema-asistencia/renderer/app.js`
   - Agregadas funciones de control del modo automático
   - Agregados event handlers
   - Agregada lógica de notificaciones

7. `sistema-asistencia/services/BiometricService.ts`
   - Marcado `compareTemplates()` como deprecated
   - Actualizado `verifyFingerprint()` para usar `/api/identify`
   - Actualizado `identifyEmployee()` para identificación 1:N

---

## 🚧 Requerimientos del Backend (edge-uru-ui)

Para que esta implementación funcione completamente, el backend **edge-uru-ui** necesita:

### 1. Operación `storeLoadTemplates` (IMPLEMENTADO pero NO PROBADO)
```csharp
case "storeLoadTemplates":
{
    // Recibe templates externos
    // Los deserializa
    // Los agrega al FingerprintTempStore
    // Retorna estadísticas
}
```

**Estado**: Código agregado pero falla al deserializar templates.

**Problema**: Templates de la BD no son compatibles con `DPUruNet.Fmd.DeserializeXml()`.

**Solución Necesaria**:
1. Investigar formato exacto de templates guardados en SQLite
2. Ajustar serialización/deserialización según formato real
3. Potencialmente agregar soporte para múltiples formatos de template
4. Agregar validación de formato antes de deserializar

### 2. Manejo de Formato de Templates

**Formatos Posibles**:
- `DP_REGISTRATION` (XML serializado) - Esperado
- `DP_VERIFICATION` (binario)
- `ANSI 378`
- `ISO 19794-2`

**Código de Investigación Sugerido**:
```csharp
// En EdgeUruBridge.cs, caso "enroll"
Console.WriteLine($"[DEBUG] FMD Format: {result.fmdReg.Format}");
Console.WriteLine($"[DEBUG] FMD Bytes Length: {result.fmdReg.Bytes?.Length}");

var xml = DPUruNet.Fmd.SerializeXml(result.fmdReg);
Console.WriteLine($"[DEBUG] XML Length: {xml.Length}");
Console.WriteLine($"[DEBUG] XML Preview: {xml.Substring(0, Math.Min(500, xml.Length))}");
```

### 3. Persistencia Opcional del Store

**Problema Actual**: Store es volátil (se pierde al reiniciar).

**Opciones**:
1. **No persistir** (mantener actual) - Más seguro, requiere recarga manual
2. **Persistir en archivo** - Riesgo de seguridad, más conveniente
3. **Persistir encriptado** - Balance seguridad/conveniencia

**Si se implementa persistencia**:
```csharp
case "storeSave":
{
    // Serializar store a archivo JSON/XML
    // Encriptar (opcional)
    // Guardar en disco
}

case "storeRestore":
{
    // Leer archivo
    // Desencriptar (si aplica)
    // Cargar al store en RAM
}
```

### 4. API de Gestión del Store

**Endpoints Sugeridos**:
```typescript
GET  /api/store           // Listar templates (YA EXISTE)
POST /api/store-load      // Cargar templates (IMPLEMENTADO)
DELETE /api/store         // Limpiar store (YA EXISTE)
GET  /api/store-stats     // Estadísticas (YA EXISTE)
POST /api/store-remove    // Remover template específico (SUGERIDO)
```

---

## 🎯 Próximos Pasos Recomendados

### Implementación en edge-uru-ui (PRIORIDAD)

1. **Investigar Formato de Templates**
   ```bash
   # En tu repo edge-uru-ui
   git checkout -b feature/template-store-api
   ```

   Agregar logging en enrollment para ver formato exacto:
   ```csharp
   // En caso "enroll", después de obtener fmdReg:
   Console.WriteLine($"=== TEMPLATE DEBUG ===");
   Console.WriteLine($"Format: {result.fmdReg.Format}");
   Console.WriteLine($"Views: {result.fmdReg.Views}");

   var xml = DPUruNet.Fmd.SerializeXml(result.fmdReg);
   Console.WriteLine($"XML:\n{xml}");
   Console.WriteLine($"======================");
   ```

2. **Ajustar storeLoadTemplates**
   - Agregar soporte para detección automática de formato
   - Agregar conversión entre formatos si es necesario
   - Mejorar manejo de errores con detalles específicos

3. **Agregar Tests**
   ```csharp
   // Test de carga de templates
   [Test]
   public void TestStoreLoadTemplates()
   {
       // Mock templates
       // Llamar storeLoadTemplates
       // Verificar que se agregaron al store
       // Verificar que identify funciona con templates cargados
   }
   ```

4. **Documentar API**
   Crear `API_SPEC.md` en edge-uru-ui documentando:
   - Formato esperado de templates
   - Endpoints disponibles
   - Ejemplos de uso
   - Códigos de error

### Integración en Electron App (DESPUÉS)

1. **Esperar a que edge-uru-ui esté listo**
   - `/api/store-load` funcionando correctamente
   - Templates se cargan sin errores
   - Identificación 1:N funciona con templates cargados

2. **Probar AutoAttendanceService**
   - Hacer enrollment de un empleado
   - Activar modo automático
   - Verificar que identifica correctamente
   - Verificar que registra asistencia

3. **Optimizaciones**
   - Ajustar timing del loop según pruebas reales
   - Implementar reintentos en caso de errores transitorios
   - Agregar métricas de rendimiento

4. **Configuración Avanzada**
   - Timeout configurable
   - Threshold configurable (targetFarn)
   - Número de intentos configurable
   - Intervalo de recarga de cache configurable

---

## 📊 Métricas Esperadas (Una vez implementado)

### Performance
- **Tiempo de Identificación**: ~2-5 segundos
- **Tiempo de Registro**: ~1 segundo
- **Tiempo Total**: ~3-6 segundos por empleado

### Comparación con Modo Manual
- **Modo Manual**: ~20-30 segundos
- **Modo Automático**: ~3-6 segundos
- **Mejora**: **~75-80% más rápido**

### Capacidad
- **Empleados Soportados**: Limitado por RAM del store
- **Estimado**: ~500-1000 empleados con 2-4 huellas cada uno
- **Templates en Store**: ~1000-4000 templates

---

## 🔐 Consideraciones de Seguridad

1. **Templates en RAM**: Volátiles, se pierden al reiniciar (SEGURO)
2. **Templates en BD**: Persistentes, protegidos por permisos del archivo SQLite
3. **Templates en Tránsito**: HTTP local (localhost:8080) - No expuesto a red
4. **Recomendación**: Si se implementa persistencia del store, encriptar archivo

---

## 📝 Conclusión

La implementación de Auto-Asistencia requiere:

1. **En edge-uru-ui** (BACKEND):
   - Completar y probar `storeLoadTemplates`
   - Resolver incompatibilidad de formato de templates
   - Agregar tests y documentación

2. **En Electron App** (FRONTEND):
   - Ya está implementado pero depende del backend
   - Probar una vez backend esté listo
   - Ajustar según resultados de pruebas

**Recomendación**: Implementar primero en edge-uru-ui, hacer commit, y luego integrar aquí.

---

## 📚 Referencias

- **Repo Backend**: https://github.com/devcicm/edge-uru-ui
- **SDK Documentation**: DPUruNet SDK
- **Template Formats**: DP_REGISTRATION, DP_VERIFICATION, ANSI 378, ISO 19794-2

---

**Documento Generado**: 2025-01-13
**Autor**: Claude (Anthropic)
**Versión**: 1.0
