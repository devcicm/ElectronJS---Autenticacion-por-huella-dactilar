# Changelog del refactor — electron-biometric-fingerprint

Rama: `refactor/teseo-fase1` · Inicio: `b0cf676` · GM inicial verificado ✅

Convención de Paridad: ✅ idéntica · ⚠️ diferencias esperadas documentadas · ❌ revertido.

## Vía A — Refactor puro (C(P) preservado)

| Paso | Criterio | Qué cambió | Mapeo antes→después | Paridad | Custodia |
|---|---|---|---|---|---|
| A.1 | D-01+N-05 | Config única del servidor biométrico | nuevo `sistema-asistencia/shared/biometric-config.ts`; `electron/main.ts` / `BiometricService.ts` / `TouchModeService.ts` importan; `FingerprintEnroller.js` usa `window.config.get()`; `biometric-engine/node/server.ts` lee `BIOMETRIC_PORT` env | ✅ | `2dd45c6` (+ `04adc37` housekeeping line-endings, `0b6e612` submódulo, `a669ab6` gitlink) |
| A.2 | N-03 | Purgar 18 artefactos compilados (`.js`/`.d.ts`) de `src/` + `.gitignore` | `sistema-asistencia/{models,services,types}/*.js+d.ts` y `database/init.{js,d.ts}` eliminados de tracking (runtime en `dist/`) | ✅ | `ea1c5ca` |
| A.3 | N-03 | Eliminar `electron/renderer/index.html` huérfano (0 refs) | archivo muerto confirmado por grep | ✅ | `ff9a9c3` |
| A.4 | FE-19 | Reclasificado **NOT_APPLICABLE** — `loadSavedSettings` ya tenía try/catch con fallback a defaults (líneas 2549-2554) | evidencia de auditoría corregida en ejecución; sin código | n/a | `5e06f29` |
| A.5 | FE-15 | Tabla ocurrencia-por-ocurrencia: 19 estáticas puras (no smell), 4 user-data (→ B3), 5 internas/controladas (no smell). **Subconjunto PURE_REFACTOR vacío** | sin código; superficie ejecutable a B3 | n/a | `a3ad46d` |
| A.6a | BE-20 | Logger con niveles (LOG_LEVEL env), 118 call-sites `console.*`→`logger.*` en `electron/main.ts`, `BiometricService.ts`, `TouchModeService.ts` | nuevo `sistema-asistencia/shared/logger.ts` (cero deps, default info) | ✅ | `b9549a9` |
| A.7a | FE-01 | Sistema renderer → ES modules | `app.js` `type="module"`; `FingerprintEnroller.js` export class (sin auto-instancia); 34 globals de `app.js` reexpuestos explícitamente vía `Object.assign(window, {...})` para preservar handlers inline; `biometric-config.ts` invocado vía `window.config.get()` en `connectToSSE` (ahora async). **gm4 regenerada explícitamente** (solo cambió `scriptLoadOrder` — `elementIds`/`viewSections`/`stylesheets` intactos) | ⚠️ gm4 (scriptLoadOrder) | `5ef1b04` |
| A.6b | BE-20 | Logger renderer (espejo TS), 85 call-sites en `app.js` + `FingerprintEnroller.js` | nuevo `sistema-asistencia/renderer/js/logger.js` (LOG_LEVEL desde `localStorage`) | ✅ | `8c83566` |
| A.8 | D-03 | Eliminar copia muerta de `EnrollmentControl.js` en sistema (0 referencias) — engine demo conserva la viva | `-525` líneas | ✅ | `1fb3680` |
| A.9 | N-02 | Constantes nombradas en `biometric-config.ts`: `DEFAULT_TARGET_FARN=21474`, `TIMEOUT_*`; 7 literales reemplazados en `BiometricService.ts` | ✅ (única ocurrencia de `21474` en app = la constante misma) | ✅ | `d2bb36e` |

## Vía B — Hardening autorizado (cambioset por paso, gm regenerada explícita)

