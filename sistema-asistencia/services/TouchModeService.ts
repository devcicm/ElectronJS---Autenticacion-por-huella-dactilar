/**
 * Servicio Touch Mode - Captura Continua
 * Maneja el modo de escucha continua del lector biométrico
 *
 * Basado en la implementación de edge-uru-ui branch: feature/touch-events-implementation
 */

import { EventSource } from 'eventsource';
import { BiometricService } from './BiometricService.js';
import { getDatabaseManager } from '../database/init.js';
import { AttendanceModel } from '../models/index.js';
import { BIOMETRIC_SERVER, fetchJson } from '../shared/biometric-config.js';
import { logger } from '../shared/logger.js';
import { getLocalDateString, calculateElapsedMilliseconds } from '../shared/date-utils.js';
import { safeParseInt, safeParseJson } from '../shared/object-utils.js';

export type BiometricHardwareState =
    | 'IDLE'
    | 'STARTING'
    | 'TOUCH_CONTINUOUS'
    | 'ENROLLING'
    | 'IDENTIFYING'
    | 'ERROR';

export type StopReasonType =
    | 'NONE'
    | 'MANUAL_STOP'
    | 'OPERATION_PAUSE'
    | 'SERVICE_STOPPED_MANUALLY'
    | 'NO_FINGERPRINTS'
    | 'UNEXPECTED_USB_DISCONNECT'
    | 'UNEXPECTED_SERVICE_DROP';

export interface TouchModeState {
    isActive: boolean;
    desiredActive: boolean;
    serverOnline: boolean;
    hardwareState: BiometricHardwareState;
    stopReason: StopReasonType;
    statusMessage: string;
    lastEventTime: Date | null;
    totalTouches: number;
    totalFingerprints: number;
    readerConnected?: boolean;
    readerModel?: string | null;
    readerSerial?: string | null;
    readerFirmware?: string | null;
}

export type TouchEventHandler = (eventType: string, data: any) => void;

export class TouchModeService {
    private biometricService: BiometricService;
    private attendanceModel: AttendanceModel;
    private eventSource: any = null; // Usar any para compatibilidad con EventSource de Node.js
    private reconnectTimer: NodeJS.Timeout | null = null; // B4: lifecycle
    private state: TouchModeState = {
        isActive: false,
        desiredActive: false,
        serverOnline: true,
        hardwareState: 'IDLE',
        stopReason: 'NONE',
        statusMessage: 'Lector en espera',
        lastEventTime: null,
        totalTouches: 0,
        totalFingerprints: 0,
        readerConnected: undefined,
        readerModel: null,
        readerSerial: null,
        readerFirmware: null
    };
    private eventHandlers: TouchEventHandler[] = [];
    private consecutiveErrors: number = 0;
    private readonly MAX_CONSECUTIVE_ERRORS = 5;
    private errorDeactivationInProgress = false;
    private isStarting = false;
    private wasActiveBeforeDisconnect = false;
    private isDisposed = false;

    /**
     * Obtener el estado actual del hardware biométrico (FSM)
     */
    getHardwareState(): BiometricHardwareState {
        return this.state.hardwareState;
    }

    /**
     * Forzar o coordinar estado del hardware biométrico externamente
     */
    setHardwareState(newState: BiometricHardwareState, reason?: string): void {
        this.transitionTo(newState, reason);
    }

    /**
     * Asegurar conexión al stream SSE para recibir eventos Plug & Play (READER_CONNECTED / READER_DISCONNECTED)
     */
    ensureEventStreamConnected(): void {
        if (this.state.stopReason === 'SERVICE_STOPPED_MANUALLY') {
            return;
        }
        if (!this.isDisposed && (!this.eventSource || this.eventSource.readyState === 2)) {
            this.connectToEvents();
        }
    }

    /**
     * Notificar cambio de estado del servicio biométrico (controlado manual vs caída inesperada)
     */
    async notifyServerStatusChanged(online: boolean, manual: boolean = false): Promise<void> {
        if (!online) {
            const wasActiveOrDesired = this.state.isActive || this.state.desiredActive || this.wasActiveBeforeDisconnect;
            this.state.serverOnline = false;
            this.state.isActive = false;

            if (manual) {
                this.state.desiredActive = false;
                this.wasActiveBeforeDisconnect = false;
                this.state.stopReason = 'SERVICE_STOPPED_MANUALLY';
                this.disconnectFromEvents();
                this.transitionTo('IDLE', 'Servicio biométrico detenido manualmente');
            } else {
                if (wasActiveOrDesired) {
                    this.wasActiveBeforeDisconnect = true;
                }
                this.state.stopReason = 'UNEXPECTED_SERVICE_DROP';
                this.transitionTo('ERROR', 'Servicio biométrico cortado inesperadamente');
            }

            this.emitEvent('SERVICE_STATUS_CHANGED', {
                online: false,
                manual,
                reason: this.state.stopReason,
                state: this.getLocalState()
            });
            return;
        }

        // El servidor volvió a estar en línea
        this.state.serverOnline = true;
        this.consecutiveErrors = 0;
        const shouldAutoStart = manual || this.wasActiveBeforeDisconnect || this.state.desiredActive;

        if (this.state.stopReason === 'SERVICE_STOPPED_MANUALLY' || this.state.stopReason === 'UNEXPECTED_SERVICE_DROP') {
            this.state.stopReason = 'MANUAL_STOP';
            this.transitionTo('IDLE', 'Servicio biométrico en línea');
        }

        this.ensureEventStreamConnected();

        this.emitEvent('SERVICE_STATUS_CHANGED', {
            online: true,
            manual,
            reason: this.state.stopReason,
            state: this.getLocalState()
        });

        if (shouldAutoStart && !this.state.isActive && !this.isDisposed) {
            await this.start({ isAutoRecovery: !manual });
        }
    }

