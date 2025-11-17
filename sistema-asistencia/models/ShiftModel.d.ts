/**
 * Modelo de Turnos
 */
import { DatabaseManager } from '../database/init';
import { Shift, ShiftCreate, ShiftUpdate } from '../types';
export declare class ShiftModel {
    private db;
    constructor(db: DatabaseManager);
    /**
     * Obtener todos los turnos
     */
    getAll(): Shift[];
    /**
     * Obtener turno por ID
     */
    getById(id: number): Shift | undefined;
    /**
     * Obtener turno por nombre
     */
    getByName(name: string): Shift | undefined;
    /**
     * Crear un nuevo turno
     */
    create(data: ShiftCreate): Shift;
    /**
     * Actualizar un turno
     */
    update(data: ShiftUpdate): Shift;
    /**
     * Eliminar un turno
     */
    delete(id: number): boolean;
    /**
     * Obtener estadísticas del turno
     */
    getStats(shiftId: number): {
        total_employees: number;
        active_employees: number;
    };
    /**
     * Calcular duración del turno en horas
     */
    calculateShiftDuration(shift: Shift): number;
    /**
     * Convertir tiempo HH:MM a minutos
     */
    private timeToMinutes;
}
//# sourceMappingURL=ShiftModel.d.ts.map