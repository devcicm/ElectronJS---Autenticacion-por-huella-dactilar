---
title: electron-fingerprint — Arquitectura de componentes
id: 0a5cfe7f-56b7-4e45-bb5b-7ca7f66e0321
createdAt: 2026-06-02T08:17:02.000Z
updatedAt: 2026-06-02T08:17:02.000Z
tags: ["diagram", "architecture", "electron-fingerprint"]
norm_refs: ["AP-11", "AP-12", "AP-13", "AP-16", "AP-20", "CN-01", "CN-02", "SP-01"]
status: stub
cia_integrity: medium
cia_availability: medium
cia_sensitivity: internal
agent: claude
project: electron-fingerprint
diagramType: mermaid
category: component
---

# electron-fingerprint — Arquitectura de componentes

> Diagrama generado por vault_onboard desde estructura de archivos. Verificar y ajustar.

**Lenguaje:** typescript
**Framework:** Electron

## Diagrama

```mermaid
graph TD
  model --> AttendanceModel
  model --> EmployeeModel
  model --> FingerprintModel
  service --> TouchModeService
  service --> AttendanceService
  service --> BiometricService
  service --> AttendanceService.d
```

## Para enriquecer

```bash
python scripts/vault_diagram_save.py --project electron-fingerprint \
  --title "Arquitectura electron-fingerprint" --type mermaid --category component \
  --content "..."
```
