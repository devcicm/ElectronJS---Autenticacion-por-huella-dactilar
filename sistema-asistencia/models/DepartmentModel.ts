/**
 * Modelo de Departamentos
 */

import { DatabaseManager } from '../database/init.js';
import { Department, DepartmentCreate, DepartmentUpdate } from '../types/index.js';
import { safeParseInt } from '../shared/object-utils.js';

export class DepartmentModel {
    constructor(private db: DatabaseManager) {}

    /**
     * Obtener todos los departamentos
     */
    getAll(): Department[] {
        return this.db.query<Department>(
            'SELECT * FROM departments ORDER BY name'
        );
    }

    /**
     * Obtener departamento por ID
     */
    getById(id: number): Department | undefined {
        const cleanId = safeParseInt(id, 0);
        if (cleanId <= 0) return undefined;
        return this.db.queryOne<Department>(
            'SELECT * FROM departments WHERE id = ?',
            [cleanId]
        );
    }

    /**
     * Obtener departamento por nombre
     */
    getByName(name: string): Department | undefined {
        return this.db.queryOne<Department>(
            'SELECT * FROM departments WHERE name = ?',
            [name]
        );
    }

    /**
     * Crear un nuevo departamento
     */
    create(data: DepartmentCreate): Department {
        if (!data || typeof data !== 'object') {
            throw new Error('Datos de departamento inválidos');
        }

        const name = typeof data.name === 'string' ? data.name.trim() : '';
        if (!name) {
            throw new Error('El nombre del departamento es requerido');
        }

        const description = data.description ? String(data.description).trim() : null;
        const managerIdRaw = data.manager_id !== undefined && data.manager_id !== null
            ? safeParseInt(data.manager_id, 0)
            : null;
        const manager_id = managerIdRaw && managerIdRaw > 0 ? managerIdRaw : null;

        const result = this.db.execute(
            `INSERT INTO departments (name, description, manager_id)
             VALUES (?, ?, ?)`,
            [name, description, manager_id]
        );

        const department = this.getById(result.lastInsertRowid as number);
        if (!department) {
            throw new Error('Error creando departamento');
        }

        return department;
    }

    /**
     * Actualizar un departamento
     */
    update(data: DepartmentUpdate): Department {
        if (!data || typeof data !== 'object') {
            throw new Error('Datos de actualización inválidos');
        }

        const id = safeParseInt(data.id, 0);
        if (id <= 0) {
            throw new Error('ID de departamento inválido');
        }

        const updates: string[] = [];
        const params: any[] = [];

        if (data.name !== undefined) {
            const name = String(data.name).trim();
            if (!name) throw new Error('El nombre no puede estar vacío');
            updates.push('name = ?');
            params.push(name);
        }
        if (data.description !== undefined) {
            updates.push('description = ?');
            params.push(data.description ? String(data.description).trim() : null);
        }
        if (data.manager_id !== undefined) {
            const mIdRaw = data.manager_id !== null ? safeParseInt(data.manager_id, 0) : null;
            const mId = mIdRaw && mIdRaw > 0 ? mIdRaw : null;
            updates.push('manager_id = ?');
            params.push(mId);
        }

        if (updates.length === 0) {
            throw new Error('No hay datos para actualizar');
        }

        params.push(id);

        this.db.execute(
            `UPDATE departments SET ${updates.join(', ')} WHERE id = ?`,
            params
        );

        const department = this.getById(id);
        if (!department) {
            throw new Error('Departamento no encontrado después de actualizar');
        }

        return department;
    }

    /**
     * Eliminar un departamento
     */
    delete(id: number): boolean {
        const result = this.db.execute('DELETE FROM departments WHERE id = ?', [id]);
        return result.changes > 0;
    }

    /**
     * Obtener estadísticas del departamento
     */
    getStats(departmentId: number): {
        total_employees: number;
        active_employees: number;
        inactive_employees: number;
    } {
        const stats = this.db.queryOne<{
            total_employees: number;
            active_employees: number;
            inactive_employees: number;
        }>(
            `SELECT
                COUNT(*) as total_employees,
                SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_employees,
                SUM(CASE WHEN status != 'active' THEN 1 ELSE 0 END) as inactive_employees
             FROM employees
             WHERE department_id = ?`,
            [departmentId]
        );

        return stats || { total_employees: 0, active_employees: 0, inactive_employees: 0 };
    }
}
