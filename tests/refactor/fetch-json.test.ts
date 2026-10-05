// T-fetchJson: helper con AbortSignal.timeout. Cubre timeouts, parse JSON, propaga AbortError.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchJson } from '../../dist/sistema-asistencia/shared/biometric-config.js';

// fetchJson usa fetch nativo. Mockeamos global.fetch para no requerir red.
const mockFetch = (responder) => {
    globalThis.fetch = async (url, init) => {
        return responder(url, init);
    };
};

const restoreFetch = () => {
    delete globalThis.fetch;
};

test('fetchJson: devuelve body parseado cuando responde OK', async () => {
    mockFetch(async () => {
        return new Response(JSON.stringify({ ok: true, value: 42 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    });
    try {
        const data = await fetchJson('http://x.test/api', {});
        assert.deepEqual(data, { ok: true, value: 42 });
    } finally {
        restoreFetch();
    }
});

test('fetchJson: aplica AbortSignal.timeout al fetch', async () => {
    let capturedInit;
    mockFetch(async (url, init) => {
        capturedInit = init;
        return new Response('{}', { status: 200 });
    });
    try {
        await fetchJson('http://x.test/api', { method: 'POST' }, 500);
        assert.ok(capturedInit.signal, 'fetchJson debe pasar signal al fetch');
        assert.ok(capturedInit.signal instanceof AbortSignal, 'signal debe ser AbortSignal');
    } finally {
        restoreFetch();
    }
});

test('fetchJson: aborta despues del timeout y propaga AbortError', async () => {
    // fetch que nunca termina — pero respeta AbortSignal (simula engine muerto)
    mockFetch((_url, init) => new Promise((_, reject) => {
        if (init.signal) {
            init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }
    }));
    try {
        await assert.rejects(
            () => fetchJson('http://x.test/api', {}, 100),
            (err) => {
                assert.ok(err && (err.name === 'AbortError' || err.code === 'ABORT_ERR' || /abort/i.test(err.message || '')),
                    `expected AbortError, got ${err && err.name}: ${err && err.message}`);
                return true;
            }
        );
    } finally {
        restoreFetch();
    }
});

test('fetchJson: preserva method, headers y body del init', async () => {
    let captured;
    mockFetch(async (url, init) => {
        captured = init;
        return new Response('{}', { status: 200 });
    });
    try {
        await fetchJson('http://x.test/api', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Custom': 'test' },
            body: JSON.stringify({ a: 1 }),
        });
        assert.equal(captured.method, 'POST');
        // headers es objeto plano — fetch normal lo convierte a Headers en runtime
        assert.equal(captured.headers['X-Custom'], 'test');
        assert.equal(captured.body, JSON.stringify({ a: 1 }));
    } finally {
        restoreFetch();
    }
});

test('fetchJson: propaga errores del fetch (no AbortError)', async () => {
    mockFetch(async () => {
        throw new Error('network failure');
    });
    try {
        await assert.rejects(
            () => fetchJson('http://x.test/api', {}),
            (err) => err.message === 'network failure'
        );
    } finally {
        restoreFetch();
    }
});