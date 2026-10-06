/**
 * Utilidades para manejo consistente de fechas y horas locales.
 *
 * Evita la discrepancia UTC de toISOString() que desincroniza fechas
 * en zonas horarias negativas (ej: UTC-5, UTC-6) durante horas vespertinas/nocturnas,
 * donde toISOString().split('T')[0] avanza al día siguiente mientras la hora local
 * sigue siendo del día actual.
 */

/**
 * Retorna la fecha local en formato YYYY-MM-DD.
 */
export function getLocalDateString(d: Date = new Date()): string {
    const valid = d instanceof Date && !Number.isNaN(d.getTime()) ? d : new Date();
    const year = valid.getFullYear();
    const month = String(valid.getMonth() + 1).padStart(2, '0');
    const day = String(valid.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * Retorna la hora local en formato HH:MM:SS.
 */
export function getLocalTimeString(d: Date = new Date()): string {
    const valid = d instanceof Date && !Number.isNaN(d.getTime()) ? d : new Date();
    const hours = String(valid.getHours()).padStart(2, '0');
    const minutes = String(valid.getMinutes()).padStart(2, '0');
    const seconds = String(valid.getSeconds()).padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
}

/**
 * Parsea una cadena de fecha YYYY-MM-DD como fecha local (medianoche local).
 */
export function parseLocalDate(dateStr: string): Date {
    if (!dateStr || typeof dateStr !== 'string') {
        return new Date();
    }
    const cleanDate = dateStr.includes('T') ? dateStr.split('T')[0] : dateStr;
    const parts = cleanDate.split('-').map(p => parseInt(p, 10));
    if (parts.length >= 3 && parts.every(p => Number.isFinite(p))) {
        return new Date(parts[0], parts[1] - 1, parts[2]);
    }
    const fallback = new Date(dateStr);
    return Number.isNaN(fallback.getTime()) ? new Date() : fallback;
}

