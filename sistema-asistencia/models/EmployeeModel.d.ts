/**
 * Modelo de Empleados
 */
import { DatabaseManager } from '../database/init';
import { Employee, EmployeeCreate, EmployeeUpdate, EmployeeWithDetails, EmployeeFilters } from '../types';
export declare class EmployeeModel {
    private db;
    constructor(db: DatabaseManager);
    /**
     * Obtener todos los empleados
     */
    getAll(filters?: EmployeeFilters): Employee[];
    /**
     * Obtener empleados con detalles completos
     */
    getAllWithDetails(filters?: EmployeeFilters): EmployeeWithDetails[];
    /**
     * Obtener un empleado por ID
     */
    getById(id: number): Employee | undefined;
    /**
     * Obtener empleado con detalles por ID
     */
    getByIdWithDetails(id: number): EmployeeWithDetails | undefined;
    /**
     * Obtener un empleado por código
     */
    getByCode(code: string): Employee | undefined;
    /**
     * Obtener un empleado por email
     */
    getByEmail(email: string): Employee | undefined;
    /**
     * Crear un nuevo empleado
     */
    create(data: EmployeeCreate): Employee;
    /**
     * Actualizar un empleado
     */
    update(data: EmployeeUpdate): Employee;
    /**
     * Eliminar un empleado
     */
    delete(id: number): boolean;
    /**
     * Contar empleados activos
     */
    countActive(): number;
    /**
     * Obtener empleados por departamento
     */
    getByDepartment(departmentId: number): Employee[];
    /**
     * Obtener empleados por turno
     */
    getByShift(shiftId: number): Employee[];
}
//# sourceMappingURL=EmployeeModel.d.ts.map