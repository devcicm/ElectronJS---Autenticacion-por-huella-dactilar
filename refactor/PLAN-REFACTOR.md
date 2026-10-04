# Plan de refactor — electron-biometric-fingerprint

## Precondiciones

- git en estado limpio: **sí** (rama `refactor/teseo-fase1`, HEAD `af15bda`)
- golden master en refactor/baseline/: **sí** (5 secciones, `node refactor/scripts/gm-verify.mjs` ✅)
- (ambas verdes ⇒ el plan es ejecutable)

## Protocolo de cada paso (Fase 4)

1. Anunciar criterio(s), clase y archivos
2. Ejecutar el cambio mínimo
3. `npm run build` + `node refactor/scripts/gm-verify.mjs` → paridad C(P)
4. Commit atómico con mapeo antes→después (cadena de custodia)
5. Si rompe paridad: revertir, documentar obstáculo, replanear. **Nunca** se ajusta el baseline para hacerlo pasar.

## Pasos

| Paso | P | Criterio(s) | Clase | Archivos | Depende de | Comparador / verificación |
|---|---|---|---|---|---|---|
| 1 | P1 | D-01 + N-05 | PURE_REFACTOR | nuevo `sistema-asistencia/shared/biometric-config.ts`; `BiometricService.ts:10`, `TouchModeService.ts:13`, `main.ts:19`, `FingerprintEnroller.js:25` | — | gm2 (contrato `config:get` intacto) + build + arranque |
| 2 | P1 | N-03 (src compilados) | PURE_REFACTOR | 9 `.js` + `.d.ts`/`.map` en `sistema-asistencia/{models,services,database,types}` + `.gitignore` | — | build limpio + gm3/gm5 + imports de `dist/` resueltos |
| 3 | P1 | N-03 (huérfano) | PURE_REFACTOR | `electron/renderer/index.html` (git rm) | — | 0 referencias (grep) + gm4 |
| 4 | P1 | FE-19 | PURE_REFACTOR | `app.js:2551` (loadSettings) | — | gm4 + prueba con storage corrupto (default aplicado) |
| 5 | P2 | FE-15 (solo ocurrencias estáticas) | PURE_REFACTOR | `app.js` + controles engine — tabla ocurrencia-por-ocurrencia (74 candidatas, se filtran las que interpolan dato de usuario → BUGS #2) | 4 (mismo archivo) | gm4 exact + smoke visual por vista |
| 6 | P3 | BE-20 | PURE_REFACTOR | nuevo `logger` (main + renderer adapter); 210 call-sites en 6 archivos, preservando mensaje y nivel (error→error, warn→warn) | 1 (usa config) | gm-verify + arranque con logs equivalentes |
| 7a | P2 | FE-01 (sistema-asistencia) | PURE_REFACTOR | `index.html` + `app.js` + `FingerprintEnroller.js` → ES modules, globals→exports | 1, 5 | gm4 (orden de carga pasa a import) + smoke completo |
| 7b | P2 | FE-01 (engine public) | PURE_REFACTOR | `public/index.html` + 12 JS → ES modules | — | gm4-engine + smoke demo UI |
| 8 | P3 | D-03 | PURE_REFACTOR | `EnrollmentControl.js` → fuente única servida por engine (`express.static` apunta al archivo compartido; sistema carga ese mismo archivo) | 7a, 7b | diff byte a byte del comportamiento + smoke de ambos |
| 9 | P3 | N-02 | PURE_REFACTOR | `21474`→`DEFAULT_TARGET_FARN`, timeouts→constantes nombradas (server.ts + services + controles) | 1 (dueño del conocimiento) | gm1 exact |

**Gate aplicado:** todos los pasos son `CONFIRMED ∧ PURE_REFACTOR`. Ante duda en ejecución (p. ej. una ocurrencia FE-15 que resulte interpolar dato de usuario) el paso se detiene y la ocurrencia se reclasifica — nunca se fuerza.

## Pasos P4 (documentados, fuera de esta pasada)

| Criterio | Motivo de exclusión | Recomendación registrada |
|---|---|---|
| BE-19 (fuga `String(e)`) | FIX: cambia body observable | BUGS #1 — diseñar contrato de error en changeset propio |
| FE-15 con dato de usuario | FIX: escape cambia salida ante input hostil (XSS) | BUGS #2 — escapar + sanitizar en changeset propio |
| Exposición 0.0.0.0 sin auth | FIX: cambia contrato de red | BUGS #3 — bind 127.0.0.1 o auth; decisión de arquitectura |
| spawn `node` en PATH | FIX/empaquetado | BUGS #4 — resolver binario empaquetado |

## Fuera de alcance (esta pasada)

- CANDIDATE C1–C5 (RES-05 ×2, OBJ-04, FE-16/17, N-04): requieren investigación que puede tocar runtime con hardware; se investigan en pasada aparte.
- Todo `vault-*`, `dist/`, submódulo C# (salvo su contrato HTTP ya congelado).
