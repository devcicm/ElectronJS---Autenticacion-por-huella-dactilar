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
import { safeParseInt, buildUpdateClause } from '../shared/object-utils.js';

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
        if (!data || typeof data !== 'object') {
            throw new Error('Datos de empleado inválidos o no proporcionados');
        }

        const deptId = safeParseInt(data.department_id, 0);
        const shiftId = safeParseInt(data.shift_id, 0);
        if (deptId <= 0) throw new Error('Departamento inválido');
        if (shiftId <= 0) throw new Error('Turno inválido');

        const result = this.db.execute(
            `INSERT INTO employees (
                employee_code, first_name, last_name, email, phone,
                department_id, shift_id, position, hire_date, status, photo_url, enrollment_mode
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                String(data.employee_code || '').trim(),
                String(data.first_name || '').trim(),
                String(data.last_name || '').trim(),
                String(data.email || '').trim().toLowerCase(),
                data.phone ? String(data.phone).trim() : null,
                deptId,
                shiftId,
                String(data.position || '').trim(),
                String(data.hire_date || '').trim(),
                data.status || 'active',
                data.photo_url || null,
                data.enrollment_mode || 'simple'
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
        if (!data || typeof data !== 'object') {
            throw new Error('Datos de actualización inválidos o no proporcionados');
        }

        const id = safeParseInt(data.id, 0);
        if (id <= 0) {
            throw new Error('ID de empleado inválido');
        }

        const { setClause, params } = buildUpdateClause(data, {
            employee_code: (v) => String(v).trim(),
            first_name: (v) => String(v).trim(),
            last_name: (v) => String(v).trim(),
            email: (v) => String(v).trim().toLowerCase(),
            phone: (v) => (v ? String(v).trim() : null),
            department_id: (v) => {
                const deptId = safeParseInt(v, 0);
                if (deptId <= 0) throw new Error('Departamento inválido');
                return deptId;
            },
            shift_id: (v) => {
                const shiftId = safeParseInt(v, 0);
                if (shiftId <= 0) throw new Error('Turno inválido');
                return shiftId;
            },
            status: (v) => v,
            photo_url: (v) => v,
            enrollment_mode: (v) => v,
            position: (v) => v,
            hire_date: (v) => v
        });

        if (!setClause) {
            throw new Error('No hay datos para actualizar');
        }

        params.push(id);

        this.db.execute(
            `UPDATE employees SET ${setClause} WHERE id = ?`,
            params
        );

        const employee = this.getById(id);
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
