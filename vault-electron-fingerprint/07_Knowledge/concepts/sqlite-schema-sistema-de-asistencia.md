---
title: SQLite Schema — Sistema de Asistencia
id: 592053f9-f3b4-48bb-a3ca-75d6a13e4d03
category: concept
createdAt: 2026-05-24T03:04:58.000Z
updatedAt: 2026-05-24T03:04:58.000Z
project: electron-fingerprint
tags: ["sqlite", "schema", "biometrico", "asistencia"]
cia_integrity: medium
cia_availability: medium
cia_sensitivity: internal
agent: system
---

El sistema utiliza SQLite via better-sqlite3 con las siguientes entidades principales:

**Tablas:**
- departments: id, name, description
- shifts: id, name, start_time, end_time, tolerance_minutes
- employees: id, employee_number (UNIQUE), first_name, last_name, department_id (FK), shift_id (FK), position, email, phone, hire_date, is_active
- fingerprints: id, employee_id (FK), hand (LEFT/RIGHT), finger_position, template_data (BLOB base64 ISO), quality_score (0-100). UNIQUE(employee_id, hand, finger_position)
- attendance_records: id, employee_id (FK), date, check_in_time, check_out_time, status (ON_TIME/LATE/EARLY_DEPARTURE/ABSENT)

**Vistas:** employees_with_details, attendance_with_details, daily_attendance_summary

**Triggers:** updated_at auto-actualizado en todas las tablas

**Invariantes:** quality_score CHECK 0-100, hand CHECK IN (LEFT, RIGHT), UNIQUE(employee_id, hand, finger_position)