    /**
     * Transición interna formal de la FSM
     */
    private transitionTo(newState: BiometricHardwareState, reason?: string): void {
        const oldState = this.state.hardwareState;
        if (oldState === newState) return;

        this.state.hardwareState = newState;
        if (reason) {
            this.state.statusMessage = reason;
        }
        logger.info(`[TouchModeService] 🔄 FSM: ${oldState} -> ${newState}${reason ? ` (${reason})` : ''}`);
        this.emitEvent('STATE_CHANGED', { from: oldState, to: newState, reason });
    }

    constructor(db?: any) {
        const database = db || getDatabaseManager();
        this.biometricService = new BiometricService(database);
        this.attendanceModel = new AttendanceModel(database);
    }

    /**
     * Iniciar modo de captura continua
     */
    async start(options?: { isAutoRecovery?: boolean }): Promise<{ success: boolean; message: string }> {
        if (this.state.isActive) {
            logger.info('[TouchModeService] Modo touch ya se encuentra activo.');
            return {
                success: true,
                message: 'Modo de captura continua ya está activo'
            };
        }

        if (this.isStarting) {
            logger.info('[TouchModeService] Inicialización de modo touch ya en progreso.');
            return {
                success: false,
                message: 'Inicialización de modo touch en progreso'
            };
        }

        this.isStarting = true;
        this.state.desiredActive = true;
        this.transitionTo('STARTING', options?.isAutoRecovery ? 'Reanudando captura continua automáticamente' : 'Iniciando captura continua');
        try {
            logger.info('=== INICIANDO MODO TOUCH CONTINUO ===');

            // Verificar si el servidor está disponible
            const serverAvailable = await this.biometricService.isServerAvailable();
            if (!serverAvailable) {
                logger.error('[TouchModeService] ❌ Servidor biométrico no disponible');
                this.state.serverOnline = false;
                this.state.isActive = false;
                if (this.state.stopReason !== 'SERVICE_STOPPED_MANUALLY') {
                    this.state.stopReason = 'UNEXPECTED_SERVICE_DROP';
                    this.wasActiveBeforeDisconnect = true;
                }
                this.transitionTo(
                    this.state.stopReason === 'SERVICE_STOPPED_MANUALLY' ? 'IDLE' : 'ERROR',
                    this.state.stopReason === 'SERVICE_STOPPED_MANUALLY'
                        ? 'Servicio biométrico detenido manualmente'
                        : 'Servidor biométrico no disponible'
                );
                return {
                    success: false,
                    message: 'Servidor biométrico no disponible'
                };
            }
            this.state.serverOnline = true;
            logger.info('[TouchModeService] ✅ Servidor biométrico disponible');

            // Asegurar suscripción SSE temprana para escuchar READER_CONNECTED / READER_DISCONNECTED
            if (this.state.stopReason === 'SERVICE_STOPPED_MANUALLY') {
                this.state.stopReason = 'NONE';
            }
            this.ensureEventStreamConnected();

            // Verificar que hay empleados con huellas en la base de datos
            const db = getDatabaseManager();
            const employeesWithFingerprints = db.query<{ employee_id: number }>(
                'SELECT DISTINCT employee_id FROM fingerprints'
            );

            if (employeesWithFingerprints.length === 0) {
                logger.error('[TouchModeService] ❌ No hay empleados con huellas registradas');
                this.state.stopReason = 'NO_FINGERPRINTS';
                this.transitionTo('IDLE', 'Sin huellas registradas');
                return {
                    success: false,
                    message: 'No hay empleados con huellas registradas. Por favor, registre huellas primero.'
                };
            }
            logger.info(`[TouchModeService] ✅ ${employeesWithFingerprints.length} empleados con huellas en BD`);

            // Inicializar el lector si no está inicializado
            logger.info('[TouchModeService] 🔧 Inicializando lector biométrico...');
            const initResult = await fetchJson(`${BIOMETRIC_SERVER}/api/init`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            }) as { ok: boolean; message?: string; error?: string };
            if (!initResult.ok) {
                logger.warn('[TouchModeService] ⚠️ Advertencia al inicializar lector:', initResult.message || initResult.error);
            } else {
                this.state.readerConnected = true;
                logger.info('[TouchModeService] ✅ Lector inicializado correctamente');
            }

            // Iniciar modo touch en el backend
            logger.info('[TouchModeService] 🚀 Activando modo de captura continua en backend...');
            const result = await fetchJson(`${BIOMETRIC_SERVER}/api/touch/start`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            }) as { ok: boolean; message?: string; error?: string; mode?: string };

