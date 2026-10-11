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

test('FSM: Eventos Plug & Play READER_DISCONNECTED y READER_CONNECTED actualizan estado del lector y transicionan FSM', async () => {
    const service = new TouchModeService(mockDb);
    const receivedEvents: string[] = [];

    const unsubscribe = service.onEvent((eventType) => {
        receivedEvents.push(eventType);
    });

    try {
        await service.handleBiometricEvent({
            eventType: 'READER_DISCONNECTED',
            message: 'Lector biométrico desconectado del puerto USB'
        });

        assert.equal(service.getHardwareState(), 'ERROR');
        assert.equal(service.getLocalState().readerConnected, false);
        assert.ok(receivedEvents.includes('READER_DISCONNECTED'));

        await service.handleBiometricEvent({
            eventType: 'READER_CONNECTED',
            message: 'Lector conectado: U.are.U 4500',
            data: {
                model: 'U.are.U® 4500 Fingerprint Reader',
                serial: '{06EBB468-72B9-0E44-98FF-C74A7235DDA1}',
                firmware: '10.281.0'
            }
        });

        assert.equal(service.getHardwareState(), 'IDLE');
        const state = service.getLocalState();
        assert.equal(state.readerConnected, true);
        assert.equal(state.readerModel, 'U.are.U® 4500 Fingerprint Reader');
        assert.equal(state.readerSerial, '{06EBB468-72B9-0E44-98FF-C74A7235DDA1}');
        assert.equal(state.readerFirmware, '10.281.0');
        assert.ok(receivedEvents.includes('READER_CONNECTED'));
    } finally {
        unsubscribe();
        service.dispose();
    }
});

test('FSM: Distinción entre Eventos Controlados (Paro Manual) y No Controlados (Caída Inesperada de Servicio)', async () => {
    const service = new TouchModeService(mockDb);
    const serviceEvents: any[] = [];

    const unsubscribe = service.onEvent((eventType, data) => {
        if (eventType === 'SERVICE_STATUS_CHANGED') {
            serviceEvents.push(data);
        }
    });

    try {
        // 1. Caída inesperada del servicio (No Controlado)
        await service.notifyServerStatusChanged(false, false);
        assert.equal(service.getHardwareState(), 'ERROR');
        assert.equal(service.getLocalState().serverOnline, false);
        assert.equal(service.getLocalState().stopReason, 'UNEXPECTED_SERVICE_DROP');

        // 2. Detención manual del servicio por el usuario (Controlado)
        await service.notifyServerStatusChanged(false, true);
        assert.equal(service.getHardwareState(), 'IDLE');
        assert.equal(service.getLocalState().serverOnline, false);
        assert.equal(service.getLocalState().stopReason, 'SERVICE_STOPPED_MANUALLY');
        assert.equal(service.getLocalState().desiredActive, false);

        assert.equal(serviceEvents.length, 2);
        assert.equal(serviceEvents[0].manual, false);
        assert.equal(serviceEvents[0].reason, 'UNEXPECTED_SERVICE_DROP');
        assert.equal(serviceEvents[1].manual, true);
        assert.equal(serviceEvents[1].reason, 'SERVICE_STOPPED_MANUALLY');
    } finally {
        unsubscribe();
        service.dispose();
    }
});

test('FSM: FINGER_TOUCHED incrementa totalTouches antes de emitir el snapshot a los handlers y stop preserva IDENTIFYING', async () => {
    const service = new TouchModeService(mockDb);
    let capturedTouchesInPayload = 0;

    const unsubscribe = service.onEvent((eventType, data) => {
        if (eventType === 'FINGER_TOUCHED') {
            capturedTouchesInPayload = data?.state?.totalTouches ?? 0;
        }
    });

    try {
        // Simular modo activo
        (service as any).state.isActive = true;
        service.setHardwareState('TOUCH_CONTINUOUS');

        await service.handleBiometricEvent({ eventType: 'FINGER_TOUCHED' });
        assert.equal(service.getLocalState().totalTouches, 1);
        assert.equal(capturedTouchesInPayload, 1);

        // Si entra a IDENTIFYING y ocurre pausa de operación, preserva IDENTIFYING
        service.setHardwareState('IDENTIFYING', 'Verificando huella 1:1');
        (service as any).state.serverOnline = false; // evitar llamada HTTP real en test unitario
        await service.stop('OPERATION_PAUSE');
        assert.equal(service.getHardwareState(), 'IDENTIFYING');
    } finally {
        unsubscribe();
        service.dispose();
    }
});

