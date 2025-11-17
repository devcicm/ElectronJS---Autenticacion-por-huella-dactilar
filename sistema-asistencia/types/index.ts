/**
 * Tipos TypeScript para el Sistema de Asistencia
 */

// ============================================================================
// EMPLEADOS
// ============================================================================

export interface Employee {
    id: number;
    employee_code: string;      // Código único del empleado
    first_name: string;
    last_name: string;
    email: string;
    phone?: string;
    department_id: number;
    shift_id: number;
    position: string;           // Puesto/Cargo
    hire_date: string;          // ISO date string
    status: 'active' | 'inactive' | 'suspended';
    photo_url?: string;
    enrollment_mode?: 'simple' | 'advanced';  // Modo de captura de huellas
    created_at: string;
    updated_at: string;
}

export interface EmployeeCreate {
    employee_code: string;
    first_name: string;
    last_name: string;
    email: string;
    phone?: string;
    department_id: number;
    shift_id: number;
    position: string;
    hire_date: string;
    status?: 'active' | 'inactive' | 'suspended';
    photo_url?: string;
    enrollment_mode?: 'simple' | 'advanced';
}

export interface EmployeeUpdate {
    id: number;
    employee_code?: string;
    first_name?: string;
    last_name?: string;
    email?: string;
    phone?: string;
    department_id?: number;
    shift_id?: number;
    position?: string;
    hire_date?: string;
    status?: 'active' | 'inactive' | 'suspended';
    photo_url?: string;
    enrollment_mode?: 'simple' | 'advanced';
}

// ============================================================================
// DEPARTAMENTOS
// ============================================================================

export interface Department {
    id: number;
    name: string;
    description?: string;
    manager_id?: number;        // ID del empleado que es gerente
    created_at: string;
    updated_at: string;
}

export interface DepartmentCreate {
    name: string;
    description?: string;
    manager_id?: number;
    color?: string;
}

export interface DepartmentUpdate {
    id: number;
    name?: string;
    description?: string;
    manager_id?: number;
    color?: string;
}

// ============================================================================
// TURNOS
// ============================================================================

export interface Shift {
    id: number;
    name: string;               // ej: "Matutino", "Vespertino", "Nocturno"
    start_time: string;         // HH:MM formato 24h
    end_time: string;           // HH:MM formato 24h
    tolerance_minutes: number;  // Minutos de tolerancia para llegada tarde
    color?: string;             // Color para UI (hex)
    created_at: string;
    updated_at: string;
}

export interface ShiftCreate {
    name: string;
    start_time: string;
    end_time: string;
    tolerance_minutes?: number;
    color?: string;
}

export interface ShiftUpdate {
    id: number;
    name?: string;
    start_time?: string;
    end_time?: string;
    tolerance_minutes?: number;
    color?: string;
}

// ============================================================================
// HUELLAS DACTILARES
// ============================================================================

export interface Fingerprint {
    id: number;
    employee_id: number;
    finger_position: FingerPosition;
    hand: 'LEFT' | 'RIGHT';
    template_data: string;      // Template biométrico (base64)
    quality_score: number;      // 0-100
    enrolled_at: string;
    created_at: string;
}

export interface FingerprintCreate {
    employee_id: number;
    finger_position: FingerPosition;
    hand: 'LEFT' | 'RIGHT';
    template_data: string;
    quality_score?: number;
}

export interface FingerprintUpdate {
    id: number;
    template_data?: string;
    quality_score?: number;
}

export type FingerPosition =
    | 'right_thumb' | 'right_index' | 'right_middle' | 'right_ring' | 'right_pinky'
    | 'left_thumb' | 'left_index' | 'left_middle' | 'left_ring' | 'left_pinky';

// ============================================================================
// REGISTROS DE ASISTENCIA
// ============================================================================

export interface AttendanceRecord {
    id: number;
    employee_id: number;
    date: string;               // ISO date string (solo fecha)
    check_in_time?: string;     // HH:MM:SS
    check_out_time?: string;    // HH:MM:SS
    status: AttendanceStatus;
    minutes_late: number;
    minutes_overtime: number;
    fingerprint_verified: boolean;
    notes?: string;
    created_at: string;
    updated_at: string;
}

export interface AttendanceRecordCreate {
    employee_id: number;
    date: string;
    check_in_time?: string;
    check_out_time?: string;
    status: AttendanceStatus;
    minutes_late?: number;
    minutes_overtime?: number;
    fingerprint_verified?: boolean;
    notes?: string;
}

export type AttendanceStatus =
    | 'present'         // Presente
    | 'late'           // Llegada tarde
    | 'absent'         // Ausente
    | 'excused'        // Falta justificada
    | 'half_day'       // Medio día
    | 'on_leave';      // En permiso

// ============================================================================
// VISTAS Y REPORTES
// ============================================================================

export interface EmployeeWithDetails extends Employee {
    department_name: string;
    shift_name: string;
    shift_start_time: string;
    shift_end_time: string;
    fingerprints_count: number;
}

export interface AttendanceWithDetails extends AttendanceRecord {
    employee_code: string;
    employee_name: string;
    department_name: string;
    shift_name: string;
}

export interface DailyAttendanceSummary {
    date: string;
    total_employees: number;
    present_count: number;
    late_count: number;
    absent_count: number;
    excused_count: number;
    on_leave_count: number;
    present_percentage: number;
}

export interface EmployeeAttendanceSummary {
    employee_id: number;
    employee_code: string;
    employee_name: string;
    department_name: string;
    period_start: string;
    period_end: string;
    total_days: number;
    present_days: number;
    late_days: number;
    absent_days: number;
    excused_days: number;
    total_minutes_late: number;
    average_check_in_time?: string;
    attendance_rate: number;
}

// ============================================================================
// CONFIGURACIÓN DEL SISTEMA
// ============================================================================

export interface AttendanceConfig {
    auto_mark_absent_time: string;  // Hora para marcar ausencias automáticas (HH:MM)
    require_checkout: boolean;       // Requiere marcar salida
    allow_manual_entry: boolean;     // Permite entrada manual de asistencia
    grace_period_minutes: number;    // Período de gracia general
    notification_enabled: boolean;   // Notificaciones activadas
}

// ============================================================================
// RESPUESTAS DE API
// ============================================================================

export interface ApiResponse<T> {
    success: boolean;
    data?: T;
    error?: string;
    message?: string;
}

export interface PaginatedResponse<T> {
    success: boolean;
    data: T[];
    total: number;
    page: number;
    per_page: number;
    total_pages: number;
}

// ============================================================================
// FILTROS Y BÚSQUEDA
// ============================================================================

export interface EmployeeFilters {
    department_id?: number;
    shift_id?: number;
    status?: 'active' | 'inactive' | 'suspended';
    search?: string;            // Búsqueda por nombre, código, email
}

export interface AttendanceFilters {
    employee_id?: number;
    department_id?: number;
    start_date?: string;
    end_date?: string;
    status?: AttendanceStatus;
}

// ============================================================================
// EVENTOS DEL SISTEMA
// ============================================================================

export type SystemEvent =
    | { type: 'employee:created'; data: Employee }
    | { type: 'employee:updated'; data: Employee }
    | { type: 'employee:deleted'; data: { id: number } }
    | { type: 'attendance:checked-in'; data: AttendanceRecord }
    | { type: 'attendance:checked-out'; data: AttendanceRecord }
    | { type: 'fingerprint:enrolled'; data: Fingerprint }
    | { type: 'system:error'; data: { error: string; context?: any } };
