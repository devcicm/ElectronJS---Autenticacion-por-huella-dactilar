---
title: biometric-engine
id: c93ed7e0-120a-47ca-b0f1-c2b0e72e6c61
type: service
location: local
createdAt: 2026-05-24T03:33:43.000Z
updatedAt: 2026-05-24T03:33:43.000Z
project: electron-fingerprint
status: active
tags: ["biometrico", "fingerprint", "dotnet"]
cia_integrity: medium
cia_availability: high
cia_sensitivity: internal
agent: system
---

## Descripción

Servidor HTTP del motor biometrico .NET. Expone API REST para captura, enrolamiento e identificacion 1-N via dispositivo DP4500 (Edge-URU-UI SDK). Proceso hijo de Electron.


## Configuración

- **ip**: `127.0.0.1`
- **port**: `8080`
- **protocol**: `HTTP`
- **runtime**: `.NET Framework 4.7.2`
- **sdk**: `Edge-URU-UI DP4500`