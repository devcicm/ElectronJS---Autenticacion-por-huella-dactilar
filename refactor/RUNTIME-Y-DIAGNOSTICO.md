# Runtime y diagnóstico — por qué la UI de Electron no respondía y el lector de huellas sí

- Fecha: 2026-10-05
- Rama: `refactor/teseo-fase1`
- Alcance: fase de **estabilización runtime** posterior a las pasadas de refactor puro (Vía A/B) y hardening (H/N/X/Tier A+B+C).
- Documentos relacionados: `CHANGELOG-REFACTOR.md`, `REPORTE-REFACTOR.md`, `AUDITORIA.md`, `PLAN-REFACTOR.md`.

> Este documento explica la **naturaleza** del fallo que dejaba el *aside* sin navegar en
> Electron, **por qué** el servicio de lector de huellas funciona correctamente, y **cómo** se
> diagnosticó. Incluye el mapa antes→después de cada parche y un checklist de smoke runtime.

---

## 1. Síntoma

- La app empaquetada/desarrollada en Electron arrancaba, el **motor biométrico** (Node/Express +
  SSE, puerto `8080`) arrancaba, pero **el *aside* no navegaba**: hacer clic en los ítems del menú
  lateral no cambiaba la sección visible.
- El **mismo renderer**, servido por el **lab** standalone (`lab-http-host.mjs`, `http://localhost:9090`),
  **sí funciona**: la navegación y las vistas responden.
- Discrepancia clave a explicar: *mismo código, dos hosts (`file://` vs `http://`), comportamiento distinto*.

---

## 2. Cadena de causas (tres fallos independientes que se acumularon)

Los tres son de **carga/arranque**, no de lógica de negocio. Se detectaron y corrigieron en este orden:

### F1 — `require()` en proyecto ESM (`main.ts`) · fix `1d6c28f`
- El `package.json` raíz declara `"type": "module"` → todos los `.js` del proyecto son **ESM**; en
  runtime **no existe `require`**.
- `electron/main.ts` usaba `require('node:fs')` / `require('node:os')` → al arrancar lanzaba
  `ReferenceError: require is not defined` → `initIpcHandlers()` **nunca se ejecutaba**.
- Consecuencia: sin handlers IPC, el renderer no recibía datos ni podía disparar acciones.
- **Fix**: convertir a `import fs from 'node:fs'` / `import os from 'node:os'` (imports ESM).
  Ver evidencia: `main.ts:1-8` (imports ESM), `main.ts:10-11` (`__filename`/`__dirname` derivados de `import.meta.url`).

### F2 — `electron/preload.ts` excluido de compilación · fix `b51cee5` + consolidado en `e2ee258`
- `tsconfig.json` (root) listaba `electron/preload.ts` en `exclude`. El preload es **necesario**:
  `contextBridge` es lo único que expone `window.attendance / biometric / touchMode / biometricServer`.
- Resultado del exclude: `dist/preload.js` **no se generaba** (o quedaba vacío) → el renderer veía
  esas APIs como `undefined` → `TypeError` al invocarlas.
- El preload tiene su **propio** `tsconfig.preload.json` (`module: CommonJS`, `rootDir: ./electron`,
  `outDir: ./dist`) → el artefacto correcto es `dist/preload.js`, y `main.ts:28` lo carga con
  `path.join(__dirname, '../preload.js')` (donde `__dirname` = `dist/electron`).
- **Fix**: quitar `electron/preload.ts` del `exclude` (para que su build dedicado se ejecute) y
  revertir el preload a `const { contextBridge, ipcRenderer } = require('electron')` (idiomático para
  su tsconfig CommonJS). Se eliminó también el duplicado espurio `dist/electron/preload.js` que había
  dejado un cambio previo de tsconfig.

### F3 — Renderer convertido a **ES modules** (A.7a) incompatible con `file://` · fix `e2ee258`
- El paso **A.7a** (`5ef1b04`) convirtió el renderer a ES modules: `<script type="module" src="app.js">`
  + `import { FingerprintEnroller } from './js/controls/FingerprintEnroller.js'` + `import { logger } …` etc.
- En Electron, `main.ts:35` carga la UI con `mainWindow.loadFile(…/index.html)` → el documento tiene
  origen **`file://`** (origen **opaco / `null`**).
- Los **module scripts** se solicitan siempre en **modo CORS**. Chromium **bloquea** los *module
  imports* desde un origen opaco → **el grafo de `app.js` nunca se evalúa**.
