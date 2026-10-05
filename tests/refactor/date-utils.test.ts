import test from 'node:test';
import assert from 'node:assert/strict';
import { getLocalDateString, getLocalTimeString, parseLocalDate } from '../../dist/sistema-asistencia/shared/date-utils.js';

test('getLocalDateString: formatea fecha local con ceros a la izquierda', () => {
    const d = new Date(2026, 4, 3, 23, 45, 0); // 3 de Mayo de 2026, 23:45
    assert.equal(getLocalDateString(d), '2026-05-03');
});

test('getLocalDateString: no desincroniza a medianoche o fin de mes', () => {
    const d = new Date(2026, 11, 31, 23, 59, 59); // 31 de Diciembre de 2026
    assert.equal(getLocalDateString(d), '2026-12-31');
});

test('getLocalTimeString: formatea HH:MM:SS', () => {
    const d = new Date(2026, 0, 1, 8, 5, 9); // 08:05:09
    assert.equal(getLocalTimeString(d), '08:05:09');
});

test('parseLocalDate: genera fecha con medianoche local', () => {
    const parsed = parseLocalDate('2026-10-05');
    assert.equal(parsed.getFullYear(), 2026);
    assert.equal(parsed.getMonth(), 9); // 0-indexed: 9 = Octubre
    assert.equal(parsed.getDate(), 5);
});
