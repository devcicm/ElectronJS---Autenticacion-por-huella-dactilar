/**
 * Modelo de Huellas Dactilares
 */
import { DatabaseManager } from '../database/init';
import { Fingerprint, FingerprintCreate, FingerprintUpdate, FingerPosition } from '../types';
export declare class FingerprintModel {
    private db;
    constructor(db: DatabaseManager);
    /**
     * Obtener todas las huellas de un empleado
     */
    getByEmployee(employeeId: number): Fingerprint[];
    /**
     * Obtener huella por ID
     */
    getById(id: number): Fingerprint | undefined;
    /**
     * Obtener huella específica de un empleado
     */
    getByEmployeeAndFinger(employeeId: number, fingerPosition: FingerPosition): Fingerprint | undefined;
    /**
     * Crear o actualizar una huella
     */
    upsert(data: FingerprintCreate): Fingerprint;
    /**
     * Crear una nueva huella
     */
    create(data: FingerprintCreate): Fingerprint;
    /**
     * Actualizar una huella
     */
    update(data: FingerprintUpdate): Fingerprint;
    /**
     * Eliminar una huella
     */
    delete(id: number): boolean;
    /**
     * Eliminar todas las huellas de un empleado
     */
    deleteByEmployee(employeeId: number): number;
    /**
     * Verificar si un empleado tiene huellas registradas
     */
    hasFingerprints(employeeId: number): boolean;
    /**
     * Contar huellas de un empleado
     */
    countByEmployee(employeeId: number): number;
    /**
     * Obtener todos los empleados con huellas registradas
     */
    getEmployeesWithFingerprints(): number[];
    /**
     * Buscar empleado por template (para verificación)
     * Nota: Esta es una búsqueda simple por ID de empleado.
     * La verificación real del template se hace en el biometric-engine.
     */
    findByTemplate(employeeId: number): Fingerprint[];
    /**
     * Obtener estadísticas de huellas
     */
    getStats(): {
        total_fingerprints: number;
        employees_with_fingerprints: number;
        average_quality: number;
    };
}
//# sourceMappingURL=FingerprintModel.d.ts.map