- Consecuencia: `DOMContentLoaded` dispara, pero el callback `setupNavigation()` (definido dentro de
  `app.js`) nunca se registra → **ningún listener** sobre los 8 `.nav-item` → el *aside* “no se desplaza”.
- **Fix `e2ee258`**: revertir el renderer a **scripts clásicos** sin perder el hardening:
  - `js/logger.js`, `js/escape-html.js`, `js/sanitize.js` → IIFE que publican `window.logger`,
    `window.escapeHtml`, `window.sanitizeText/Phone/Email`.
  - `js/controls/FingerprintEnroller.js` → sin `import`/`export`; `window.FingerprintEnroller = new FingerprintEnroller()`.
  - `app.js` → sin imports; consume los globales previos.
  - `index.html` → `<script src>` clásicos **en orden de dependencia**:
    `logger.js → escape-html.js → sanitize.js → controls/FingerprintEnroller.js → app.js`.

---

## 3. Naturaleza: por qué ES modules fallan en `file://` y los scripts clásicos no

| Aspecto | `<script type="module">` (A.7a) | `<script src>` clásico (fix) |
|---|---|---|
| Fetch | **siempre en modo CORS** | modo clásico (no-CORS) |
| Origen `file://` | opaco/`null` → **bloqueado** por CORS | permitido dentro del mismo árbol `file://` |
| Resolución | `import` por URL de módulo, con chequeos de origen | ejecución directa en scope global |
| Resultado | grafo no evaluado → `app.js` muerto | `app.js` se evalúa → `setupNavigation()` activo |

Configuración relevante de la ventana (`electron/main.ts:27-31`) — **no** hay `webSecurity: false`:

```ts
webPreferences: {
  preload: path.join(__dirname, '../preload.js'),
  nodeIntegration: false,
  contextIsolation: true,
}
```

Es decir, con `webSecurity` por defecto (activo) y `contextIsolation: true`, el único puente válido
es `preload` + `contextBridge`, y el renderer **debe** cargarse como scripts clásicos bajo `file://`.

**Regla derivada**: en este proyecto el renderer de Electron **no usa ES modules**. El hardening
(logger, escapeHtml, sanitize, observabilidad) se preserva mediante IIFEs que exponen `window.*` y
`<script src>` clásicos ordenados. (El demo del engine puede seguir con clásicos por la misma razón.)

---

## 4. Por qué el servicio de lector de huellas funciona bien

El motor biométrico es **independiente** del problema de módulos del renderer:

- **Engine**: `biometric-engine/node` es un child process **CommonJS** (su `package.json` no declara
  `"type"`, por lo que `require` es válido ahí). Se lanza desde `main.ts` y sirve HTTP + SSE en
  `http://localhost:8080`.
- **Bridge C# (DP4500)**: `bridge-csharp.dll` + `DPUruNet.dll` (edge-js) cargados por el engine.
- **Puente a la UI**: `preload.ts` (F2) expone `window.biometric/touchMode/attendance/biometricServer`
  sobre IPC; `main.ts` (F1) registra los handlers; `app.js` (F3) cablea la UI a esas APIs.

Una vez corregidos F1+F2+F3, el flujo completo queda operativo:
`window.biometricServer` (start/status) → `window.biometric` (enroll/identify) →
`window.touchMode` (SSE de captura continua) → `window.FingerprintEnroller` (eventos SSE de progreso).

---

## 5. Evidencia: el trace del renderer

Con el renderer en scripts clásicos, el buffer `window.__trace` (ver §6) confirma la ejecución completa:

```
[trace] module-load start
[trace] module-load FingerprintEnroller disponible: true
[trace] dom DOMContentLoaded fired
[INFO]  Sistema de Asistencia - Iniciando...
[trace] setup-nav start
[trace] setup-nav listener attached   (×8)
[trace] setup-nav end
[trace] data loadInitialData start
[INFO]  Datos cargados: 2 empleados, 5 departamentos, 4 turnos
[trace] data loadInitialData done
[trace] touch initializeTouchMode start
[INFO]  Inicializando Touch Mode...
[INFO]  Sistema listo
→ Servidor biométrico iniciado correctamente en http://localhost:8080
```

- **Sin** `Failed to load module`, `blocked by CORS`, `ReferenceError`, `SyntaxError`.
- `loadInitialData` devuelve datos reales ⇒ preload + IPC + servicios funcionando.
- Engine arranca ⇒ bridge C#/lector disponible.

