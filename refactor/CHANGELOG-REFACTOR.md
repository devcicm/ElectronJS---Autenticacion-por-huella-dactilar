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