/**
 * Utilidades para manejo consistente de fechas y horas locales.
 *
 * Evita la discrepancia UTC de toISOString() que desincroniza fechas
 * en zonas horarias negativas (ej: UTC-5, UTC-6) durante horas vespertinas/nocturnas,
 * donde toISOString().split('T')[0] avanza al día siguiente mientras la hora local
 * sigue siendo del día actual.
 */
import { safeParseInt } from './object-utils.js';

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
 * Retorna la hora local con precisión de milisegundos en formato HH:MM:SS.mmm.
 */
export function getLocalTimeWithMsString(d: Date = new Date()): string {
    const valid = d instanceof Date && !Number.isNaN(d.getTime()) ? d : new Date();
    const base = getLocalTimeString(valid);
    const ms = String(valid.getMilliseconds()).padStart(3, '0');
    return `${base}.${ms}`;
}

/**
 * Parsea una cadena de fecha YYYY-MM-DD como fecha local (medianoche local 00:00:00.000).
 */
export function parseLocalDate(dateStr: string): Date {
    if (!dateStr || typeof dateStr !== 'string') {
        return new Date();
    }
    const cleanDate = dateStr.includes('T') ? dateStr.split('T')[0] : dateStr;
    const parts = cleanDate.split('-').map(p => parseInt(p, 10));
    if (parts.length >= 3 && parts.every(p => Number.isFinite(p))) {
        return new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0);
    }
    const fallback = new Date(dateStr);
    return Number.isNaN(fallback.getTime()) ? new Date() : fallback;
}


/**
 * Convierte una hora en formato HH:MM, HH:MM:SS o HH:MM:SS.mmm a minutos transcurridos desde medianoche.
 * Maneja valores nulos, indefinidos, cadenas vacías o malformadas de forma segura devolviendo 0.
 */
export function timeToMinutes(time: string | null | undefined): number {
    if (!time || typeof time !== 'string') return 0;
    const parts = time.split(':');
    if (parts.length < 2) return 0;
    const hours = safeParseInt(parts[0], 0);
    const minutes = safeParseInt(parts[1], 0);
    return hours * 60 + minutes;
}

/**
 * Convierte una hora en formato HH:MM, HH:MM:SS o HH:MM:SS.mmm a milisegundos exactos desde medianoche (00:00:00.000).
 * Maneja entradas inválidas devolviendo 0 de forma segura.
 */
export function timeToMilliseconds(time: string | null | undefined): number {
    if (!time || typeof time !== 'string') return 0;
    const trimmed = time.trim();
    const parts = trimmed.split(':');
    if (parts.length < 2) return 0;

    const hours = Number(parts[0]);
    const minutes = Number(parts[1]);
    let seconds = 0;
    let ms = 0;

    if (parts.length >= 3) {
        const secParts = parts[2].split('.');
        seconds = Number(secParts[0]);
        if (secParts.length > 1) {
            const rawMs = secParts[1].padEnd(3, '0').slice(0, 3);
            ms = Number(rawMs);
        }
    }

    if (
        !Number.isFinite(hours) ||
        !Number.isFinite(minutes) ||
        !Number.isFinite(seconds) ||
        !Number.isFinite(ms)
    ) {
        return 0;
    }
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59 || seconds < 0 || seconds > 59 || ms < 0 || ms > 999) {
        return 0;
    }

    return ((hours * 3600 + minutes * 60 + seconds) * 1000) + ms;
}

/**
 * Calcula los milisegundos exactos transcurridos entre una fecha/hora local registrada
 * (dateStr YYYY-MM-DD y timeStr HH:MM:SS.mmm) y un instante de referencia (now).
 */
export function calculateElapsedMilliseconds(
    dateStr: string,
    timeStr: string | null | undefined,
    now: Date = new Date()
): number {
    if (!dateStr || !timeStr) return 0;
    const baseDate = parseLocalDate(dateStr);
    const timeMs = timeToMilliseconds(timeStr);
    const targetEpochMs = baseDate.getTime() + timeMs;
    const nowEpochMs = now instanceof Date && !Number.isNaN(now.getTime()) ? now.getTime() : Date.now();
    return Math.max(0, nowEpochMs - targetEpochMs);
}