---

## 6. Instrumentación y método (lo trabajado)

La causa se aisló con observabilidad **dentro** de la app, no por adivinanza:

1. **Trazado en el renderer** (`17caff8`): `window.__trace` + helper `T(type,label,data)` + `__dumpTrace()`
   que emite a `window.electronBridge.dumpTrace` (y a `window.labBridge.dumpTrace` en el lab).
   Eventos: `module-load`, `dom`, `setup-nav` (con conteo de listeners), `nav-click`, `show-section`,
   `load-section`, `IPC error`, `unhandledrejection`, `beforeunload`.
2. **Handler en main** (`17caff8`): `trace:dump` persiste el JSON en
   `%TEMP%\electron-fingerprint-traces\trace-electron-*.json` (ver `main.ts:231-242`).
3. **Lab standalone** (`5a4d31c`): `lab-http-host.mjs` (`http://localhost:9090`) sirve el **mismo**
   renderer **sin Electron**, con un bridge C# **inline** compilado vía Roslyn (`csc.dll`,
   `/langversion:10`) y SQLite real **read-only** (`node:sqlite`, `PRAGMA query_only = 1`). Un *shim*
   implementa `window.attendance/biometric/touchMode` contra endpoints reales. Permite decidir en
   segundos si un problema es **de Electron** o **de los servicios**.
4. **CDP** (`b674e7d`, `928…`/`d8ab028`): `cdp-test-lab.mjs` (spawn lab + Edge headless + Chrome
   DevTools Protocol) y `cdp-debug.mjs` (estado del DOM, timing IPC, carga de módulos, consola).
5. **Comparador de trazas** (`3a678f1`): `compare-traces.mjs` diffea el dump de Electron vs el del lab
   (eventos comunes / solo-electron / solo-lab) — fue lo que permitió **ver** dónde divergía.
6. **Hardening defensivo Tier A+B+C** (`9308d0b`), que evita “cuelgues” ante fallos de red/servicio:
   - `fetchJson` con `AbortSignal.timeout` en 15 endpoints (`BiometricService.ts`/`TouchModeService.ts`).
   - `safeHandle()` en 11 handlers IPC de `main.ts` (try/catch + log + error estructurado).
   - `withTimeout(promise, 10000)` en `loadInitialData` e `initializeTouchMode` (renderer).
   - Forwarder de `console-message` del renderer al logger de main + detector `render-process-gone`.
   - Listeners globales `unhandledrejection` / `error` en el renderer.
7. **Bug de migración DB** (`bc93f8c`, raíz de un “UI hang” previo): `runMigrations` debía ejecutarse
   **antes** de `executeSchema`. Una DB preexistente sin la columna `is_default` hacía fallar el
   `INSERT` de `schema.sql` (`no such column: is_default`) → `executeSchema` lanzaba → migraciones
   nunca corrían → **todas** las consultas IPC fallaban. Reordenado + `tryMigrateIsDefault` tolera
   `no such table` en DB fresca.

---

## 7. Mapa antes → después

| # | Fallo | Estado *antes* (con fallo) | Commit | Estado *después* (corregido) |
|---|---|---|---|---|
| F1 | `require()` en ESM | `main.ts` con `require('node:fs'/'node:os')`; `initIpcHandlers()` no corría | `1d6c28f` | imports ESM (`node:fs`, `node:os`); handlers registrados |
| F2 | preload no compilado | `electron/preload.ts` en `exclude`; `window.*` indefinido | `b51cee5` + `e2ee258` | preload compilado en `dist/preload.js`; APIs expuestas; duplicado `dist/electron/preload.js` eliminado |
| F3 | renderer ES modules en `file://` | `<script type="module">` + `import`; `app.js` no se evalúa; aside muerto | `e2ee258` | scripts clásicos en orden; `setupNavigation()` activo (8 listeners) |

**Paridad (golden master) tras la estabilización**:

| Sección | Final | Nota |
|---|---|---|
| gm1-http-api | `dbe5375ba092` | sin cambio |
| gm2-ipc-contract | `a5376b50ca2c` | baseline estaba **stale**: faltaban `electronBridge` y `trace:dump` de observabilidad (cambio aditivo, regenerado) |
| gm3-sqlite-schema | `63b730ac6006` | sin cambio |
| gm4-renderer-dom | `5040bc09bc67` | `scriptLoadOrder` vuelve a clásico (A.7a revertido) |
| gm5-manifests | `4b7d3bb0f329` | sin cambio |

