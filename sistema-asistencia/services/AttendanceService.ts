/**
 * Servicio de Asistencia
 * Coordina la lógica de negocio entre modelos y el motor biométrico
 */

import { DatabaseManager, getDatabaseManager } from '../database/init.js';
import {
    EmployeeModel,
    AttendanceModel,
    FingerprintModel,
    DepartmentModel,
    ShiftModel
} from '../models/index.js';
import {
    AttendanceRecord,
    AttendanceWithDetails,
    Employee,
    EmployeeWithDetails,
    AttendanceFilters,
    AttendanceStatus,
    AttendanceUpdate
} from '../types/index.js';
import { getLocalDateString, parseLocalDate } from '../shared/date-utils.js';
import { safeParseInt, safeParseBoolean } from '../shared/object-utils.js';
import { summarizeAttendance, groupToMap } from '../shared/fp-utils.js';

export class AttendanceService {
    private db: DatabaseManager;
    private employeeModel: EmployeeModel;
    private attendanceModel: AttendanceModel;
    private fingerprintModel: FingerprintModel;
    private departmentModel: DepartmentModel;
    private shiftModel: ShiftModel;

    constructor(db?: DatabaseManager) {
        this.db = db || getDatabaseManager();
        this.employeeModel = new EmployeeModel(this.db);
        this.attendanceModel = new AttendanceModel(this.db);
        this.fingerprintModel = new FingerprintModel(this.db);
        this.departmentModel = new DepartmentModel(this.db);
        this.shiftModel = new ShiftModel(this.db);
    }

    /**
     * Valida y obtiene un empleado activo. Retorna el empleado o un mensaje de error.
     */
    private getValidActiveEmployee(employeeId: number): { employee?: Employee; error?: string } {
        const empId = safeParseInt(employeeId, 0);
        if (empId <= 0) return { error: 'ID de empleado inválido' };

        const employee = this.employeeModel.getById(empId);
        if (!employee) return { error: 'Empleado no encontrado' };
        if (employee.status !== 'active') return { error: 'El empleado no está activo' };

        return { employee };
    }

    /**
     * Obtiene el registro de asistencia de un empleado para la fecha de hoy.
     */
    private getTodayAttendance(employeeId: number): AttendanceRecord | undefined {
        return this.attendanceModel.getByEmployeeAndDate(employeeId, getLocalDateString());
    }

    /**
     * Marcar entrada con verificación biométrica (Idempotente)
     */
    async checkInWithFingerprint(employeeId: number, fingerprintVerified: boolean = true): Promise<{
        success: boolean;
        message: string;
        record?: AttendanceRecord;
        employee?: Employee;
        alreadyCheckedIn?: boolean;
    }> {
        try {
            const { employee, error } = this.getValidActiveEmployee(employeeId);
            if (error || !employee) {
                return { success: false, message: error || 'Error de validación' };
            }

            const isVerified = safeParseBoolean(fingerprintVerified, true);

            // Verificación de idempotencia: Si ya registró entrada hoy, devolver éxito con el registro existente
            const existing = this.getTodayAttendance(employee.id);
            if (existing && existing.check_in_time) {
                return {
                    success: true,
                    message: 'Entrada ya registrada previamente',
                    record: existing,
                    employee,
                    alreadyCheckedIn: true
                };
            }

            // Marcar entrada
            const record = this.attendanceModel.checkIn(employee.id, isVerified);

            let message = `Entrada registrada correctamente`;
            if (record.status === 'late') {
                message += ` (${record.minutes_late} minutos de retraso)`;
            }

            return {
                success: true,
                message,
                record,
                employee
            };
        } catch (error: any) {
            return {
                success: false,
                message: error.message || 'Error al registrar entrada'
            };
        }
    }

