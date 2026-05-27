---
id: 77a17b42-7081-4475-a538-1208b8d9188f
title: Enrolamiento de Huella Dactilar
project: electron-fingerprint
flow_type: workflow
type: flow
createdAt: 2026-05-24T03:31:17.000Z
updatedAt: 2026-05-24T03:31:17.000Z
tags: ["electron-fingerprint", "workflow", "workflow"]
cia_integrity: medium
cia_availability: medium
cia_sensitivity: internal
agent: system
---

**Proyecto:** `electron-fingerprint`  |  **Tipo:** `workflow`


## Descripcion

Flujo de enrolamiento: el administrador selecciona empleado y posicion del dedo. El motor .NET captura y evalua calidad, retorna plantilla base64 que se almacena en SQLite con constraint UNIQUE.

## Metadata

| Campo | Valor |
|---|---|
| **Trigger** | Administrador inicia enrolamiento desde UI |
| **Actores** | `Administrador`, `BiometricService`, `BiometricEngine .NET`, `SQLite` |
| **Pre-condicion** | Motor biometrico inicializado, empleado existente en BD |
| **Post-condicion** | Plantilla ISO base64 almacenada en fingerprints, quality_score registrado |

## Diagrama

```mermaid
flowchart TD
    A[Admin selecciona empleado\ny posicion del dedo] --> B[POST /api/enroll\ntag: employee_{id}_{fingerPos}]
    B --> C[Motor DP4500 captura\nhuellas multiples para calidad]
    C --> D{quality_score\n>= 60?}
    D -->|Si| E[templateBase64 retornado\npor motor .NET]
    D -->|No| F[Reintentar captura\nmensaje de calidad baja]
    E --> G[INSERT INTO fingerprints\ntemplate_data, quality_score]
    G --> H[UNIQUE constraint\nemployee_id + hand + finger_pos]
    H -->|Nuevo| I[Enrolamiento completado\nUI notificada]
    H -->|Existe| J[UPDATE plantilla existente\npor misma posicion]
```