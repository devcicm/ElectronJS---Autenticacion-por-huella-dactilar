/**
 * Modelo de Departamentos
 */
import { DatabaseManager } from '../database/init';
import { Department, DepartmentCreate, DepartmentUpdate } from '../types';
export declare class DepartmentModel {
    private db;
    constructor(db: DatabaseManager);
    /**
     * Obtener todos los departamentos
     */
    getAll(): Department[];
    /**
     * Obtener departamento por ID
     */
    getById(id: number): Department | undefined;
    /**
     * Obtener departamento por nombre
     */
    getByName(name: string): Department | undefined;
    /**
     * Crear un nuevo departamento
     */
    create(data: DepartmentCreate): Department;
    /**
     * Actualizar un departamento
     */
    update(data: DepartmentUpdate): Department;
    /**
     * Eliminar un departamento
     */
    delete(id: number): boolean;
    /**
     * Obtener estadísticas del departamento
     */
    getStats(departmentId: number): {
        total_employees: number;
        active_employees: number;
        inactive_employees: number;
    };
}
//# sourceMappingURL=DepartmentModel.d.ts.map