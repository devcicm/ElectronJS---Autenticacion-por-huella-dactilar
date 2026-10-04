// T2 — suite para sanitize (utilidad de H1)
// Cubre: trim, control chars, HTML peligrosos, cap de longitud, phone, email.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    sanitizeText,
    sanitizePhone,
    sanitizeEmail,
} from '../../sistema-asistencia/renderer/js/sanitize.js';

test('sanitizeText: vacíos y nulos', () => {
    assert.equal(sanitizeText(null), '');
    assert.equal(sanitizeText(undefined), '');
    assert.equal(sanitizeText(''), '');
});

test('sanitizeText: trim basico', () => {
    assert.equal(sanitizeText('  hello  '), 'hello');
    assert.equal(sanitizeText('\n\thola\r\n'), 'hola');
});

test('sanitizeText: strip de control chars', () => {
    assert.equal(sanitizeText('a\x00b\x07c\x1F'), 'abc');
    assert.equal(sanitizeText('hello\x7Fworld'), 'helloworld');
});

test('sanitizeText: strip HTML peligrosos', () => {
    assert.equal(sanitizeText('<script>x</script>'), 'scriptx/script');
    assert.equal(sanitizeText('<b>x</b>'), 'bx/b');
    assert.equal(sanitizeText('"O\'Reilly"'), 'OReilly');
});

test('sanitizeText: cap maxLen', () => {
    assert.equal(sanitizeText('x'.repeat(200), 50), 'x'.repeat(50));
    assert.equal(sanitizeText('abcde', 10), 'abcde');
    assert.equal(sanitizeText('abcde', 3), 'abc');
});

test('sanitizeText: default 100', () => {
    assert.equal(sanitizeText('x'.repeat(150)).length, 100);
});

test('sanitizeText: stripHtml=false conserva HTML', () => {
    assert.equal(sanitizeText('<b>x</b>', 100, false), '<b>x</b>');
    assert.equal(sanitizeText('  <a href="x">  ', 100, false), '<a href="x">');
});

test('sanitizeText: unicode preservado (acentos, eñes, emojis)', () => {
    assert.equal(sanitizeText('María García Núñez'), 'María García Núñez');
    assert.equal(sanitizeText('café mañana piña'), 'café mañana piña');
});

test('sanitizePhone: vacíos y null', () => {
    assert.equal(sanitizePhone(null), null);
    assert.equal(sanitizePhone(''), null);
    assert.equal(sanitizePhone(undefined), null);
});

test('sanitizePhone: passthrough de digitos y + -', () => {
    assert.equal(sanitizePhone('+1 555-1234'), '+1 555-1234');
    assert.equal(sanitizePhone('5551234567'), '5551234567');
});

test('sanitizePhone: strip de letras y chars raros (espacios y + - permitidos)', () => {
    assert.equal(sanitizePhone('123abc456'), '123456');
    assert.equal(sanitizePhone('(555) 123-4567'), '555 123-4567');
    assert.equal(sanitizePhone('phone: 5551234'), ' 5551234');
});

test('sanitizePhone: cap 20', () => {
    assert.equal(sanitizePhone('1'.repeat(50)).length, 20);
});

test('sanitizePhone: solo chars permitidos (no quedan letras)', () => {
    assert.equal(sanitizePhone('abc-def+ghi'), '-+');
});

test('sanitizeEmail: vacíos', () => {
    assert.equal(sanitizeEmail(''), '');
    assert.equal(sanitizeEmail(null), '');
});

test('sanitizeEmail: lowercase + trim + cap', () => {
    assert.equal(sanitizeEmail('  Test@EXAMPLE.com  '), 'test@example.com');
    assert.equal(sanitizeEmail('x'.repeat(300)).length, 254);
});

test('sanitizeEmail: no valida formato (eso es responsabilidad del caller)', () => {
    // sanitizeEmail SOLO normaliza; la regex de validación vive en saveNewEmployee
    assert.equal(sanitizeEmail('not-an-email'), 'not-an-email');
    assert.equal(sanitizeEmail('a@b'), 'a@b');
});

test('sanitize: combinacion realista de payloads', () => {
    // Usuario malicioso intenta inyectar HTML + control chars en employee_code
    const payload = '<img src=x\x00onerror="alert(1)">';
    const result = sanitizeText(payload, 50);
    // Verifica: sin control chars, sin HTML peligrosos
    assert.equal(result.includes('\x00'), false);
    assert.equal(result.includes('<'), false);
    assert.equal(result.includes('>'), false);
    assert.equal(result.includes('"'), false);
    assert.equal(result.includes("'"), false);
});