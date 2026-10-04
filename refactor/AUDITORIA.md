# Auditoría de refactor — electron-biometric-fingerprint

- Fecha: 2026-10-04
- Stack detectado (Fase 0): Electron 31 + TypeScript 5.6 (main/preload), JS plano (2 renderers), Node/Express + SSE (biometric-engine), C# .NET 4.7.2 (bridge DP4500), SQLite (better-sqlite3)
- Alcance acordado: código de la app (`electron/`, `sistema-asistencia/`, `biometric-engine/node/`). **Fuera:** `vault-*` (tooling Obsidian), `dist/`, `node_modules`, submódulo C# salvo su contrato.
- Red de seguridad: git **limpio** (rama `refactor/teseo-fase1`) · golden master **generado** (`refactor/baseline/`, 5 secciones, verificado ✅)

## Resumen

| Dominio | 🔴 | 🟠 | 🟡 | ⚪ | Total |
|---|---|---|---|---|---|
| Núcleo | 0 | 1 | 2 | 1 | 4 |
| DRY | 0 | 1 | 1 | 0 | 2 |
| Frontend | 0 | 2 | 2 | 0 | 4 |
| Backend | 0 | 0 | 1 | 0 | 1 (+2 FIX) |
| ALG | 0 | 0 | 0 | 0 | 0 |
| RES | 0 | 0 | 0 | 0 | 0 (+2 CANDIDATE) |
| OBJ | 0 | 0 | 0 | 0 | 0 (+1 CANDIDATE) |

## Hallazgos confirmados

