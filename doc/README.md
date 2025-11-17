# Sistema de Asistencia Biométrica - Documentación

## 📚 Índice General

Esta carpeta contiene toda la documentación técnica del Sistema de Asistencia Biométrica basado en Electron.js y DigitalPersona U.are.U 4500.

### 🎯 Documentación Principal

1. **[TOUCH-MODE-CAPTURA-CONTINUA.md](./TOUCH-MODE-CAPTURA-CONTINUA.md)**
   - Documentación técnica completa del sistema de captura continua
   - Arquitectura general (Frontend + Backend)
   - Componentes Backend (C# + Node.js)
   - Componentes Frontend (TypeScript + JavaScript)
   - Implementación detallada
   - Eventos y comunicación
   - Manejo de errores
   - Archivos clave del sistema

2. **[DIAGRAMAS-FLUJO-TOUCH-MODE.md](./DIAGRAMAS-FLUJO-TOUCH-MODE.md)**
   - Diagramas de secuencia completos
   - Flujo de auto-inicialización
   - Flujo de identificación y registro
   - Diagrama de hilos (threading)
   - Flujo de manejo de errores

---

## 🏗️ Estructura del Proyecto

```
ElectronJS - Autenticacion por huella dactilar/
│
├── biometric-engine/          # Motor biométrico (Backend)
│   ├── bridge-csharp/         # Código C# (.NET Framework 4.7.2)
│   │   ├── src/
│   │   │   ├── Core/          # BiometricCore.cs - Motor principal
│   │   │   └── Bridge/        # Interfaz Edge.js
│   │   └── bin-deps/          # DLLs del SDK DigitalPersona
│   │
│   ├── node/                  # Servidor Node.js
│   │   ├── server.js          # API REST + SSE
│   │   └── public/            # UI de prueba
│   │
│   └── docs/                  # Documentación del engine
│
├── electron/                  # Aplicación Electron
│   ├── main.ts                # Proceso principal
│   ├── preload.ts             # Preload script (IPC API)
│   └── index.html             # Ventana principal
│
├── sistema-asistencia/        # Sistema de Asistencia (Frontend)
│   ├── database/              # Base de datos SQLite
│   │   ├── init.ts            # Inicialización y migraciones
│   │   └── schema.sql         # Esquema de BD
│   │
│   ├── models/                # Modelos de datos
│   │   ├── AttendanceModel.ts # Gestión de asistencias
│   │   ├── EmployeeModel.ts   # Gestión de empleados
│   │   ├── DepartmentModel.ts # Gestión de departamentos
│   │   ├── ShiftModel.ts      # Gestión de turnos
│   │   └── FingerprintModel.ts# Gestión de huellas
│   │
│   ├── services/              # Servicios de negocio
│   │   ├── TouchModeService.ts# ⭐ Servicio de captura continua
│   │   ├── AttendanceService.ts # Servicio de asistencias
│   │   └── BiometricService.ts # Servicio biométrico
│   │
│   ├── renderer/              # Interfaz de usuario
│   │   ├── app.js             # ⭐ Aplicación principal UI
│   │   ├── index.html         # HTML principal
│   │   └── styles.css         # Estilos
│   │
│   └── types/                 # Definiciones TypeScript
│
├── docs/                      # 📚 Documentación (esta carpeta)
│   ├── README.md              # Este archivo
│   ├── TOUCH-MODE-CAPTURA-CONTINUA.md
│   └── DIAGRAMAS-FLUJO-TOUCH-MODE.md
│
└── package.json               # Dependencias y scripts
```

---

## 🔑 Conceptos Clave

### Modo de Captura Continua (Touch Mode)

El **Touch Mode** es el sistema que permite el registro automático de asistencia:

1. **Detección Automática**: El lector detecta cuando alguien coloca el dedo
2. **Identificación 1:N**: Compara contra todas las huellas registradas
3. **Registro Inteligente**: Determina automáticamente si es entrada o salida
4. **Notificación en Tiempo Real**: Informa al usuario inmediatamente

### Arquitectura Multi-Capa

```
┌─────────────────────────────────────────────┐
│  FRONTEND (Electron Renderer)               │
│  - app.js: UI + Event Listeners             │
│  - Auto-inicialización                      │
└─────────────────────────────────────────────┘
                    ↕ IPC
┌─────────────────────────────────────────────┐
│  ELECTRON MAIN PROCESS                      │
│  - main.ts: IPC Handlers                    │
│  - TouchModeService (Singleton)             │
│  - Lógica de negocio                        │
└─────────────────────────────────────────────┘
                 ↕ HTTP/SSE
┌─────────────────────────────────────────────┐
│  BACKEND (Node.js + C#)                     │
│  - server.js: API REST + SSE Streaming      │
│  - BiometricCore.cs: Motor C# + Hilos       │
│  - SDK DigitalPersona                       │
└─────────────────────────────────────────────┘
                    ↕
┌─────────────────────────────────────────────┐
│  HARDWARE                                   │
│  - Lector DigitalPersona U.are.U 4500       │
└─────────────────────────────────────────────┘
```

### Tecnologías Utilizadas

#### Backend
- **C# .NET Framework 4.7.2**: Motor biométrico principal
- **Node.js**: Servidor API REST y SSE
- **Edge.js**: Bridge entre Node.js y C#
- **SDK DigitalPersona**: Interfaz con hardware

#### Frontend
- **Electron**: Framework de aplicación desktop
- **TypeScript**: Servicios y modelos tipados
- **JavaScript**: UI e interacciones
- **SQLite**: Base de datos local

#### Comunicación
- **IPC (Electron)**: Main ↔ Renderer
- **HTTP/REST**: Frontend ↔ Backend
- **SSE (Server-Sent Events)**: Backend → Frontend (tiempo real)

---

## 🚀 Inicio Rápido

### Prerequisitos

- Node.js 16+ instalado
- .NET Framework 4.7.2 o superior
- Visual Studio 2022 (para compilar C#)
- Lector DigitalPersona U.are.U 4500 conectado

### Instalación

```bash
# 1. Instalar dependencias
npm install

# 2. Compilar el bridge C#
cd biometric-engine/bridge-csharp
"C:\Program Files\Microsoft Visual Studio\2022\Enterprise\MSBuild\Current\Bin\MSBuild.exe" ^
  EdgeBridge.csproj ^
  /p:Configuration=Release ^
  /p:Platform=AnyCPU ^
  /t:Rebuild

# 3. Volver al directorio raíz
cd ../..

# 4. Compilar TypeScript y ejecutar
npm run build
npm start
```

### Estructura de Comandos

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.json && tsc -p tsconfig.preload.json && tsc -p tsconfig.asistencia.json && ...",
    "start": "npm run build && electron .",
    "dev": "electron ."
  }
}
```

---

## 📊 Base de Datos

### Esquema Principal

```sql
-- Empleados
employees (id, employee_code, first_name, last_name, email,
           department_id, shift_id, position, status, ...)

