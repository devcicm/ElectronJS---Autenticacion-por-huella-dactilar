# Reporte de refactor — electron-biometric-fingerprint

- Rama: `refactor/teseo-fase1` (HEAD al cierre de sesión)
- Skill: `refactor-codebase` v2.1 instalada en `~/.claude/skills/`
- Golden master: `refactor/baseline/` (5 secciones, hash por archivo)

## Ocurrencias por criterio

| Criterio | Antes | Después |
|---|---|---|
| D-01 conocimiento duplicado (`localhost:8080`) | ≥4 sitios | 1 (constante única + IPC existente) |
| N-05 URL/puerto hardcodeado | ≥4 | 0 (env + config única) |
| N-02 valor mágico (`21474`) en app | ≥3 sitios | 1 (constante) |
| N-02 timeouts literales | 4 sites | 0 (constantes nombradas) |
| N-03 archivos compilados en `src/` | 18 tracked | 0 |
| N-03 archivo muerto `electron/renderer/index.html` | 1 | 0 |
| D-03 copia muerta `EnrollmentControl.js` | 1 | 0 (engine conserva única viva) |
| BE-20 `console.*` como única observabilidad | 210 sites | 0 (logger con niveles; cero deps) |
| FE-19 JSON.parse sin guard en loadSettings | (reclasificado) | ya guardada |
| FE-15 estáticas puras | 19 | (no era smell) |
| FE-15 user-data en `innerHTML`/`insertAdjacentHTML` | 8 sitios | 0 (escapeHtml) |
| FE-01 scripts sin módulos en renderer sistema | 2 scripts clásicos | 1 module con imports |
| BE-19 `String(e)` filtrado al cliente | 21 handlers | 0 (helper `respondInternal`) |
| Exposición 0.0.0.0 sin auth | sí | no (default loopback + guard de token) |
| RES-05 reconnect timer sin `clear` | 1 | 0 (timer con cleanup) |
| OBJ-04 instancias por IPC | sí | no (singletons cacheados) |

## Paridad del golden master

| Contrato congelado | Comparador | Baseline | Final | Resultado |
|---|---|---|---|---|
| gm1 HTTP API | exact (endpoints, validaciones, errorShape) | `c10afed2cd23` | `dbe5375ba092` | ⚠️ B2: errorShape deliberada (autorizada) |
| gm2 IPC contract | exact (canales) | `956f21ba75ba` | `956f21ba75ba` | ✅ |
| gm3 SQLite schema | exact | `22019adc5a3f` | `22019adc5a3f` | ✅ |
| gm4 renderer DOM | exact (scriptLoadOrder excluido post A.7a) | `951c78272811` | `951c78272811` | ⚠️ A.7a: scriptLoadOrder deliberada (autorizada) |
| gm5 manifests | exact | `a77df93e771d` | `a77df93e771d` | ✅ |

Regeneraciones explícitas justificadas (Regla 5, `paridad.md`): A.7a y B2.

## No-degradación de recursos (dominio RES)

| Recurso contado | Regla | Antes | Después | Resultado |
|---|---|---|---|---|
| Reconnect timers en TouchModeService | Z antes, sin Z leakers tras stop() | 1 sin cleanup | 1 con `clearTimeout` | ✅ |
| Service instances (AttendanceService/BiometricService) | cacheados (1 por servicio), no per-call | `new` por IPC (≈ cada llamada) | 1 singleton | ✅ |
| EventSource en FingerprintEnroller | `disconnect()` garantizado en `beforeunload` | sin cleanup explícito | cleanup registrado | ✅ |

## Bugs detectados / hardening ejecutado

| ID | Título | Estado |
|---|---|---|
| BUGS #1 (BE-19) | Fuga de `String(e)` al cliente | Resuelto en B2 |
| BUGS #2 (FE-15 XSS) | Interpolación sin escape | Resuelto en B3 en 8 sitios; resto (`value="..."` en `insertAdjacentHTML`) → **pasada de hardening adicional** |
| BUGS #3 (0.0.0.0 sin auth) | Bind abierto | Resuelto en B1 (default loopback, escalable vía env) |
| BUGS #4 (spawn `node`) | Dependiente de PATH | Resuelto en B5 (`ELECTRON_RUN_AS_NODE`) |

## Decisiones y deprecaciones

| Decisión | Motivo | Pendiente de |
|---|---|---|
| `electron/biometric-config.ts` único dueño del puerto + URL | App-side | nada |
| Engine mantiene su propio `DEFAULT_TARGET_FARN` | Cross-repo (submódulo) — no se puede unificar fuente | si se requiere, paquete compartido |
| Demo UI engine sigue con `<script>` clásicos | FE-01: conversión = churn sin valor (demostración, no app) | si crece la demo, una sola pasada para ES modules |
| Modales con `value="..."` user-data | No estaban en FE-15 auditado; B3 los dejó para pasada adicional | hardening pass de `insertAdjacentHTML` (~6 modales) |
| Email si alguien introduce `<script>` en un campo `debe*` | el frontend debería validar formato antes de persistir | endurecer `saveNewEmployee` / `updateEmployee` (FE-22-adjacent) |

## Fuera de alcance (esta sesión)

- CANDIDATE C1–C5 (RES-05 ×2, OBJ-04-adjacent ya resuelto en B4, FE-16/17, N-04) — los OBJ-04 ya resueltos en B4, el resto queda para investigación con lector presente.
- Submódulo C# (`biometric-engine/bridge-csharp`) — contrato HTTP/JSON de unión congelado en gm1; ningún cambio estructural del bridge.
- Vault tooling (`vault-*`) — no es código de la app; documentado.
- Dependencias (`package.json` deps): **intactas**. Sin upgrades en el mismo changeset del refactor (línea roja #7).

## Métricas

- **Commits del refactor puro + hardening**: 17 en `refactor/teseo-fase1` (12 Vía A + 5 Vía B) + 1 housekeeping (line-endings).
- **Líneas netas eliminadas**: ≈ 2 400 (artefactos compilados, copia muerta, archivo huérfano).
- **Líneas netas añadidas**: ≈ 300 (config compartida, logger, escapeHtml, lifecycle, B5).
- **Cambioset reproductivos retro (gm4, gm1)**: 2, ambos con justificación explícita.

## Verificación final

```
node refactor/scripts/gm-verify.mjs  →  [GM] Paridad C(P) verificada ✅
git status --porcelain              →  (limpio)
git log --oneline b0cf676..HEAD     →  17 commits del refactor + housekeeping
```

## Pasada de hardening adicional sugerida (post-sesión)

1. **escapeHtml en modales `insertAdjacentHTML`**: `showEditEmployeeModal` (line 672+) y `showEnrollFingerprintModal` (line 1008+) — interpolan `employee.first_name`, `last_name`, `employee_code`, `email`, `phone`, `position` dentro de `value="..."`. Mismo patrón, mismo riesgo, misma solución (57 escapes adicionales estimados).
2. **Validación de entrada user-controlled en formularios** (FE-22-adjacent): regex actual en `saveNewEmployee`/`updateEmployee` solo valida email; añadir normalización/sanitización para nombres/códigos antes de persistir (defensa en profundidad: no confiar solo en la capa de escape).
3. **CANDIDATE C1 (RES-05 en FingerprintEnroller)**: si la app añade vistas que alternan el control, asegurar `disconnect()` al desmontar; hoy vive en el singleton del módulo.
4. **Engine demo UI → ES modules** (FE-01) si crece la demo; hoy valor/coste desfavorable.