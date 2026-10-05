// T-X2 — suite para escapeHtml engine-public (defense-in-depth)
// engine-demo no usa ESM; el script escape-html.js se carga vía <script> y expone
// la función global `escapeHtml` (sin import).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Cargar el script como CJS: lo wrapeamos en una export para evaluarlo aquí.
// El archivo engine-public/js/escape-html.js define `escapeHtml` globalmente;
// para testearlo lo requerimos en un contexto donde lo expongamos como global.
const SRC = fs.readFileSync(
    path.resolve('biometric-engine/node/public/js/escape-html.js'),
    'utf-8'
);
// Evaluar como módulo local: simulamos el scope global
const wrap = `(function() { ${SRC}; globalThis.escapeHtml = escapeHtml; })();`;
eval(wrap);
const escapeHtml = globalThis.escapeHtml;

test('engine escapeHtml: vacías y nulos', () => {
    assert.equal(escapeHtml(''), '');
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
});

test('engine escapeHtml: 5 entidades peligrosas', () => {
    assert.equal(escapeHtml('&'), '&amp;');
    assert.equal(escapeHtml('<'), '&lt;');
    assert.equal(escapeHtml('>'), '&gt;');
    assert.equal(escapeHtml('"'), '&quot;');
    assert.equal(escapeHtml("'"), '&#39;');
});

test('engine escapeHtml: payload XSS completo', () => {
    const payload = '<img src=x onerror="alert(\'xss\')">';
    const escaped = escapeHtml(payload);
    assert.equal(escaped, '&lt;img src=x onerror=&quot;alert(&#39;xss&#39;)&quot;&gt;');
    // Verificar que los tags peligrosos estan escapados (las comillas que delimitan
    // atributos tambien, para que el payload no sea funcional aunque el texto siga visible)
    assert.ok(!escaped.includes('<img'));
    assert.ok(!escaped.includes('<script>'));
    assert.ok(!escaped.includes('<xss'));
});

test('engine escapeHtml: compatible con sistema (mismo comportamiento que renderer/js/escape-html.js)', async () => {
    const SYS = fs.readFileSync(
        path.resolve('sistema-asistencia/renderer/js/escape-html.js'),
        'utf-8'
    );
    // Extraer solo el cuerpo del return (lineas de la funcion), normalizando indentación
    const extractBody = (src) => src.split('\n').filter(l => /return String|^\s+\.|^\s+}\)/.test(l)).map(l => l.trim()).join('\n');
    const sysBody = extractBody(SYS);
    const engBody = extractBody(SRC);
    assert.equal(engBody, sysBody, 'cuerpos divergentes entre sistema y engine');
});

test('engine escapeHtml: idempotencia en salida', () => {
    const once = escapeHtml('<script>');
    const twice = escapeHtml(once);
    // Aplicar dos veces no restaura el original
    assert.equal(twice, '&amp;lt;script&amp;gt;');
    assert.notEqual(twice, once);
});