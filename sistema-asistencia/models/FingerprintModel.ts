/**
 * Modelo de Huellas Dactilares
 */

import { DatabaseManager } from '../database/init.js';
import { Fingerprint, FingerprintCreate, FingerprintUpdate, FingerPosition } from '../types/index.js';
import { safeParseInt } from '../shared/object-utils.js';

export class FingerprintModel {
    constructor(private db: DatabaseManager) {}

    /**
     * Obtener todas las huellas de un empleado
     */
    getByEmployee(employeeId: number): Fingerprint[] {
        const empId = safeParseInt(employeeId, 0);
        if (empId <= 0) return [];
        return this.db.query<Fingerprint>(
            'SELECT * FROM fingerprints WHERE employee_id = ? ORDER BY finger_position',
            [empId]
        );
    }

    /**
     * Obtener huella por ID
     */
    getById(id: number): Fingerprint | undefined {
        const cleanId = safeParseInt(id, 0);
        if (cleanId <= 0) return undefined;
        return this.db.queryOne<Fingerprint>(
            'SELECT * FROM fingerprints WHERE id = ?',
            [cleanId]
        );
    }

    /**
     * Obtener huella específica de un empleado (por mano y dedo)
     */
    getByEmployeeAndFinger(employeeId: number, hand: 'LEFT' | 'RIGHT', fingerPosition: FingerPosition): Fingerprint | undefined {
        const empId = safeParseInt(employeeId, 0);
        if (empId <= 0) return undefined;
        return this.db.queryOne<Fingerprint>(
            'SELECT * FROM fingerprints WHERE employee_id = ? AND hand = ? AND finger_position = ?',
            [empId, hand, fingerPosition]
        );
    }

    /**
     * Crear o actualizar una huella
     */
    upsert(data: FingerprintCreate): Fingerprint {
        if (!data || typeof data !== 'object') {
            throw new Error('Datos de huella inválidos');
        }
        const empId = safeParseInt(data.employee_id, 0);
        if (empId <= 0) throw new Error('ID de empleado inválido');

        // Verificar si ya existe (considerando mano Y dedo)
        const existing = this.getByEmployeeAndFinger(empId, data.hand, data.finger_position);

        if (existing) {
            // Actualizar
            return this.update({
                id: existing.id,
                template_data: data.template_data,
                quality_score: data.quality_score
            });
        } else {
            // Crear nuevo
            return this.create({
                ...data,
                employee_id: empId
            });
        }
    }

    /**
     * Crear una nueva huella
     */
    create(data: FingerprintCreate): Fingerprint {
        const result = this.db.execute(
            `INSERT INTO fingerprints (employee_id, finger_position, hand, template_data, quality_score)
             VALUES (?, ?, ?, ?, ?)`,
            [
                data.employee_id,
                data.finger_position,
                data.hand,
                data.template_data,
                data.quality_score || 0
            ]
        );

        const fingerprint = this.getById(result.lastInsertRowid as number);
        if (!fingerprint) {
            throw new Error('Error creando huella dactilar');
        }

        return fingerprint;
    }

    /**
     * Actualizar una huella
     */
    update(data: FingerprintUpdate): Fingerprint {
        const updates: string[] = [];
        const params: any[] = [];

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

        this.db.execute(
            `UPDATE fingerprints SET ${updates.join(', ')} WHERE id = ?`,
            params
        );

        const fingerprint = this.getById(data.id);
        if (!fingerprint) {
            throw new Error('Huella no encontrada después de actualizar');
        }

        return fingerprint;
    }

    /**
     * Eliminar una huella
     */
    delete(id: number): boolean {
        const result = this.db.execute('DELETE FROM fingerprints WHERE id = ?', [id]);
        return result.changes > 0;
    }

    /**
     * Eliminar todas las huellas de un empleado
     */
    deleteByEmployee(employeeId: number): number {
        const result = this.db.execute('DELETE FROM fingerprints WHERE employee_id = ?', [employeeId]);
        return result.changes;
    }

    /**
     * Verificar si un empleado tiene huellas registradas
     */
    hasFingerprints(employeeId: number): boolean {
        const result = this.db.queryOne<{ count: number }>(
            'SELECT COUNT(*) as count FROM fingerprints WHERE employee_id = ?',
            [employeeId]
        );
        return (result?.count || 0) > 0;
    }

    /**
     * Contar huellas de un empleado
     */
    countByEmployee(employeeId: number): number {
        const result = this.db.queryOne<{ count: number }>(
            'SELECT COUNT(*) as count FROM fingerprints WHERE employee_id = ?',
            [employeeId]
        );
        return result?.count || 0;
    }

    /**
     * Obtener todos los empleados con huellas registradas
     */
    getEmployeesWithFingerprints(): number[] {
        const results = this.db.query<{ employee_id: number }>(
            'SELECT DISTINCT employee_id FROM fingerprints ORDER BY employee_id'
        );
        return results.map(r => r.employee_id);
    }

    /**
     * Buscar empleado por template (para verificación)
     * Nota: Esta es una búsqueda simple por ID de empleado.
     * La verificación real del template se hace en el biometric-engine.
     */
    findByTemplate(employeeId: number): Fingerprint[] {
        return this.getByEmployee(employeeId);
    }

    /**
     * Obtener estadísticas de huellas
     */
    getStats(): {
        total_fingerprints: number;
        employees_with_fingerprints: number;
        average_quality: number;
    } {
        const stats = this.db.queryOne<{
            total_fingerprints: number;
            employees_with_fingerprints: number;
            average_quality: number;
        }>(
            `SELECT
                COUNT(*) as total_fingerprints,
                COUNT(DISTINCT employee_id) as employees_with_fingerprints,
                AVG(quality_score) as average_quality
             FROM fingerprints`
        );

        return stats || {
            total_fingerprints: 0,
            employees_with_fingerprints: 0,
            average_quality: 0
        };
    }
}
