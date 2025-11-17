/**
 * Modelo de Empleados
 */

import { DatabaseManager } from '../database/init.js';
import {
    Employee,
    EmployeeCreate,
    EmployeeUpdate,
    EmployeeWithDetails,
    EmployeeFilters
} from '../types/index.js';

export class EmployeeModel {
    constructor(private db: DatabaseManager) {}

    /**
     * Obtener todos los empleados
     */
    getAll(filters?: EmployeeFilters): Employee[] {
        let sql = 'SELECT * FROM employees WHERE 1=1';
        const params: any[] = [];

        if (filters?.department_id) {
            sql += ' AND department_id = ?';
            params.push(filters.department_id);
        }

        if (filters?.shift_id) {
            sql += ' AND shift_id = ?';
            params.push(filters.shift_id);
        }

        if (filters?.status) {
            sql += ' AND status = ?';
            params.push(filters.status);
        }

        if (filters?.search) {
            sql += ` AND (
                first_name LIKE ? OR
                last_name LIKE ? OR
                employee_code LIKE ? OR
                email LIKE ?
            )`;
            const searchParam = `%${filters.search}%`;
            params.push(searchParam, searchParam, searchParam, searchParam);
        }

        sql += ' ORDER BY last_name, first_name';

        return this.db.query<Employee>(sql, params);
    }

    /**
     * Obtener empleados con detalles completos
     */
    getAllWithDetails(filters?: EmployeeFilters): EmployeeWithDetails[] {
        let sql = 'SELECT * FROM employees_with_details WHERE 1=1';
        const params: any[] = [];

        if (filters?.department_id) {
            sql += ' AND department_id = ?';
            params.push(filters.department_id);
        }

        if (filters?.shift_id) {
            sql += ' AND shift_id = ?';
            params.push(filters.shift_id);
        }

        if (filters?.status) {
            sql += ' AND status = ?';
            params.push(filters.status);
        }

        if (filters?.search) {
            sql += ` AND (
                first_name LIKE ? OR
                last_name LIKE ? OR
                employee_code LIKE ? OR
                email LIKE ?
            )`;
            const searchParam = `%${filters.search}%`;
            params.push(searchParam, searchParam, searchParam, searchParam);
        }

        sql += ' ORDER BY last_name, first_name';

        return this.db.query<EmployeeWithDetails>(sql, params);
    }

    /**
     * Obtener un empleado por ID
     */
    getById(id: number): Employee | undefined {
        return this.db.queryOne<Employee>(
            'SELECT * FROM employees WHERE id = ?',
            [id]
        );
    }

    /**
     * Obtener empleado con detalles por ID
     */
    getByIdWithDetails(id: number): EmployeeWithDetails | undefined {
        return this.db.queryOne<EmployeeWithDetails>(
            'SELECT * FROM employees_with_details WHERE id = ?',
            [id]
        );
    }

    /**
     * Obtener un empleado por código
     */
    getByCode(code: string): Employee | undefined {
        return this.db.queryOne<Employee>(
            'SELECT * FROM employees WHERE employee_code = ?',
            [code]
        );
    }

    /**
     * Obtener un empleado por email
     */
    getByEmail(email: string): Employee | undefined {
        return this.db.queryOne<Employee>(
            'SELECT * FROM employees WHERE email = ?',
            [email]
        );
    }

    /**
     * Crear un nuevo empleado
     */
    create(data: EmployeeCreate): Employee {
        const result = this.db.execute(
            `INSERT INTO employees (
                employee_code, first_name, last_name, email, phone,
                department_id, shift_id, position, hire_date, status, photo_url
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                data.employee_code,
                data.first_name,
                data.last_name,
                data.email,
                data.phone || null,
                data.department_id,
                data.shift_id,
                data.position,
                data.hire_date,
                data.status || 'active',
                data.photo_url || null
            ]
        );

        const employee = this.getById(result.lastInsertRowid as number);
        if (!employee) {
            throw new Error('Error creando empleado');
        }

        return employee;
    }

    /**
     * Actualizar un empleado
     */
    update(data: EmployeeUpdate): Employee {
        const updates: string[] = [];
        const params: any[] = [];

        if (data.employee_code !== undefined) {
            updates.push('employee_code = ?');
            params.push(data.employee_code);
        }
        if (data.first_name !== undefined) {
            updates.push('first_name = ?');
            params.push(data.first_name);
        }
        if (data.last_name !== undefined) {
            updates.push('last_name = ?');
            params.push(data.last_name);
        }
        if (data.email !== undefined) {
            updates.push('email = ?');
            params.push(data.email);
        }
        if (data.phone !== undefined) {
            updates.push('phone = ?');
            params.push(data.phone);
        }
        if (data.department_id !== undefined) {
            updates.push('department_id = ?');
            params.push(data.department_id);
        }
        if (data.shift_id !== undefined) {
            updates.push('shift_id = ?');
            params.push(data.shift_id);
        }
        if (data.status !== undefined) {
            updates.push('status = ?');
            params.push(data.status);
        }
        if (data.photo_url !== undefined) {
            updates.push('photo_url = ?');
            params.push(data.photo_url);
        }
        if (data.enrollment_mode !== undefined) {
            updates.push('enrollment_mode = ?');
            params.push(data.enrollment_mode);
        }
        if (data.position !== undefined) {
            updates.push('position = ?');
            params.push(data.position);
        }
        if (data.hire_date !== undefined) {
            updates.push('hire_date = ?');
            params.push(data.hire_date);
        }

        if (updates.length === 0) {
            throw new Error('No hay datos para actualizar');
        }

        params.push(data.id);

        this.db.execute(
            `UPDATE employees SET ${updates.join(', ')} WHERE id = ?`,
            params
        );

        const employee = this.getById(data.id);
        if (!employee) {
            throw new Error('Empleado no encontrado después de actualizar');
        }

        return employee;
    }

    /**
     * Eliminar un empleado
     */
    delete(id: number): boolean {
        const result = this.db.execute('DELETE FROM employees WHERE id = ?', [id]);
        return result.changes > 0;
    }

    /**
     * Contar empleados activos
     */
    countActive(): number {
        const result = this.db.queryOne<{ count: number }>(
            "SELECT COUNT(*) as count FROM employees WHERE status = 'active'"
        );
        return result?.count || 0;
    }

    /**
     * Obtener empleados por departamento
     */
    getByDepartment(departmentId: number): Employee[] {
        return this.db.query<Employee>(
            'SELECT * FROM employees WHERE department_id = ? ORDER BY last_name, first_name',
            [departmentId]
        );
    }

    /**
     * Obtener empleados por turno
     */
    getByShift(shiftId: number): Employee[] {
        return this.db.query<Employee>(
            'SELECT * FROM employees WHERE shift_id = ? ORDER BY last_name, first_name',
            [shiftId]
        );
    }
}
