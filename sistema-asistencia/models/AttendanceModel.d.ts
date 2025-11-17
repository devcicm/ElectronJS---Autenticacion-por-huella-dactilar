/**
 * Modelo de Asistencia
 */
import { DatabaseManager } from '../database/init';
import { AttendanceRecord, AttendanceRecordCreate, AttendanceWithDetails, AttendanceFilters, DailyAttendanceSummary } from '../types';
export declare class AttendanceModel {
    private db;
    constructor(db: DatabaseManager);
    /**
     * Obtener todos los registros con filtros
     */
    getAll(filters?: AttendanceFilters): AttendanceRecord[];
    /**
     * Obtener registros con detalles completos
     */
    getAllWithDetails(filters?: AttendanceFilters): AttendanceWithDetails[];
    /**
     * Obtener registro por ID
     */
    getById(id: number): AttendanceRecord | undefined;
    /**
     * Obtener registro de un empleado en una fecha específica
     */
    getByEmployeeAndDate(employeeId: number, date: string): AttendanceRecord | undefined;
    /**
     * Obtener registros de hoy
     */
    getToday(): AttendanceWithDetails[];
    /**
     * Crear registro de asistencia
     */
    create(data: AttendanceRecordCreate): AttendanceRecord;
    /**
     * Marcar entrada (check-in)
     */
    checkIn(employeeId: number, fingerprintVerified?: boolean): AttendanceRecord;
    /**
     * Marcar salida (check-out)
     */
    checkOut(employeeId: number): AttendanceRecord;
    /**
     * Calcular minutos de retraso
     */
    private calculateLateMinutes;
    /**
     * Calcular minutos de tiempo extra
     */
    private calculateOvertimeMinutes;
    /**
     * Convertir tiempo HH:MM a minutos
     */
    private timeToMinutes;
    /**
     * Obtener resumen de asistencia diaria
     */
    getDailySummary(date?: string): DailyAttendanceSummary | undefined;
    /**
     * Obtener estadísticas del día actual
     */
    getTodayStats(): {
        total_employees: number;
        present: number;
        late: number;
        absent: number;
        present_percentage: number;
    };
    /**
     * Marcar ausentes automáticamente
     */
    markAbsentees(date?: string): number;
}
//# sourceMappingURL=AttendanceModel.d.ts.map