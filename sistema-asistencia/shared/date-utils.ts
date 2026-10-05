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
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * Retorna la hora local en formato HH:MM:SS.
 */
export function getLocalTimeString(d: Date = new Date()): string {
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    const seconds = String(d.getSeconds()).padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
}

/**
 * Parsea una cadena de fecha YYYY-MM-DD como fecha local (medianoche local).
 */
export function parseLocalDate(dateStr: string): Date {
    const [year, month, day] = dateStr.split('-').map(Number);
    return new Date(year, month - 1, day);
}
