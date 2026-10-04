/**
 * H1 — Sanitización/normalización de inputs en formularios (UI layer).
 * Trim, strip de controles, strip de HTML peligrosos, cap de longitud.
 * Defense-in-depth: la capa de escape (B3) sigue siendo la primaria en render;
 * este helper limpia la persistencia para que la BD no almacene payloads hostiles.
 */
export function sanitizeText(value, maxLen = 100, stripHtml = true) {
    if (value === null || value === undefined) return '';
    let s = String(value).replace(/[\x00-\x1F\x7F]/g, '');
    s = s.trim();
    if (stripHtml) s = s.replace(/[<>"']/g, '');
    if (s.length > maxLen) s = s.slice(0, maxLen);
    return s;
}

export function sanitizePhone(value) {
    if (!value) return null;
    const s = String(value).trim().replace(/[^\d+\-\s]/g, '');
    return s.slice(0, 20) || null;
}

export function sanitizeEmail(value) {
    if (!value) return '';
    return String(value).trim().toLowerCase().slice(0, 254);
}