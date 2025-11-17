/**
 * Servicio de Asistencia
 * Coordina la lógica de negocio entre modelos y el motor biométrico
 */
import { getDatabaseManager } from '../database/init.js';
import { EmployeeModel, AttendanceModel, FingerprintModel, DepartmentModel, ShiftModel } from '../models/index.js';
export class AttendanceService {
    db = getDatabaseManager();
    employeeModel = new EmployeeModel(this.db);
    attendanceModel = new AttendanceModel(this.db);
    fingerprintModel = new FingerprintModel(this.db);
    departmentModel = new DepartmentModel(this.db);
    shiftModel = new ShiftModel(this.db);
    /**
     * Marcar entrada con verificación biométrica
     */
    async checkInWithFingerprint(employeeId, fingerprintVerified = true) {
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
        }
        catch (error) {
            return {
                success: false,
                message: error.message || 'Error al registrar entrada'
            };
        }
    }
    /**
     * Marcar salida
     */
    async checkOut(employeeId) {
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
        }
        catch (error) {
            return {
                success: false,
                message: error.message || 'Error al registrar salida'
            };
        }
    }
    /**
     * Obtener registros de asistencia con detalles
     */
    getAttendanceRecords(filters) {
        return this.attendanceModel.getAllWithDetails(filters);
    }
    /**
     * Obtener registros de hoy
     */
    getTodayRecords() {
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
    markAbsentees(date) {
        return this.attendanceModel.markAbsentees(date);
    }
    /**
     * Obtener empleados activos
     */
    getActiveEmployees() {
        return this.employeeModel.getAllWithDetails({ status: 'active' });
    }
    /**
     * Buscar empleado por código
     */
    findEmployeeByCode(code) {
        return this.employeeModel.getByCode(code);
    }
    /**
     * Obtener información completa de un empleado
     */
    getEmployeeDetails(employeeId) {
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
    canCheckIn(employeeId) {
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
    canCheckOut(employeeId) {
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
}
//# sourceMappingURL=AttendanceService.js.map