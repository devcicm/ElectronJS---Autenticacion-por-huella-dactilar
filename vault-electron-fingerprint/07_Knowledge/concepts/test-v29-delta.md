---
title: Test v29 Delta
id: 2fcc3ed5-20f6-4eb6-9101-f3b6c1dbb6e9
createdAt: 2026-05-27T08:05:38.000Z
updatedAt: 2026-05-27T08:17:41.000Z
tags: ["test", "electron-fingerprint", "database"]
cia_integrity: low
cia_availability: low
cia_sensitivity: internal
agent: system
---

# Test v29 Delta

Esta nota verifica el funcionamiento de vault_delta y vault_tags en v29.

## Objetivo
Confirmar deteccion de cambios entre sesiones y registro canonico de tags.

## Componentes probados
- vault_delta: SHA-256 por nota + BFS sobre grafo inverso → detecta changed/added/stale_deps
- vault_tags: registry canonico en 00_System/tag-registry.json, near-dup audit, rename
- vault_backup: arbol Merkle en .manifest.json + --verify para integridad

## Tags canonicos aplicados
- electron-fingerprint: tag de proyecto (consolidado desde electron)
- database: cubre hash-index.json como artefacto de datos
- workflow: consolidado desde flow en los flujos biometricos

## Resultado
vault_audit incluye bloque tagHealth con score, near-dupes y notas sin tag.