/**
 * Modelo de Asistencia
 */

import { DatabaseManager } from '../database/init.js';
import {
    AttendanceRecord,
    AttendanceRecordCreate,
    AttendanceWithDetails,
    AttendanceFilters,
    DailyAttendanceSummary,
    AttendanceStatus
} from '../types/index.js';
import { getLocalDateString, getLocalTimeString } from '../shared/date-utils.js';

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
            sql += ' AND department_id = ?';
            params.push(filters?.department_id);
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
        const result = this.db.execute(
            `INSERT INTO attendance_records (
                employee_id, date, check_in_time, check_out_time, status,
                minutes_late, minutes_overtime, fingerprint_verified, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                data.employee_id,
                data.date,
                data.check_in_time || null,
                data.check_out_time || null,
                data.status,
                data.minutes_late || 0,
                data.minutes_overtime || 0,
                data.fingerprint_verified ? 1 : 0,
                data.notes || null
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
    private calculateLateMinutes(checkInTime: string, shiftStartTime: string, toleranceMinutes: number): number {
        const checkIn = this.timeToMinutes(checkInTime);
        const shiftStart = this.timeToMinutes(shiftStartTime);
        const tolerance = toleranceMinutes || 0;

        const diff = checkIn - shiftStart - tolerance;
        return diff > 0 ? diff : 0;
    }

    /**
     * Calcular minutos de tiempo extra
     */
    private calculateOvertimeMinutes(checkOutTime: string, shiftEndTime: string): number {
        const checkOut = this.timeToMinutes(checkOutTime);
        const shiftEnd = this.timeToMinutes(shiftEndTime);

        const diff = checkOut - shiftEnd;
        return diff > 0 ? diff : 0;
    }

    /**
     * Convertir tiempo HH:MM a minutos
     */
    private timeToMinutes(time: string): number {
        const [hours, minutes] = time.split(':').map(Number);
        return hours * 60 + minutes;
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

        // Obtener empleados activos sin registro para la fecha
        const employeesWithoutRecord = this.db.query<{ id: number }>(
            `SELECT e.id
             FROM employees e
             WHERE e.status = 'active'
             AND NOT EXISTS (
                 SELECT 1 FROM attendance_records ar
                 WHERE ar.employee_id = e.id AND ar.date = ?
             )`,
            [targetDate]
        );

        let count = 0;
        for (const emp of employeesWithoutRecord) {
            this.create({
                employee_id: emp.id,
                date: targetDate,
                status: 'absent',
                fingerprint_verified: false
            });
            count++;
        }

        return count;
    }
}
