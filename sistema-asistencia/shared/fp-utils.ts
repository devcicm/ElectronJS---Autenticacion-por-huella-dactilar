/**
 * Utilidades de Programación Funcional (FP):
 * - Pureza e inmutabilidad (evita mutaciones de estado y efectos secundarios)
 * - Composición y pipelines declarativos
 * - Agrupación, indexación y partición en una sola pasada O(N)
 * - Folds y reducciones puras para métricas de asistencia (evita antipatrón de múltiples filtros/pasadas)
 */

export interface AttendanceRecordLike {
    readonly status?: string | null;
    readonly fingerprint_verified?: boolean | number | null;
    readonly minutes_late?: number | null;
    readonly minutes_overtime?: number | null;
}

export interface AttendanceSummaryMetrics {
    readonly total: number;
    readonly present: number;
    readonly late: number;
    readonly absent: number;
    readonly verified: number;
    readonly totalLateMinutes: number;
    readonly avgLateMinutes: number;
    readonly totalOvertimeMinutes: number;
    readonly avgOvertimeMinutes: number;
    readonly attendanceRate: string;
    readonly punctualityRate: string;
}

/**
 * Agrupa una lista por una clave calculada retornando un Map puro.
 * Complejidad O(N). No muta la lista original.
 */
export function groupToMap<T, K>(
    list: readonly T[],
    keyFn: (item: T) => K
): Map<K, T[]> {
    const map = new Map<K, T[]>();
    for (let i = 0; i < list.length; i++) {
        const item = list[i];
        const key = keyFn(item);
        const existing = map.get(key);
        if (existing) {
            existing.push(item);
        } else {
            map.set(key, [item]);
        }
    }
    return map;
}

/**
 * Agrupa una lista por clave retornando un objeto seguro (sin Prototype Pollution).
 * Complejidad O(N).
 */
export function groupBy<T, K extends PropertyKey>(
    list: readonly T[],
    keyFn: (item: T) => K
): Record<K, T[]> {
    const result = Object.create(null) as Record<K, T[]>;
    for (let i = 0; i < list.length; i++) {
        const item = list[i];
        const key = keyFn(item);
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        if (!result[key]) {
            result[key] = [];
        }
        result[key].push(item);
    }
    return Object.assign({}, result);
}

/**
 * Cuenta ocurrencias por clave retornando un Map.
 * Complejidad O(N).
 */
export function countToMap<T, K>(
    list: readonly T[],
    keyFn: (item: T) => K
): Map<K, number> {
    const map = new Map<K, number>();
    for (let i = 0; i < list.length; i++) {
        const key = keyFn(list[i]);
        map.set(key, (map.get(key) || 0) + 1);
    }
    return map;
}

/**
 * Cuenta ocurrencias por clave retornando un objeto seguro.
 * Complejidad O(N).
 */
export function countBy<T, K extends PropertyKey>(
    list: readonly T[],
    keyFn: (item: T) => K
): Record<K, number> {
    const result = Object.create(null) as Record<K, number>;
    for (let i = 0; i < list.length; i++) {
        const key = keyFn(list[i]);
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        result[key] = (result[key] || 0) + 1;
    }
    return Object.assign({}, result);
}

/**
 * Indexa una lista por una clave única en un Map O(1) de acceso.
 * Complejidad O(N).
 */
export function indexToMap<T, K>(
    list: readonly T[],
    keyFn: (item: T) => K
): Map<K, T> {
    const map = new Map<K, T>();
    for (let i = 0; i < list.length; i++) {
        const item = list[i];
        map.set(keyFn(item), item);
    }
    return map;
}

/**
 * Indexa una lista por una clave única en un Record de acceso directo.
 * Protegido contra Prototype Pollution.
 */
export function indexBy<T, K extends PropertyKey>(
    list: readonly T[],
    keyFn: (item: T) => K
): Record<K, T> {
    const result = Object.create(null) as Record<K, T>;
    for (let i = 0; i < list.length; i++) {
        const item = list[i];
        const key = keyFn(item);
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        result[key] = item;
    }
    return Object.assign({}, result);
}

/**
 * Divide una colección en dos listas basándose en un predicado puro.
 * [coincidencias, noCoincidencias].
 * Complejidad O(N) en una sola pasada.
 */
export function partition<T>(
    list: readonly T[],
    predicate: (item: T) => boolean
): [T[], T[]] {
    const truthy: T[] = [];
    const falsy: T[] = [];
    for (let i = 0; i < list.length; i++) {
        const item = list[i];
        if (predicate(item)) {
            truthy.push(item);
        } else {
            falsy.push(item);
        }
    }
    return [truthy, falsy];
}

/**
 * Pipeline de funciones puras de izquierda a derecha.
 * pipe(x, f, g) === g(f(x))
 */
export function pipe<T>(initial: T, ...fns: Array<(arg: any) => any>): any {
    return fns.reduce((acc, fn) => fn(acc), initial);
}

/**
 * Fold puro que calcula todas las métricas de asistencia en una sola pasada O(N).
 * Resuelve el antipatrón de múltiples filtros y reducciones independientes
 * (filter(present).length, filter(late).length, filter(absent).length, reduce(late), reduce(overtime), filter(verified).length).
 */
export function summarizeAttendance(records: readonly AttendanceRecordLike[]): AttendanceSummaryMetrics {
    const total = records.length;
    let present = 0;
    let late = 0;
    let absent = 0;
    let verified = 0;
    let totalLateMinutes = 0;
    let totalOvertimeMinutes = 0;

    for (let i = 0; i < total; i++) {
        const r = records[i];
        const st = r.status;
        if (st === 'present') {
            present++;
        } else if (st === 'late') {
            late++;
        } else if (st === 'absent') {
            absent++;
        }

        if (r.fingerprint_verified) {
            verified++;
        }

        if (r.minutes_late && r.minutes_late > 0) {
            totalLateMinutes += r.minutes_late;
        }

        if (r.minutes_overtime && r.minutes_overtime > 0) {
            totalOvertimeMinutes += r.minutes_overtime;
        }
    }

    const attended = present + late;
    const avgLateMinutes = total > 0 ? Math.round(totalLateMinutes / total) : 0;
    const avgOvertimeMinutes = total > 0 ? Math.round(totalOvertimeMinutes / total) : 0;
    const attendanceRate = total > 0 ? ((attended / total) * 100).toFixed(1) : '0.0';
    const punctualityRate = total > 0 ? ((present / total) * 100).toFixed(1) : '0.0';

    return {
        total,
        present,
        late,
        absent,
        verified,
        totalLateMinutes,
        avgLateMinutes,
        totalOvertimeMinutes,
        avgOvertimeMinutes,
        attendanceRate,
        punctualityRate
    };
}
