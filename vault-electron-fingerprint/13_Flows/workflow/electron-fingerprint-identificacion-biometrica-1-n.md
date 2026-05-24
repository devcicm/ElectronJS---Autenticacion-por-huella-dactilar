---
id: 0233a550-5d7d-47d0-9a92-d33caf3a3eba
title: Identificacion Biometrica 1-N
project: electron-fingerprint
flow_type: workflow
type: flow
createdAt: 2026-05-24T03:30:40.000Z
updatedAt: 2026-05-24T03:30:40.000Z
tags: ["electron-fingerprint", "flow", "workflow"]
cia_integrity: medium
cia_availability: medium
cia_sensitivity: internal
agent: system
---

**Proyecto:** `electron-fingerprint`  |  **Tipo:** `workflow`


## Descripcion

Flujo de identificacion 1-N: el sistema captura una huella, carga todas las plantillas de SQLite, las envia al motor .NET para comparacion y registra la asistencia si hay coincidencia.

## Metadata

| Campo | Valor |
|---|---|
| **Trigger** | Empleado coloca dedo en sensor |
| **Actores** | `Empleado`, `BiometricService`, `SQLite`, `BiometricEngine .NET`, `AttendanceService` |
| **Pre-condicion** | Motor biometrico inicializado en localhost:8080, empleado enrolado con al menos una plantilla |
| **Post-condicion** | Registro de asistencia creado en attendance_records, UI notificada via IPC |

## Diagrama

```mermaid
flowchart TD
    A[Empleado coloca dedo\nen sensor DP4500] --> B[captureFingerprint\nvia /api/single]
    B --> C[Cargar todas las plantillas\nde SQLite fingerprints table]
    C --> D[POST /api/external/verify-multiple\narray de templates base64]
    D --> E{Score de coincidencia\n>= umbral?}
    E -->|Si| F[Identificar empleado\npor tag employee_id_fingerPos]
    E -->|No| G[Acceso denegado\nRegistrar intento fallido]
    F --> H[Registrar attendance_record\ncon check_in_time]
    H --> I[Notificar UI via IPC\nAcceso autorizado]
```