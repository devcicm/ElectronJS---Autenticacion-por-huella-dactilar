-- ============================================================================
-- ESQUEMA DE BASE DE DATOS - SISTEMA DE ASISTENCIA
-- ============================================================================

-- ============================================================================
-- TABLA: departments (Departamentos)
-- ============================================================================
CREATE TABLE IF NOT EXISTS departments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    manager_id INTEGER,
    is_default INTEGER NOT NULL DEFAULT 0,  -- N1: marca las filas base (1-5) para reset seguro
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_departments_name ON departments(name);

-- ============================================================================
-- TABLA: shifts (Turnos)
-- ============================================================================
CREATE TABLE IF NOT EXISTS shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    start_time TEXT NOT NULL,          -- HH:MM
    end_time TEXT NOT NULL,            -- HH:MM
    tolerance_minutes INTEGER NOT NULL DEFAULT 0,
    color TEXT DEFAULT '#3B82F6',
    is_default INTEGER NOT NULL DEFAULT 0,  -- N1: marca las filas base (1-4) para reset seguro
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_shifts_name ON shifts(name);

-- ============================================================================
-- TABLA: employees (Empleados)
-- ============================================================================
CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_code TEXT NOT NULL UNIQUE,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    phone TEXT,
    department_id INTEGER NOT NULL,
    shift_id INTEGER NOT NULL,
    position TEXT NOT NULL,
    hire_date TEXT NOT NULL,           -- ISO date
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'inactive', 'suspended')),
    photo_url TEXT,
    enrollment_mode TEXT DEFAULT 'simple' CHECK(enrollment_mode IN ('simple', 'advanced')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),

    FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE RESTRICT,
    FOREIGN KEY (shift_id) REFERENCES shifts(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_employees_code ON employees(employee_code);
CREATE INDEX IF NOT EXISTS idx_employees_email ON employees(email);
CREATE INDEX IF NOT EXISTS idx_employees_department ON employees(department_id);
CREATE INDEX IF NOT EXISTS idx_employees_shift ON employees(shift_id);
CREATE INDEX IF NOT EXISTS idx_employees_status ON employees(status);
CREATE INDEX IF NOT EXISTS idx_employees_name ON employees(last_name, first_name);

-- ============================================================================
-- TABLA: fingerprints (Huellas Dactilares)
-- ============================================================================
CREATE TABLE IF NOT EXISTS fingerprints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL,
    finger_position TEXT NOT NULL CHECK(finger_position IN ('THUMB', 'INDEX', 'MIDDLE', 'RING', 'PINKY')),
    hand TEXT NOT NULL CHECK(hand IN ('LEFT', 'RIGHT')),
    template_data TEXT NOT NULL,      -- Base64 encoded template
    quality_score INTEGER DEFAULT 0,  -- 0-100
    enrolled_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),

    FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,

    -- Un empleado no puede tener el mismo dedo registrado dos veces
    UNIQUE(employee_id, hand, finger_position)
);

CREATE INDEX IF NOT EXISTS idx_fingerprints_employee ON fingerprints(employee_id);
CREATE INDEX IF NOT EXISTS idx_fingerprints_hand_finger ON fingerprints(hand, finger_position);

-- ============================================================================
-- TABLA: attendance_records (Registros de Asistencia)
-- ============================================================================
CREATE TABLE IF NOT EXISTS attendance_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL,
    date TEXT NOT NULL,                -- ISO date (YYYY-MM-DD)
    check_in_time TEXT,                -- HH:MM:SS
    check_out_time TEXT,               -- HH:MM:SS
    status TEXT NOT NULL DEFAULT 'present' CHECK(status IN ('present', 'late', 'absent', 'excused', 'half_day', 'on_leave')),
    minutes_late INTEGER NOT NULL DEFAULT 0,
    minutes_overtime INTEGER NOT NULL DEFAULT 0,
    fingerprint_verified INTEGER NOT NULL DEFAULT 0,  -- Boolean (0 o 1)
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),

    FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,

    -- Un empleado solo puede tener un registro por día
    UNIQUE(employee_id, date)
);

CREATE INDEX IF NOT EXISTS idx_attendance_employee ON attendance_records(employee_id);
CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance_records(date);
CREATE INDEX IF NOT EXISTS idx_attendance_employee_date ON attendance_records(employee_id, date);
CREATE INDEX IF NOT EXISTS idx_attendance_status ON attendance_records(status);

-- ============================================================================
-- TABLA: system_config (Configuración del Sistema)
-- ============================================================================
CREATE TABLE IF NOT EXISTS system_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    description TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Valores por defecto de configuración
INSERT OR IGNORE INTO system_config (key, value, description) VALUES
    ('auto_mark_absent_time', '09:00', 'Hora para marcar ausencias automáticas (HH:MM)'),
    ('require_checkout', '1', 'Requiere marcar salida (1=sí, 0=no)'),
    ('allow_manual_entry', '1', 'Permite entrada manual de asistencia (1=sí, 0=no)'),
    ('grace_period_minutes', '10', 'Período de gracia en minutos'),
    ('notification_enabled', '1', 'Notificaciones activadas (1=sí, 0=no)');

