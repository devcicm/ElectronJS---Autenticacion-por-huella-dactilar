---
title: npm run build
id: 36f56143-9b8a-4f3f-bde0-f1d1ea19dd39
createdAt: 2026-06-02T08:17:02.000Z
updatedAt: 2026-06-02T08:17:02.000Z
tags: ["runbook", "pipeline", "electron-fingerprint", "npm"]
norm_refs: ["AP-11", "AP-12", "AP-13", "AP-16", "AP-20", "CN-01", "CN-02", "SP-01"]
status: stub
cia_integrity: medium
cia_availability: high
cia_sensitivity: internal
agent: claude
project: electron-fingerprint
category: pipeline
---

# npm run build

> Runbook generado por vault_onboard desde package.json. Verificar pasos reales.

**Trigger:** Ejecutar `build` del proyecto
**Categoría:** pipeline
**Comando:** `tsc -p tsconfig.json && tsc -p tsconfig.preload.json && tsc -p tsconfig.asistencia.json && xcopy /Y /I /E sistema-asistencia\renderer dist\sistema-asistencia\renderer\ && xcopy /Y /I sistema-asistenci`

## Prerrequisitos

- [ ] Node.js instalado
- [ ] Dependencias instaladas: `npm install`

## Pasos

1. Abrir terminal en el directorio del proyecto
2. Ejecutar: `npm run build`

## Para enriquecer

```bash
python scripts/vault_runbook_save.py --project electron-fingerprint \
  --title "npm run build" --trigger "..." \
  --category pipeline --steps '[{"step":"npm run build"}]'
```
