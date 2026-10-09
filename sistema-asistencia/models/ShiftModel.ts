/**
 * Modelo de Turnos
 */

import { DatabaseManager } from '../database/init.js';
import { Shift, ShiftCreate, ShiftUpdate } from '../types/index.js';
import { safeParseInt, buildUpdateClause } from '../shared/object-utils.js';
import { timeToMinutes } from '../shared/date-utils.js';

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

        const { setClause, params } = buildUpdateClause(data, {
            name: (v) => {
                const name = String(v).trim();
                if (!name) throw new Error('El nombre no puede estar vacío');
                return name;
            },
            start_time: (v) => {
                const st = String(v).trim();
                if (!st) throw new Error('La hora de inicio no puede estar vacía');
                return st;
            },
            end_time: (v) => {
                const et = String(v).trim();
                if (!et) throw new Error('La hora de fin no puede estar vacía');
                return et;
            },
            tolerance_minutes: (v) => Math.max(0, safeParseInt(v, 0)),
            color: (v) => String(v).trim() || '#3B82F6'
        });

        if (!setClause) {
            throw new Error('No hay datos para actualizar');
        }

        params.push(id);

        this.db.execute(
            `UPDATE shifts SET ${setClause} WHERE id = ?`,
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
     * Convertir tiempo HH:MM a minutos (delega a date-utils)
     */
    private timeToMinutes(time: string): number {
        return timeToMinutes(time);
    }
}
