---
title: electron-fingerprint — Infraestructura
id: 3eecd83a-04da-444f-9d0a-562f86277324
createdAt: 2026-06-02T07:46:09.000Z
updatedAt: 2026-06-02T07:46:09.000Z
tags: ["stub", "infrastructure", "electron-fingerprint"]
norm_refs: ["AP-11", "AP-12", "AP-13", "AP-16", "AP-20", "CN-01", "CN-02", "SP-01"]
status: stub
cia_integrity: medium
cia_availability: medium
cia_sensitivity: internal
agent: claude
project: electron-fingerprint
---

# electron-fingerprint — Infraestructura

> Stub generado por vault_onboard desde archivos de configuración detectados.

## Archivos detectados

- `docker-compose.yml`
- `Dockerfile`

## Servicios (docker-compose)

- `electron-app`
- `biometric-server`
- `asistencia-network`
- `db-data`

## Puertos expuestos

- `5173:5173`
- `3001:3000`
- `3000:3000`
- `5173`

## Variables de entorno (.env)

— No detectadas

## Imagen base

node:18-bullseye

## Próximos pasos

- Verificar servicios y puertos reales
- Documentar con vault_infra_save para cada componente
- Agregar variables con vault_env_save

## Imagen base Docker

node:18-bullseye

## Para enriquecer

```bash
python scripts/vault_infra_save.py --project electron-fingerprint --component "..."
python scripts/vault_env_save.py --project electron-fingerprint --env_file ".env"
```
