/**
 * Modelo de Departamentos
 */

import { DatabaseManager } from '../database/init.js';
import { Department, DepartmentCreate, DepartmentUpdate } from '../types/index.js';

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
        return this.db.queryOne<Department>(
            'SELECT * FROM departments WHERE id = ?',
            [id]
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
        const result = this.db.execute(
            `INSERT INTO departments (name, description, manager_id, color)
             VALUES (?, ?, ?, ?)`,
            [
                data.name,
                data.description || null,
                data.manager_id || null,
                data.color || '#3B82F6'
            ]
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
        const updates: string[] = [];
        const params: any[] = [];

        if (data.name !== undefined) {
            updates.push('name = ?');
            params.push(data.name);
        }
        if (data.description !== undefined) {
            updates.push('description = ?');
            params.push(data.description);
        }
        if (data.manager_id !== undefined) {
            updates.push('manager_id = ?');
            params.push(data.manager_id);
        }
        if (data.color !== undefined) {
            updates.push('color = ?');
            params.push(data.color);
        }

        if (updates.length === 0) {
            throw new Error('No hay datos para actualizar');
        }

        params.push(data.id);

        this.db.execute(
            `UPDATE departments SET ${updates.join(', ')} WHERE id = ?`,
            params
        );

        const department = this.getById(data.id);
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