`node refactor/scripts/gm-verify.mjs` → **5/5 OK**.

---

## 8. Verificación

```
npm run build                        → ok (renderer copiado; sin dist/electron/preload.js)
node refactor/scripts/gm-verify.mjs  → [GM] Paridad C(P) verificada ✅  (5/5)
npm test                             → tests 45 · pass 45 · fail 0
Electron (smoke)                     → setup-nav ×8, loadInitialData OK, engine :8080 OK, sin CORS/ReferenceError
```

---

## 9. Lecciones aprendidas

- **`file://` ≠ `http://` para el renderer.** Los ES modules y las APIs `fetch`/XHR están sujetos a
  CORS de origen; bajo `file://` el origen es opaco. **Los scripts clásicos sí cargan.** Convertir un
  renderer Electron cargado con `loadFile()` a ES modules es una **regresión de runtime**, aunque los
  tests y el golden master pasen.
- **El golden master y los unit tests no detectan fallos de carga.** gm captura contratos y DOM
  estático; no ejecuta el grafo del renderer ni el arranque de Electron. Un **smoke `npm start`** es
  obligatorio antes de cerrar cualquier changeset que toque renderer/preload/main/tsconfig.
- **`"type": "module"` es global.** Todo `.js` de la raíz es ESM (sin `require`). `require` solo es
  válido en subpaquetes CommonJS (p. ej. `biometric-engine/node`) o donde un tsconfig compila a
  CommonJS (el preload).
- **Un `exclude` en tsconfig puede dejar un artefacto vacío silenciosamente** (`dist/preload.js`), y
  el renderer lo manifiesta como `window.X === undefined`, no como error de build.
- **Orden de migraciones importa**: `ALTER TABLE` antes de ejecutar el `schema.sql` que ya asume la
  columna; si no, una DB preexistente rompe **todas** las consultas.
- **La observabilidad in-app paga**: el trace (`__trace` + `trace:dump`) y el lab aislaron la causa
  (¿Electron o servicios?) sin instrumentación externa ni hardware.
- **Diagnóstico headless**: el lab + CDP permiten reproducir y comparar el renderer en un navegador
  real, acelerando el aislamiento frente a abrir Electron a mano.

---

## 10. Checklist de smoke runtime (para futuras pasadas)

Antes de cerrar un changeset que toque `renderer/`, `preload.ts`, `main.ts` o `tsconfig*`:

1. `npm run build` sin errores; verificar que `dist/sistema-asistencia/renderer/index.html` **no** tenga `type="module"`.
2. `dist/preload.js` existe y no está vacío; `dist/electron/preload.js` **no** existe.
3. `npm start` (30 s): el trace muestra `module-load → DOMContentLoaded → setup-nav (8 listeners) → loadInitialData → Sistema listo`.
4. Sin `CORS`/`ReferenceError`/`Failed to load module` en consola del renderer.
5. `Servidor biométrico iniciado correctamente en http://localhost:8080`.
6. `node refactor/scripts/gm-verify.mjs` → 5/5 y `npm test` → 45/45.
7. (Opcional) Lab: `node lab-http-host.mjs` y `node compare-traces.mjs` para diff Electron vs lab.

---

## 11. Archivos tocados en la estabilización

- `electron/main.ts` (F1; observabilidad `trace:dump`, `safeHandle`, forwarder de consola).
- `electron/preload.ts` (F2; `require` CJS; expone `electronBridge`/`trace:dump`).
- `tsconfig.json` (F2; `exclude` de `electron/preload.ts` restaurado).
- `sistema-asistencia/renderer/index.html` (F3; `<script src>` clásicos en orden).
- `sistema-asistencia/renderer/app.js` (F3; sin imports; observabilidad `__trace`/`T`/`withTimeout`).
- `sistema-asistencia/renderer/js/{logger,escape-html,sanitize}.js` (F3; IIFE sobre `window.*`).
- `sistema-asistencia/renderer/js/controls/FingerprintEnroller.js` (F3; sin import/export; instancia global).
- `tests/refactor/{load-classic.mjs,escape-html,sanitize,logger,engine-escape-html}.test.mjs` (adaptación a scripts clásicos).
- `refactor/baseline/{gm-index,gm2-ipc-contract,gm4-renderer-dom}.json` (regen explícita).