    /**
     * Marcar salida (Idempotente)
     */
    async checkOut(employeeId: number): Promise<{
        success: boolean;
        message: string;
        record?: AttendanceRecord;
        employee?: Employee;
        alreadyCheckedOut?: boolean;
    }> {
        try {
            const empId = safeParseInt(employeeId, 0);
            if (empId <= 0) {
                return { success: false, message: 'ID de empleado inválido' };
            }

            const employee = this.employeeModel.getById(empId);
            if (!employee) {
                return { success: false, message: 'Empleado no encontrado' };
            }

            // Verificación de idempotencia: Si ya registró salida hoy, devolver éxito con el registro existente
            const existing = this.getTodayAttendance(empId);
            if (existing && existing.check_out_time) {
                return {
                    success: true,
                    message: 'Salida ya registrada previamente',
                    record: existing,
                    employee,
                    alreadyCheckedOut: true
                };
            }

            const record = this.attendanceModel.checkOut(empId);

            let message = `Salida registrada correctamente`;
            if (record.minutes_overtime > 0) {
                message += ` (${record.minutes_overtime} minutos de tiempo extra)`;
            }

            return {
                success: true,
                message,
                record,
                employee
            };
        } catch (error: any) {
            return {
                success: false,
                message: error.message || 'Error al registrar salida'
            };
        }
    }

    /**
     * Justificar una falta (actualiza estado a excused/on_leave y asigna nota justificativa)
     */
    async justifyAbsence(
        recordIdOrData: number | { recordId?: number; employeeId?: number; date?: string; notes?: string; status?: AttendanceStatus },
        justificationNotes?: string,
        newStatus: AttendanceStatus = 'excused'
    ): Promise<{
        success: boolean;
        message: string;
        record?: AttendanceRecord;
    }> {
        try {
            let recId = 0;
            let empId = 0;
            let dateStr = '';
            let notes = '';
            let status: AttendanceStatus = newStatus;

            if (typeof recordIdOrData === 'object' && recordIdOrData !== null) {
                recId = safeParseInt(recordIdOrData.recordId, 0);
                empId = safeParseInt(recordIdOrData.employeeId, 0);
                dateStr = String(recordIdOrData.date || '').trim();
                notes = String(recordIdOrData.notes || '').trim();
                if (recordIdOrData.status) status = recordIdOrData.status;
            } else {
                recId = safeParseInt(recordIdOrData, 0);
                notes = String(justificationNotes || '').trim();
            }

            let updated: AttendanceRecord | undefined;
            if (recId > 0) {
                updated = this.attendanceModel.justifyAbsence(recId, notes, status);
            } else if (empId > 0 && dateStr) {
                updated = this.attendanceModel.justifyOrUpsertAbsence(empId, dateStr, notes, status);
            }

            if (!updated) {
                return {
                    success: false,
                    message: 'No se encontró el registro de asistencia a justificar'
                };
            }

            return {
                success: true,
                message: 'Falta justificada correctamente',
                record: updated
            };
        } catch (error: any) {
            return {
                success: false,
                message: error.message || 'Error al justificar la falta'
            };
        }
    }

    /**
     * Obtener registros de asistencia con detalles (soporta también acción de justificación por filters.action === 'justify')
     */
    getAttendanceRecords(filters?: AttendanceFilters | any): AttendanceWithDetails[] | Promise<any> {
        if (filters && typeof filters === 'object' && (filters.action === 'justify' || filters.action === 'justifyAbsence')) {
            return this.justifyAbsence(
                {
                    recordId: filters.recordId || filters.id,
                    employeeId: filters.employee_id || filters.employeeId,
                    date: filters.date,
                    notes: filters.notes || filters.justification || '',
                    status: filters.status || 'excused'
                }
            );
        }
        if (filters && typeof filters === 'object' && filters.action === 'mark_absentees') {
            try {
                const targetDate = filters.date && typeof filters.date === 'string' && filters.date.trim()
                    ? filters.date.trim()
                    : getLocalDateString();
                const markedCount = this.attendanceModel.markAbsentees(targetDate);
                return Promise.resolve({
                    success: true,
                    date: targetDate,
                    markedCount,
                    message: markedCount > 0
                        ? `Corte de faltas completado (${targetDate}): ${markedCount} empleado(s) marcado(s) como ausente(s).`
                        : `Corte de faltas verificado (${targetDate}): Todos los empleados activos ya cuentan con registro.`
                });
            } catch (error: any) {
                return Promise.resolve({
                    success: false,
                    markedCount: 0,
                    message: error.message || 'Error al ejecutar el corte de faltas'
                });
            }
        }
        return this.attendanceModel.getAllWithDetails(filters);
    }

