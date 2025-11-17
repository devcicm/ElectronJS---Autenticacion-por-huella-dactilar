/**
 * Servicio de Asistencia
 * Coordina la lógica de negocio entre modelos y el motor biométrico
 */
import { AttendanceRecord, AttendanceWithDetails, Employee, EmployeeWithDetails, AttendanceFilters } from '../types/index.js';
export declare class AttendanceService {
    private db;
    private employeeModel;
    private attendanceModel;
    private fingerprintModel;
    private departmentModel;
    private shiftModel;
    /**
     * Marcar entrada con verificación biométrica
     */
    checkInWithFingerprint(employeeId: number, fingerprintVerified?: boolean): Promise<{
        success: boolean;
        message: string;
        record?: AttendanceRecord;
        employee?: Employee;
    }>;
    /**
     * Marcar salida
     */
    checkOut(employeeId: number): Promise<{
        success: boolean;
        message: string;
        record?: AttendanceRecord;
        employee?: Employee;
    }>;
    /**
     * Obtener registros de asistencia con detalles
     */
    getAttendanceRecords(filters?: AttendanceFilters): AttendanceWithDetails[];
    /**
     * Obtener registros de hoy
     */
    getTodayRecords(): AttendanceWithDetails[];
    /**
     * Obtener estadísticas del día
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
    /**
     * Obtener empleados activos
     */
    getActiveEmployees(): EmployeeWithDetails[];
    /**
     * Buscar empleado por código
     */
    findEmployeeByCode(code: string): Employee | undefined;
    /**
     * Obtener información completa de un empleado
     */
    getEmployeeDetails(employeeId: number): {
        employee: EmployeeWithDetails | undefined;
        todayAttendance: AttendanceRecord | undefined;
        fingerprints: number;
    };
    /**
     * Verificar si un empleado puede marcar entrada
     */
    canCheckIn(employeeId: number): {
        can: boolean;
        reason?: string;
    };
    /**
     * Verificar si un empleado puede marcar salida
     */
    canCheckOut(employeeId: number): {
        can: boolean;
        reason?: string;
    };
    /**
     * Obtener resumen del dashboard
     */
    getDashboardSummary(): {
        stats: {
            total_employees: number;
            present: number;
            late: number;
            absent: number;
            present_percentage: number;
        };
        todayRecords: AttendanceWithDetails[];
        totalEmployees: number;
        departments: Department[];
        shifts: Shift[];
    };
}
//# sourceMappingURL=AttendanceService.d.ts.map