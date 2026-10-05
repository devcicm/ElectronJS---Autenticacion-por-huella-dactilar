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

**RESOLUCIÓN (estabilización runtime, R5):** el renderer de sistema **permanece con scripts clásicos**.
El paso A.7a lo convirtió a ES modules y eso resultó una **regresión de runtime**: Electron carga la UI
con `loadFile()` (`file://`, origen opaco) y Chromium bloquea los *module imports* por CORS ⇒ `app.js`
no se evaluaba ⇒ `setupNavigation()` no corría ⇒ el aside no navegaba. Revertido en `e2ee258`. Detalle:
**`refactor/RUNTIME-Y-DIAGNOSTICO.md`**.

## Posibles (no confirmados)

| # | Criterio | Ubicación | Estado | Duda / evidencia faltante |
|---|---|---|---|---|
| C1 | RES-05 | TouchModeService.ts:328-330 | **NOT_APPLICABLE** | Reclasificado tras H2+B4: reconexión SSE con `reconnectTimer: NodeJS.Timeout` y `clearTimeout` en `disconnectFromEvents()` y `dispose()`; fuga STADA · lifecycle B4 confirmado: `window.addEventListener('beforeunload', () => window.FingerprintEnroller.disconnect())` en `app.js:13`. FingerprintEnroller (singular) además desconecta en 2 setTimeouts de cierre de enrollment + botón Cancelar del modal (H2) |
| C2 | RES-05 | FingerprintEnroller.js:25,352 | **NOT_APPLICABLE** | Resuelto por H2: `enroller.disconnect()` invocado en 3 sitios terminales (success simple, success advanced, Cancel button); fuga STADA en esos tres puntos |
| C3 | OBJ-04 | main.ts:196-206, 229+ | **RESUELTO en B4** | singletons cacheados (`attendanceServiceInstance`, `biometricServiceInstance`); se crean una vez por main process lifetime |
| C4 | FE-16/FE-17 | TemplateManagerControl.js:573 | **RESUELTO en H3** | `onclick="window.location.reload()"` reemplazado por `addEventListener('click', () => this.loadTemplates())` (reintento idempotente, botón "Reintentar") |
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

**RESOLUCIÓN (ejecución paso A.5):** tabla ocurrencia-por-ocurrencia generada (`refactor/scripts/fe15-classify.cjs`) sobre las 28 asignaciones de sistema-asistencia: 19 estáticas puras (no son el smell — string constante sin datos), 4 interpolan dato de usuario (app.js:188, 235, 484, 3039 → FIX, se ejecutan en B3), 5 interpolan constantes internas (`finger.label` controlado por código, base64 del server — dominio seguro). **El subconjunto PURE_REFACTOR es vacío: no hay cambio de código en A.5.** La superficie ejecutable de FE-15 vive íntegra en B3 (hardening autorizado).