-- ============================================================================
-- VISTAS
-- ============================================================================

-- Vista: employees_with_details
-- Empleados con información completa de departamento y turno
CREATE VIEW IF NOT EXISTS employees_with_details AS
SELECT
    e.*,
    d.name AS department_name,
    s.name AS shift_name,
    s.start_time AS shift_start_time,
    s.end_time AS shift_end_time,
    (SELECT COUNT(*) FROM fingerprints WHERE employee_id = e.id) AS fingerprints_count
FROM employees e
LEFT JOIN departments d ON e.department_id = d.id
LEFT JOIN shifts s ON e.shift_id = s.id;

-- Vista: attendance_with_details
-- Registros de asistencia con información completa del empleado
CREATE VIEW IF NOT EXISTS attendance_with_details AS
SELECT
    ar.*,
    e.employee_code,
    e.first_name || ' ' || e.last_name AS employee_name,
    d.name AS department_name,
    s.name AS shift_name,
    s.start_time AS shift_start_time,
    s.end_time AS shift_end_time
FROM attendance_records ar
LEFT JOIN employees e ON ar.employee_id = e.id
LEFT JOIN departments d ON e.department_id = d.id
LEFT JOIN shifts s ON e.shift_id = s.id;

-- Vista: daily_attendance_summary
-- Resumen de asistencia diaria
CREATE VIEW IF NOT EXISTS daily_attendance_summary AS
SELECT
    date,
    COUNT(DISTINCT employee_id) AS total_employees,
    SUM(CASE WHEN status = 'present' THEN 1 ELSE 0 END) AS present_count,
    SUM(CASE WHEN status = 'late' THEN 1 ELSE 0 END) AS late_count,
    SUM(CASE WHEN status = 'absent' THEN 1 ELSE 0 END) AS absent_count,
    SUM(CASE WHEN status = 'excused' THEN 1 ELSE 0 END) AS excused_count,
    SUM(CASE WHEN status = 'on_leave' THEN 1 ELSE 0 END) AS on_leave_count,
    ROUND(
        (SUM(CASE WHEN status IN ('present', 'late') THEN 1 ELSE 0 END) * 100.0) /
        COUNT(DISTINCT employee_id),
        2
    ) AS present_percentage
FROM attendance_records
GROUP BY date
ORDER BY date DESC;

-- ============================================================================
-- TRIGGERS
-- ============================================================================

-- Trigger: Actualizar updated_at en employees
CREATE TRIGGER IF NOT EXISTS update_employees_timestamp
AFTER UPDATE ON employees
BEGIN
    UPDATE employees SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- Trigger: Actualizar updated_at en departments
CREATE TRIGGER IF NOT EXISTS update_departments_timestamp
AFTER UPDATE ON departments
BEGIN
    UPDATE departments SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- Trigger: Actualizar updated_at en shifts
CREATE TRIGGER IF NOT EXISTS update_shifts_timestamp
AFTER UPDATE ON shifts
BEGIN
    UPDATE shifts SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- Trigger: Actualizar updated_at en attendance_records
CREATE TRIGGER IF NOT EXISTS update_attendance_timestamp
AFTER UPDATE ON attendance_records
BEGIN
    UPDATE attendance_records SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- Trigger: Actualizar updated_at en system_config
CREATE TRIGGER IF NOT EXISTS update_config_timestamp
AFTER UPDATE ON system_config
BEGIN
    UPDATE system_config SET updated_at = datetime('now') WHERE key = NEW.key;
END;

-- ============================================================================
-- DATOS INICIALES
-- ============================================================================

-- Departamentos de ejemplo (N1: is_default=1 marca filas base para reset seguro)
INSERT OR IGNORE INTO departments (id, name, description, is_default) VALUES
    (1, 'Recursos Humanos', 'Gestión de personal y recursos humanos', 1),
    (2, 'Tecnología', 'Departamento de TI y desarrollo', 1),
    (3, 'Ventas', 'Equipo de ventas y comercial', 1),
    (4, 'Administración', 'Administración y finanzas', 1),
    (5, 'Operaciones', 'Operaciones y logística', 1);

-- Turnos de ejemplo (N1: is_default=1 marca filas base para reset seguro)
INSERT OR IGNORE INTO shifts (id, name, start_time, end_time, tolerance_minutes, color, is_default) VALUES
    (1, 'Matutino', '08:00', '16:00', 10, '#3B82F6', 1),
    (2, 'Vespertino', '14:00', '22:00', 10, '#F59E0B', 1),
    (3, 'Nocturno', '22:00', '06:00', 15, '#8B5CF6', 1),
    (4, 'Administrativo', '09:00', '18:00', 15, '#10B981', 1);

-- ============================================================================
-- FIN DEL ESQUEMA
-- ============================================================================
