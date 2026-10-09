/**
 * Modelo de Asistencia
 */

import { DatabaseManager } from '../database/init.js';
import {
    AttendanceRecord,
    AttendanceRecordCreate,
    AttendanceUpdate,
    AttendanceWithDetails,
    AttendanceFilters,
    DailyAttendanceSummary,
    AttendanceStatus
} from '../types/index.js';
import { getLocalDateString, getLocalTimeString, timeToMinutes } from '../shared/date-utils.js';
import { safeParseInt, safeParseBoolean } from '../shared/object-utils.js';

export class AttendanceModel {
    constructor(private db: DatabaseManager) {}

    /**
     * Obtener todos los registros con filtros
     */
    getAll(filters?: AttendanceFilters): AttendanceRecord[] {
        let sql = 'SELECT * FROM attendance_records WHERE 1=1';
        const params: any[] = [];

        if (filters?.employee_id) {
            sql += ' AND employee_id = ?';
            params.push(filters.employee_id);
        }

        if (filters?.start_date) {
            sql += ' AND date >= ?';
            params.push(filters.start_date);
        }

        if (filters?.end_date) {
            sql += ' AND date <= ?';
            params.push(filters.end_date);
        }

        if (filters?.status) {
            sql += ' AND status = ?';
            params.push(filters.status);
        }

        sql += ' ORDER BY date DESC, check_in_time DESC';

        return this.db.query<AttendanceRecord>(sql, params);
    }

    /**
     * Obtener registros con detalles completos
     */
    getAllWithDetails(filters?: AttendanceFilters): AttendanceWithDetails[] {
        let sql = 'SELECT * FROM attendance_with_details WHERE 1=1';
        const params: any[] = [];

        if (filters?.employee_id) {
            sql += ' AND employee_id = ?';
            params.push(filters.employee_id);
        }

        if (filters?.department_id) {
            sql += ' AND employee_id IN (SELECT id FROM employees WHERE department_id = ?)';
            params.push(filters.department_id);
        }

        if (filters?.start_date) {
            sql += ' AND date >= ?';
            params.push(filters.start_date);
        }

        if (filters?.end_date) {
            sql += ' AND date <= ?';
            params.push(filters.end_date);
        }

        if (filters?.status) {
            sql += ' AND status = ?';
            params.push(filters.status);
        }

        sql += ' ORDER BY date DESC, check_in_time DESC';

        return this.db.query<AttendanceWithDetails>(sql, params);
    }

    /**
     * Obtener registro por ID
     */
    getById(id: number): AttendanceRecord | undefined {
        return this.db.queryOne<AttendanceRecord>(
            'SELECT * FROM attendance_records WHERE id = ?',
            [id]
        );
    }

    /**
     * Obtener registro de un empleado en una fecha específica
     */
    getByEmployeeAndDate(employeeId: number, date: string): AttendanceRecord | undefined {
        return this.db.queryOne<AttendanceRecord>(
            'SELECT * FROM attendance_records WHERE employee_id = ? AND date = ?',
            [employeeId, date]
        );
    }

    /**
     * Obtener registros de hoy
     */
    getToday(): AttendanceWithDetails[] {
        const today = getLocalDateString();
        return this.getAllWithDetails({ start_date: today, end_date: today });
    }