| Paso | Criterio | Qué cambió | Paridad |
|---|---|---|---|
| B1 | seguridad red | `app.listen(PORT, HOST)` con `BIOMETRIC_HOST` env (default `127.0.0.1`); guard: si HOST no loopback → exigir `X-Api-Token` (`BIOMETRIC_API_TOKEN`) o `process.exit(1)` | ✅ gm1 (endpoints/validaciones intactas; bind y 401 no son parte de gm1) |
| B2 | BE-19 | Helper `respondInternal()` en `server.ts`; 21 `error:String(e)` → `{ok:false,code:"INTERNAL_ERROR",error:"Error interno..."}`; log full server-side. **gm1 regenerada explícitamente**: solo `errorShape` (resto intacto) | ⚠️ gm1 (errorShape) |
| B3 | FE-15 (FIX) | `escapeHtml()` util; 57 escapes en 8 sitios `innerHTML`/`insertAdjacentHTML` con interpolación user-controlled (nombres, códigos, emails, dept/shift) | ✅ gm1-5 (innerHTML de tablas ≠ contrato congelado) |
| B3' | FE-15 (FIX, pasada adicional) | 13+2 escapes en modales: `dept.name`/`shift.name` en `<option>` + `<input value="...">`, `employee.hire_date`/`employee.phone` (incluido `\|\|`). Confirm dialogs intactos (texto plano, no HTML) | ✅ |
| B4 | RES-05 + OBJ-04 | `TouchModeService`: `reconnectTimer` con `clearTimeout` en `disconnectFromEvents`; `main.ts`: singletons cacheados para `AttendanceService`/`BiometricService`; `app.js`: `FingerprintEnroller.disconnect()` en `beforeunload` | ✅ (sin cambios de contrato observable) |
| B5 | BE-15-adj | `spawn(process.execPath, ...)` con `ELECTRON_RUN_AS_NODE=1` (funciona empaquetado, sin PATH de `node`); arranque por evento con backoff 200→500ms | ✅ (max wait 15s preservado) |

## Pasada de hardening Eje 1 (H1+H2+H3)

| Paso | Criterio | Qué cambió | Paridad |
|---|---|---|---|
| H1 | FE-22-adjacent | Helper `sanitize.js`: `sanitizeText` (trim + strip control + strip HTML peligrosos + cap maxLen), `sanitizePhone`, `sanitizeEmail`. Aplicado en `saveNewEmployee`/`updateEmployee`/`saveDepartment`/`updateDepartment`/`saveShift`/`updateShift` | ✅ |
| H2 | RES-05 (residual) | `enroller.disconnect()` en 2 setTimeouts de cierre (success simple/advanced) + botón Cancelar del modal de enrollment | ✅ |
| H3 | FE-16 + FE-17 (engine demo) | `TemplateManagerControl.js`: `onclick="window.location.reload()"` → `addEventListener('click', () => this.loadTemplates())` con `id="retry-load-templates-btn"`. Botón "Recargar Página" → "Reintentar" (reintento idempotente) | ✅ |

## Tests (Eje 3 — T1+T2+T3)

| Paso | Qué cubre | Resultado |
|---|---|---|
| T1 | `escapeHtml` (8 tests): vacíos, passthrough seguro, 5 entidades, XSS completo, orden, atributos, números/bool, idempotencia | ✅ |
| T2 | `sanitize` (17 tests): trim, control chars, HTML strip, cap maxLen, default 100, stripHtml=false, unicode, phone (vacíos/digitos/strip/cap/solo chars), email (vacíos/lowercase/cap), payload realista | ✅ |
| T3 | `logger` renderer JS (4 tests): default info filtra debug, prefijo [LEVEL], niveles mayusculas, argumentos múltiples | ✅ |
| T4 | IPC parity — ya implementado via `gm-verify.mjs` (no duplicado) | ✅ |

## Pasada de hardening Eje 2 (N1+X2)

| Paso | Criterio | Qué cambió | Paridad |
|---|---|---|---|
| C1-C4 | audit | Reclasificación C1-C4: RES-05 + OBJ-04 + FE-16/17 ya resueltos en B4, H2, H3 | doc |
| N1 | N-03-adjacent (data safety) | Columna `is_default INTEGER NOT NULL DEFAULT 0` en `departments` + `shifts`; INSERTs del seed marcan id≤5 y id≤4 como base; migración `ALTER TABLE` en `init.ts` (idempotente, marca solo si DB fresca); `resetDatabase` usa `WHERE is_default = 0`. **gm3 regenerada explícitamente** (solo CREATE TABLE; seeds/índices/vistas/triggers intactos) | ⚠️ gm3 (CREATE TABLE) |
| X2 | FE-15 (engine hardening) | `escapeHtml` (mirror de sistema) en `biometric-engine/node/public/js/escape-html.js`; cargado via `<script>` antes de controles en `demo-avance.html`; 40 sitios de `${error.message}` y `${template.tag}/${dept.name}` etc. wrapped en engine public | ✅ |
| B5-revert | regresión runtime | Revertir `spawn(process.execPath + ELECTRON_RUN_AS_NODE=1)` → `spawn('node', ...)`. Causa: edge-js 5.x prebuilt Node 20.10; Electron 31 trae Node 20.18 → ABI mismatch. Mantener `waitForReady` (B5-keep, arranque por evento). Edge-js ABI root cause pendiente en changeset propio (requiere `npm rebuild edge-js`) | ⚠️ runtime fix |
| edge-js upgrade | runtime root cause | `edge-js ^20.3.0` → `26.1.0` en `biometric-engine/node/package.json` (cambia lockfile). v26 trae prebuilts para Node 22/24 (system Node 24.14 ahora compatible). gm5 regenerada explícitamente (solo edge-js version bump; gm1-4 intactos). Audit: 4 vulnerabilidades transitivas en express/qs/body-parser — pendientes para changeset aparte | ⚠️ gm5 (manifests) |
| fix UI hang | Tier A+B+C runtime | 15 endpoints de `BiometricService.ts`/`TouchModeService.ts` refactorizados a `fetchJson` con `AbortSignal.timeout` (5s default). 11 IPC handlers críticos wrapped en `safeHandle()` (try/catch + log + error estructurado). Renderer `app.js`: `withTimeout(promise, 10000)` wraps `loadInitialData` + `initializeTouchMode`; listeners `unhandledrejection` + `error` capturan escapes. Main `electron/main.ts`: forwarder de console del renderer al logger main + detector `render-process-gone`. `gm-capture.mjs` ahora reconoce `safeHandle` como handler. gm5 regenerada (solo `test` script change). +5 tests `fetchJson` (45 tests total). | ⚠️ gm5 (test script) |

