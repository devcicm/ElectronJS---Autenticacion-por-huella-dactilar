---
id: 126acb19-8411-47bc-b7ee-7a3a7268382f
title: BiometricService.ts
project: electron-fingerprint
file_path: sistema-asistencia/services/BiometricService.ts
type: code-module
language: typescript
iso_type: service
createdAt: 2026-05-24T02:58:05.000Z
updatedAt: 2026-05-24T02:58:05.000Z
tags: ["biometrico", "fingerprint", "sqlite", "electron", "electron-fingerprint", "code", "biometricservice", "service"]
---

**Ruta:** `sistema-asistencia/services/BiometricService.ts`  |  **Lenguaje:** `typescript`  |  **Tipo ISO:** `service`


## Proposito

Servicio principal de autenticacion biometrica. Gestiona comunicacion con motor .NET (localhost:8080), enrolamiento de huellas y identificacion 1-N contra plantillas en SQLite.

## Metodos

| Metodo | Firma | Descripcion |
|---|---|---|
| `initBiometricServer` | `async initBiometricServer(): Promise<boolean>` | Inicializa servidor biometrico .NET en localhost:8080 |
| `enrollFingerprint` | `async enrollFingerprint(employeeId: number, fingerPosition: string): Promise<EnrollResult>` | Enrola huella dactilar via /api/enroll |
| `identifyEmployee` | `async identifyEmployee(): Promise<IdentifyResult>` | Identifica empleado cargando plantillas de SQLite y enviando a /api/external/verify-multiple |
| `captureFingerprint` | `async captureFingerprint(): Promise<CaptureResult>` | Captura huella unica via /api/single sin asociar a empleado |

## Exportaciones


- BiometricService
- EnrollResult
- IdentifyResult
- CaptureResult

## Importaciones desde


- `better-sqlite3`
- `eventsource`
- `BiometricEngine HTTP API`

## Responsabilidades


- Comunicacion con motor biometrico via HTTP REST
- Enrolamiento de plantillas ISO base64
- Identificacion 1-N contra todas las plantillas
- Almacenamiento de plantillas en SQLite