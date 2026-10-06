/**
 * Utilidades para deconstrucción y construcción segura de objetos,
 * tipado defensivo, parsing y protección contra Prototype Pollution.
 */

/**
 * Parsea un número entero de forma segura con base decimal y fallback garantizado.
 * Protege contra NaN, null, undefined, cadenas no numéricas, arrays o símbolos.
 */
export function safeParseInt(value: unknown, fallback: number = 0, radix: number = 10): number {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? Math.trunc(value) : fallback;
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed === '') return fallback;
        const parsed = parseInt(trimmed, radix);
        return Number.isFinite(parsed) ? parsed : fallback;
    }
    if (typeof value === 'boolean') {
        return value ? 1 : 0;
    }
    return fallback;
}

/**
 * Parsea un número de punto flotante de forma segura con fallback garantizado.
 * Protege contra NaN, Infinity y tipos no compatibles.
 */
export function safeParseFloat(value: unknown, fallback: number = 0): number {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : fallback;
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed === '') return fallback;
        const parsed = parseFloat(trimmed);
        return Number.isFinite(parsed) ? parsed : fallback;
    }
    return fallback;
}

/**
 * Coerción booleana robusta y contextual.
 * Reconoce cadenas literales 'true', 'false', '1', '0', 'yes', 'no' y enteros 1/0.
 */
export function safeParseBoolean(value: unknown, fallback: boolean = false): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') {
        if (value === 1) return true;
        if (value === 0) return false;
        return Number.isFinite(value) && value !== 0;
    }
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'si' || normalized === 'sí' || normalized === 't') {
            return true;
        }
        if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'f' || normalized === '') {
            return false;
        }
    }
    return fallback;
}

/**
 * Parsea una cadena JSON de manera segura.
 * Retorna el fallback si el JSON es inválido o no es un string.
 * Protege contra Prototype Pollution (__proto__, constructor, prototype).
 */
export function safeParseJson<T>(raw: unknown, fallback: T): T {
    if (raw === null || raw === undefined) return fallback;
    if (typeof raw !== 'string') {
        return (typeof raw === 'object' ? safeClone(raw) : fallback) as T;
    }
    const trimmed = raw.trim();
    if (!trimmed) return fallback;
    try {
        const parsed = JSON.parse(trimmed, (key, value) => {
            if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
                return undefined;
            }
            return value;
        });
        if (parsed === null || parsed === undefined) return fallback;
        return parsed as T;
    } catch {
        return fallback;
    }
}

/**
 * Clona un objeto o valor de manera segura, descartando llaves hostiles de prototipo.
 */
export function safeClone<T>(source: T): T {
    if (source === null || typeof source !== 'object') {
        return source;
    }
    if (Array.isArray(source)) {
        return source.map(item => safeClone(item)) as unknown as T;
    }
    const cleanObj: Record<string, any> = Object.create(null);
    for (const key of Object.keys(source as object)) {
        if (key !== '__proto__' && key !== 'constructor' && key !== 'prototype') {
            cleanObj[key] = safeClone((source as any)[key]);
        }
    }
    return Object.assign({}, cleanObj) as unknown as T;
}

/**
 * Deconstruye de manera segura llaves de un objeto garantizando valores de respaldo.
 * Nunca lanza TypeError si el objeto es null, undefined, primitive o malformado.
 */
export function safeDestructure<T extends object, K extends keyof T>(
    target: unknown,
    keys: readonly K[],
    defaults: Partial<Record<K, T[K]>> = {}
): Record<K, T[K]> {
    const isObj = target !== null && typeof target === 'object';
    const source = (isObj ? target : {}) as Record<string, any>;
    const result = {} as Record<K, T[K]>;

    for (const key of keys) {
        const keyStr = String(key);
        if (keyStr === '__proto__' || keyStr === 'constructor' || keyStr === 'prototype') {
            continue;
        }
        const val = source[keyStr];
        result[key] = (val !== undefined ? val : defaults[key]) as T[K];
    }

    return result;
}

/**
 * Construye un objeto seguro a partir de una base y valores opcionales,
 * evitando contaminación de prototipo y filtrando undefined no deseados.
 */
export function safeConstruct<T extends object>(base: T, overrides?: Partial<T> | null): T {
    const cleanBase = safeClone(base);
    if (!overrides || typeof overrides !== 'object') {
        return cleanBase;
    }
    for (const key of Object.keys(overrides)) {
        if (key !== '__proto__' && key !== 'constructor' && key !== 'prototype') {
            const val = (overrides as any)[key];
            if (val !== undefined) {
                (cleanBase as any)[key] = val;
            }
        }
    }
    return cleanBase;
}
