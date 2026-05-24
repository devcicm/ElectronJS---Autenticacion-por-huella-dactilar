---
title: Biometric Engine HTTP API — localhost:8080
id: afa4e30a-56d1-406e-84de-74ac25c73db8
category: api
createdAt: 2026-05-24T03:21:41.000Z
updatedAt: 2026-05-24T03:21:41.000Z
project: electron-fingerprint
tags: ["biometrico", "api", "fingerprint", "electron", "8080"]
cia_integrity: medium
cia_availability: medium
cia_sensitivity: internal
agent: system
---

El motor biometrico .NET expone una API HTTP REST via SSE bridge (sseBridge.ts) en localhost:8080.

**Endpoints principales:**

| Endpoint | Metodo | Descripcion |
|---|---|---|
| /api/init | POST | Inicializa el dispositivo DP4500 (Edge-URU-UI SDK) |
| /api/single | POST | Captura una sola huella sin asociar a empleado |
| /api/enroll | POST | Enrola plantilla de huella con tag employee_{id}_{fingerPos} |
| /api/external/verify-multiple | POST | Identificacion 1-N: recibe array de plantillas, retorna mejor coincidencia |
| /api/store-stats | GET | Estadisticas del store de plantillas en memoria del motor |
| /api/device-info | GET | Informacion del dispositivo biometrico conectado |

**Formato de enrolamiento:**
- Tag: employee_{employeeId}_{fingerPosition}
- Template: base64 ISO format

**Flujo de identificacion (1-N):**
1. Node.js carga todas las plantillas de SQLite
2. Envia array de {tag, templateBase64} a /api/external/verify-multiple
3. Motor compara con captura actual del sensor
4. Retorna tag del mejor match con score de confianza

**Nota de seguridad:** El servidor solo escucha en localhost. No expuesto a red externa.