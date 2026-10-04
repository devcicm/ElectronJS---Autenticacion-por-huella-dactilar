/**
 * B3 — escapeHtml: neutraliza 5 caracteres peligrosos en strings que se
 * interpolan dentro de HTML (texto o atributo entre comillas dobles).
 * Uso: ${escapeHtml(emp.first_name)} en innerHTML / insertAdjacentHTML.
 */
export function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}