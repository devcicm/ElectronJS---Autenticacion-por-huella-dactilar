---
title: Service Layer
id: c588b82c-cc58-41e9-b9c5-5482623e0b45
createdAt: 2026-06-02T08:17:02.000Z
updatedAt: 2026-06-02T08:17:02.000Z
tags: ["pattern", "architecture", "electron-fingerprint", "service"]
norm_refs: ["AP-11", "AP-12", "AP-13", "AP-16", "AP-20", "CN-01", "CN-02", "SP-01"]
status: stub
cia_integrity: medium
cia_availability: medium
cia_sensitivity: internal
agent: claude
project: electron-fingerprint
pattern_type: architecture
---

# Service Layer

> Patrón detectado automáticamente por vault_onboard. Verificar implementación real.

**Categoría:** architecture
**Evidencia:** 5 archivos de tipo `service`

## Descripción

Separación de lógica de negocio en servicios

## Archivos detectados

- `sistema-asistencia/services/TouchModeService.ts`
- `sistema-asistencia/services/AttendanceService.ts`
- `sistema-asistencia/services/BiometricService.ts`
- `sistema-asistencia/services/AttendanceService.d.ts`
- `sistema-asistencia/services/BiometricService.d.ts`

## Para enriquecer

```bash
python scripts/vault_pattern_save.py --project electron-fingerprint --name "service-layer" \
  --pattern_type architecture --status implementado
```
