# Diagrama de Flujo Completo - Sistema Biométrico ElectronJS + Edge-URU-UI

## 1. DIAGRAMA GENERAL DEL SISTEMA

```
┌─────────────────────────────────────────────────────────────────────┐
│                          CAPA 1: FRONTEND                            │
│                    (JavaScript + HTML + CSS)                         │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │  electron/renderer/index.html                               │    │
│  │  • Interfaz de usuario                                      │    │
│  │  • Controles del engine (EnrollmentControl, etc.)          │    │
│  │  • Lenguaje: HTML5, JavaScript (ES6+), CSS3               │    │
│  └────────────────────────────────────────────────────────────┘    │
│                              │                                        │
│                              │ HTTP Requests                         │
│                              │ (fetch API)                           │
│                              ↓                                        │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │  BiometricAdapter.js                                        │    │
│  │  • Wrapper de la API del engine                            │    │
│  │  • Manejo de eventos SSE                                   │    │
│  │  • Lenguaje: JavaScript puro                               │    │
│  └────────────────────────────────────────────────────────────┘    │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             │ HTTP/HTTPS + SSE
                             │ URL: http://localhost:8080
                             │
┌────────────────────────────▼────────────────────────────────────────┐
│                    CAPA 2: SERVIDOR NODE.JS                          │
│                       (TypeScript → JavaScript)                      │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │  biometric-engine/node/server.ts                            │    │
│  │  • Express.js server                                        │    │
│  │  • API REST endpoints (/api/*)                             │    │
│  │  • Server-Sent Events (/events)                            │    │
│  │  • Lenguaje: TypeScript compilado a JavaScript (Node.js)   │    │
│  │                                                             │    │
│  │  Endpoints principales:                                     │    │
│  │  - POST /api/init        → Inicializar lector             │    │
│  │  - POST /api/enroll      → Enrolar huella (4 muestras)    │    │
│  │  - POST /api/verify      → Verificar 1:1                  │    │
│  │  - POST /api/identify    → Identificar 1:N                │    │
│  │  - POST /api/single      → Captura simple                 │    │
│  │  - GET  /events          → SSE stream                      │    │
│  └────────────────────────────────────────────────────────────┘    │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             │ Edge.js Bridge
                             │ (JavaScript ↔ CLR Interop)
                             │
┌────────────────────────────▼────────────────────────────────────────┐
│                    CAPA 3: BRIDGE C# .NET                            │
│                    (C# .NET Framework 4.7.2)                         │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │  biometric-engine/bridge-csharp/src/Bridge/                 │    │
│  │  EdgeUruBridge.cs                                           │    │
│  │  • Interface entre Node.js y C#                            │    │
│  │  • Manejo de operaciones asíncronas (Task.Run)            │    │
│  │  • Emisión de eventos SSE                                  │    │
│  │  • Lenguaje: C# (.NET Framework 4.7.2)                    │    │
│  │                                                             │    │
│  │  Operaciones:                                               │    │
│  │  - "init"      → Inicializar SDK                          │    │
│  │  - "enroll"    → Llamar a Dp4500Service.Enroll3()        │    │
│  │  - "verify"    → Llamar a VerifyLiveAgainstReg()         │    │
│  │  - "identify"  → Llamar a IdentifyLive1N()               │    │
│  │  - "single"    → Llamar a SingleCapture()                │    │
│  └────────────────────────────────────────────────────────────┘    │
│                              │                                        │
│                              ↓                                        │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │  biometric-engine/bridge-csharp/src/Core/                   │    │
│  │  Dp4500Service.cs                                           │    │
│  │  • Lógica biométrica central                              │    │
│  │  • Algoritmos de enrolamiento, verificación e ID          │    │
│  │  • Gestión del lector DP4500                              │    │
│  │  • Lenguaje: C# (.NET Framework 4.7.2)                    │    │
│  └────────────────────────────────────────────────────────────┘    │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             │ DPUruNet API Calls
                             │ (Managed .NET Wrapper)
                             │
┌────────────────────────────▼────────────────────────────────────────┐
│                    CAPA 4: SDK DIGITALPERSONA                        │
│                       (DLLs Nativas C/C++)                           │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │  biometric-engine/bin-deps/                                 │    │
│  │  • DPUruNet.dll      → SDK .NET Wrapper                   │    │
│  │  • dpfpdd.dll        → Device Driver                       │    │
│  │  • dpfj.dll          → Feature Extraction & Matching       │    │
│  │  • Lenguaje: C/C++ (Nativo de Windows)                    │    │
│  │                                                             │    │
│  │  Funcionalidades:                                           │    │
│  │  - Comunicación USB con el lector                         │    │
│  │  - Captura de imagen de huella                            │    │
│  │  - Extracción de características (minutiae)               │    │
│  │  - Comparación de templates (matching)                    │    │
│  │  - Gestión de calidad de imagen                           │    │
│  └────────────────────────────────────────────────────────────┘    │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             │ USB Communication
                             │ (Protocolo propietario DP)
                             │
┌────────────────────────────▼────────────────────────────────────────┐
│                    CAPA 5: HARDWARE                                  │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │  DigitalPersona U.are.U 4500 (DP4500)                      │    │
│  │  • Sensor óptico de huellas dactilares                     │    │
│  │  • Resolución: 512 DPI                                     │    │
│  │  • Área de captura: 16mm x 18mm                           │    │
│  │  • Conexión: USB 2.0                                       │    │
│  │  • Tecnología: Hardware                                     │    │
│  └────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. FLUJO DETALLADO DE UNA OPERACIÓN (Ejemplo: Enrolamiento)

### Paso a paso con lenguajes y protocolos:

```
USUARIO PRESIONA "Enrolar"
    │
    ▼
