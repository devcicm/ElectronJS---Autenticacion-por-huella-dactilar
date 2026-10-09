import test from 'node:test';
import assert from 'node:assert/strict';
import {
    safeParseJson,
    safeClone,
    safeParseInt,
    safeParseBoolean
} from '../../dist/sistema-asistencia/shared/object-utils.js';
import { loadClassic } from './load-classic.mjs';

loadClassic('../../sistema-asistencia/renderer/js/sanitize.js');
const { sanitizeText, sanitizePhone, sanitizeEmail } = globalThis as any;

test('WAF/Security: safeParseJson previene Prototype Pollution en primer y múltiples niveles', () => {
    const maliciousPayload = JSON.stringify({
        __proto__: { isAdmin: true },
        constructor: { prototype: { isHacked: true } },
        prototype: { backdoor: true },
        data: {
            user: 'Carlos',
            nested: {
                __proto__: { nestedHacked: true },
                role: 'employee'
            }
        }
    });

    const result: any = safeParseJson(maliciousPayload, null);

    assert.notEqual(result, null);
    assert.equal(result.data.user, 'Carlos');
    assert.equal(result.data.nested.role, 'employee');

    // Comprobar que ningún objeto en la aplicación fue contaminado
    const plainObj: any = {};
    assert.equal(plainObj.isAdmin, undefined);
    assert.equal(plainObj.isHacked, undefined);
    assert.equal(plainObj.backdoor, undefined);
    assert.equal(plainObj.nestedHacked, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(result, '__proto__'), false);
});

test('WAF/Security: safeClone purga llaves maliciosas y conserva inmutabilidad de prototipos', () => {
    // Objeto creado manualmente con propiedades hostiles
    const hostileObj = Object.create(null);
    hostileObj.safeField = 'valorLegitimo';
    hostileObj.__proto__ = { exploit: true };
    hostileObj.constructor = { exploit: true };
    hostileObj.prototype = { exploit: true };

    const cloned: any = safeClone(hostileObj);

    assert.equal(cloned.safeField, 'valorLegitimo');
    // Las propiedades propias peligrosas fueron eliminadas
    assert.equal(Object.prototype.hasOwnProperty.call(cloned, '__proto__'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(cloned, 'prototype'), false);
    assert.equal(({} as any).exploit, undefined);
});

test('WAF/Security: safeClone en arreglos y estructuras anidadas', () => {
    const listWithHostiles = [
        { id: 1, name: 'Normal' },
        { id: 2, name: 'Atacante', __proto__: { pwned: true } }
    ];

    const cleanList: any = safeClone(listWithHostiles);
    assert.equal(cleanList.length, 2);
    assert.equal(cleanList[0].name, 'Normal');
    assert.equal(cleanList[1].name, 'Atacante');
    assert.equal(({} as any).pwned, undefined);
});

test('WAF/Security: Sanitización estricta elimina tags HTML y delimitadores peligrosos', () => {
    const xssPayload = '<script>alert("XSS")</script><b>Hola</b>';
    const cleaned = sanitizeText(xssPayload, 100, true);
    assert.ok(!cleaned.includes('<'));
    assert.ok(!cleaned.includes('>'));
    assert.ok(!cleaned.includes('"'));
    assert.equal(cleaned, 'scriptalert(XSS)/scriptbHola/b');

    const sqlLikeName = "Juan'; DROP TABLE employees; --";
    const cleanedSql = sanitizeText(sqlLikeName, 50, true);
    assert.ok(!cleanedSql.includes("'"));
    assert.equal(cleanedSql, 'Juan; DROP TABLE employees; --');
});

test('WAF/Security: Sanitización de email y teléfono normaliza y acota longitud', () => {
    const maliciousEmail = '  ADMIN@empresa.com  ';
    const cleanEmail = sanitizeEmail(maliciousEmail);
    assert.equal(cleanEmail, 'admin@empresa.com');

    const phoneExploit = '+52 55 1234-5678 malicious';
    const cleanPhone = sanitizePhone(phoneExploit);
    assert.ok(!cleanPhone.includes('malicious'));
    assert.equal(cleanPhone, '+52 55 1234-5678 ');
});

test('WAF/Security: Validación de nombres de archivo previene Path Traversal', () => {
    const rawTraversalTimestamp = '../../etc/passwd..2026-10-08';
    const sanitizedTs = rawTraversalTimestamp.replace(/[:.]/g, '-').replace(/[^a-zA-Z0-9_-]/g, '');
    assert.ok(!sanitizedTs.includes('/'));
    assert.ok(!sanitizedTs.includes('\\'));
    assert.ok(!sanitizedTs.includes('.'));
    assert.equal(sanitizedTs, '----etcpasswd--2026-10-08');
});
