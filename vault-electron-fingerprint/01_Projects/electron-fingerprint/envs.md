---
title: Environment Variables - electron-fingerprint
project: electron-fingerprint
type: envs
updatedAt: 2026-05-24T03:32:11.000Z
description: Configuracion de desarrollo local para sistema de asistencia biometrica
cia_integrity: high
cia_availability: medium
cia_sensitivity: restricted
agent: system
---

# Environment Variables: electron-fingerprint

_Configuracion de desarrollo local para sistema de asistencia biometrica_

## dev

| Nombre | Descripción | Requerida | Default | Sensible | Proveedor |
|---|---|---|---|---|---|
| `BIOMETRIC_ENGINE_PORT` | Puerto del servidor HTTP del motor biometrico .NET | ✓ | `8080` | — | env-file |
| `BIOMETRIC_ENGINE_HOST` | Host del motor biometrico, solo localhost por seguridad | — | `localhost` | — | env-file |
| `DB_PATH` | Ruta al archivo SQLite de la base de datos | — | `./data/asistencia.db` | — | env-file |
| `LOG_LEVEL` | Nivel de logging (debug/info/warn/error) | — | `info` | — | env-file |
| `FINGERPRINT_QUALITY_THRESHOLD` | Score minimo de calidad para aceptar una huella (0-100) | — | `60` | — | env-file |

