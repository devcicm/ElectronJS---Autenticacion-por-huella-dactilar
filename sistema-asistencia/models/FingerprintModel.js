/**
 * Modelo de Huellas Dactilares
 */
export class FingerprintModel {
    db;
    constructor(db) {
        this.db = db;
    }
    /**
     * Obtener todas las huellas de un empleado
     */
    getByEmployee(employeeId) {
        return this.db.query('SELECT * FROM fingerprints WHERE employee_id = ? ORDER BY finger_position', [employeeId]);
    }
    /**
     * Obtener huella por ID
     */
    getById(id) {
        return this.db.queryOne('SELECT * FROM fingerprints WHERE id = ?', [id]);
    }
    /**
     * Obtener huella específica de un empleado
     */
    getByEmployeeAndFinger(employeeId, fingerPosition) {
        return this.db.queryOne('SELECT * FROM fingerprints WHERE employee_id = ? AND finger_position = ?', [employeeId, fingerPosition]);
    }
    /**
     * Crear o actualizar una huella
     */
    upsert(data) {
        // Verificar si ya existe
        const existing = this.getByEmployeeAndFinger(data.employee_id, data.finger_position);
        if (existing) {
            // Actualizar
            return this.update({
                id: existing.id,
                template_data: data.template_data,
                quality_score: data.quality_score
            });
        }
        else {
            // Crear nuevo
            return this.create(data);
        }
    }
    /**
     * Crear una nueva huella
     */
    create(data) {
        const result = this.db.execute(`INSERT INTO fingerprints (employee_id, finger_position, template_data, quality_score)
             VALUES (?, ?, ?, ?)`, [
            data.employee_id,
            data.finger_position,
            data.template_data,
            data.quality_score || 0
        ]);
        const fingerprint = this.getById(result.lastInsertRowid);
        if (!fingerprint) {
            throw new Error('Error creando huella dactilar');
        }
        return fingerprint;
    }
    /**
     * Actualizar una huella
     */
    update(data) {
        const updates = [];
        const params = [];
        if (data.template_data !== undefined) {
            updates.push('template_data = ?');
            params.push(data.template_data);
        }
        if (data.quality_score !== undefined) {
            updates.push('quality_score = ?');
            params.push(data.quality_score);
        }
        if (updates.length === 0) {
            throw new Error('No hay datos para actualizar');
        }
        params.push(data.id);
        this.db.execute(`UPDATE fingerprints SET ${updates.join(', ')} WHERE id = ?`, params);
        const fingerprint = this.getById(data.id);
        if (!fingerprint) {
            throw new Error('Huella no encontrada después de actualizar');
        }
        return fingerprint;
    }
    /**
     * Eliminar una huella
     */
    delete(id) {
        const result = this.db.execute('DELETE FROM fingerprints WHERE id = ?', [id]);
        return result.changes > 0;
    }
    /**
     * Eliminar todas las huellas de un empleado
     */
    deleteByEmployee(employeeId) {
        const result = this.db.execute('DELETE FROM fingerprints WHERE employee_id = ?', [employeeId]);
        return result.changes;
    }
    /**
     * Verificar si un empleado tiene huellas registradas
     */
    hasFingerprints(employeeId) {
        const result = this.db.queryOne('SELECT COUNT(*) as count FROM fingerprints WHERE employee_id = ?', [employeeId]);
        return (result?.count || 0) > 0;
    }
    /**
     * Contar huellas de un empleado
     */
    countByEmployee(employeeId) {
        const result = this.db.queryOne('SELECT COUNT(*) as count FROM fingerprints WHERE employee_id = ?', [employeeId]);
        return result?.count || 0;
    }
    /**
     * Obtener todos los empleados con huellas registradas
     */
    getEmployeesWithFingerprints() {
        const results = this.db.query('SELECT DISTINCT employee_id FROM fingerprints ORDER BY employee_id');
        return results.map(r => r.employee_id);
    }
    /**
     * Buscar empleado por template (para verificación)
     * Nota: Esta es una búsqueda simple por ID de empleado.
     * La verificación real del template se hace en el biometric-engine.
     */
    findByTemplate(employeeId) {
        return this.getByEmployee(employeeId);
    }
    /**
     * Obtener estadísticas de huellas
     */
    getStats() {
        const stats = this.db.queryOne(`SELECT
                COUNT(*) as total_fingerprints,
                COUNT(DISTINCT employee_id) as employees_with_fingerprints,
                AVG(quality_score) as average_quality
             FROM fingerprints`);
        return stats || {
            total_fingerprints: 0,
            employees_with_fingerprints: 0,
            average_quality: 0
        };
    }
}
//# sourceMappingURL=FingerprintModel.js.map