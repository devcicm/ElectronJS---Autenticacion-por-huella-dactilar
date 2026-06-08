---
title: "SLO: biometric-engine — Disponibilidad"
id: f2781051-31d6-417e-99e1-6750b3fe8fc6
createdAt: 2026-06-08T00:22:05.000Z
updatedAt: 2026-06-08T00:22:05.000Z
tags: ["slo", "observability", "electron-fingerprint", "biometric-engine", "availability"]
norm_refs: ["AP-11", "AP-12", "AP-13", "AP-16", "AP-20", "CN-01", "CN-02", "SP-01"]
project: electron-fingerprint
service: biometric-engine
slo_type: availability
target: 99.5
unit: %
window: 30d
alert_threshold: 99.002
iso_standard: ISO 20000-1:2018 §8.3
iso_quality: ISO/IEC 25010:2023 §4.2.1
cia_integrity: high
cia_availability: high
cia_sensitivity: internal
agent: claude
---

# SLO: biometric-engine — Disponibilidad

> Porcentaje del tiempo que el servicio está operativo y accesible.
> ISO/IEC 25010:2023 §4.2.1 — Reliability / Availability
> ISO 20000-1:2018 §8.3 — Service level management

## Definición del SLO

| Campo | Valor |
|---|---|
| **Proyecto** | electron-fingerprint |
| **Servicio** | biometric-engine |
| **Tipo** | availability — Disponibilidad |
| **SLO** | availability ≥ 99.5% |
| **Ventana** | 30d (rolling) |
| **Umbral de alerta** | ≥ 99.002% |
| **ISO característica** | Reliability / Availability |

## SLI (Service Level Indicator)

**Qué medir:** Porcentaje del tiempo que el servicio está operativo y accesible.

**Ejemplo de query:**
```
successful_requests / total_requests × 100
```

**Evento bueno:** HTTP 2xx/3xx en < 1s
**Evento malo:** HTTP 5xx, timeout > 1s, o servicio no alcanzable

**Fuente de datos:** _Pendiente: URL de dashboard o query de métrica_

## Error Budget

| Métrica | Valor |
|---|---|
| allowed_failure_pct | 0.5 |
| allowed_downtime_minutes | 216.0 |
| allowed_downtime_human | 3h 36m |
| burn_rate_1h | 0.3 |

## Alertas recomendadas (Multi-window, multi-burn-rate)

| Ventana | Burn rate | Severidad | Acción |
|---|---|---|---|
| 1h / 5m | 14.4× | P1 — página inmediato | Investigar ahora |
| 6h / 30m | 6× | P2 — página urgente | Investigar en < 1h |
| 3d / 6h | 1× | P3 — ticket | Investigar en próximos días |

## Consecuencias (SLA)

_Sin consecuencias contractuales definidas aún. Agregar penalidades o créditos si aplica._

## Descripción adicional

Disponibilidad del motor biometrico en horario laboral

## Historial de compliance

| Período | Valor medido | Cumplido | Error budget consumido |
|---|---|---|---|
| — | — | — | — |

## Referencias

- ISO 20000-1:2018 §8.3 — Service level management
- ISO/IEC 25010:2023 §4.2.1 — Reliability / Availability
- Google SRE Book — Chapter 4: Service Level Objectives