| # | Criterio | Ubicación | Evidencia | Estado | Clase | Sev | Riesgo | P |
|---|---|---|---|---|---|---|---|---|
| 1 | D-01 | BiometricService.ts:10 · TouchModeService.ts:13 · FingerprintEnroller.js:25 · main.ts:19 | `http://localhost:8080` / `BIOMETRIC_PORT` en ≥4 módulos; cambiar puerto toca N archivos | CONFIRMED | PURE_REFACTOR | 🟠 | 🟡 | P1 |
| 2 | N-05 | ídem #1 | URLs/puerto hardcodeados sin config/env (no hay secrets → no BE-16) | CONFIRMED | PURE_REFACTOR | 🟡 | 🟢 | P1 |
| 3 | N-02 | server.ts (defaultFarn `21474` ×65 en repo) · timeouts 10000/12000/15000/30000/240000 repetidos | valores mágicos sin nombre duplicados server↔services↔controles | CONFIRMED | PURE_REFACTOR | 🟡 | 🟢 | P3 |
| 4 | N-03 | `sistema-asistencia/{models,services,database,types}/*.js + .d.ts` (9 .js trackeados) | artefactos de compilación versionados junto a la fuente .ts; el runtime usa `dist/` (package.json main=dist/electron/main.js; tsconfig.asistencia outDir=./dist) | CONFIRMED | PURE_REFACTOR | 🟠 | 🟡 | P1 |
| 5 | N-03 | `electron/renderer/index.html` | 0 referencias en el repo (main.ts:33 carga `sistema-asistencia/renderer/index.html`); hash distinto del vivo → copia divergente muerta | CONFIRMED | PURE_REFACTOR | 🟡 | 🟢 | P1 |
| 6 | D-03 | `sistema-asistencia/renderer/js/controls/EnrollmentControl.js` ≡ `biometric-engine/node/public/js/controls/EnrollmentControl.js` | `fc /b`: byte-idénticos | CONFIRMED | PURE_REFACTOR | 🟡 | 🟢 | P3 |
| 7 | BE-20 | app.js(78) · TouchModeService.ts(80) · main.ts(34) · FingerprintEnroller.js(7) · server.ts(7) · BiometricService.ts(4) | 210 `console.*` como única observabilidad | CONFIRMED | PURE_REFACTOR | 🟡 | 🟢 | P3 |
| 8 | FE-15 | 74 ocurrencias innerHTML (app.js ×23, engine public ×51) | smell mecánico confirmado; **por ocurrencia**: templates estáticos → refactor; interpolación de datos de usuario (app.js:192, 484; controles con nombres/tags) → FIX (ver BUGS #2) | CONFIRMED | PURE_REFACTOR (solo ocurrencias estáticas) | 🔴 smell / 🟡 por-ocurrencia | 🟡 | P2 |
| 9 | FE-01 | ambos index.html | `<script src>` clásicos sin `type="module"`; estado/funciones por globals (window.*) | CONFIRMED | PURE_REFACTOR | 🟠 | 🟡 | P3 (requiere FE-04-verify) |

## Posibles (no confirmados)

| # | Criterio | Ubicación | Estado | Duda / evidencia faltante |
|---|---|---|---|---|
| C1 | RES-05 | TouchModeService.ts:328-330 | CANDIDATE | reconexión SSE via setTimeout sin clear en stop(); mitigado por guard `state.isActive` — falta demostrar fuga real |
| C2 | RES-05 | FingerprintEnroller.js:25,352 | CANDIDATE | `eventSource.close()` tiene 1 call-site; no se verificó que siempre se invoque al cerrar la vista |
| C3 | OBJ-04 | main.ts:196-206, 229+ | CANDIDATE | `new AttendanceService()`/`BiometricService()` por llamada IPC; DatabaseManager es singleton → coste real no medido |
| C4 | FE-16/FE-17 | TemplateManagerControl.js:573 | CANDIDATE | `onclick="window.location.reload()"` inline en UI demo del engine; verificar consumidores de esa vista |
| C5 | N-04 | comentarios con workarounds en TouchModeService (reintentos) | CANDIDATE | verificar si protegen caso real antes de tocar |

## Zonas revisadas sin hallazgos

- **BE-11**: `readFileSync` solo en arranque (init.ts:59, una vez, no por-request) → NOT_APPLICABLE
- **BE-12**: escrituras vía better-sqlite3 transaccionales (reset en transacción, main.ts:402) → limpio
- **BE-15**: fail-fast con diagnóstico presente (init.ts:48-51) → limpio
- **BE-16**: sin credenciales/tokens en código → limpio
- **BE-17**: sin CORS permisivo (no hay middleware CORS) → NOT_APPLICABLE
- **BE-21/FE-21**: sin `catch` vacíos en zonas de app (patrón verificado ×0) → limpio
- **BE-22/BE-05**: contrato IPC usa `{success,message}` consistente; HTTP usa 400/500 reales → limpio
- **FE-04**: sin detección de página por existencia de elementos → limpio
- **FE-13**: sin `var` en zonas de app (solo vault/C#) → limpio
- **FE-22/FE-23/FE-24**: sin doble fuente de verdad, sin XHR síncrono → limpio
- **FE-19** en TouchModeService.ts:298 y FingerprintEnroller.js:33: JSON.parse de SSE **sí** está en try/catch → limpio
- **FE-19** en app.js:2551 (`loadSavedSettings`): CORRECCIÓN de auditoría — el `JSON.parse` **sí** está envuelto en try/catch con fallback a defaults (app.js:2549-2554); la evidencia original miró la línea sin su contexto. Estado final: **NOT_APPLICABLE**, sin cambio de código (verificado en ejecución del paso A.4)
- **ALG**: listados renderizados con n pequeño (empleados); sin bucles anidados con volumen real → sin hallazgos
- **D-02/D-04/D-06**: única fuente de datos por dominio; no se detectó falsa duplicación → limpio
- **N-06**: capas UI→preload→IPC→services→models unidireccionales → limpio

## Nota sobre FE-15 por ocurrencia

La sustitución mecánica `innerHTML`→`textContent` **solo** es refactor puro donde el contenido es estático o interno. Donde se interpola dato de usuario (nombres de empleados, tags, códigos) el escape cambia la salida observable ante input malicioso: eso es **FIX** (BUGS #2), no refactor. El plan Fase 3 separará ambas listas ocurrencia por ocurrencia.
