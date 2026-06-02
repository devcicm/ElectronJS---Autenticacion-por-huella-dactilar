---
title: Test v29 Delta
id: 2fcc3ed5-20f6-4eb6-9101-f3b6c1dbb6e9
createdAt: 2026-05-27T08:05:38.000Z
updatedAt: 2026-05-27T08:09:36.000Z
tags: ["test", "v29", "delta", "hash"]
cia_integrity: low
cia_availability: low
cia_sensitivity: internal
agent: system
---

# Test v29 Delta

Esta nota fue **modificada** para probar la deteccion de cambios de vault_delta.

## Objetivo
Verificar que el sistema detecta cambios entre sesiones correctamente mediante SHA-256.

## Componentes bajo prueba
- vault_delta: deteccion de cambios via SHA-256 + BFS sobre grafo inverso
- vault_tags: registro canonico, orphans, near-duplicados
- vault_backup: arbol Merkle en manifest + --verify

## Resultado esperado
vault_delta debe reportar esta nota en 'changed' al comparar contra el snapshot anterior.