            if (!result.ok) {
                const errMsg = result.message || result.error || 'Error al iniciar modo touch';
                logger.error('[TouchModeService] ❌ Error al iniciar modo touch:', errMsg);
                if (!initResult.ok) {
                    this.state.readerConnected = false;
                    this.state.stopReason = 'UNEXPECTED_USB_DISCONNECT';
                    this.wasActiveBeforeDisconnect = true;
                }
                this.transitionTo('ERROR', errMsg);
                return {
                    success: false,
                    message: errMsg
                };
            }

            logger.info('[TouchModeService] ✅ Backend en modo:', result.mode || 'Continuous');

            // Cargar huellas de la BD al store del backend para que identify funcione
            logger.info('[TouchModeService] 📋 Cargando huellas de BD al store del backend...');
            await this.loadFingerprintsToBackendStore();

            // Conectar a eventos SSE si no estaba conectado
            this.ensureEventStreamConnected();

            this.state.isActive = true;
            this.state.serverOnline = true;
            this.state.readerConnected = true;
            this.state.stopReason = 'NONE';
            this.wasActiveBeforeDisconnect = false;
            this.state.totalTouches = 0;
            this.state.totalFingerprints = 0;

            // Resetear contador de errores al iniciar correctamente
            this.consecutiveErrors = 0;
            this.errorDeactivationInProgress = false;
            this.transitionTo('TOUCH_CONTINUOUS', 'Modo touch continuo activo');

            logger.info('=== ✅ MODO TOUCH CONTINUO ACTIVO ===');
            logger.info(`[TouchModeService] 👂 Escuchando eventos del lector...`);
            logger.info(`[TouchModeService] 📊 ${employeesWithFingerprints.length} empleados disponibles para identificación`);

