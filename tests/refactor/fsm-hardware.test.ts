import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TouchModeService, type BiometricHardwareState } from '../../dist/sistema-asistencia/services/TouchModeService.js';

const mockDb = {
    query: () => [],
    queryOne: () => undefined,
    execute: () => ({ changes: 0, lastInsertRowid: 0 })
};

test('FSM: Estado inicial es IDLE y no activo', () => {
    const service = new TouchModeService(mockDb);
    try {
        assert.equal(service.getHardwareState(), 'IDLE');
        assert.equal(service.getLocalState().isActive, false);
        assert.equal(service.getLocalState().hardwareState, 'IDLE');
    } finally {
        service.dispose();
    }
});

test('FSM: setHardwareState emite STATE_CHANGED y actualiza getHardwareState', () => {
    const service = new TouchModeService(mockDb);
    const transitions: Array<{ from: BiometricHardwareState; to: BiometricHardwareState; reason?: string }> = [];

    const unsubscribe = service.onEvent((eventType, data) => {
        if (eventType === 'STATE_CHANGED') {
            transitions.push(data);
        }
    });

    try {
        service.setHardwareState('STARTING', 'Iniciando servicio');
        assert.equal(service.getHardwareState(), 'STARTING');

        service.setHardwareState('TOUCH_CONTINUOUS', 'Escucha continua activada');
        assert.equal(service.getHardwareState(), 'TOUCH_CONTINUOUS');

        service.setHardwareState('ENROLLING', 'Operación de enrolamiento');
        assert.equal(service.getHardwareState(), 'ENROLLING');

        service.setHardwareState('IDENTIFYING', 'Comparación 1:N');
        assert.equal(service.getHardwareState(), 'IDENTIFYING');

        service.setHardwareState('ERROR', 'Fallo de comunicación');
        assert.equal(service.getHardwareState(), 'ERROR');

        service.setHardwareState('IDLE', 'Detenido');
        assert.equal(service.getHardwareState(), 'IDLE');

        assert.equal(transitions.length, 6);
        assert.deepEqual(transitions[0], { from: 'IDLE', to: 'STARTING', reason: 'Iniciando servicio' });
        assert.deepEqual(transitions[1], { from: 'STARTING', to: 'TOUCH_CONTINUOUS', reason: 'Escucha continua activada' });
        assert.deepEqual(transitions[2], { from: 'TOUCH_CONTINUOUS', to: 'ENROLLING', reason: 'Operación de enrolamiento' });
        assert.deepEqual(transitions[3], { from: 'ENROLLING', to: 'IDENTIFYING', reason: 'Comparación 1:N' });
        assert.deepEqual(transitions[4], { from: 'IDENTIFYING', to: 'ERROR', reason: 'Fallo de comunicación' });
        assert.deepEqual(transitions[5], { from: 'ERROR', to: 'IDLE', reason: 'Detenido' });
    } finally {
        unsubscribe();
        service.dispose();
    }
});

test('FSM: dispose() resetea estado a IDLE y desactiva listeners', () => {
    const service = new TouchModeService(mockDb);
    let eventReceived = false;

    service.onEvent((eventType) => {
        if (eventType === 'STATE_CHANGED') {
            eventReceived = true;
        }
    });

    service.setHardwareState('TOUCH_CONTINUOUS');
    assert.equal(service.getHardwareState(), 'TOUCH_CONTINUOUS');

    service.dispose();
    assert.equal(service.getHardwareState(), 'IDLE');
    assert.equal(service.getLocalState().isActive, false);

    // Tras dispose, los listeners fueron desregistrados
    eventReceived = false;
    service.setHardwareState('STARTING');
    assert.equal(eventReceived, false);
});
