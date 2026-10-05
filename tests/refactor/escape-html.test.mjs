// T1 — suite para escapeHtml (utilidad de B3)
// Cubre: passthrough, vacíos, XSS-driven, 5 entidades, atributos vs texto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadClassic } from './load-classic.mjs';

loadClassic('../../sistema-asistencia/renderer/js/escape-html.js');
const escapeHtml = globalThis.escapeHtml;

test('escapeHtml: vacíos y nulos', () => {
    assert.equal(escapeHtml(''), '');
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
});

test('escapeHtml: passthrough seguro', () => {
    assert.equal(escapeHtml('hello'), 'hello');
    assert.equal(escapeHtml('María García 123'), 'María García 123');
    assert.equal(escapeHtml('café mañana'), 'café mañana');
});

test('escapeHtml: 5 entidades peligrosas', () => {
    assert.equal(escapeHtml('&'), '&amp;');
    assert.equal(escapeHtml('<'), '&lt;');
    assert.equal(escapeHtml('>'), '&gt;');
    assert.equal(escapeHtml('"'), '&quot;');
    assert.equal(escapeHtml("'"), '&#39;');
});

test('escapeHtml: payload XSS completo', () => {
    const payload = '<script>alert("xss")</script>';
    assert.equal(escapeHtml(payload), '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
});

test('escapeHtml: combinacion de entidades en orden', () => {
    // Verifica el ORDEN correcto: & primero (si no, las demas se duplicarian)
    assert.equal(escapeHtml('&<>'), '&amp;&lt;&gt;');
    assert.equal(escapeHtml('a&b<c>d"e\'f'), 'a&amp;b&lt;c&gt;d&quot;e&#39;f');
});

test('escapeHtml: atributos con comillas dobles y simples', () => {
    // Caso típico: value="${userInput}" con userInput malicioso
    assert.equal(escapeHtml(`" onmouseover="alert(1)`), '&quot; onmouseover=&quot;alert(1)');
    assert.equal(escapeHtml(`'><script>alert(1)</script>`), '&#39;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
});

test('escapeHtml: numeros y booleanos pasan como string', () => {
    assert.equal(escapeHtml(0), '0');
    assert.equal(escapeHtml(42), '42');
    assert.equal(escapeHtml(true), 'true');
    assert.equal(escapeHtml(false), 'false');
});

test('escapeHtml: idempotente en salida', () => {
    // Una cadena ya escapada no debe re-escapear las entidades
    const once = escapeHtml('<b>');
    const twice = escapeHtml(once);
    assert.equal(twice, '&amp;lt;b&amp;gt;');
    // Esto es esperado (escapeHtml no sabe que ya estaba escapado);
    // confirma que aplicar dos veces NO restaura el original.
    assert.notEqual(twice, once);
});