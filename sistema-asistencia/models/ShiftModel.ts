/**
 * Modelo de Turnos
 */

import { DatabaseManager } from '../database/init.js';
import { Shift, ShiftCreate, ShiftUpdate } from '../types/index.js';
import { safeParseInt } from '../shared/object-utils.js';

export class ShiftModel {
    constructor(private db: DatabaseManager) {}

    /**
     * Obtener todos los turnos
     */
    getAll(): Shift[] {
        return this.db.query<Shift>(
            'SELECT * FROM shifts ORDER BY start_time'
        );
    }

    /**
     * Obtener turno por ID
     */
    getById(id: number): Shift | undefined {
        const cleanId = safeParseInt(id, 0);
        if (cleanId <= 0) return undefined;
        return this.db.queryOne<Shift>(
            'SELECT * FROM shifts WHERE id = ?',
            [cleanId]
        );
    }

    /**
     * Obtener turno por nombre
     */
    getByName(name: string): Shift | undefined {
        return this.db.queryOne<Shift>(
            'SELECT * FROM shifts WHERE name = ?',
            [name]
        );
    }

    /**
     * Crear un nuevo turno
     */
    create(data: ShiftCreate): Shift {
        if (!data || typeof data !== 'object') {
            throw new Error('Datos de turno inválidos');
        }

        const name = typeof data.name === 'string' ? data.name.trim() : '';
        if (!name) {
            throw new Error('El nombre del turno es requerido');
        }

        const startTime = typeof data.start_time === 'string' ? data.start_time.trim() : '';
        const endTime = typeof data.end_time === 'string' ? data.end_time.trim() : '';
        if (!startTime || !endTime) {
            throw new Error('Hora de inicio y fin son requeridas');
        }

        const toleranceMinutes = Math.max(0, safeParseInt(data.tolerance_minutes, 10));
        const color = typeof data.color === 'string' && data.color.trim() ? data.color.trim() : '#3B82F6';

        const result = this.db.execute(
            `INSERT INTO shifts (name, start_time, end_time, tolerance_minutes, color)
             VALUES (?, ?, ?, ?, ?)`,
            [name, startTime, endTime, toleranceMinutes, color]
        );

        const shift = this.getById(result.lastInsertRowid as number);
        if (!shift) {
            throw new Error('Error creando turno');
        }

        return shift;
    }

    /**
     * Actualizar un turno
     */
    update(data: ShiftUpdate): Shift {
        if (!data || typeof data !== 'object') {
            throw new Error('Datos de actualización inválidos');
        }

        const id = safeParseInt(data.id, 0);
        if (id <= 0) {
            throw new Error('ID de turno inválido');
        }

        const updates: string[] = [];
        const params: any[] = [];

        if (data.name !== undefined) {
            const name = String(data.name).trim();
            if (!name) throw new Error('El nombre no puede estar vacío');
            updates.push('name = ?');
            params.push(name);
        }
        if (data.start_time !== undefined) {
            const st = String(data.start_time).trim();
            if (!st) throw new Error('La hora de inicio no puede estar vacía');
            updates.push('start_time = ?');
            params.push(st);
        }
        if (data.end_time !== undefined) {
            const et = String(data.end_time).trim();
            if (!et) throw new Error('La hora de fin no puede estar vacía');
            updates.push('end_time = ?');
            params.push(et);
        }
        if (data.tolerance_minutes !== undefined) {
            const tol = Math.max(0, safeParseInt(data.tolerance_minutes, 0));
            updates.push('tolerance_minutes = ?');
            params.push(tol);
        }
        if (data.color !== undefined) {
            updates.push('color = ?');
            params.push(String(data.color).trim() || '#3B82F6');
        }

        if (updates.length === 0) {
            throw new Error('No hay datos para actualizar');
        }

        params.push(id);

        this.db.execute(
            `UPDATE shifts SET ${updates.join(', ')} WHERE id = ?`,
            params
        );

        const shift = this.getById(id);
        if (!shift) {
            throw new Error('Turno no encontrado después de actualizar');
        }

        return shift;
    }

    /**
     * Eliminar un turno
     */
    delete(id: number): boolean {
        const result = this.db.execute('DELETE FROM shifts WHERE id = ?', [id]);
        return result.changes > 0;
    }

    /**
     * Obtener estadísticas del turno
     */
    getStats(shiftId: number): {
        total_employees: number;
        active_employees: number;
    } {
        const stats = this.db.queryOne<{
            total_employees: number;
            active_employees: number;
        }>(
            `SELECT
                COUNT(*) as total_employees,
                SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_employees
             FROM employees
             WHERE shift_id = ?`,
            [shiftId]
        );

        return stats || { total_employees: 0, active_employees: 0 };
    }

    /**
     * Calcular duración del turno en horas
     */
    calculateShiftDuration(shift: Shift): number {
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
    private timeToMinutes(time: string): number {
        const [hours, minutes] = time.split(':').map(Number);
        return hours * 60 + minutes;
    }
}