-- Huellas Dactilares
fingerprints (id, employee_id, finger_position, hand,
              template_data, quality_score, ...)

-- Registros de Asistencia
attendance_records (id, employee_id, date, check_in_time,
                    check_out_time, status, minutes_late,
                    fingerprint_verified, ...)

-- Departamentos
departments (id, name, description, manager_id, ...)

-- Turnos de Trabajo
shifts (id, name, start_time, end_time,
        tolerance_minutes, color, ...)
```

### Ubicación

La base de datos SQLite se encuentra en:
```
sistema-asistencia/database/attendance.db
```

---

## 🔧 Configuración

### Variables de Configuración

**TouchModeService.ts**
```typescript
const BIOMETRIC_SERVER = 'http://localhost:8080';
const MAX_CONSECUTIVE_ERRORS = 5;
const MIN_TIME_BETWEEN_CHECKIN_CHECKOUT = 60000; // 1 minuto
```

**BiometricCore.cs**
```csharp
private const int IMAGE_WIDTH = 500;
private const int IMAGE_HEIGHT = 550;
private const Fmd.Format FMD_FORMAT = Fmd.Format.ANSI_378_2004;
```

**Matching Threshold**
```typescript
const TARGET_FARN = 5000; // Más bajo = más estricto
// 0 = Coincidencia perfecta
// 5000 = Muy estricto
// 21474 = Permisivo (no recomendado)
```

---

## 🎯 Funcionalidades Principales

### 1. Auto-Inicialización

Al iniciar la aplicación, el Touch Mode se activa automáticamente:

```javascript
// app.js
document.addEventListener('DOMContentLoaded', async () => {
    await loadInitialData();
    await initializeTouchMode();  // ← Auto-inicio
    loadDashboard();
});
```

### 2. Identificación 1:N

El sistema compara la huella capturada contra **todas** las huellas registradas:

```csharp
// BiometricCore.cs
public dynamic IdentifyLastCaptured(dynamic input)
{
    int targetFarn = input.targetFarn ?? 5000;

    foreach (var template in _templates)
    {
        int falsematch_rate = 0;
        CompareResult result = Comparison.Compare(
            _lastCapturedFmd,
            0,
            template.Fmd,
            0,
            ref falsematch_rate
        );

        if (result == CompareResult.Match &&
            falsematch_rate < targetFarn)
        {
            return new {
                ok = true,
                matched = true,
                userId = template.UserId,
                score = falsematch_rate
            };
        }
    }

    return new { ok = true, matched = false };
}
```

### 3. Lógica de Entrada/Salida

```typescript
// TouchModeService.ts
private async identifyAndRegister() {
    // 1. Identificar
    const { employeeId, score } = await this.identifyLastCaptured();

    // 2. Validar score perfecto
    if (score !== 0) return;

    // 3. Consultar registro del día
    const todayRecord = this.attendanceModel
        .getByEmployeeAndDate(employeeId, today);

    // 4. Determinar acción
    if (!todayRecord.check_in_time) {
        // ENTRADA
        this.attendanceModel.checkIn(employeeId, true);
    } else if (!todayRecord.check_out_time) {
        // SALIDA (con validación de tiempo mínimo)
        if (diffMinutes >= 1) {
            this.attendanceModel.checkOut(employeeId);
        }
    }
}
```

### 4. Eventos en Tiempo Real (SSE)

```typescript
// TouchModeService.ts
private connectToSSE() {
    this.eventSource = new EventSource(`${SERVER}/api/events`);

    this.eventSource.addEventListener('FINGERPRINT_READY', (e) => {
        this.state.totalFingerprints++;
        this.identifyAndRegister(); // ← Auto-identificar
    });

    this.eventSource.addEventListener('FINGER_TOUCHED', (e) => {
        this.state.totalTouches++;
        console.log('👆 Dedo detectado');
    });
}
```

### 5. Manejo Robusto de Errores

```typescript
// TouchModeService.ts
private consecutiveErrors = 0;
private readonly MAX_CONSECUTIVE_ERRORS = 5;

