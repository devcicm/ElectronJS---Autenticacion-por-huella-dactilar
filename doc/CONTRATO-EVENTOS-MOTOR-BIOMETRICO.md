# Contrato de eventos del motor biométrico (hook de captura y validación)

- Fecha: 2026-10-05
- Alcance: `biometric-engine/` (bridge C# `EdgeUruBridge`/`Dp4500Service`, servidor Node `server.ts`/`sseBridge.ts`) y los consumidores (`sistema-asistencia/`, demo del engine).
- Objetivo: documentar **cómo** el motor notifica la **captura** y **validación** de huellas a los consumidores/suscriptores, con el catálogo de eventos derivado del código (fuente de verdad).

> **TL;DR** — Sí, hay *hook*. En C# son **eventos .NET** (`Dp4500Service`) reenviados por **un callback** de edge-js (`EdgeUruBridge.SendEvent`); el fan-out a **múltiples** consumidores lo hace Node vía **SSE** en `GET /events` (`SseBridge`). El callback es **mono-suscriptor** a nivel bridge; los múltiples suscriptores se resuelven en la capa SSE.

---

## 1. Arquitectura de notificación (3 capas)

```
DigitalPersona SDK
   │  Reader.On_Captured  (callback del SDK)
   ▼
[CAPA 1] Dp4500Service.cs ── eventos .NET (Action<...>)
   │  OnFingerTouched / OnFingerprintReady / OnCaptureReady /
   │  OnSampleCountChanged / OnAttemptResult / OnImageCaptured / OnStatus
   ▼
[CAPA 2] EdgeUruBridge.cs ── hook edge-js (mono-suscriptor)
   │  registerCallback + SendEvent(envelope)
   ▼
[CAPA 3] server.ts + sseBridge.ts ── fan-out SSE
   │  SseBridge.emit → GET /events (text/event-stream)
   ▼
Consumidores: FingerprintEnroller.js (renderer), TouchModeService.ts (main), BiometricAdapter.js (demo)
```

---

## 2. Capa 1 — Eventos .NET (`Dp4500Service.cs`)

`Dp4500Service` se suscribe al callback del SDK en `Init()`:

```csharp
// Dp4500Service.cs:585
if (!_subscribed) { Reader.On_Captured += OnCaptured; _subscribed = true; }
```

Y expone estos eventos (`Dp4500Service.cs:552-579`):

| Evento | Firma | Significado |
|---|---|---|
| `OnFingerTouched` | `Action<Fid>` | dedo detectado y **captura válida** (`:617-620`) |
| `OnFingerprintReady` | `Action<Fmd>` | FMD (plantilla) listo para comparación (`:631-637`) |
| `OnCaptureReady` | `Action` | lector listo para la siguiente captura (`:712`) |
| `OnSampleCountChanged` | `Action<int>` | progreso de enrolamiento (1/4, 2/4…) (`:577`) |
| `OnAttemptResult` | `Action<int,bool,string?>` | resultado de intento de **validación** (nº, éxito, motivo) (`:1140-1196`) |
| `OnImageCaptured` | `Action<string>` | imagen de huella (base64 PNG) (`:909,1018,1071,1153`) |
| `OnStatus` | `Action<string>` | mensajes de estado internos |

`OnCaptured` (`:594-663`) corre en el **callback del SDK**; en modo continuo valida la captura (`IsGoodCapture`), dispara `OnFingerTouched` y `OnFingerprintReady`, y **rearma** la captura en un **thread separado** (`ThreadPool.QueueUserWorkItem`) para no bloquear el SDK.

---

## 3. Capa 2 — Hook edge-js (`EdgeUruBridge.cs`)

El bridge expone `Invoke(op)` y usa **un único callback** JS para emitir eventos.

### Registro del callback (hook)

```csharp
// EdgeUruBridge.cs:155-160
case "registerCallback":
    _callback = (Func<object, Task<object>>)input.callback;
    Console.WriteLine("[BRIDGE] Callback registered");
    return new { ok = true, message = "Callback registered" };
```

```js
// server.ts:451-459
await call({
  op: "registerCallback",
  callback: async (eventData) => { sseBridge.emit(eventData); return null; }
});
```

### Emisión (`SendEvent`)

```csharp
// EdgeUruBridge.cs:92-129 (resumen)
private static void SendEvent(string eventType, string message,
                              string severity = "INFO", object? data = null)
{
    if (_callback == null) { Console.WriteLine($"[EVENT SKIP] Callback not registered: {eventType}"); return; }
    var eventData = new Dictionary<string, object> {
        ["evt"] = eventType, ["eventType"] = eventType,
        ["message"] = message, ["severity"] = severity,
        ["timestamp"] = DateTime.UtcNow.ToString("O"), ["origin"] = "dp4500"
    };
    if (data != null) eventData["data"] = data;
    Task.Run(async () => { await _callback(eventData); }); // no bloquea edge-js
}
```

**Características del hook:**
- **Mono-suscriptor**: `_callback` es una sola función; registrar de nuevo la reemplaza.
- **Asíncrono**: se invoca en `Task.Run` para no bloquear el puente.
- **Sin suscriptor → se descarta** con log `[EVENT SKIP]` (`:94-98`).
- El bridge **traduce** los eventos .NET a eventos de dominio de granularidad fina (§6). Ej. `OnSampleCountChanged` → `SAMPLE_COLLECTED`; `OnAttemptResult` → **solo intentos fallidos** → `CAPTURE_FAILED` (`:183-191`); `OnImageCaptured` → `IMAGE_CAPTURED`.

---

## 4. Capa 3 — Fan-out SSE (`sseBridge.ts` + `server.ts`)

`SseBridge` mantiene un mapa de clientes y reenvía cada evento a **todos**:

```ts
// sseBridge.ts:56-99 (resumen)
emit(event, metadata = {}) {
  // aplica processors (ensureEventType, attachServerTimestamp, derivados)
  for (const finalEvent of events) {
    const payload = `data: ${JSON.stringify(finalEvent)}\n\n`;
    for (const { res } of this.clients.values()) { res.write(payload); res.flush?.(); }
  }
}
```

Endpoint:

```ts
// server.ts:132-137
app.get("/events", (req, res) => {
  const detach = sseBridge.attachClient(res);
  req.on("close", detach);
  req.on("error", detach);
});
```

`attachClient` fija `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, hace `flushHeaders()` y envía un evento de bienvenida `hello` (`sseBridge.ts:27-50`).

**Procesadores por defecto** (`sseBridge.ts:23-24`):
- `ensureEventType`: si falta `eventType`, lo copia desde `evt`.
- `attachServerTimestamp`: añade `serverTimestamp` (ISO) si no existe.

**Procesador de dominio** (`server.ts:66-130`): deriva eventos (ver §6 "Derivados"). Requiere cambiar los nombres de eventos en un solo lugar (`server.ts`), no en C#.

---

## 5. Contrato de suscripción (consumidores)

1. El suscriptor abre `GET http://<host>:<port>/events` con `EventSource` (header `Accept` implícito de SSE).
2. Recibe `data: <json>\n\n` por cada evento; parsea el JSON.
3. Al desconectar, cierra el `EventSource` (`req.on("close")` libera el cliente en el servidor).

**Consumidores actuales:**

| Consumidor | Ruta | Suscripción |
|---|---|---|
| Renderer de la app | `sistema-asistencia/renderer/js/controls/FingerprintEnroller.js:28` | `new EventSource('http://localhost:${cfg.biometricPort}/events')` (`onmessage` `:34`) |
| Main process de la app | `sistema-asistencia/services/TouchModeService.ts:286` | `new EventSource(`${BIOMETRIC_SERVER}/events`)` (`onmessage` `:288`) |
| Demo del engine | `biometric-engine/node/public/js/adapter/BiometricAdapter.js` | `EventSource('/events')` |

> El puerto por defecto es `8080` (`BIOMETRIC_PORT`), host `127.0.0.1` (`BIOMETRIC_HOST`). Con host no-loopback se exige `X-Api-Token` (`server.ts:35-54`) — **pero el token solo aplica a rutas HTTP; `/events` como EventSource no envía header personalizado**, por lo que la exposición remota de SSE queda fuera del guard actual. Ver gotchas §8.

---

## 6. Catálogo de eventos

Envelope común (C# → SSE): `{ evt, eventType, message, severity, origin:"dp4500", timestamp, data?, serverTimestamp? }`.
`severity` ∈ `INFO | SUCCESS | WARNING | ERROR` (default `INFO`).

### 6.1 Sistema / lector
| `eventType` | severity | `data` | Cuándo |
|---|---|---|---|
| `SYSTEM_STATUS` | SUCCESS | — | bootstrap OK (`EdgeUruBridge.cs:145`) |
| `SYSTEM_ERROR` | ERROR | — | error de bootstrap/op (`:150,212,222,…`) |
| `READER_READY` | SUCCESS | `{model,status}` | lector inicializado (`:205`) |
| `READER_DISPOSED` | INFO | — | lector liberado (`:991`) |
| `READER_INFO_RETRIEVED` | INFO | — | info obtenida (`:1050`) |
| `READER_CONNECTED` | SUCCESS/INFO | `{model,status}` | Plug & Play: Lector USB conectado o servicio iniciado |
| `READER_DISCONNECTED` | WARNING/ERROR | `{reason}` | Plug & Play: Lector USB desconectado físicamente |
| `STORE_CLEARED` | INFO | — | almacén RAM limpiado (`:908`) |
| `STORE_STATS_RETRIEVED` | INFO | — | stats del almacén (`:1065`) |
| `TEMPLATE_LOADED` | SUCCESS | `{userId,hand,finger,tag}` | plantilla cargada (`:964`) |

### 6.2 Captura
| `eventType` | severity | `data` | Cuándo |
|---|---|---|---|
| `CAPTURE_STARTED` | INFO | `{attemptNumber,totalAttempts}?` | pide colocar el dedo (`:228,297,393,495`) |
| `IMAGE_CAPTURED` | SUCCESS/INFO | `{imageBase64,imageSize?}` | imagen disponible (`:198,257,403,505,1106`) |
| `CAPTURE_COMPLETED` | SUCCESS | `{imageBase64,templateBase64}` | captura simple completada (`:261`) |
| `CAPTURE_FAILED` | WARNING/ERROR | `{attemptNumber,reason}?` | intento fallido / excepción (`:188,275`) |
| `SAMPLE_COLLECTED` | SUCCESS | `{sampleNumber,totalSamples,progress}` | muestra de enrolamiento recolectada (`:179`) |

### 6.3 Enrolamiento (una huella)
| `eventType` | severity | `data` | Cuándo |
|---|---|---|---|
| `ENROLLMENT_STARTED` | INFO | `{userId}` | inicio (`:295`) |
| `USER_ENROLLED` | SUCCESS | `{userId}` | usuario enrolado (`:326`) |
| `ENROLLMENT_COMPLETED` | SUCCESS | `{userId,imageBase64,templateBase64}` | fin exitoso (`:332`) |
| `ENROLLMENT_FAILED` | ERROR | — | fallo (`:337,352`) |

### 6.4 Enrolamiento de 10 dedos
| `eventType` | severity | `data` | Cuándo |
|---|---|---|---|
| `ALL_FINGERS_ENROLLMENT_STARTED` | INFO | `{userId,totalFingers}` | inicio (`:671`) |
| `HAND_ENROLLMENT_STARTED` | INFO | `{hand,handLabel}` | inicio de mano (`:719`) |
| `FINGER_ENROLLMENT_STARTED` | INFO | `{hand,finger,fingerLabel,progress}` | inicio de dedo (`:729`) |
| `FINGER_ENROLLMENT_COMPLETED` | SUCCESS | `{hand,finger,tag,progress,success}` | dedo OK (`:793`) |
| `FINGER_ENROLLMENT_FAILED` | ERROR | `{hand,finger,tag,error,order,progress}` | dedo falló (`:813,834`) |
| `HAND_ENROLLMENT_COMPLETED` | INFO | `{hand,handLabel}` | mano procesada (`:844`) |
| `ALL_FINGERS_ENROLLMENT_COMPLETED` | SUCCESS | `{userId,totalFingers,successCount}` | 10/10 (`:853`) |
| `ALL_FINGERS_ENROLLMENT_PARTIAL` | WARNING | `{userId,totalFingers,successCount,failedCount}` | parcial (`:858`) |
| `ALL_FINGERS_ENROLLMENT_FAILED` | ERROR | `{userId,totalFingers,successCount,failedCount}` | 0/10 (`:863`) |

### 6.5 Verificación 1:1
| `eventType` | severity | `data` | Cuándo |
|---|---|---|---|
| `VERIFICATION_STARTED` | INFO | `{userId,maxAttempts}` | inicio (`:376`) |
| `VERIFICATION_ATTEMPT` | INFO | `{attemptNumber,totalAttempts,progress,verified,score}` | intento completado (`:410`) |
| `VERIFICATION_SUCCESS` | SUCCESS | `{userId,score,threshold,attempt,totalAttempts,parsedTag}` | coincidencia (`:418`) |
| `VERIFICATION_RETRY` | WARNING | `{attemptNumber,totalAttempts,score,threshold}` | reintento (`:439`) |
| `VERIFICATION_FAILED` | ERROR | `{userId,attempts}` | agotó intentos (`:446,463`) |

### 6.6 Identificación 1:N
| `eventType` | severity | `data` | Cuándo |
|---|---|---|---|
| `IDENTIFICATION_STARTED` | INFO | `{gallerySize,maxAttempts}` | inicio (`:484`) |
| `IDENTIFICATION_ATTEMPT` | INFO | `{attemptNumber,totalAttempts,progress,matched,bestScore}` | intento completado (`:510`) |
| `IDENTIFICATION_MATCH` | SUCCESS | `{userId,score,gallerySize,attempt,totalAttempts,parsedTag}` | match (`:518`) |
| `IDENTIFICATION_RETRY` | WARNING | `{attemptNumber,totalAttempts,bestScore,threshold}` | reintento (`:540`) |
| `IDENTIFICATION_NO_MATCH` | ERROR | `{attempts,threshold,gallerySize}` | sin match (`:547,566`) |

### 6.7 Touch mode / identificación por toque
| `eventType` | severity | `data` | Cuándo |
|---|---|---|---|
| `TOUCH_MODE_STARTED` | SUCCESS | `{mode,eventsAvailable}` | modo continuo activado (`:1134`) |
| `TOUCH_MODE_STOPPED` | INFO | `{mode,timestamp}` | desactivado (`:1174`) |
| `FINGER_TOUCHED` | INFO | `{width,height,timestamp}` | dedo detectado en modo continuo (`:1095`) |
| `FINGERPRINT_READY` | SUCCESS | `{fmdSize,format:"ANSI",timestamp}` | FMD listo (`:1117`) |
| `CAPTURE_READY` | INFO | `{timestamp}` | listo para próxima captura (`:1127`) |
| `TOUCH_IDENTIFICATION_STARTED` | INFO | `{gallerySize}` | identifica la última huella (`:593`) |
| `TOUCH_IDENTIFICATION_MATCH` | SUCCESS | `{userId,score,gallerySize,parsedTag}` | match (`:622`) |
| `TOUCH_IDENTIFICATION_NO_MATCH` | WARNING | `{bestScore,threshold,gallerySize}` | sin match (`:637`) |

### 6.8 Derivados (en `server.ts:66-130`, no en C#)
| `eventType` | Origen | Notas |
|---|---|---|
| `ENROLLMENT_SAMPLE_SUCCESS` / `ENROLLMENT_SAMPLE_STATUS` | derivado de `ENROLLMENT_SAMPLE_COLLECTED` | **Procesador legado**: el bridge emite `SAMPLE_COLLECTED`, no `ENROLLMENT_SAMPLE_COLLECTED`, por lo que hoy no se dispara. |
| `SYSTEM_ATTEMPT_STATUS` | parseo de `SYSTEM_STATUS` | extrae `attempt`/`sampleNumber`/`totalSamples` vía regex (`Intento N`, `muestra N/M`). |

### 6.9 Evento de bienvenida (SSE, solo servidor)
| `evt` | Cuándo |
|---|---|
| `hello` | al conectar un cliente SSE; `data: {"evt":"hello","clientId":N}` (`sseBridge.ts:41`) |

---

## 7. Wire format (SSE)

```
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive

data: {"evt":"hello","clientId":1}

data: {"eventType":"READER_READY","evt":"READER_READY","message":"...","severity":"SUCCESS","origin":"dp4500","timestamp":"2026-...Z","data":{"model":"DP4500","status":"READY"},"serverTimestamp":"2026-...Z"}

```

- Cada línea de datos: `data: <json>` + `\n\n`.
- `res.flush?.()` tras cada escritura para tiempo real (`sseBridge.ts:93-96`).
- El cliente `EventSource` expone cada bloque en `onmessage` (sin `event:`/`id:`/`retry:` explícitos).

---

## 8. Notas de diseño y gotchas

- **Validación exitosa vs intentos fallidos**: `OnAttemptResult` solo se reenvía cuando `success == false` (`EdgeUruBridge.cs:183-191`). El **éxito** se comunica por el evento de operación (`VERIFICATION_SUCCESS`, `IDENTIFICATION_MATCH`, `ENROLLMENT_*_COMPLETED`), no por `OnAttemptResult`.
- **Mono-suscriptor en C#**: no hay pub/sub en el bridge; un solo `registerCallback`. El fan-out multi-cliente es de `SseBridge`.
- **Eventos grandes**: `IMAGE_CAPTURED`/`*_COMPLETED` incluyen `imageBase64` (y a veces `templateBase64`) — payload pesado por SSE.
- **Hilos**: los eventos se emiten en `Task.Run` (C#) y en `ThreadPool` (rearme), desacoplados del callback del SDK.
- **`addEventListener('NOMBRE', …)` no funciona**: el servidor **no** emite líneas `event:`, solo `data: <json>`. Los ejemplos de docs previos que usan `eventSource.addEventListener('FINGER_TOUCHED', …)` nunca disparan; el patrón correcto es `eventSource.onmessage = (e) => { const ev = JSON.parse(e.data); switch (ev.eventType) {…} }` (como hace `FingerprintEnroller.js`).
- **Seguridad del stream**: `GET /events` no envía header `X-Api-Token` desde `EventSource`; si `BIOMETRIC_HOST` no es loopback, el guard de token **no cubre** SSE. Mantener `127.0.0.1` por defecto.
- **Nombres**: `SendEvent` usa nombres en MAYÚSCULAS con guion bajo; los procesadores en `server.ts` deben usar `eventType` (o `evt`) tal cual.
- **FSM y Eventos Controlados vs No Controlados**: La máquina de estados (`TouchModeService.ts` / `app.js`) distingue eventos controlados (como `STOP` manual por el usuario que retorna a `IDLE`) de cortes no controlados (como desconexión súbita del cable USB `READER_DISCONNECTED` o caída del servicio `500/ECONNREFUSED` que transicionan a `ERROR` y notifican visualmente en la UI).

---

## 9. Correcciones a documentación previa

| Doc | Decía | Correcto |
|---|---|---|
| `doc/TOUCH-MODE-CAPTURA-CONTINUA.md:239` | `app.get('/api/events', ...)` | `GET /events` (`server.ts:132`) |
| `doc/DIAGRAMAS-FLUJO-TOUCH-MODE.md:197` | `EventSource('http://localhost:8080/api/events')` | `.../events` |
| `doc/DIAGRAMA_FLUJO_SISTEMA.md:464,282` | `SseBridge.broadcast(event)` | `SseBridge.emit(event)` (`sseBridge.ts:56`) |
| `doc/DIAGRAMA_FLUJO_SISTEMA.md:471,458` | payload `{type, payload}` | `{evt,eventType,message,severity,origin,timestamp,data?}` |
| `doc/DIAGRAMA_FLUJO_SISTEMA.md:493` | evento `SAMPLE_REQUEST` | no existe; se emite `SAMPLE_COLLECTED`/`CAPTURE_STARTED` |
| `doc/TOUCH-MODE-CAPTURA-CONTINUA.md:237-264` | pseudo `emitSSE`/`sseClients[]` | clase `SseBridge` (Map de clientes, processors, flush) |

---

## 10. Referencias de código

- `biometric-engine/bridge-csharp/src/Core/Dp4500Service.cs:552-579,585,594-663`
- `biometric-engine/bridge-csharp/src/Bridge/EdgeUruBridge.cs:92-129,155-160,177-201,1093-1137`
- `biometric-engine/node/server.ts:62-137,449-468`
- `biometric-engine/node/sseBridge.ts:16-123`
- `sistema-asistencia/renderer/js/controls/FingerprintEnroller.js:28,34`
- `sistema-asistencia/services/TouchModeService.ts:286,288`
