/**
 * Servicio de Asistencia
 * Coordina la lógica de negocio entre modelos y el motor biométrico
 */

import { getDatabaseManager } from '../database/init.js';
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
    AttendanceFilters
} from '../types/index.js';

export class AttendanceService {
    private db = getDatabaseManager();
    private employeeModel = new EmployeeModel(this.db);
    private attendanceModel = new AttendanceModel(this.db);
    private fingerprintModel = new FingerprintModel(this.db);
    private departmentModel = new DepartmentModel(this.db);
    private shiftModel = new ShiftModel(this.db);

    /**
     * Marcar entrada con verificación biométrica
     */
    async checkInWithFingerprint(employeeId: number, fingerprintVerified: boolean = true): Promise<{
        success: boolean;
        message: string;
        record?: AttendanceRecord;
        employee?: Employee;
    }> {
        try {
            // Verificar que el empleado existe y está activo
            const employee = this.employeeModel.getById(employeeId);
            if (!employee) {
                return { success: false, message: 'Empleado no encontrado' };
            }

            if (employee.status !== 'active') {
                return { success: false, message: 'El empleado no está activo' };
            }

            // Marcar entrada
            const record = this.attendanceModel.checkIn(employeeId, fingerprintVerified);

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
     * Marcar salida
     */
    async checkOut(employeeId: number): Promise<{
        success: boolean;
        message: string;
        record?: AttendanceRecord;
        employee?: Employee;
    }> {
        try {
            const employee = this.employeeModel.getById(employeeId);
            if (!employee) {
                return { success: false, message: 'Empleado no encontrado' };
            }

            const record = this.attendanceModel.checkOut(employeeId);

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
     * Obtener registros de asistencia con detalles
     */
    getAttendanceRecords(filters?: AttendanceFilters): AttendanceWithDetails[] {
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
        const employee = this.employeeModel.getByIdWithDetails(employeeId);
        const today = new Date().toISOString().split('T')[0];
        const todayAttendance = this.attendanceModel.getByEmployeeAndDate(employeeId, today);
        const fingerprints = this.fingerprintModel.countByEmployee(employeeId);

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
        const employee = this.employeeModel.getById(employeeId);

        if (!employee) {
            return { can: false, reason: 'Empleado no encontrado' };
        }

        if (employee.status !== 'active') {
            return { can: false, reason: 'Empleado no activo' };
        }

        const today = new Date().toISOString().split('T')[0];
        const existing = this.attendanceModel.getByEmployeeAndDate(employeeId, today);

        if (existing) {
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
        const employee = this.employeeModel.getById(employeeId);

        if (!employee) {
            return { can: false, reason: 'Empleado no encontrado' };
        }

        const today = new Date().toISOString().split('T')[0];
        const existing = this.attendanceModel.getByEmployeeAndDate(employeeId, today);

        if (!existing) {
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
        const targetDate = date || new Date().toISOString().split('T')[0];
        const records = this.attendanceModel.getAllWithDetails({
            start_date: targetDate,
            end_date: targetDate
        });

        const summary = this.attendanceModel.getDailySummary(targetDate);
        const employees = this.employeeModel.getAllWithDetails({ status: 'active' });

        // Calcular estadísticas adicionales
        const verifiedCount = records.filter(r => r.fingerprint_verified).length;
        const avgLateMinutes = records.reduce((sum, r) => sum + (r.minutes_late || 0), 0) / (records.length || 1);

        return {
            date: targetDate,
            records,
            summary,
            totalEmployees: employees.length,
            stats: {
                total: records.length,
                present: records.filter(r => r.status === 'present').length,
                late: records.filter(r => r.status === 'late').length,
                absent: employees.length - records.length,
                verified: verifiedCount,
                avgLateMinutes: Math.round(avgLateMinutes)
            }
        };
    }

    /**
     * Generar reporte semanal
     */
    generateWeeklyReport(endDate?: string) {
        const end = endDate ? new Date(endDate) : new Date();
        const start = new Date(end);
        start.setDate(start.getDate() - 6); // 7 días atrás

        const startStr = start.toISOString().split('T')[0];
        const endStr = end.toISOString().split('T')[0];

        const records = this.attendanceModel.getAllWithDetails({
            start_date: startStr,
            end_date: endStr
        });

        // Agrupar por día
        const byDay = new Map<string, AttendanceWithDetails[]>();
        records.forEach(record => {
            if (!byDay.has(record.date)) {
                byDay.set(record.date, []);
            }
            byDay.get(record.date)!.push(record);
        });

        // Generar resumen por día
        const dailyStats = Array.from(byDay.entries()).map(([date, dayRecords]) => ({
            date,
            total: dayRecords.length,
            present: dayRecords.filter(r => r.status === 'present').length,
            late: dayRecords.filter(r => r.status === 'late').length,
            absent: dayRecords.filter(r => r.status === 'absent').length,
            verified: dayRecords.filter(r => r.fingerprint_verified).length
        }));

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
        const targetYear = year || now.getFullYear();
        const targetMonth = month || now.getMonth() + 1;

        // Primer y último día del mes
        const startDate = new Date(targetYear, targetMonth - 1, 1);
        const endDate = new Date(targetYear, targetMonth, 0);

        const startStr = startDate.toISOString().split('T')[0];
        const endStr = endDate.toISOString().split('T')[0];

        const records = this.attendanceModel.getAllWithDetails({
            start_date: startStr,
            end_date: endStr
        });

        const employees = this.employeeModel.getAllWithDetails({ status: 'active' });

        // Estadísticas por empleado
        const byEmployee = new Map<number, AttendanceWithDetails[]>();
        records.forEach(record => {
            if (!byEmployee.has(record.employee_id)) {
                byEmployee.set(record.employee_id, []);
            }
            byEmployee.get(record.employee_id)!.push(record);
        });

        const employeeStats = Array.from(byEmployee.entries()).map(([empId, empRecords]) => {
            const emp = employees.find(e => e.id === empId);
            return {
                employeeId: empId,
                employeeName: emp ? `${emp.first_name} ${emp.last_name}` : 'N/A',
                employeeCode: emp?.employee_code || 'N/A',
                totalDays: empRecords.length,
                presentDays: empRecords.filter(r => r.status === 'present').length,
                lateDays: empRecords.filter(r => r.status === 'late').length,
                absentDays: empRecords.filter(r => r.status === 'absent').length,
                totalLateMinutes: empRecords.reduce((sum, r) => sum + (r.minutes_late || 0), 0),
                attendanceRate: ((empRecords.filter(r => r.status === 'present' || r.status === 'late').length / empRecords.length) * 100).toFixed(1)
            };
        });

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
                totalRecords: records.length,
                present: records.filter(r => r.status === 'present').length,
                late: records.filter(r => r.status === 'late').length,
                absent: records.filter(r => r.status === 'absent').length,
                verified: records.filter(r => r.fingerprint_verified).length
            }
        };
    }

    /**
     * Generar reporte individual de empleado
     */
    generateEmployeeReport(employeeId: number, startDate?: string, endDate?: string) {
        const employee = this.employeeModel.getByIdWithDetails(employeeId);
        if (!employee) {
            throw new Error('Empleado no encontrado');
        }

        // Por defecto: último mes
        const end = endDate ? new Date(endDate) : new Date();
        const start = startDate ? new Date(startDate) : new Date(end.getFullYear(), end.getMonth(), 1);

        const startStr = start.toISOString().split('T')[0];
        const endStr = end.toISOString().split('T')[0];

        const records = this.attendanceModel.getAllWithDetails({
            employee_id: employeeId,
            start_date: startStr,
            end_date: endStr
        });

        const fingerprints = this.fingerprintModel.getByEmployee(employeeId);

        // Calcular estadísticas
        const totalDays = records.length;
        const presentDays = records.filter(r => r.status === 'present').length;
        const lateDays = records.filter(r => r.status === 'late').length;
        const absentDays = records.filter(r => r.status === 'absent').length;
        const totalLateMinutes = records.reduce((sum, r) => sum + (r.minutes_late || 0), 0);
        const totalOvertimeMinutes = records.reduce((sum, r) => sum + (r.minutes_overtime || 0), 0);
        const verifiedDays = records.filter(r => r.fingerprint_verified).length;

        return {
            employee,
            period: {
                startDate: startStr,
                endDate: endStr
            },
            records,
            fingerprints: fingerprints.length,
            stats: {
                totalDays,
                presentDays,
                lateDays,
                absentDays,
                totalLateMinutes,
                avgLateMinutes: totalDays > 0 ? Math.round(totalLateMinutes / totalDays) : 0,
                totalOvertimeMinutes,
                avgOvertimeMinutes: totalDays > 0 ? Math.round(totalOvertimeMinutes / totalDays) : 0,
                verifiedDays,
                attendanceRate: totalDays > 0 ? ((presentDays + lateDays) / totalDays * 100).toFixed(1) : '0.0',
                punctualityRate: totalDays > 0 ? (presentDays / totalDays * 100).toFixed(1) : '0.0'
            }
        };
    }
}
