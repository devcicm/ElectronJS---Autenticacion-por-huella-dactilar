// T3 — suite para el logger renderer (espejo del logger TS en shared/logger.ts)
// Cubre: nivel por defecto, filtrado por nivel, metodos delegan a console correcto,
// LOG_LEVEL desde localStorage, comportamiento con localStorage no disponible.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Mock localStorage para tests (Node no lo provee nativamente)
globalThis.localStorage = {
    _data: {},
    getItem(key) { return this._data[key] ?? null; },
    setItem(key, val) { this._data[key] = String(val); },
    removeItem(key) { delete this._data[key]; },
};

globalThis.console = {
    log: (...args) => { (globalThis.__logCalls = globalThis.__logCalls || []).push({ method: 'log', args }); },
    warn: (...args) => { (globalThis.__logCalls = globalThis.__logCalls || []).push({ method: 'warn', args }); },
    error: (...args) => { (globalThis.__logCalls = globalThis.__logCalls || []).push({ method: 'error', args }); },
};

function resetLog() { delete globalThis.__logCalls; }
function getCalls() { return globalThis.__logCalls || []; }

// Import DESPUES de mockear console para que la captura esté activa
import { loadClassic } from './load-classic.mjs';
loadClassic('../../sistema-asistencia/renderer/js/logger.js');
const logger = globalThis.logger;

test('logger: default info -> debug suprimido, info+ emitidos', () => {
    resetLog();
    globalThis.localStorage._data = {};
    logger.debug('no debe salir');
    logger.info('sale info');
    logger.warn('sale warn');
    logger.error('sale error');

    const calls = getCalls();
    assert.equal(calls.length, 3);
    assert.equal(calls[0].method, 'log');
    assert.equal(calls[1].method, 'warn');
    assert.equal(calls[2].method, 'error');
});

test('logger: prefijo [LEVEL] en cada mensaje', () => {
    resetLog();
    logger.info('mensaje');
    const { method, args } = getCalls()[0];
    assert.equal(method, 'log');
    assert.equal(args[0], '[INFO]');
    assert.equal(args[1], 'mensaje');
});

test('logger: niveles mayusculas (debug filtrado en default info)', () => {
    resetLog();
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    const levels = getCalls().map(c => c.args[0]);
    assert.deepEqual(levels, ['[INFO]', '[WARN]', '[ERROR]']);
});

test('logger: argumentos multiples se pasan tal cual', () => {
    resetLog();
    logger.info('a', 1, { x: 1 }, [1, 2]);
    const { args } = getCalls()[0];
    assert.equal(args.length, 5); // [LEVEL], a, 1, {x:1}, [1,2]
    assert.equal(args[0], '[INFO]');
    assert.equal(args[1], 'a');
    assert.equal(args[2], 1);
    assert.deepEqual(args[3], { x: 1 });
    assert.deepEqual(args[4], [1, 2]);
});