---
title: Infrastructure Map
updatedAt: 2026-05-24T03:34:19.000Z
project: electron-fingerprint
location: local
---

## Network Map

```mermaid
graph LR
    subgraph local["🏠 Local"]
        biometric-engine⚙️ biometric-engine
:8080
        sqlite-asistencia("sqlite-asistencia
:0)
    end
    sqlite-asistencia -->|"N/A:"| biometric-engine
```
