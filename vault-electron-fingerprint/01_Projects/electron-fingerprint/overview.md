---
title: Overview: electron-fingerprint
project: electron-fingerprint
type: project-overview
updatedAt: 2026-05-24T02:56:01.000Z
---

# Overview: electron-fingerprint


## Descripción

Aplicacion de escritorio ElectronJS para autenticacion y control de asistencia mediante huella dactilar. Motor biometrico .NET con dispositivo DP4500, almacena plantillas ISO en SQLite.


_Actualizado: 2026-05-24 · deps: 0 · frameworks: 0 · ADRs: 0 · patrones: 0_


## Stack técnico

- **Runtime:** Node.js 20 / Electron 31.3.1 / TypeScript
- **DB:** [[sqlite-asistencia]] — SQLite via better-sqlite3
- **Biometrico:** [[biometric-engine]] — Motor .NET DP4500 en localhost:8080

## Documentación técnica

- [[biometricservice]] — Servicio principal TypeScript de autenticacion biometrica
- [[sqlite-schema-sistema-de-asistencia]] — Schema SQLite detallado (5 tablas + vistas + triggers)
- [[biometric-engine-http-api-localhost8080]] — API HTTP del motor biometrico
- [[electron-fingerprint-arquitectura-del-sistema]] — Diagrama de arquitectura de alto nivel
- [[electron-fingerprint-erd-schema-sqlite]] — ERD del schema SQLite
- [[electron-fingerprint-identificacion-biometrica-1-n]] — Flujo de identificacion 1-N
- [[electron-fingerprint-enrolamiento-de-huella-dactilar]] — Flujo de enrolamiento
- [[envs]] — Variables de entorno por ambiente
