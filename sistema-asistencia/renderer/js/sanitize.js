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

    window.sanitizeText = sanitizeText;
    window.sanitizePhone = sanitizePhone;
    window.sanitizeEmail = sanitizeEmail;
    window.safeParseInt = safeParseInt;
    window.safeParseFloat = safeParseFloat;
    window.safeParseBoolean = safeParseBoolean;
    window.safeParseJson = safeParseJson;
    window.safeClone = safeClone;
    window.safeDestructure = safeDestructure;
    window.ObjectUtils = {
        safeParseInt,
        safeParseFloat,
        safeParseBoolean,
        safeParseJson,
        safeClone,
        safeDestructure
    };
})();