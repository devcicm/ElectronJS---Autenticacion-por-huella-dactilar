---

title: Arquitectura del Sistema

id: b7bbf8c8-59f4-4247-baf2-959d72c6b229

project: electron-fingerprint

diagramType: mermaid

category: component

createdAt: 2026-05-24T03:25:58.000Z

updatedAt: 2026-05-24T03:25:58.000Z

cia_integrity: medium

cia_availability: medium

cia_sensitivity: internal

agent: system

---

## Descripción

Arquitectura de alto nivel: Renderer HTML/TS, Main Process (Electron + services + SQLite), Motor Biometrico .NET via SSE en localhost:8080

## Diagrama



```mermaid
graph TB
    subgraph Renderer["Renderer HTML + TypeScript"]
        UI[UI Components Enrollment / Verification]
    end
    subgraph Main["Main Process Electron + Node.js"]
        BS[BiometricService.ts]
        AS[AttendanceService.ts]
        DB[(SQLite)]
        IPC[IPC Bridge]
    end
    subgraph Engine["Biometric Engine .NET C#"]
        SSE[sseBridge.ts Node.js SSE Proxy]
        NET[.NET DLLs DP4500 SDK]
        DEV[Sensor Huella DP4500]
    end
    UI <-->|IPC| IPC
    IPC --> BS
    IPC --> AS
    BS <--> DB
    AS <--> DB
    BS -->|HTTP REST :8080| SSE
    SSE <--> NET
    NET <--> DEV
```