            return {
                success: true,
                message: `Modo de captura continua activado (${employeesWithFingerprints.length} empleados registrados)`
            };
        } catch (error: any) {
            logger.error('[TouchModeService] ❌ Error al iniciar modo touch:', error);
            this.transitionTo('ERROR', error.message || 'Error al iniciar modo touch');
            return {
                success: false,
                message: error.message || 'Error al iniciar modo touch'
            };
        } finally {
            this.isStarting = false;
        }
    }

    /**
     * Cargar huellas de la BD al store del backend
     */
    private async loadFingerprintsToBackendStore(): Promise<void> {
        try {
            const db = getDatabaseManager();

            // Obtener todas las huellas de la BD
            const fingerprints = db.query<{
                id: number;
                employee_id: number;
                hand: string;
                finger_position: string;
                template_data: string;
            }>('SELECT * FROM fingerprints');

            logger.info(`[TouchModeService] Encontradas ${fingerprints.length} huellas en BD`);

            // Primero, limpiar el store del backend
            await fetchJson(`${BIOMETRIC_SERVER}/api/store`, {
                method: 'DELETE'
            });
            logger.info('[TouchModeService] Store del backend limpiado');

            // Cargar templates en lotes concurrentes (chunking) para optimizar latencia I/O Big O
            const CONCURRENCY = 5;
            let loaded = 0;
            for (let i = 0; i < fingerprints.length; i += CONCURRENCY) {
                const chunk = fingerprints.slice(i, i + CONCURRENCY);
                const results = await Promise.allSettled(
                    chunk.map(async (fp) => {
                        const userId = `employee_${fp.employee_id}`;
                        try {
                            const result = await fetchJson(`${BIOMETRIC_SERVER}/api/load-template`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    userId: userId,
                                    templateBase64: fp.template_data,
                                    hand: fp.hand,
                                    finger: fp.finger_position
                                })
                            }) as { ok: boolean; message?: string; tag?: string };

                            if (result.ok) {
                                logger.info(`[TouchModeService] ✅ Huella cargada: ${result.tag}`);
                                return true;
                            } else {
                                logger.warn(`[TouchModeService] ⚠️ Error cargando huella ${userId}:`, result.message);
                                return false;
                            }
                        } catch (error) {
                            logger.warn(`[TouchModeService] ❌ No se pudo cargar huella ${userId}:`, error);
                            return false;
                        }
                    })
                );

                loaded += results.filter(
                    (res): res is PromiseFulfilledResult<boolean> => res.status === 'fulfilled' && res.value === true
                ).length;
            }

            logger.info(`[TouchModeService] ✅ ${loaded}/${fingerprints.length} huellas cargadas al backend`);

        } catch (error: any) {
            logger.error('[TouchModeService] Error cargando huellas al backend:', error);
            throw error;
        }
    }

    /**
     * Sincronizar el store en memoria del motor biométrico y la FSM tras alta/baja de huellas en SQLite
     */
    async syncFingerprintsStore(): Promise<void> {
        try {
            const db = getDatabaseManager();
            const employeesWithFingerprints = db.query<{ employee_id: number }>(
                'SELECT DISTINCT employee_id FROM fingerprints'
            );

            if (employeesWithFingerprints.length === 0) {
                logger.info('[TouchModeService] 🧹 0 huellas en BD tras mutación — limpiando store en memoria');
                if (this.state.serverOnline && this.state.stopReason !== 'SERVICE_STOPPED_MANUALLY') {
                    try {
                        await fetchJson(`${BIOMETRIC_SERVER}/api/store`, { method: 'DELETE' });
                    } catch (e) {
                        logger.warn('[TouchModeService] No se pudo limpiar store en backend:', e);
                    }
                }

                if (this.state.isActive) {
                    await this.stop('NO_FINGERPRINTS');
                } else if (
                    this.state.stopReason === 'NONE' ||
                    this.state.stopReason === 'MANUAL_STOP' ||
                    this.state.stopReason === 'OPERATION_PAUSE'
                ) {
                    this.state.stopReason = 'NO_FINGERPRINTS';
                    this.state.statusMessage = 'Sin huellas registradas';
                    this.emitEvent('STATE_CHANGED', {
                        from: this.state.hardwareState,
                        to: this.state.hardwareState,
                        reason: 'Sin huellas registradas',
                        state: this.getLocalState()
                    });
                }
                return;
            }

            // Hay al menos 1 empleado con huellas en BD
            if (this.state.serverOnline && this.state.stopReason !== 'SERVICE_STOPPED_MANUALLY') {
                await this.loadFingerprintsToBackendStore();
            }

            if (this.state.stopReason === 'NO_FINGERPRINTS') {
                if (this.state.desiredActive && !this.state.isActive && this.state.hardwareState !== 'ENROLLING') {
                    logger.info('[TouchModeService] 🔄 Primera huella registrada — iniciando modo continuo automáticamente');
                    await this.start({ isAutoRecovery: true });
                } else {
                    this.state.stopReason = 'MANUAL_STOP';
                    this.state.statusMessage = 'Huellas registradas — Lector listo';
                    this.emitEvent('STATE_CHANGED', {
                        from: this.state.hardwareState,
                        to: this.state.hardwareState,
                        reason: this.state.statusMessage,
                        state: this.getLocalState()
                    });
                }
            }
        } catch (error) {
            logger.error('[TouchModeService] Error sincronizando store de huellas:', error);
        }
    }

    /**
     * Detener modo de captura continua
     * @param reason Motivo controlado o no controlado de la detención
     */
    async stop(reason: StopReasonType = 'MANUAL_STOP'): Promise<{ success: boolean; message: string }> {
        const isUncontrolled = reason === 'UNEXPECTED_USB_DISCONNECT' || reason === 'UNEXPECTED_SERVICE_DROP';

        if (reason === 'MANUAL_STOP' || reason === 'SERVICE_STOPPED_MANUALLY') {
            this.state.desiredActive = false;
            this.wasActiveBeforeDisconnect = false;
            this.state.stopReason = reason;
        } else if (reason === 'OPERATION_PAUSE' || reason === 'NO_FINGERPRINTS') {
            this.state.stopReason = reason;
        } else if (isUncontrolled) {
            if (this.state.isActive || this.state.desiredActive) {
                this.wasActiveBeforeDisconnect = true;
            }
            this.state.stopReason = reason;
        }

        try {
            // Detener modo touch en el backend solo si el servidor sigue en línea
            if (this.state.serverOnline && reason !== 'SERVICE_STOPPED_MANUALLY') {
                await fetchJson(`${BIOMETRIC_SERVER}/api/touch/stop`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                }) as { ok: boolean; message?: string };
            }

            logger.info(`[TouchModeService] Modo touch detenido correctamente (motivo: ${reason})`);

            return {
                success: true,
                message: 'Modo de captura continua desactivado'
            };
        } catch (error: any) {
            logger.error('[TouchModeService] Error al detener modo touch:', error);
            return {
                success: false,
                message: error.message || 'Error al detener modo touch'
            };
        } finally {
            // Mantener stream SSE activo para eventos Plug & Play salvo paro manual de servicio
            this.state.isActive = false;

            if (isUncontrolled) {
                this.transitionTo(
                    'ERROR',
                    reason === 'UNEXPECTED_USB_DISCONNECT'
                        ? 'Lector biométrico desconectado del puerto USB'
                        : 'Servicio biométrico cortado inesperadamente'
                );
            } else if (this.state.hardwareState !== 'ENROLLING' && this.state.hardwareState !== 'IDENTIFYING') {
                const reasonText =
                    reason === 'OPERATION_PAUSE'
                        ? 'Pausado temporalmente por operación biométrica'
                        : reason === 'SERVICE_STOPPED_MANUALLY'
                            ? 'Servicio biométrico detenido manualmente'
                            : reason === 'NO_FINGERPRINTS'
                                ? 'Sin huellas registradas'
                                : 'Modo touch detenido';
                this.transitionTo('IDLE', reasonText);
            }
        }
    }

    /**
     * Obtener estado actual
     */
    async getStatus(): Promise<{ isActive: boolean; mode: string }> {
        try {
            const result = await fetchJson(`${BIOMETRIC_SERVER}/api/touch/status`) as { ok: boolean; isActive: boolean; mode: string };

            return {
                isActive: result.isActive || false,
                mode: result.mode || 'OnDemand'
            };
        } catch (error) {
            logger.error('[TouchModeService] Error al obtener estado:', error);
            return {
                isActive: false,
                mode: 'OnDemand'
            };
        }
    }

    /**
     * Obtener estado local
     */
    getLocalState(): TouchModeState {
        return { ...this.state };
    }

    /**
     * Registrar handler para eventos
     */
    onEvent(handler: TouchEventHandler): () => void {
        this.eventHandlers.push(handler);

        // Retornar función para desregistrar
        return () => {
            const index = this.eventHandlers.indexOf(handler);
            if (index > -1) {
                this.eventHandlers.splice(index, 1);
            }
        };
    }

    /**
     * Conectar a eventos SSE del servidor biométrico
     */
    private connectToEvents() {
        if (this.eventSource) {
            this.eventSource.close();
        }

        logger.info('[TouchModeService] Conectando a eventos SSE...');

        this.eventSource = new EventSource(`${BIOMETRIC_SERVER}/events`);

        this.eventSource.onopen = () => {
            const wasOffline = !this.state.serverOnline || this.state.stopReason === 'UNEXPECTED_SERVICE_DROP';
            this.state.serverOnline = true;
            this.consecutiveErrors = 0;

            if (wasOffline) {
                logger.info('[TouchModeService] ✅ Conexión SSE establecida con el servidor biométrico');
                if (this.state.stopReason === 'UNEXPECTED_SERVICE_DROP') {
                    this.state.stopReason = this.wasActiveBeforeDisconnect || this.state.desiredActive ? 'NONE' : 'MANUAL_STOP';
                }
                this.emitEvent('SERVICE_STATUS_CHANGED', {
                    online: true,
                    manual: false,
                    reason: this.state.stopReason,
                    state: this.getLocalState()
                });

                if ((this.wasActiveBeforeDisconnect || this.state.desiredActive) && !this.state.isActive && !this.isDisposed) {
                    setTimeout(() => {
                        if (!this.isDisposed && !this.state.isActive) {
                            this.start({ isAutoRecovery: true }).catch(err =>
                                logger.error('[TouchModeService] Error en auto-recuperación al reconectar SSE:', err)
                            );
                        }
                    }, 600);
                } else if (this.state.hardwareState === 'ERROR') {
                    this.transitionTo('IDLE', 'Servicio biométrico reconectado');
                }
            }
        };

        this.eventSource.onmessage = (event: any) => {
            try {
                const data = safeParseJson<any>(event.data, null);
                if (!data) {
                    logger.warn('[TouchModeService] Payload SSE descartado: JSON no válido o malicioso');
                    return;
                }

                // Resetear contador de errores en eventos exitosos
                if (this.consecutiveErrors > 0 || !this.state.serverOnline) {
                    logger.info('[TouchModeService] Conexión SSE restaurada - Reseteando contador de errores');
                    this.consecutiveErrors = 0;
                    this.state.serverOnline = true;
                }

                this.handleBiometricEvent(data);
            } catch (error) {
                logger.error('[TouchModeService] Error parsing SSE event:', error);
            }
        };

        this.eventSource.onerror = (error: any) => {
            if (this.isDisposed || this.state.stopReason === 'SERVICE_STOPPED_MANUALLY') {
                return;
            }

            logger.error('[TouchModeService] SSE error:', error);

            this.consecutiveErrors++;
            logger.warn(`[TouchModeService] Errores consecutivos: ${this.consecutiveErrors}/${this.MAX_CONSECUTIVE_ERRORS}`);

            // Verificar inmediatamente si el servicio biométrico se cayó inesperadamente
            this.biometricService.isServerAvailable().then(available => {
                if (!available && !this.isDisposed && this.state.stopReason !== 'SERVICE_STOPPED_MANUALLY') {
                    if (this.state.serverOnline || this.state.hardwareState !== 'ERROR') {
                        logger.error('[TouchModeService] 🚨 Caída inesperada del servicio biométrico detectada');
                        if (this.state.isActive || this.state.desiredActive) {
                            this.wasActiveBeforeDisconnect = true;
                        }
                        this.state.isActive = false;
                        this.state.serverOnline = false;
                        this.state.stopReason = 'UNEXPECTED_SERVICE_DROP';
                        this.transitionTo('ERROR', 'Servicio biométrico cortado inesperadamente');
                        this.emitEvent('SERVICE_STATUS_CHANGED', {
                            online: false,
                            manual: false,
                            reason: 'UNEXPECTED_SERVICE_DROP',
                            state: this.getLocalState()
                        });
                    }
                }
            }).catch(() => {});

            // Si superamos el límite de errores y el modo touch estaba activo, desactivar automáticamente
            if (this.state.isActive && this.consecutiveErrors >= this.MAX_CONSECUTIVE_ERRORS) {
                logger.error('[TouchModeService] ❌ LÍMITE DE ERRORES ALCANZADO - Desactivando servicio automáticamente');
                this.handleCriticalError('Se alcanzó el límite de errores en la comunicación con el lector');
                return;
            }

            // Intentar reconectar después de 3 segundos mientras el servicio no haya sido liberado
            if (!this.isDisposed) {
                if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
                this.reconnectTimer = setTimeout(() => {
                    this.reconnectTimer = null;
                    if (!this.isDisposed && (this.state.stopReason as StopReasonType) !== 'SERVICE_STOPPED_MANUALLY' && this.eventSource?.readyState === 2) { // 2 = CLOSED
                        logger.info('[TouchModeService] Reconectando a eventos SSE...');
                        this.connectToEvents();
                    }
                }, 3000);
            }
        };
    }

    /**
     * Desconectar de eventos SSE
     */
    private disconnectFromEvents() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
        }
    }

    /**
     * Manejar eventos biométricos (incluyendo eventos Plug & Play READER_CONNECTED y READER_DISCONNECTED)
     */
    public async handleBiometricEvent(data: any) {
        const eventType = data?.eventType || '';

        logger.info('📩 [TouchModeService] Evento SSE recibido:', eventType);

        // Actualizar estado
        this.state.lastEventTime = new Date();
        this.state.serverOnline = true;

        // Actualizar estado interno de conexión y contadores antes de notificar a los handlers
        if (eventType === 'READER_DISCONNECTED') {
            this.state.readerConnected = false;
            this.biometricService.resetReaderState();
            if (this.state.isActive || this.state.desiredActive) {
                this.wasActiveBeforeDisconnect = true;
            }
            this.state.isActive = false;
            this.state.stopReason = 'UNEXPECTED_USB_DISCONNECT';
            logger.warn(`🔌❌ [TouchModeService] Lector desconectado físicamente: ${data.message || 'Sin conexión USB'}`);
            this.transitionTo('ERROR', data.message || 'Lector biométrico desconectado del puerto USB');
        } else if (eventType === 'READER_CONNECTED') {
            this.state.readerConnected = true;
            if (data?.data) {
                this.state.readerModel = data.data.model ?? this.state.readerModel;
                this.state.readerSerial = data.data.serial ?? this.state.readerSerial;
                this.state.readerFirmware = data.data.firmware ?? this.state.readerFirmware;
            }
            logger.info(`🔌✅ [TouchModeService] Lector conectado físicamente: ${data.message || 'Conectado'}`);
            if (this.wasActiveBeforeDisconnect || this.state.desiredActive) {
                this.transitionTo('STARTING', 'Lector USB conectado — Reanudando escucha continua');
            } else {
                if (this.state.stopReason === 'UNEXPECTED_USB_DISCONNECT') {
                    this.state.stopReason = 'MANUAL_STOP';
                }
                this.transitionTo('IDLE', data.message || 'Lector biométrico conectado al puerto USB');
            }
        } else if (eventType === 'FINGER_TOUCHED' && this.state.isActive) {
            this.state.totalTouches++;
            logger.info(`👆 [TouchModeService] DEDO DETECTADO en el lector (total: ${this.state.totalTouches})`);
        } else if (eventType === 'FINGERPRINT_READY' && this.state.isActive) {
            this.state.totalFingerprints++;
            logger.info(`✅ [TouchModeService] HUELLA CAPTURADA Y LISTA (total: ${this.state.totalFingerprints})`);
        }

        // Emitir evento a handlers registrados enriquecido con snapshot de estado
        const enrichedData =
            eventType === 'READER_CONNECTED' ||
            eventType === 'READER_DISCONNECTED' ||
            eventType === 'FINGER_TOUCHED' ||
            eventType === 'FINGERPRINT_READY'
                ? { ...data, state: this.getLocalState() }
                : data;

        this.eventHandlers.forEach(handler => {
            try {
                handler(eventType, enrichedData);
            } catch (error) {
                logger.error('[TouchModeService] Error in event handler:', error);
            }
        });

        // Procesar eventos específicos
        switch (eventType) {
            case 'READER_CONNECTED':
                if ((this.wasActiveBeforeDisconnect || this.state.desiredActive) && !this.state.isActive && !this.isDisposed) {
                    this.wasActiveBeforeDisconnect = false;
                    logger.info('🔄 [TouchModeService] Reanudando automáticamente captura continua tras reconexión física del lector...');
                    setTimeout(() => {
                        if (!this.isDisposed && !this.state.isActive) {
                            this.start({ isAutoRecovery: true }).catch(err =>
                                logger.error('[TouchModeService] Error al reanudar modo touch tras reconexión USB:', err)
                            );
                        }
                    }, 600);
                }
                break;

            case 'READER_DISCONNECTED':
                break;

            case 'FINGER_TOUCHED':
                if (!this.state.isActive) break;
                logger.info(`[TouchModeService] Capturando huella...`);
                break;

            case 'FINGERPRINT_READY':
                if (!this.state.isActive) break;
                logger.info(`[TouchModeService] Iniciando identificación 1:N contra base de datos...`);

                // Identificar empleado automáticamente
                await this.autoIdentifyAndRegister();
                break;

            case 'CAPTURE_READY':
                logger.info('🔄 [TouchModeService] Lector rearmado - Listo para nueva captura');
                break;
        }
    }

    /**
     * Identificar empleado automáticamente y registrar asistencia
     */
     private async autoIdentifyAndRegister() {
        this.transitionTo('IDENTIFYING', 'Identificando huella dactilar');
        try {
            logger.info('🔍 [TouchModeService] ==================== INICIANDO IDENTIFICACIÓN ====================');

            // En modo touch, usar el endpoint especializado para identificar con la última huella capturada
            logger.info('[TouchModeService] Llamando al backend para identificar con última huella capturada...');

            const identifyResult = await fetchJson(`${BIOMETRIC_SERVER}/api/touch/identify-last`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    targetFarn: 5000 // Umbral de coincidencia más estricto (menor valor = mayor precisión)
                })
            }) as {
                ok: boolean;
                matched: boolean;
                userId?: string;
                score?: number;
                error?: string;
            };

            if (!identifyResult.ok || !identifyResult.matched || !identifyResult.userId) {
                logger.info('❌ [TouchModeService] NO SE PUDO IDENTIFICAR AL EMPLEADO');
                logger.info(`[TouchModeService] Respuesta del backend:`, identifyResult);
                this.emitEvent('IDENTIFICATION_FAILED', {
                    message: identifyResult.error || 'No se encontró coincidencia'
                });
                return;
            }

            // Convertir userId a employeeId (formato esperado: "employee_1" o "1")
            let employeeId: number;
            const employeeIdMatch = identifyResult.userId.match(/employee_(\d+)/);
            if (employeeIdMatch) {
                employeeId = safeParseInt(employeeIdMatch[1], 0);
            } else if (/^\d+$/.test(identifyResult.userId)) {
                employeeId = safeParseInt(identifyResult.userId, 0);
            } else {
                logger.error('[TouchModeService] Formato de userId inválido:', identifyResult.userId);
                this.emitEvent('IDENTIFICATION_FAILED', {
                    message: 'Formato de userId inválido'
                });
                return;
            }

            const score = identifyResult.score || 0;

            logger.info(`✅ [TouchModeService] EMPLEADO IDENTIFICADO EXITOSAMENTE`);
            logger.info(`[TouchModeService] - ID: ${employeeId}`);
            logger.info(`[TouchModeService] - Score de coincidencia: ${score}`);

            // Obtener información del empleado
            const db = getDatabaseManager();
            const employee = db.queryOne<any>(
                'SELECT first_name, last_name, employee_code, status FROM employees WHERE id = ?',
                [employeeId]
            );

            if (!employee) {
                logger.warn(`⚠️ [TouchModeService] Huella detectada pertenece a un empleado inexistente o eliminado (ID: ${employeeId})`);
                this.emitEvent('IDENTIFICATION_FAILED', {
                    message: `Empleado con ID ${employeeId} no encontrado en el sistema`
                });
                return;
            }

            const employeeName = `${employee.first_name || ''} ${employee.last_name || ''}`.trim();
            const employeeCode = employee.employee_code || '';

            if (employee.status !== 'active') {
                logger.warn(`⚠️ [TouchModeService] Empleado ${employeeName} está inactivo.`);
                this.emitEvent('IDENTIFICATION_FAILED', {
                    message: `El empleado ${employeeName} está inactivo`
                });
                return;
            }

            logger.info(`[TouchModeService] - Nombre: ${employeeName}`);
            logger.info(`[TouchModeService] - Código: ${employeeCode}`);

            this.emitEvent('EMPLOYEE_IDENTIFIED', {
                employeeId,
                employeeName,
                employeeCode,
                score: identifyResult.score
            });

            // Determinar si es entrada o salida usando fecha local
            const today = getLocalDateString();
            logger.info(`[TouchModeService] Verificando registros del día: ${today}`);

            const todayRecord = this.attendanceModel.getByEmployeeAndDate(employeeId, today);

            const hasCheckedIn = todayRecord && todayRecord.check_in_time !== null;
            const hasCheckedOut = todayRecord && todayRecord.check_out_time !== null;

            if (!hasCheckedIn) {
                // Registrar entrada
                logger.info(`📥 [TouchModeService] REGISTRANDO ENTRADA`);
                logger.info(`[TouchModeService] - Empleado: ${employeeId}`);
                logger.info(`[TouchModeService] - Fecha: ${today}`);

                const record = this.attendanceModel.checkIn(employeeId, true);

                this.emitEvent('CHECK_IN_REGISTERED', {
                    employeeId,
                    employeeName,
                    employeeCode,
                    timestamp: new Date(),
                    record,
                    score: identifyResult.score
                });

                logger.info(`✅ [TouchModeService] ENTRADA REGISTRADA EXITOSAMENTE`);
                logger.info(`[TouchModeService] - Hora: ${record.check_in_time}`);
                logger.info(`[TouchModeService] - Estado: ${record.status}`);
                logger.info(`[TouchModeService] - Empleado: ${employeeName}`);

            } else if (!hasCheckedOut) {
                // Validar tiempo mínimo entre check-in y check-out con precisión de milisegundos
                const now = new Date();
                const elapsedMs = calculateElapsedMilliseconds(today, todayRecord.check_in_time, now);

                // Consultar cooldown configurado en system_config (predeterminado: 60s = 60,000 ms; mínimo de seguridad en touch: 15,000 ms)
                const cooldownRow = db.queryOne<{ value: string }>(
                    "SELECT value FROM system_config WHERE key = 'cooldown_seconds'"
                );
                const configuredCooldownSec = cooldownRow ? safeParseInt(cooldownRow.value, 60) : 60;
                const minIntervalMs = Math.max(15_000, configuredCooldownSec * 1000);

                if (elapsedMs < minIntervalMs) {
                    const secondsElapsed = Math.floor(elapsedMs / 1000);
                    const minimumSeconds = Math.floor(minIntervalMs / 1000);
                    logger.info(`⏱️ [TouchModeService] CHECK-OUT MUY RÁPIDO - Debe esperar al menos ${minimumSeconds}s (${minIntervalMs}ms) desde el check-in`);
                    logger.info(`[TouchModeService] - Tiempo transcurrido: ${elapsedMs}ms (${secondsElapsed}s)`);
                    this.emitEvent('CHECK_OUT_TOO_SOON', {
                        employeeId,
                        employeeName,
                        employeeCode,
                        elapsedMs,
                        minimumMs: minIntervalMs,
                        secondsElapsed,
                        minimumSeconds
                    });
                    return;
                }

                // Registrar salida
                logger.info(`📤 [TouchModeService] REGISTRANDO SALIDA`);
                logger.info(`[TouchModeService] - Empleado: ${employeeId}`);
                logger.info(`[TouchModeService] - Entrada fue a las: ${todayRecord.check_in_time}`);

                const record = this.attendanceModel.checkOut(employeeId);

                this.emitEvent('CHECK_OUT_REGISTERED', {
                    employeeId,
                    employeeName,
                    employeeCode,
                    timestamp: new Date(),
                    record,
                    score: identifyResult.score
                });

                logger.info(`✅ [TouchModeService] SALIDA REGISTRADA EXITOSAMENTE`);
                logger.info(`[TouchModeService] - Hora: ${record.check_out_time}`);
                logger.info(`[TouchModeService] - Empleado: ${employeeName}`);

            } else {
                logger.info(`ℹ️ [TouchModeService] EMPLEADO YA COMPLETÓ SU ASISTENCIA HOY`);
                logger.info(`[TouchModeService] - Entrada: ${todayRecord.check_in_time}`);
                logger.info(`[TouchModeService] - Salida: ${todayRecord.check_out_time}`);
                this.emitEvent('ALREADY_REGISTERED', {
                    employeeId,
                    employeeName,
                    employeeCode,
                    checkInTime: todayRecord.check_in_time,
                    checkOutTime: todayRecord.check_out_time
                });
            }

            logger.info('🔍 [TouchModeService] ==================== FIN IDENTIFICACIÓN ====================');

        } catch (error: any) {
            logger.error('❌ [TouchModeService] ERROR EN AUTO-IDENTIFICACIÓN:', error);
            logger.error('[TouchModeService] Stack:', error.stack);
            this.emitEvent('AUTO_REGISTER_ERROR', {
                error: error.message
            });
        } finally {
            if (this.state.isActive && this.state.hardwareState === 'IDENTIFYING') {
                this.transitionTo('TOUCH_CONTINUOUS', 'Reanudando escucha continua tras identificación');
            }
        }
    }

    /**
     * Manejar error crítico y desactivar servicio automáticamente
     */
    private async handleCriticalError(message: string): Promise<void> {
        if (this.errorDeactivationInProgress) {
            return; // Evitar múltiples desactivaciones simultáneas
        }

        this.errorDeactivationInProgress = true;
        this.state.stopReason = 'UNEXPECTED_SERVICE_DROP';
        this.transitionTo('ERROR', message);

        logger.error('❌❌❌ [TouchModeService] ERROR CRÍTICO DETECTADO ❌❌❌');
        logger.error(`[TouchModeService] Mensaje: ${message}`);
        logger.error('[TouchModeService] Desactivando modo automático por seguridad...');

        try {
            // Emitir evento de error crítico antes de desactivar
            this.emitEvent('CRITICAL_ERROR', {
                message,
                timestamp: new Date(),
                state: this.getLocalState()
            });

            // Desactivar el servicio preservando el estado de error no controlado
            await this.stop('UNEXPECTED_SERVICE_DROP');

            logger.info('[TouchModeService] ✅ Servicio desactivado correctamente por error crítico');
        } catch (error: any) {
            logger.error('[TouchModeService] Error al desactivar servicio:', error);
        } finally {
            this.errorDeactivationInProgress = false;
        }
    }

    /**
     * Emitir evento a todos los handlers
     */
    private emitEvent(eventType: string, data: any) {
        this.eventHandlers.forEach(handler => {
            try {
                handler(eventType, data);
            } catch (error) {
                logger.error('[TouchModeService] Error in event handler:', error);
            }
        });
    }

    /**
     * Limpiar recursos
     */
    dispose() {
        this.isDisposed = true;
        this.wasActiveBeforeDisconnect = false;
        this.state.desiredActive = false;
        this.disconnectFromEvents();
        this.eventHandlers = [];
        this.state.isActive = false;
        this.transitionTo('IDLE', 'Servicio liberado');
    }
}
