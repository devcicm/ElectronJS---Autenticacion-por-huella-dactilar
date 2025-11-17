/**
 * Modelo de Turnos
 */
export class ShiftModel {
    db;
    constructor(db) {
        this.db = db;
    }
    /**
     * Obtener todos los turnos
     */
    getAll() {
        return this.db.query('SELECT * FROM shifts ORDER BY start_time');
    }
    /**
     * Obtener turno por ID
     */
    getById(id) {
        return this.db.queryOne('SELECT * FROM shifts WHERE id = ?', [id]);
    }
    /**
     * Obtener turno por nombre
     */
    getByName(name) {
        return this.db.queryOne('SELECT * FROM shifts WHERE name = ?', [name]);
    }
    /**
     * Crear un nuevo turno
     */
    create(data) {
        const result = this.db.execute(`INSERT INTO shifts (name, start_time, end_time, tolerance_minutes, color)
             VALUES (?, ?, ?, ?, ?)`, [
            data.name,
            data.start_time,
            data.end_time,
            data.tolerance_minutes || 0,
            data.color || '#3B82F6'
        ]);
        const shift = this.getById(result.lastInsertRowid);
        if (!shift) {
            throw new Error('Error creando turno');
        }
        return shift;
    }
    /**
     * Actualizar un turno
     */
    update(data) {
        const updates = [];
        const params = [];
        if (data.name !== undefined) {
            updates.push('name = ?');
            params.push(data.name);
        }
        if (data.start_time !== undefined) {
            updates.push('start_time = ?');
            params.push(data.start_time);
        }
        if (data.end_time !== undefined) {
            updates.push('end_time = ?');
            params.push(data.end_time);
        }
        if (data.tolerance_minutes !== undefined) {
            updates.push('tolerance_minutes = ?');
            params.push(data.tolerance_minutes);
        }
        if (data.color !== undefined) {
            updates.push('color = ?');
            params.push(data.color);
        }
        if (updates.length === 0) {
            throw new Error('No hay datos para actualizar');
        }
        params.push(data.id);
        this.db.execute(`UPDATE shifts SET ${updates.join(', ')} WHERE id = ?`, params);
        const shift = this.getById(data.id);
        if (!shift) {
            throw new Error('Turno no encontrado después de actualizar');
        }
        return shift;
    }
    /**
     * Eliminar un turno
     */
    delete(id) {
        const result = this.db.execute('DELETE FROM shifts WHERE id = ?', [id]);
        return result.changes > 0;
    }
    /**
     * Obtener estadísticas del turno
     */
    getStats(shiftId) {
        const stats = this.db.queryOne(`SELECT
                COUNT(*) as total_employees,
                SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_employees
             FROM employees
             WHERE shift_id = ?`, [shiftId]);
        return stats || { total_employees: 0, active_employees: 0 };
    }
    /**
     * Calcular duración del turno en horas
     */
    calculateShiftDuration(shift) {
        const start = this.timeToMinutes(shift.start_time);
        const end = this.timeToMinutes(shift.end_time);
        let duration = end - start;
        // Si el turno cruza la medianoche
        if (duration < 0) {
            duration += 24 * 60; // Añadir 24 horas en minutos
        }
        return duration / 60; // Convertir a horas
    }
    /**
     * Convertir tiempo HH:MM a minutos
     */
    timeToMinutes(time) {
        const [hours, minutes] = time.split(':').map(Number);
        return hours * 60 + minutes;
    }
}
//# sourceMappingURL=ShiftModel.js.map