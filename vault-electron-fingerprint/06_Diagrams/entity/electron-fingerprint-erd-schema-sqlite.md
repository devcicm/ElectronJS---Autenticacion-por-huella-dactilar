---

title: ERD Schema SQLite

id: a6b85546-6b79-4f2e-9401-2cd1d2e3705e

project: electron-fingerprint

diagramType: mermaid

category: entity

createdAt: 2026-05-24T03:27:14.000Z

updatedAt: 2026-05-24T03:27:14.000Z

cia_integrity: medium

cia_availability: medium

cia_sensitivity: internal

agent: system

---

## Descripción

Diagrama entidad-relacion del schema SQLite. 5 tablas: departments, shifts, employees, fingerprints, attendance_records. Clave: fingerprints.template_data almacena plantilla ISO base64.

## Diagrama



```mermaid
erDiagram
    departments {
        int id PK
        string name
        string description
    }
    shifts {
        int id PK
        string name
        string start_time
        string end_time
        int tolerance_minutes
    }
    employees {
        int id PK
        string employee_number UK
        string first_name
        string last_name
        int department_id FK
        int shift_id FK
        string position
        bool is_active
    }
    fingerprints {
        int id PK
        int employee_id FK
        string hand
        string finger_position
        blob template_data
        int quality_score
    }
    attendance_records {
        int id PK
        int employee_id FK
        date date
        datetime check_in_time
        datetime check_out_time
        string status
    }
    employees ||--o{ fingerprints : "tiene"
    employees ||--o{ attendance_records : "registra"
    departments ||--o{ employees : "agrupa"
    shifts ||--o{ employees : "asigna"
```