import test from 'node:test';
import assert from 'node:assert/strict';
import {
    safeParseInt,
    safeParseFloat,
    safeParseBoolean,
    safeParseJson,
    safeClone,
    safeDestructure,
    safeConstruct
} from '../../dist/sistema-asistencia/shared/object-utils.js';
import {
    getLocalDateString,
    getLocalTimeString,
    parseLocalDate
} from '../../dist/sistema-asistencia/shared/date-utils.js';

test('safeParseInt: enteros válidos, floats y strings con trim', () => {
    assert.equal(safeParseInt(42), 42);
    assert.equal(safeParseInt(3.85), 3);
    assert.equal(safeParseInt('  100  '), 100);
    assert.equal(safeParseInt('-15'), -15);
    assert.equal(safeParseInt(0), 0);
    assert.equal(safeParseInt('0'), 0);
});

test('safeParseInt: casos inválidos devuelven fallback', () => {
    assert.equal(safeParseInt(NaN, 10), 10);
    assert.equal(safeParseInt(null, 5), 5);
    assert.equal(safeParseInt(undefined, 7), 7);
    assert.equal(safeParseInt('', 20), 20);
    assert.equal(safeParseInt('   ', 20), 20);
    assert.equal(safeParseInt('no-numero', 0), 0);
    assert.equal(safeParseInt({}, 99), 99);
    assert.equal(safeParseInt(Infinity, -1), -1);
});

test('safeParseInt: booleans y bases numéricas', () => {
    assert.equal(safeParseInt(true), 1);
    assert.equal(safeParseInt(false), 0);
    assert.equal(safeParseInt('FF', 0, 16), 255);
});

test('safeParseFloat: números de punto flotante válidos e inválidos', () => {
    assert.equal(safeParseFloat(3.14159), 3.14159);
    assert.equal(safeParseFloat('  98.76  '), 98.76);
    assert.equal(safeParseFloat('-0.5'), -0.5);
    assert.equal(safeParseFloat('abc', 0), 0);
    assert.equal(safeParseFloat(null, 1.5), 1.5);
    assert.equal(safeParseFloat(undefined, 2.5), 2.5);
});

test('safeParseBoolean: variantes truthy y falsy', () => {
    assert.equal(safeParseBoolean(true), true);
    assert.equal(safeParseBoolean(false), false);
    assert.equal(safeParseBoolean(1), true);
    assert.equal(safeParseBoolean(0), false);
    assert.equal(safeParseBoolean('true'), true);
    assert.equal(safeParseBoolean('TRUE'), true);
    assert.equal(safeParseBoolean('1'), true);
    assert.equal(safeParseBoolean('yes'), true);
    assert.equal(safeParseBoolean('si'), true);
    assert.equal(safeParseBoolean('sí'), true);
    assert.equal(safeParseBoolean('false'), false);
    assert.equal(safeParseBoolean('FALSE'), false);
    assert.equal(safeParseBoolean('0'), false);
    assert.equal(safeParseBoolean('no'), false);
    assert.equal(safeParseBoolean('invalido', true), true);
    assert.equal(safeParseBoolean(null, false), false);
});

test('safeParseJson: parseo seguro con fallback y protección prototype pollution', () => {
    const valid = safeParseJson('{"a": 1, "b": "hola"}', {});
    assert.deepEqual(valid, { a: 1, b: 'hola' });

    const fallback = safeParseJson('invalido { json', { fallback: true });
    assert.deepEqual(fallback, { fallback: true });

    const empty = safeParseJson('', { empty: true });
    assert.deepEqual(empty, { empty: true });

    // Prototype pollution: no debe inyectar propiedades en el prototipo global de Object
    const malicious = '{"__proto__": {"polluted": true}, "normal": 123}';
    const parsedMalicious: any = safeParseJson(malicious, {});
    assert.equal(parsedMalicious.normal, 123);
    assert.equal((({} as any).polluted), undefined);
});

test('safeClone: clonación profunda inmune a prototype pollution', () => {
    const original = {
        nombre: 'Juan',
        turnos: [1, 2, 3],
        detalles: { activo: true }
    };
    const cloned = safeClone(original);
    assert.deepEqual(cloned, original);
    assert.notEqual(cloned, original);
    assert.notEqual(cloned.turnos, original.turnos);
    assert.notEqual(cloned.detalles, original.detalles);
});

test('safeDestructure: deconstrucción sin TypeError sobre null, undefined o primitivos', () => {
    const keys = ['id', 'name', 'status'] as const;
    const defaults = { id: 0, name: 'Anónimo', status: 'inactive' };

    const fromNull = safeDestructure(null, keys, defaults);
    assert.deepEqual(fromNull, defaults);

    const fromUndefined = safeDestructure(undefined, keys, defaults);
    assert.deepEqual(fromUndefined, defaults);

    const fromPartial = safeDestructure({ id: 10, name: 'Carlos' }, keys, defaults);
    assert.deepEqual(fromPartial, { id: 10, name: 'Carlos', status: 'inactive' });
});

test('safeConstruct: construcción segura a partir de base y overrides', () => {
    const base = { id: 1, theme: 'light', active: true };
    const constructed = safeConstruct(base, { theme: 'dark' });
    assert.deepEqual(constructed, { id: 1, theme: 'dark', active: true });
    assert.equal(base.theme, 'light'); // no muta el base
});

test('date-utils: resiliencia ante inputs nulos, strings ISO o inválidos', () => {
    // parseLocalDate con ISO string completo
    const d1 = parseLocalDate('2026-10-06T18:30:00.000Z');
    assert.equal(d1.getFullYear(), 2026);
    assert.equal(d1.getMonth(), 9);
    assert.equal(d1.getDate(), 6);

    // parseLocalDate con input no válido no crashea
    const d2 = parseLocalDate(null as any);
    assert.ok(d2 instanceof Date);
    assert.ok(!Number.isNaN(d2.getTime()));

    // getLocalDateString y getLocalTimeString ante Invalid Date usan fallback Date()
    const invalidDate = new Date('fecha-invalida');
    const strDate = getLocalDateString(invalidDate);
    assert.match(strDate, /^\d{4}-\d{2}-\d{2}$/);

    const strTime = getLocalTimeString(invalidDate);
    assert.match(strTime, /^\d{2}:\d{2}:\d{2}$/);
});