    /**
     * Obtener registros de hoy
     */
    getTodayRecords(): AttendanceWithDetails[] {
        return this.attendanceModel.getToday();
    }

    /**
     * Obtener estadísticas del día
     */
    getTodayStats() {
        return this.attendanceModel.getTodayStats();
    }

    /**
     * Marcar ausentes automáticamente
     */
    markAbsentees(date?: string): number {
        return this.attendanceModel.markAbsentees(date);
    }

    /**
     * Obtener empleados activos
     */
    getActiveEmployees(): EmployeeWithDetails[] {
        return this.employeeModel.getAllWithDetails({ status: 'active' });
    }

    /**
     * Buscar empleado por código
     */
    findEmployeeByCode(code: string): Employee | undefined {
        return this.employeeModel.getByCode(code);
    }

    /**
     * Obtener información completa de un empleado
     */
    getEmployeeDetails(employeeId: number): {
        employee: EmployeeWithDetails | undefined;
        todayAttendance: AttendanceRecord | undefined;
        fingerprints: number;
    } {
        const empId = safeParseInt(employeeId, 0);
        const employee = this.employeeModel.getByIdWithDetails(empId);
        const todayAttendance = this.getTodayAttendance(empId);
        const fingerprints = this.fingerprintModel.countByEmployee(empId);

        return {
            employee,
            todayAttendance,
            fingerprints
        };
    }

    /**
     * Verificar si un empleado puede marcar entrada
     */
    canCheckIn(employeeId: number): {
        can: boolean;
        reason?: string;
    } {
        const { employee, error } = this.getValidActiveEmployee(employeeId);
        if (error || !employee) {
            return { can: false, reason: error === 'El empleado no está activo' ? 'Empleado no activo' : error };
        }

        const existing = this.getTodayAttendance(employee.id);
        if (existing && existing.check_in_time) {
            return { can: false, reason: 'Ya tiene registro de entrada hoy' };
        }

        return { can: true };
    }

    /**
     * Verificar si un empleado puede marcar salida
     */
    canCheckOut(employeeId: number): {
        can: boolean;
        reason?: string;
    } {
        const empId = safeParseInt(employeeId, 0);
        if (empId <= 0) {
            return { can: false, reason: 'ID de empleado inválido' };
        }

        const employee = this.employeeModel.getById(empId);
        if (!employee) {
            return { can: false, reason: 'Empleado no encontrado' };
        }

        const existing = this.getTodayAttendance(empId);
        if (!existing || !existing.check_in_time) {
            return { can: false, reason: 'No hay registro de entrada hoy' };
        }

        if (existing.check_out_time) {
            return { can: false, reason: 'Ya registró la salida' };
        }

        return { can: true };
    }

    /**
     * Obtener resumen del dashboard
     */
    getDashboardSummary() {
        const stats = this.getTodayStats();
        const todayRecords = this.getTodayRecords();
        const totalEmployees = this.employeeModel.countActive();
        const departments = this.departmentModel.getAll();
        const shifts = this.shiftModel.getAll();

        return {
            stats,
            todayRecords,
            totalEmployees,
            departments,
            shifts
        };
    }