[1] FRONTEND (JavaScript)
    • Archivo: electron/renderer/index.html
    • Lenguaje: JavaScript (ES6+)
    • Acción: enrollmentControl.startEnrollment('Usuario123')
    │
    ├─► BiometricAdapter.js
    │   • Lenguaje: JavaScript
    │   • Acción: adapter.apiCall('/api/enroll', { tag: 'Usuario123', maxSamples: 4 })
    │
    ▼
[2] HTTP REQUEST
    • Protocolo: HTTP POST
    • URL: http://localhost:8080/api/enroll
    • Content-Type: application/json
    • Body: { "tag": "Usuario123", "maxSamples": 4, "timeoutMs": 60000 }
    │
    ▼
[3] SERVIDOR NODE.JS (TypeScript)
    • Archivo: biometric-engine/node/server.ts
    • Lenguaje: TypeScript → JavaScript (Node.js)
    • Framework: Express.js
    │
    ├─► Endpoint handler: app.post('/api/enroll', async (req, res) => {...})
    │   • Extrae parámetros: tag, maxSamples, timeoutMs
    │   • Llama al bridge C#
    │
    ├─► edgeBridge.invoke({ op: 'enroll', tag, maxSamples, timeoutMs })
    │   • Edge.js: Puente JavaScript ↔ CLR
    │   • Tecnología: edge.js (invocación de código .NET desde Node.js)
    │
    ▼
