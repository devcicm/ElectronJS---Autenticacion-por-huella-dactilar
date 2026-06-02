---
title: npm run start
id: 023f4757-35c3-4627-aff2-af1384b4cd2e
createdAt: 2026-06-02T08:17:02.000Z
updatedAt: 2026-06-02T08:17:02.000Z
tags: ["runbook", "setup", "electron-fingerprint", "npm"]
norm_refs: ["AP-11", "AP-12", "AP-13", "AP-16", "AP-20", "CN-01", "CN-02", "SP-01"]
status: stub
cia_integrity: medium
cia_availability: high
cia_sensitivity: internal
agent: claude
project: electron-fingerprint
category: setup
---

# npm run start

> Runbook generado por vault_onboard desde package.json. Verificar pasos reales.

**Trigger:** Ejecutar `start` del proyecto
**Categoría:** setup
**Comando:** `npm run build && electron .`

## Prerrequisitos

- [ ] Node.js instalado
- [ ] Dependencias instaladas: `npm install`

## Pasos

1. Abrir terminal en el directorio del proyecto
2. Ejecutar: `npm run start`

## Para enriquecer

```bash
python scripts/vault_runbook_save.py --project electron-fingerprint \
  --title "npm run start" --trigger "..." \
  --category setup --steps '[{"step":"npm run start"}]'
```