    /**
     * Generar reporte diario
     */
    generateDailyReport(date?: string) {
        const targetDate = (date && date.trim()) ? getLocalDateString(parseLocalDate(date)) : getLocalDateString();
        const records = this.attendanceModel.getAllWithDetails({
            start_date: targetDate,
            end_date: targetDate
        });

        const summary = this.attendanceModel.getDailySummary(targetDate);
        const employees = this.employeeModel.getAllWithDetails({ status: 'active' });

        // Incluir empleados activos sin marcación registrada en la fecha consultada como ausentes del día
        const recordedEmpIds = new Set(records.map(r => r.employee_id));
        const missingActiveRecords: AttendanceWithDetails[] = employees
            .filter(emp => !recordedEmpIds.has(emp.id))
            .map(emp => ({
                id: 0,
                employee_id: emp.id,
                date: targetDate,
                check_in_time: null,
                check_out_time: null,
                status: 'absent' as AttendanceStatus,
                minutes_late: 0,
                minutes_overtime: 0,
                fingerprint_verified: false,
                notes: 'Sin marcación registrada',
                created_at: targetDate,
                updated_at: targetDate,
                employee_code: emp.employee_code,
                employee_name: `${emp.first_name} ${emp.last_name}`,
                department_name: emp.department_name || 'Sin departamento',
                shift_name: emp.shift_name || 'Sin turno',
                shift_start_time: emp.shift_start_time || '08:00',
                shift_end_time: emp.shift_end_time || '16:00'
            }));

        const allDailyRecords = [...records, ...missingActiveRecords];

        // Reducción funcional O(N) en una sola pasada pura
        const summaryMetrics = summarizeAttendance(allDailyRecords);

        return {
            date: targetDate,
            records: allDailyRecords,
            summary,
            totalEmployees: employees.length,
            stats: {
                total: allDailyRecords.length,
                present: summaryMetrics.present,
                late: summaryMetrics.late,
                absent: summaryMetrics.absent,
                verified: summaryMetrics.verified,
                avgLateMinutes: summaryMetrics.avgLateMinutes
            }
        };
    }

    /**
     * Generar reporte semanal
     */
    generateWeeklyReport(endDate?: string) {
        const end = (endDate && endDate.trim()) ? parseLocalDate(endDate) : new Date();
        const start = new Date(end);
        start.setDate(start.getDate() - 6); // 7 días atrás

        const startStr = getLocalDateString(start);
        const endStr = getLocalDateString(end);

        const records = this.attendanceModel.getAllWithDetails({
            start_date: startStr,
            end_date: endStr
        });

        const activeEmployeesCount = this.employeeModel.countActive();

        // Agrupación pura O(N) por día
        const byDay = groupToMap(records, r => r.date);

        // Fold funcional O(N) por día en lugar de múltiples pasadas con filter
        const dailyStats = Array.from(byDay.entries()).map(([date, dayRecords]) => {
            const m = summarizeAttendance(dayRecords);
            const effectiveAbsent = Math.max(m.absent, Math.max(0, activeEmployeesCount - (m.present + m.late)));
            return {
                date,
                total: Math.max(m.total, activeEmployeesCount),
                present: m.present,
                late: m.late,
                absent: effectiveAbsent,
                verified: m.verified
            };
        });

        return {
            startDate: startStr,
            endDate: endStr,
            records,
            dailyStats,
            totalRecords: records.length,
            avgDailyAttendance: records.length / 7
        };
    }