[4] EDGE.JS BRIDGE
    • Biblioteca: edge.js
    • Función: Marshaling entre V8 (Node.js) y CLR (.NET)
    • Convierte: JSON (JS) → dynamic object (C#)
    │
    ▼
[5] C# BRIDGE (C# .NET Framework)
    • Archivo: bridge-csharp/src/Bridge/EdgeUruBridge.cs
    • Lenguaje: C# (.NET Framework 4.7.2)
    • Método: Invoke(dynamic input)
    │
    ├─► Switch case "enroll"
    │   • Lee: tag, maxSamples, timeoutMs
    │   • Valida que el lector esté inicializado
    │
    ├─► await Task.Run(() => _reader.Enroll3(...))
    │   • Ejecuta operación biométrica en thread separado
    │   • Razón: No bloquear el event loop de Node.js
    │
    ▼
[6] DP4500 SERVICE (C# .NET Framework)
    • Archivo: bridge-csharp/src/Core/Dp4500Service.cs
    • Lenguaje: C# (.NET Framework 4.7.2)
    • Método: Enroll3(tag, maxSamples, targetFarn, maxRetries)
    │
    ├─► BUCLE: Capturar 4 muestras
    │   │
    │   ├─► Para cada muestra (1/4, 2/4, 3/4, 4/4):
    │   │
    │   ├─► [6.1] SendEvent("CAPTURE_STARTED", "Coloque su dedo...")
    │   │   • Emisión de evento SSE al frontend
    │   │
    │   ├─► [6.2] Reader.CaptureFingerprint()
    │   │   • Llama a DPUruNet SDK
    │   │   • Espera detección de dedo
    │   │
    │   ├─► [6.3] Validar calidad de imagen
    │   │
    │   ├─► [6.4] Convertir a FMD (Feature Minutiae Data)
    │   │   • Extracción de características
    │   │
    │   ├─► [6.5] SendEvent("SAMPLE_COLLECTED", { current: 1, total: 4 })
    │   │
    │   └─► Repetir hasta tener 4 muestras
    │
    ├─► [6.6] Crear template de registro (DP_REGISTRATION)
    │   • Combina las 4 muestras en un template único
    │   • Formato: DP_REGISTRATION (mejor para verificación)
    │
    ├─► [6.7] Almacenar en memoria (Dictionary<string, Template>)
    │   • Key: "Usuario123"
    │   • Value: Template binario + metadata
    │
    ├─► [6.8] SendEvent("ENROLLMENT_COMPLETED", { userId: "Usuario123" })
    │
    ▼
[7] DPURUNET SDK (DLLs Nativas)
    • DLL: DPUruNet.dll
    • Lenguaje: C/C++ (Wrapper .NET sobre código nativo)
    • Clases principales:
    │
    ├─► Reader.CaptureFingerprint()
    │   • Llama a dpfpdd.dll (Device Driver)
    │   • Envía comandos USB al lector
    │
    ├─► FeatureExtraction.CreateFmd()
    │   • Llama a dpfj.dll (Feature Extraction)
    │   • Algoritmo de minutiae extraction
    │
    └─► Comparison.Compare()
        • Llama a dpfj.dll (Matching Engine)
        • Algoritmo de comparación de templates
    │
    ▼
[8] DEVICE DRIVER (dpfpdd.dll)
    • DLL: dpfpdd.dll
    • Lenguaje: C/C++ (Código nativo Windows)
    • Función: Comunicación USB con el hardware
    │
    ├─► Enviar comandos al sensor
    │   • Activar LED del lector
    │   • Solicitar captura de imagen
    │
    ├─► Recibir datos del sensor
    │   • Imagen RAW (512 DPI, escala de grises)
    │   • Tamaño típico: ~62KB por imagen
    │
    └─► Gestión de recursos USB
    │
    ▼
[9] HARDWARE DP4500
    • Dispositivo: DigitalPersona U.are.U 4500
    • Tecnología: Sensor óptico
    • Conexión: USB 2.0
    │
    ├─► Usuario coloca el dedo en el sensor
    │
    ├─► Sensor captura imagen (LED encendido)
    │   • Resolución: 512 DPI
    │   • Tiempo: ~500ms por captura
    │
    └─► Envía imagen RAW por USB
    │
    ▼
[10] RESPUESTA DE VUELTA (Camino inverso)
    │
    ├─► Hardware → dpfpdd.dll → DPUruNet.dll
    ├─► Dp4500Service.cs → EdgeUruBridge.cs
    ├─► Edge.js Bridge → Node.js server
    ├─► HTTP Response (JSON) → BiometricAdapter.js
    └─► Frontend (actualiza UI: "✅ Enrolamiento completado")
    │
    ▼
[11] EVENTOS EN TIEMPO REAL (Paralelo al flujo principal)
    │
    ├─► Durante el proceso, el C# emite eventos:
    │   • SendEvent("CAPTURE_STARTED", ...)
    │   • SendEvent("SAMPLE_COLLECTED", ...)
    │   • SendEvent("IMAGE_CAPTURED", ...)
    │
    ├─► SseBridge.ts recibe los eventos
    │   • Archivo: biometric-engine/node/sseBridge.ts
    │   • Lenguaje: TypeScript
    │
    ├─► SSE Stream (/events)
    │   • Protocolo: Server-Sent Events (HTTP)
    │   • Content-Type: text/event-stream
    │
    ├─► BiometricAdapter.js recibe eventos
    │   • EventSource API (JavaScript)
    │   • adapter.emit('SAMPLE_COLLECTED', data)
    │
    └─► Frontend actualiza UI en tiempo real
        • Barra de progreso: 1/4 → 2/4 → 3/4 → 4/4
        • Status bar: "Coloca el dedo..." → "Muestra 1/4 capturada"
```

---

## 3. TECNOLOGÍAS Y LENGUAJES POR CAPA

| Capa | Tecnología | Lenguaje | Protocolo/API |
|------|-----------|----------|---------------|
| **Frontend** | HTML5, CSS3, JavaScript | JavaScript (ES6+) | DOM API, Fetch API |
| **Adaptador** | BiometricAdapter | JavaScript | EventSource (SSE), Fetch |
| **Servidor** | Node.js, Express.js | TypeScript → JavaScript | HTTP REST, SSE |
| **Bridge** | Edge.js | JavaScript ↔ C# | V8 ↔ CLR Interop |
| **C# Bridge** | .NET Framework 4.7.2 | C# | Edge.js API |
| **Servicio Core** | .NET Framework 4.7.2 | C# | DPUruNet API |
| **SDK** | DPUruNet | C/C++ (Wrapper .NET) | Native DLL Calls |
| **Driver** | dpfpdd, dpfj | C/C++ | USB Protocol |
| **Hardware** | DP4500 | Hardware | USB 2.0 |

---

## 4. COMUNICACIÓN ENTRE CAPAS

### 4.1 Frontend ↔ Servidor Node.js

**Protocolo:** HTTP/HTTPS + Server-Sent Events (SSE)
**Puerto:** 8080
**Formato:** JSON

**Request Example:**
```http
POST http://localhost:8080/api/enroll
Content-Type: application/json

{
  "tag": "Usuario123",
  "maxSamples": 4,
  "timeoutMs": 60000
}
```

**Response Example:**
```json
{
  "ok": true,
  "template": "base64_encoded_template...",
  "userId": "Usuario123",
  "format": "DP_REGISTRATION"
}
```

**SSE Stream:**
```http
GET http://localhost:8080/events
Content-Type: text/event-stream

data: {"type":"SAMPLE_COLLECTED","payload":{"current":1,"total":4}}
```

### 4.2 Node.js ↔ C# Bridge

**Tecnología:** Edge.js
**Mecanismo:** Invocación directa de código .NET desde JavaScript

**JavaScript (Node.js):**
```javascript
const edgeBridge = edge.func('./path/to/EdgeBridge.dll');
const result = await edgeBridge({
  op: 'enroll',
  tag: 'Usuario123',
  maxSamples: 4
});
```

**C# (.NET):**
```csharp
public async Task<object> Invoke(dynamic input)
{
    string op = input.op;
    string tag = input.tag;
    int maxSamples = input.maxSamples;

    // ... lógica ...

    return new { ok = true, template = "..." };
}
```

### 4.3 C# ↔ DPUruNet SDK

**Lenguaje:** C# (Managed Code) → C/C++ (Native Code)
**Tecnología:** P/Invoke + Wrapper .NET

**C# Code:**
```csharp
using DPUruNet;

Reader reader = new Reader();
reader.Open();

FingerCaptureResult result = reader.CaptureFingerprint();
byte[] imageData = result.Data.Bytes;

Fmd fmd = FeatureExtraction.CreateFmd(imageData, Formats.DP_VERIFICATION);
```

### 4.4 SDK ↔ Hardware

**Protocolo:** USB 2.0
**Driver:** dpfpdd.dll
**Comandos:** Propietarios de DigitalPersona

**Flujo:**
1. SDK envía comando "Activate Sensor"
2. LED del lector se enciende
3. Usuario coloca dedo
4. Sensor captura imagen
5. Hardware envía imagen RAW (512 DPI)
6. SDK recibe y procesa imagen

---

## 5. ALMACENAMIENTO DE DATOS

### Durante ejecución (RAM):

**Ubicación:** C# Dictionary<string, Template>
**Archivo:** Dp4500Service.cs

**Estructura:**
```csharp
{
  "Usuario123_LEFT_THUMB": {
    "tag": "Usuario123_LEFT_THUMB",
    "fmd": byte[],
    "format": "DP_REGISTRATION",
    "createdAt": "2025-11-07T..."
  }
}
```

### Persistente (Opcional - No implementado actualmente):

Para implementar almacenamiento persistente:
- **SQLite** (Base de datos local)
- **SQL Server** (Base de datos empresarial)
- **Archivos JSON** (Templates en disco)

---

## 6. EVENTOS EN TIEMPO REAL (SSE)

### Flujo de eventos:

```
C# (Dp4500Service.cs)
    │
    ├─► SendEvent("ENROLLMENT_STARTED", "Iniciando enrolamiento")
    │
    ▼
EdgeUruBridge.cs
    │
    ├─► callback({ evt:"ENROLLMENT_STARTED", eventType, message, severity, origin, timestamp, data })
    │
    ▼
Node.js (server.ts)
    │
    ├─► Edge.js callback recibe el evento
    ├─► SseBridge.emit(event)
    │
    ▼
SSE Stream (/events)
    │
    ├─► Envía a todos los clientes conectados
    │   Content-Type: text/event-stream
    │   data: {"evt":"ENROLLMENT_STARTED","eventType":"ENROLLMENT_STARTED","message":"...","severity":"INFO","origin":"dp4500","timestamp":"...","data":{...},"serverTimestamp":"..."}
    │
    ▼
BiometricAdapter.js (Frontend)
    │
    ├─► EventSource.onmessage = (event) => {...}
    ├─► adapter.emit('ENROLLMENT_STARTED', data)
    │
    ▼
Frontend Components
    │
    └─► enrollmentControl.on('ENROLLMENT_STARTED', () => {
           // Actualizar UI
        })
```

**Eventos principales del sistema:**

| Evento | Descripción | Origen | Destino |
|--------|-------------|--------|---------|
| `READER_READY` | Lector inicializado | C# Bridge | Frontend |
| `READER_DISPOSED` | Lector apagado | C# Bridge | Frontend |
| `CAPTURE_STARTED` | Solicita colocar el dedo | Dp4500Service | Frontend |
| `SAMPLE_COLLECTED` | Muestra capturada (1/4, 2/4...) | Dp4500Service | Frontend |
| `IMAGE_CAPTURED` | Imagen de huella disponible | Dp4500Service | Frontend |
| `ENROLLMENT_STARTED` | Inicio de enrolamiento | Dp4500Service | Frontend |
| `ENROLLMENT_COMPLETED` | Enrolamiento exitoso | Dp4500Service | Frontend |
| `VERIFICATION_SUCCESS` | Verificación exitosa | Dp4500Service | Frontend |
| `VERIFICATION_FAILED` | Verificación fallida | Dp4500Service | Frontend |
| `IDENTIFICATION_MATCH` | Usuario identificado | Dp4500Service | Frontend |
| `IDENTIFICATION_NO_MATCH` | No se encontró coincidencia | Dp4500Service | Frontend |

> **Contrato completo de eventos** (catálogo de ~60 eventos, hook edge-js mono-suscriptor y suscripción SSE):
> ver **[CONTRATO-EVENTOS-MOTOR-BIOMETRICO.md](./CONTRATO-EVENTOS-MOTOR-BIOMETRICO.md)**.

---

## 7. RESUMEN DE LENGUAJES Y TECNOLOGÍAS

### Lenguajes utilizados:

1. **HTML5** - Estructura de la interfaz
2. **CSS3** - Estilos visuales
3. **JavaScript (ES6+)** - Lógica del frontend y adaptador
4. **TypeScript** - Servidor Node.js (compilado a JavaScript)
5. **C# (.NET Framework 4.7.2)** - Bridge y lógica biométrica
6. **C/C++** - SDK nativo y drivers

### Frameworks y Bibliotecas:

1. **ElectronJS** - Framework de aplicación desktop
2. **Express.js** - Servidor HTTP en Node.js
3. **Edge.js** - Bridge JavaScript ↔ .NET
4. **DPUruNet** - SDK de DigitalPersona

### Protocolos de comunicación:

1. **HTTP/HTTPS** - Comunicación REST
2. **Server-Sent Events (SSE)** - Eventos en tiempo real
3. **USB 2.0** - Comunicación con hardware

### Formatos de Datos:

1. **JSON** - Intercambio de datos entre capas
2. **Base64** - Codificación de templates e imágenes
3. **Binario** - Templates FMD y datos del sensor

---

## 8. FLUJO SIMPLIFICADO POR OPERACIÓN

### 8.1 Inicializar Lector

```
Frontend: Click "Encender Lector"
    ↓
POST /api/init
    ↓
C# Bridge: Initialize Reader
    ↓
DPUruNet SDK: Open Device
    ↓
Hardware: LED encendido
    ↓
Evento: READER_READY
    ↓
Frontend: Status "✅ Lector listo"
```

### 8.2 Captura Simple

```
Frontend: Click "Capturar"
    ↓
POST /api/single
    ↓
C# Bridge: SingleCapture()
    ↓
DPUruNet: CaptureFingerprint()
    ↓
Hardware: Captura imagen
    ↓
DPUruNet: CreateFmd()
    ↓
Respuesta: { pngB64, fmdXml }
    ↓
Frontend: Muestra imagen
```

### 8.3 Enrolamiento (4 muestras)

```
Frontend: Click "Iniciar Enrolamiento"
    ↓
POST /api/enroll
    ↓
C# Bridge: Enroll3()
    ↓
BUCLE 4 veces:
    ├─► Evento: CAPTURE_STARTED
    ├─► Capturar imagen
    ├─► Validar calidad
    ├─► Convertir a FMD
    ├─► Evento: SAMPLE_COLLECTED (1/4, 2/4, 3/4, 4/4)
    └─► Repetir
    ↓
Crear template DP_REGISTRATION
    ↓
Almacenar en RAM
    ↓
Evento: ENROLLMENT_COMPLETED
    ↓
Frontend: Status "✅ Enrolado"
```

### 8.4 Verificación 1:1

```
Frontend: Selecciona usuario + Click "Verificar"
    ↓
POST /api/verify { tag: "Usuario123" }
    ↓
C# Bridge: VerifyLiveAgainstReg()
    ↓
Capturar huella nueva
    ↓
Obtener template guardado de "Usuario123"
    ↓
DPUruNet: Comparison.Compare(live, stored)
    ↓
Score: 0-100
    ↓
If score >= threshold:
    Evento: VERIFICATION_SUCCESS
Else:
    Evento: VERIFICATION_FAILED
    ↓
Frontend: Muestra resultado
```

### 8.5 Identificación 1:N

```
Frontend: Click "Identificar 1:N"
    ↓
POST /api/identify
    ↓
C# Bridge: IdentifyLive1N()
    ↓
Capturar huella nueva
    ↓
BUCLE: Para cada template en galería
    ├─► Comparison.Compare(live, template)
    ├─► Calcular score
    └─► Guardar si score >= threshold
    ↓
Ordenar por score (mayor a menor)
    ↓
If hay coincidencia:
    Evento: IDENTIFICATION_MATCH { user, score }
Else:
    Evento: IDENTIFICATION_NO_MATCH
    ↓
Frontend: Muestra usuario identificado
```

---

## 9. DEPENDENCIAS DEL PROYECTO

### Frontend (Electron):
```json
{
  "electron": "^31.3.1",
  "typescript": "^5.6.2",
  "@types/node": "^20.14.12"
}
```

### Servidor Node.js (biometric-engine/node):
```json
{
  "express": "^4.x.x",
  "edge-js": "^x.x.x",
  "typescript": "^5.x.x"
}
```

### Bridge C# (biometric-engine/bridge-csharp):
```xml
<PackageReference Include="EdgeJs" Version="..." />
<Reference Include="DPUruNet" />
```

### DLLs Nativas (biometric-engine/bin-deps):
- `DPUruNet.dll` - SDK .NET Wrapper
- `dpfpdd.dll` - Device Driver
- `dpfj.dll` - Feature Extraction & Matching
- `DPCtlUruNet.dll` - Control adicional

---

## 10. VENTAJAS DE ESTA ARQUITECTURA

### ✅ Separación de responsabilidades:
- Frontend solo maneja UI
- Node.js maneja HTTP y eventos
- C# maneja lógica biométrica
- SDK maneja hardware

### ✅ Escalabilidad:
- Se puede agregar base de datos sin modificar frontend
- Se puede cambiar hardware sin modificar Node.js
- Se pueden agregar más operaciones biométricas fácilmente

### ✅ Mantenibilidad:
- Cada capa en su lenguaje óptimo
- JavaScript para UI interactiva
- TypeScript para servidor robusto
- C# para operaciones biométricas complejas

### ✅ Eventos en tiempo real:
- Feedback inmediato al usuario
- Progreso visual del enrolamiento
- No necesita polling

---

## 11. POSIBLES MEJORAS FUTURAS

1. **Agregar base de datos persistente:**
   - SQLite para templates
   - SQL Server para empresas

2. **Sistema de caché:**
   - Redis para templates más usados
   - Mejora velocidad de identificación

3. **API REST pública:**
   - Autenticación con JWT
   - Integración con otros sistemas

4. **Soporte multi-lector:**
   - Varios DP4500 simultáneos
   - Load balancing

5. **Machine Learning:**
   - Mejora en matching
   - Detección de intentos fraudulentos

---

**Fecha de creación:** 2025-11-07
**Versión del sistema:** 1.0
**Autor:** Sistema Biométrico ElectronJS + Edge-URU-UI