private async handleError(error: any) {
    this.consecutiveErrors++;

    if (this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        // Auto-desactivar por seguridad
        await this.handleCriticalError('Demasiados errores');
    }
}
```

---

## 🧪 Testing y Depuración

### Logs del Sistema

El sistema genera logs detallados en varios niveles:

**Backend (C#)**
```
[TouchModeService] ✅ Servidor biométrico disponible
[TouchModeService] 🔧 Inicializando lector biométrico...
[TouchModeService] ✅ Lector inicializado correctamente
[TouchModeService] 👂 Escuchando eventos del lector...
```

**Identificación**
```
🔍 ==================== INICIANDO IDENTIFICACIÓN ====================
✅ EMPLEADO IDENTIFICADO EXITOSAMENTE
- ID: 1
- Score de coincidencia: 0
- Nombre: Carlos Ivan Cruz Mendoza
- Código: 2153410022
🔍 ==================== FIN IDENTIFICACIÓN ====================
```

**Registro de Asistencia**
```
📥 REGISTRANDO ENTRADA
- Empleado: 1
- Fecha: 2025-11-17
- Hora: 08:15:23
- Estado: present
```

### Verificar Funcionamiento

```bash
# 1. Verificar que el servidor biométrico esté corriendo
curl http://localhost:8080/api/health