    /**
     * Generar reporte mensual
     */
    generateMonthlyReport(year?: number, month?: number) {
        const now = new Date();
        const y = safeParseInt(year, now.getFullYear());
        const m = safeParseInt(month, now.getMonth() + 1);
        const targetYear = y >= 1970 ? y : now.getFullYear();
        const targetMonth = m >= 1 && m <= 12 ? m : now.getMonth() + 1;

        // Primer y último día del mes
        const startDate = new Date(targetYear, targetMonth - 1, 1);
        const endDate = new Date(targetYear, targetMonth, 0);

        const startStr = getLocalDateString(startDate);
        const endStr = getLocalDateString(endDate);

        const records = this.attendanceModel.getAllWithDetails({
            start_date: startStr,
            end_date: endStr
        });

        const employees = this.employeeModel.getAllWithDetails({ status: 'active' });

        // Indexación funcional O(1) vía Map
        const employeeMap = new Map<number, EmployeeWithDetails>(employees.map(e => [e.id, e]));

        // Agrupación funcional O(N) por empleado
        const byEmployee = groupToMap(records, r => r.employee_id);

        // Unión de empleados con registros en el mes y plantilla activa
        const allEmpIds = new Set<number>([
            ...Array.from(byEmployee.keys()),
            ...employees.map(e => e.id)
        ]);

        const employeeStats = Array.from(allEmpIds).map(empId => {
            const emp = employeeMap.get(empId) || this.employeeModel.getByIdWithDetails(empId);
            const empRecords = byEmployee.get(empId) || [];
            const m = summarizeAttendance(empRecords);

            return {
                employeeId: empId,
                employeeName: emp ? `${emp.first_name} ${emp.last_name}` : 'N/A',
                employeeCode: emp?.employee_code || 'N/A',
                totalDays: m.total,
                presentDays: m.present,
                lateDays: m.late,
                absentDays: m.absent,
                totalLateMinutes: m.totalLateMinutes,
                attendanceRate: m.attendanceRate
            };
        });

        // Totales globales en fold puro O(N)
        const totalSummary = summarizeAttendance(records);

        return {
            year: targetYear,
            month: targetMonth,
            monthName: startDate.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' }),
            startDate: startStr,
            endDate: endStr,
            workingDays: endDate.getDate(),
            records,
            employeeStats,
            totalStats: {
                totalRecords: totalSummary.total,
                present: totalSummary.present,
                late: totalSummary.late,
                absent: totalSummary.absent,
                verified: totalSummary.verified
            }
        };
    }

    /**
     * Generar reporte individual de empleado
     */
    generateEmployeeReport(employeeId: number, startDate?: string, endDate?: string) {
        const empId = safeParseInt(employeeId, 0);
        if (empId <= 0) {
            throw new Error('ID de empleado inválido');
        }

        const rawEmployee = this.employeeModel.getByIdWithDetails(empId);
        if (!rawEmployee) {
            throw new Error('Empleado no encontrado');
        }

        const employee: EmployeeWithDetails = {
            ...rawEmployee,
            department_name: rawEmployee.department_name || 'Sin departamento',
            shift_name: rawEmployee.shift_name || 'Sin turno'
        };

        const hasStart = Boolean(startDate && String(startDate).trim());
        const hasEnd = Boolean(endDate && String(endDate).trim());

        const filters: AttendanceFilters = {
            employee_id: empId
        };
        if (hasStart) {
            filters.start_date = getLocalDateString(parseLocalDate(String(startDate)));
        }
        if (hasEnd) {
            filters.end_date = getLocalDateString(parseLocalDate(String(endDate)));
        }

        const records = this.attendanceModel.getAllWithDetails(filters);

        const now = new Date();
        const todayStr = getLocalDateString(now);
        const startStr = hasStart
            ? filters.start_date!
            : (records.length > 0
                ? records[records.length - 1].date
                : (employee.hire_date || getLocalDateString(new Date(now.getFullYear(), now.getMonth(), 1))));
        const endStr = hasEnd
            ? filters.end_date!
            : (records.length > 0 && records[0].date > todayStr ? records[0].date : todayStr);

        const fingerprints = this.fingerprintModel.getByEmployee(empId);

        // Fold funcional O(N) en una sola pasada (evita 6 iteraciones separadas)
        const m = summarizeAttendance(records);

        return {
            employee,
            period: {
                startDate: startStr,
                endDate: endStr
            },
            records,
            fingerprints: fingerprints.length,
            stats: {
                totalDays: m.total,
                presentDays: m.present,
                lateDays: m.late,
                absentDays: m.absent,
                totalLateMinutes: m.totalLateMinutes,
                avgLateMinutes: m.avgLateMinutes,
                totalOvertimeMinutes: m.totalOvertimeMinutes,
                avgOvertimeMinutes: m.avgOvertimeMinutes,
                verifiedDays: m.verified,
                attendanceRate: m.attendanceRate,
                punctualityRate: m.punctualityRate
            }
        };
    }
}
