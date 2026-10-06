/**
 * H1 — Sanitización/normalización de inputs en formularios (UI layer).
 * Trim, strip de controles, strip de HTML peligrosos, cap de longitud.
 * Defense-in-depth: la capa de escape (B3) sigue siendo la primaria en render;
 * este helper limpia la persistencia para que la BD no almacene payloads hostiles.
 * Script clásico: expone window.sanitizeText/Phone/Email (compatible con file://).
 */
(function () {
    function sanitizeText(value, maxLen = 100, stripHtml = true) {
        if (value === null || value === undefined) return '';
        let s = String(value).replace(/[\x00-\x1F\x7F]/g, '');
        s = s.trim();
        if (stripHtml) s = s.replace(/[<>"']/g, '');
        if (s.length > maxLen) s = s.slice(0, maxLen);
        return s;
    }

    function sanitizePhone(value) {
        if (!value) return null;
        const s = String(value).trim().replace(/[^\d+\-\s]/g, '');
        return s.slice(0, 20) || null;
    }

    function sanitizeEmail(value) {
        if (!value) return '';
        return String(value).trim().toLowerCase().slice(0, 254);
    }

    function safeParseInt(value, fallback = 0, radix = 10) {
        if (typeof value === 'number') {
            return Number.isFinite(value) ? Math.trunc(value) : fallback;
        }
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (trimmed === '') return fallback;
            const parsed = parseInt(trimmed, radix);
            return Number.isFinite(parsed) ? parsed : fallback;
        }
        if (typeof value === 'boolean') return value ? 1 : 0;
        return fallback;
    }

    function safeParseFloat(value, fallback = 0) {
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

    function safeParseBoolean(value, fallback = false) {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'number') {
            if (value === 1) return true;
            if (value === 0) return false;
            return Number.isFinite(value) && value !== 0;
        }
        if (typeof value === 'string') {
            const normalized = value.trim().toLowerCase();
            if (['true', '1', 'yes', 'si', 'sí', 't'].includes(normalized)) return true;
            if (['false', '0', 'no', 'f', ''].includes(normalized)) return false;
        }
        return fallback;
    }

    function safeParseJson(raw, fallback = null) {
        if (raw === null || raw === undefined) return fallback;
        if (typeof raw !== 'string') {
            return typeof raw === 'object' ? safeClone(raw) : fallback;
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
            return parsed;
        } catch {
            return fallback;
        }
    }

    function safeClone(source) {
        if (source === null || typeof source !== 'object') return source;
        if (Array.isArray(source)) return source.map(item => safeClone(item));
        const cleanObj = Object.create(null);
        for (const key of Object.keys(source)) {
            if (key !== '__proto__' && key !== 'constructor' && key !== 'prototype') {
                cleanObj[key] = safeClone(source[key]);
            }
        }
        return Object.assign({}, cleanObj);
    }

    function safeDestructure(target, keys, defaults = {}) {
        const isObj = target !== null && typeof target === 'object';
        const source = isObj ? target : {};
        const result = {};
        for (const key of keys) {
            if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
            const val = source[key];
            result[key] = val !== undefined ? val : defaults[key];
        }
        return result;
    }

    function groupToMap(list, keyFn) {
        const map = new Map();
        if (!Array.isArray(list)) return map;
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

    function countToMap(list, keyFn) {
        const map = new Map();
        if (!Array.isArray(list)) return map;
        for (let i = 0; i < list.length; i++) {
            const key = keyFn(list[i]);
            map.set(key, (map.get(key) || 0) + 1);
        }
        return map;
    }

    function indexToMap(list, keyFn) {
        const map = new Map();
        if (!Array.isArray(list)) return map;
        for (let i = 0; i < list.length; i++) {
            const item = list[i];
            map.set(keyFn(item), item);
        }
        return map;
    }

    function groupBy(list, keyFn) {
        const result = Object.create(null);
        if (!Array.isArray(list)) return Object.assign({}, result);
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

    function countBy(list, keyFn) {
        const result = Object.create(null);
        if (!Array.isArray(list)) return Object.assign({}, result);
        for (let i = 0; i < list.length; i++) {
            const key = keyFn(list[i]);
            if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
            result[key] = (result[key] || 0) + 1;
        }
        return Object.assign({}, result);
    }

    function indexBy(list, keyFn) {
        const result = Object.create(null);
        if (!Array.isArray(list)) return Object.assign({}, result);
        for (let i = 0; i < list.length; i++) {
            const item = list[i];
            const key = keyFn(item);
            if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
            result[key] = item;
        }
        return Object.assign({}, result);
    }

    function partition(list, predicate) {
        const truthy = [];
        const falsy = [];
        if (!Array.isArray(list)) return [truthy, falsy];
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

    function pipe(initial, ...fns) {
        return fns.reduce((acc, fn) => fn(acc), initial);
    }

    window.sanitizeText = sanitizeText;
    window.sanitizePhone = sanitizePhone;
    window.sanitizeEmail = sanitizeEmail;
    window.safeParseInt = safeParseInt;
    window.safeParseFloat = safeParseFloat;
    window.safeParseBoolean = safeParseBoolean;
    window.safeParseJson = safeParseJson;
    window.safeClone = safeClone;
    window.safeDestructure = safeDestructure;
    window.groupToMap = groupToMap;
    window.countToMap = countToMap;
    window.indexToMap = indexToMap;
    window.groupBy = groupBy;
    window.countBy = countBy;
    window.indexBy = indexBy;
    window.partition = partition;
    window.pipe = pipe;

    window.ObjectUtils = {
        safeParseInt,
        safeParseFloat,
        safeParseBoolean,
        safeParseJson,
        safeClone,
        safeDestructure
    };

    window.FpUtils = {
        groupToMap,
        countToMap,
        indexToMap,
        groupBy,
        countBy,
        indexBy,
        partition,
        pipe
    };
})();