    /**
     * Crear registro de asistencia
     */
    create(data: AttendanceRecordCreate): AttendanceRecord {
        if (!data || typeof data !== 'object') {
            throw new Error('Datos de asistencia inválidos o no proporcionados');
        }

        const empId = safeParseInt(data.employee_id, 0);
        if (empId <= 0) {
            throw new Error('ID de empleado inválido');
        }

        const result = this.db.execute(
            `INSERT INTO attendance_records (
                employee_id, date, check_in_time, check_out_time, status,
                minutes_late, minutes_overtime, fingerprint_verified, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                empId,
                String(data.date || '').trim(),
                data.check_in_time ? String(data.check_in_time).trim() : null,
                data.check_out_time ? String(data.check_out_time).trim() : null,
                data.status,
                safeParseInt(data.minutes_late, 0),
                safeParseInt(data.minutes_overtime, 0),
                safeParseBoolean(data.fingerprint_verified, false) ? 1 : 0,
                data.notes ? String(data.notes).trim() : null
            ]
        );

        const record = this.getById(result.lastInsertRowid as number);
        if (!record) {
            throw new Error('Error creando registro de asistencia');
        }

        return record;
    }

    /**
     * Marcar entrada (check-in)
     */
    checkIn(employeeId: number, fingerprintVerified: boolean = false): AttendanceRecord {
        const now = new Date();
        const date = getLocalDateString(now);
        const time = getLocalTimeString(now);

        // Verificar si ya existe registro para hoy
        const existing = this.getByEmployeeAndDate(employeeId, date);
        if (existing) {
            throw new Error('Ya existe un registro de asistencia para hoy');
        }

        // Obtener información del turno del empleado
        const employee = this.db.queryOne<any>(
            `SELECT e.*, s.start_time, s.tolerance_minutes
             FROM employees e
             LEFT JOIN shifts s ON e.shift_id = s.id
             WHERE e.id = ?`,
            [employeeId]
        );

        if (!employee) {
            throw new Error('Empleado no encontrado');
        }

        // Calcular minutos de retraso
        const minutesLate = this.calculateLateMinutes(time, employee.start_time, employee.tolerance_minutes);

        // Determinar estado
        let status: AttendanceStatus = 'present';
        if (minutesLate > 0) {
            status = 'late';
        }

        return this.create({
            employee_id: employeeId,
            date,
            check_in_time: time,
            status,
            minutes_late: minutesLate,
            fingerprint_verified: fingerprintVerified
        });
    }

    /**
     * Marcar salida (check-out)
     */
    checkOut(employeeId: number): AttendanceRecord {
        const now = new Date();
        const date = getLocalDateString(now);
        const time = getLocalTimeString(now);

        // Buscar registro del día
        const record = this.getByEmployeeAndDate(employeeId, date);
        if (!record) {
            throw new Error('No hay registro de entrada para hoy');
        }

        if (record.check_out_time) {
            throw new Error('Ya se registró la salida');
        }

        // Obtener hora de fin del turno
        const employee = this.db.queryOne<any>(
            `SELECT e.*, s.end_time
             FROM employees e
             LEFT JOIN shifts s ON e.shift_id = s.id
             WHERE e.id = ?`,
            [employeeId]
        );

        // Calcular tiempo extra
        const minutesOvertime = this.calculateOvertimeMinutes(time, employee?.end_time || '18:00');

        // Actualizar registro
        this.db.execute(
            `UPDATE attendance_records
             SET check_out_time = ?, minutes_overtime = ?
             WHERE id = ?`,
            [time, minutesOvertime, record.id]
        );

        const updated = this.getById(record.id);
        if (!updated) {
            throw new Error('Error actualizando registro');
        }

        return updated;
    }

    /**
     * Calcular minutos de retraso
     */
    private calculateLateMinutes(checkInTime: string, shiftStartTime?: string, toleranceMinutes?: number): number {
        if (!shiftStartTime || typeof shiftStartTime !== 'string') return 0;
        const checkIn = this.timeToMinutes(checkInTime);
        const shiftStart = this.timeToMinutes(shiftStartTime);
        const tolerance = safeParseInt(toleranceMinutes, 0);

        const diff = checkIn - shiftStart - tolerance;
        return diff > 0 ? diff : 0;
    }

    /**
     * Calcular minutos de tiempo extra
     */
    private calculateOvertimeMinutes(checkOutTime: string, shiftEndTime?: string): number {
        if (!shiftEndTime || typeof shiftEndTime !== 'string') return 0;
        const checkOut = this.timeToMinutes(checkOutTime);
        const shiftEnd = this.timeToMinutes(shiftEndTime);

        const diff = checkOut - shiftEnd;
        return diff > 0 ? diff : 0;
    }

    /**
     * Convertir tiempo HH:MM a minutos (delega a date-utils)
     */
    private timeToMinutes(time: string): number {
        return timeToMinutes(time);
    }

    /**
     * Obtener resumen de asistencia diaria
     */
    getDailySummary(date?: string): DailyAttendanceSummary | undefined {
        const targetDate = date || getLocalDateString();

        return this.db.queryOne<DailyAttendanceSummary>(
            'SELECT * FROM daily_attendance_summary WHERE date = ?',
            [targetDate]
        );
    }

    /**
     * Obtener estadísticas del día actual
     */
    getTodayStats(): {
        total_employees: number;
        present: number;
        late: number;
        absent: number;
        present_percentage: number;
    } {
        const today = getLocalDateString();
        const summary = this.getDailySummary(today);

        if (!summary) {
            return {
                total_employees: 0,
                present: 0,
                late: 0,
                absent: 0,
                present_percentage: 0
            };
        }

        return {
            total_employees: summary.total_employees,
            present: summary.present_count,
            late: summary.late_count,
            absent: summary.absent_count,
            present_percentage: summary.present_percentage
        };
    }

    /**
     * Marcar ausentes automáticamente
     */
    markAbsentees(date?: string): number {
        const targetDate = date || getLocalDateString();

        // Operación atómica de base de datos e idempotente (evita N round-trips en JS)
        const result = this.db.execute(
            `INSERT INTO attendance_records (
                employee_id, date, status, minutes_late, minutes_overtime, fingerprint_verified
             )
             SELECT e.id, ?, 'absent', 0, 0, 0
             FROM employees e
             WHERE e.status = 'active'
             AND NOT EXISTS (
                 SELECT 1 FROM attendance_records ar
                 WHERE ar.employee_id = e.id AND ar.date = ?
             )`,
            [targetDate, targetDate]
        );

        return result.changes;
    }

    /**
     * Actualizar un registro de asistencia existente (idempotente y seguro)
     */
    update(id: number, data: Partial<AttendanceUpdate>): AttendanceRecord | undefined {
        const recId = safeParseInt(id, 0);
        if (recId <= 0) return undefined;

        const existing = this.getById(recId);
        if (!existing) return undefined;

        const updates: string[] = [];
        const params: any[] = [];

        if (data.status !== undefined) {
            updates.push('status = ?');
            params.push(data.status);
        }

        if (data.notes !== undefined) {
            updates.push('notes = ?');
            params.push(data.notes ? String(data.notes).trim() : null);
        }

        if (data.check_in_time !== undefined) {
            updates.push('check_in_time = ?');
            params.push(data.check_in_time ? String(data.check_in_time).trim() : null);
        }

        if (data.check_out_time !== undefined) {
            updates.push('check_out_time = ?');
            params.push(data.check_out_time ? String(data.check_out_time).trim() : null);
        }

        if (data.minutes_late !== undefined) {
            updates.push('minutes_late = ?');
            params.push(safeParseInt(data.minutes_late, 0));
        }

        if (data.minutes_overtime !== undefined) {
            updates.push('minutes_overtime = ?');
            params.push(safeParseInt(data.minutes_overtime, 0));
        }

        if (updates.length === 0) return existing;

        updates.push("updated_at = datetime('now')");
        params.push(recId);

        this.db.execute(
            `UPDATE attendance_records SET ${updates.join(', ')} WHERE id = ?`,
            params
        );

        return this.getById(recId);
    }

    /**
     * Justificar una falta / inasistencia
     */
    justifyAbsence(id: number, notes: string, status: AttendanceStatus = 'excused'): AttendanceRecord | undefined {
        return this.update(id, { status, notes });
    }

    /**
     * Justificar o registrar una inasistencia justificada por empleado y fecha
     */
    justifyOrUpsertAbsence(employeeId: number, date: string, notes: string, status: AttendanceStatus = 'excused'): AttendanceRecord {
        const empId = safeParseInt(employeeId, 0);
        if (empId <= 0) throw new Error('ID de empleado inválido');
        const existing = this.getByEmployeeAndDate(empId, date);
        if (existing) {
            const updated = this.justifyAbsence(existing.id, notes, status);
            if (!updated) throw new Error('No se pudo actualizar el registro de asistencia');
            return updated;
        }

        return this.create({
            employee_id: empId,
            date,
            status,
            notes,
            minutes_late: 0,
            minutes_overtime: 0,
            fingerprint_verified: false
        });
    }
}