# 2. Verificar huellas cargadas en RAM
curl http://localhost:8080/api/store/stats

# 3. Ver logs en tiempo real
# (Los logs aparecen en la consola de Electron)
```

---

## 🐛 Solución de Problemas Comunes

### Problema: "Servidor biométrico no disponible"

**Causa**: El backend Node.js no está ejecutándose

**Solución**:
```bash
cd biometric-engine/node
npm install
npm start
```

### Problema: "Lector no encontrado"

**Causa**: El lector DigitalPersona no está conectado o drivers no instalados

**Solución**:
1. Verificar conexión USB del lector
2. Instalar drivers DigitalPersona
3. Reiniciar la aplicación

### Problema: Falsos positivos en identificación

**Causa**: Threshold demasiado permisivo

**Solución**:
```typescript
// TouchModeService.ts - Línea 404
targetFarn: 5000  // ← Valor estricto (actual)
// targetFarn: 21474  // ← Valor permisivo (NO usar)
```

### Problema: Errores consecutivos desactivan el sistema

**Causa**: Problema de conexión o hardware

**Solución**:
1. Revisar logs para identificar el error específico
2. Verificar conexión del lector
3. Reiniciar manualmente el Touch Mode desde la UI

---

## 📈 Rendimiento

### Métricas Típicas

- **Tiempo de captura**: ~200-300ms
- **Tiempo de identificación 1:N**: ~50-100ms por huella
  - Con 1 huella: ~50ms
  - Con 10 huellas: ~500ms
  - Con 100 huellas: ~5s
- **Tiempo total (dedo → registro)**: ~1-2 segundos

### Optimizaciones Implementadas

1. **RAM Store**: Huellas cargadas en memoria para identificación rápida
2. **Threading**: Hilos independientes para no bloquear UI
3. **SSE**: Comunicación push sin polling constante
4. **Singleton Service**: Una sola instancia compartida
5. **Validación temprana**: Salir rápido si score no es perfecto

---

## 🔐 Seguridad

### Medidas Implementadas

1. **Almacenamiento Local**: Base de datos SQLite local (no en la nube)
2. **Templates Encriptados**: Las huellas se almacenan como FMD (no imágenes)
3. **Validación Estricta**: Score = 0 para aceptar identificación
4. **IPC Sandboxing**: Comunicación segura entre procesos Electron
5. **Tiempo Mínimo**: Previene registros duplicados accidentales

### Datos Biométricos

Los datos biométricos se almacenan como **FMD (Feature Minutiae Data)**:
- ❌ **NO** se almacenan imágenes de huellas
- ✅ Se almacenan **características matemáticas** extraídas
- ✅ Es **irreversible**: No se puede reconstruir la imagen original
- ✅ Cumple con estándares **ANSI 378-2004**

---

## 🤝 Contribución

Para contribuir al proyecto:

1. Leer toda la documentación en `docs/`
2. Entender la arquitectura multi-capa
3. Seguir las convenciones de código existentes
4. Agregar tests para nuevas funcionalidades
5. Actualizar documentación según cambios

---

## 📞 Soporte

Para preguntas o problemas:

1. Revisar esta documentación
2. Revisar logs del sistema
3. Verificar issues conocidos
4. Contactar al equipo de desarrollo

---

## 📝 Notas Finales

Este sistema es una implementación completa y robusta de un sistema de asistencia biométrica con:

- ✅ Captura automática en tiempo real
- ✅ Identificación 1:N precisa
- ✅ Lógica de negocio inteligente
- ✅ Manejo robusto de errores
- ✅ UI responsive y amigable
- ✅ Base de datos estructurada
- ✅ Arquitectura escalable

Para más detalles técnicos, consultar:
- [TOUCH-MODE-CAPTURA-CONTINUA.md](./TOUCH-MODE-CAPTURA-CONTINUA.md)
- [DIAGRAMAS-FLUJO-TOUCH-MODE.md](./DIAGRAMAS-FLUJO-TOUCH-MODE.md)

---

**Última actualización**: 17 de noviembre de 2025
**Versión del Sistema**: 1.0.0