**Total: 29 tests, cero deps (node:test nativo Node 24). Script: `npm test`.**

## Fase 6 — Estabilización runtime (post-hardening)

Arranque real en Electron (`npm start`): la UI no navegaba (aside muerto) aunque el lab sí. Cadena de
tres fallos de carga acumulados. Detalle completo: **`refactor/RUNTIME-Y-DIAGNOSTICO.md`**.

| Paso | Causa | Qué cambió | Commit | Paridad |
|---|---|---|---|---|
| R0 | infra CDP | `npm debug` con `remote-debugging-port` + `cdp-debug.mjs` (estado DOM, timing IPC, carga módulos); `showSection`/`loadXxxSection` con try/catch + `withTimeout` | `d8ab028` | ✅ |
| R1 | DB migración | `runMigrations` **antes** de `executeSchema` (`is_default`); tolera `no such table` en DB fresca. Raíz de un "UI hang" previo | `bc93f8c` | ✅ |
| R2 | UI hang (defensivo) | Tier A+B+C: `fetchJson`+`AbortSignal.timeout` (15 endpoints), `safeHandle` (11 handlers), `withTimeout(10s)` renderer, forwarder de consola, `render-process-gone`; gm5 regen | `9308d0b` | ⚠️ gm5 (test script) |
| R3 (F1) | `require()` en proyecto `type:module` | `main.ts`: `require('node:fs'/'node:os')` → imports ESM; `initIpcHandlers()` ya corre | `1d6c28f` | ✅ |
| R4 (F2) | preload excluido de compilación | compilar `electron/preload.ts` a `dist/preload.js` (APIs `contextBridge` expuestas); eliminar duplicado | `b51cee5` | ✅ |
| R5 (F3) | renderer ES modules bajo `file://` | **revertir a scripts clásicos** (IIFE `window.*` + `<script src>` en orden); A.7a revertido; tests adaptados (`load-classic.mjs`); gm2/gm4 regen | `e2ee258` | ⚠️ gm2 (stale) + gm4 (scriptLoadOrder) |

**Naturaleza del fix**: `loadFile()` ⇒ origen `file://` (opaco). Los module scripts van en modo CORS y
Chromium bloquea sus imports → `app.js` no se evaluaba → `setupNavigation()` nunca corría. Los scripts
clásicos no usan CORS y sí cargan. Con F1+F2+F3 corregidos: `setup-nav` ata 8 listeners,
`loadInitialData` carga datos reales y el engine (`:8080`, lector DP4500) queda operativo.

**Verificación**: gm-verify 5/5 · `npm test` 45/45 · smoke Electron sin CORS/ReferenceError.

## Hallazgos no ejecutados (referenciados)

| Criterio | Estado | Notas |
|---|---|---|
| BE-19 (BUGS #1) | Resuelto vía B2 | |
| FE-15 con user data (BUGS #2) | Resuelto vía B3 en 8 sitios | **pendiente** las interpolaciones en `value="..."` de modales `insertAdjacentHTML` (showEditEmployeeModal, showEnrollFingerprintModal) — no estaban en el FE-15 auditado; superficie a tratar en una pasada de hardening adicional |
| Exposición 0.0.0.0 (BUGS #3) | Resuelto vía B1 (default loopback) | escalado a LAN requiere `BIOMETRIC_HOST` + `BIOMETRIC_API_TOKEN` env |
| Spawn `node` (BUGS #4) | Resuelto vía B5 | |
| C1-C5 CANDIDATE | siguen en investigación | |

## Líneas rojas respetadas

- ❌ No se reescribió desde cero
- ❌ No se mezcló FIX con refactor (cada B es su propio changeset)
- ❌ No se rompió C(P) sin regenerar baseline explícitamente
- ❌ No se actualizaron dependencias
- ❌ No se tocó la decisión de gateway C# (submódulo) salvo contrato HTTP/JSON de unión
- ✅ Pasos verificables individualmente (criterio o grupo mecánico cohesivo)
- ✅ Cada paso en su commit atómico