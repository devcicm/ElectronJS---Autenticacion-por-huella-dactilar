---
title: sqlite-asistencia
id: 4618bc36-9411-4ae7-8109-8710719e076a
type: database
location: local
createdAt: 2026-05-24T03:34:19.000Z
updatedAt: 2026-05-24T03:34:19.000Z
project: electron-fingerprint
status: active
tags: ["sqlite", "database", "biometrico"]
cia_integrity: high
cia_availability: high
cia_sensitivity: internal
agent: system
---

## Descripción

Base de datos SQLite del sistema de asistencia. Almacena empleados, departamentos, turnos, plantillas biometricas ISO base64 y registros de asistencia. Acceso via better-sqlite3 en el Main Process de Electron.


## Configuración

- **port**: `0`
- **version**: `3.x`
- **driver**: `better-sqlite3`
- **schema**: `5 tablas + 3 vistas + triggers`
- **file**: `./data/asistencia.db`

## Conexiones

- → **biometric-engine** (N/A:)
  - BiometricService carga plantillas de SQLite y las envia al motor