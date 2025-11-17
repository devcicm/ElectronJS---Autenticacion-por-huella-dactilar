/**
 * Modelo de Empleados
 */
export class EmployeeModel {
    db;
    constructor(db) {
        this.db = db;
    }
    /**
     * Obtener todos los empleados
     */
    getAll(filters) {
        let sql = 'SELECT * FROM employees WHERE 1=1';
        const params = [];
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
        return this.db.query(sql, params);
    }
    /**
     * Obtener empleados con detalles completos
     */
    getAllWithDetails(filters) {
        let sql = 'SELECT * FROM employees_with_details WHERE 1=1';
        const params = [];
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
        return this.db.query(sql, params);
    }
    /**
     * Obtener un empleado por ID
     */
    getById(id) {
        return this.db.queryOne('SELECT * FROM employees WHERE id = ?', [id]);
    }
    /**
     * Obtener empleado con detalles por ID
     */
    getByIdWithDetails(id) {
        return this.db.queryOne('SELECT * FROM employees_with_details WHERE id = ?', [id]);
    }
    /**
     * Obtener un empleado por código
     */
    getByCode(code) {
        return this.db.queryOne('SELECT * FROM employees WHERE employee_code = ?', [code]);
    }
    /**
     * Obtener un empleado por email
     */
    getByEmail(email) {
        return this.db.queryOne('SELECT * FROM employees WHERE email = ?', [email]);
    }
    /**
     * Crear un nuevo empleado
     */
    create(data) {
        const result = this.db.execute(`INSERT INTO employees (
                employee_code, first_name, last_name, email, phone,
                department_id, shift_id, position, hire_date, status, photo_url
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
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
        ]);
        const employee = this.getById(result.lastInsertRowid);
        if (!employee) {
            throw new Error('Error creando empleado');
        }
        return employee;
    }
    /**
     * Actualizar un empleado
     */
    update(data) {
        const updates = [];
        const params = [];
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
        if (updates.length === 0) {
            throw new Error('No hay datos para actualizar');
        }
        params.push(data.id);
        this.db.execute(`UPDATE employees SET ${updates.join(', ')} WHERE id = ?`, params);
        const employee = this.getById(data.id);
        if (!employee) {
            throw new Error('Empleado no encontrado después de actualizar');
        }
        return employee;
    }
    /**
     * Eliminar un empleado
     */
    delete(id) {
        const result = this.db.execute('DELETE FROM employees WHERE id = ?', [id]);
        return result.changes > 0;
    }
    /**
     * Contar empleados activos
     */
    countActive() {
        const result = this.db.queryOne("SELECT COUNT(*) as count FROM employees WHERE status = 'active'");
        return result?.count || 0;
    }
    /**
     * Obtener empleados por departamento
     */
    getByDepartment(departmentId) {
        return this.db.query('SELECT * FROM employees WHERE department_id = ? ORDER BY last_name, first_name', [departmentId]);
    }
    /**
     * Obtener empleados por turno
     */
    getByShift(shiftId) {
        return this.db.query('SELECT * FROM employees WHERE shift_id = ? ORDER BY last_name, first_name', [shiftId]);
    }
}
//# sourceMappingURL=EmployeeModel.js.map