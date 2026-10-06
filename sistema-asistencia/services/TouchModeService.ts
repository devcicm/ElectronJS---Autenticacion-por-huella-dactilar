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
import { getLocalDateString } from '../shared/date-utils.js';
import { safeParseInt } from '../shared/object-utils.js';

export type BiometricHardwareState =
    | 'IDLE'
    | 'STARTING'
    | 'TOUCH_CONTINUOUS'
    | 'ENROLLING'
    | 'IDENTIFYING'
    | 'ERROR';

export interface TouchModeState {
    isActive: boolean;
    hardwareState: BiometricHardwareState;
    lastEventTime: Date | null;
    totalTouches: number;
    totalFingerprints: number;
}

export type TouchEventHandler = (eventType: string, data: any) => void;

export class TouchModeService {
    private biometricService: BiometricService;
    private attendanceModel: AttendanceModel;
    private eventSource: any = null; // Usar any para compatibilidad con EventSource de Node.js
    private reconnectTimer: NodeJS.Timeout | null = null; // B4: lifecycle
    private state: TouchModeState = {
        isActive: false,
        hardwareState: 'IDLE',
        lastEventTime: null,
        totalTouches: 0,
        totalFingerprints: 0
    };
    private eventHandlers: TouchEventHandler[] = [];
    private consecutiveErrors: number = 0;
    private readonly MAX_CONSECUTIVE_ERRORS = 5;
    private errorDeactivationInProgress = false;
    private isStarting = false;

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
     * Transición interna formal de la FSM
     */
    private transitionTo(newState: BiometricHardwareState, reason?: string): void {
        const oldState = this.state.hardwareState;
        if (oldState === newState) return;
        this.state.hardwareState = newState;
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
    async start(): Promise<{ success: boolean; message: string }> {
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
        this.transitionTo('STARTING', 'Iniciando captura continua');
        try {
            logger.info('=== INICIANDO MODO TOUCH CONTINUO ===');

            // Verificar si el servidor está disponible
            const serverAvailable = await this.biometricService.isServerAvailable();
            if (!serverAvailable) {
                logger.error('[TouchModeService] ❌ Servidor biométrico no disponible');
                this.transitionTo('ERROR', 'Servidor biométrico no disponible');
                return {
                    success: false,
                    message: 'Servidor biométrico no disponible'
                };
            }
            logger.info('[TouchModeService] ✅ Servidor biométrico disponible');

            // Verificar que hay empleados con huellas en la base de datos
            const db = getDatabaseManager();
            const employeesWithFingerprints = db.query<{ employee_id: number }>(
                'SELECT DISTINCT employee_id FROM fingerprints'
            );

            if (employeesWithFingerprints.length === 0) {
                logger.error('[TouchModeService] ❌ No hay empleados con huellas registradas');
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
            }) as { ok: boolean; message?: string };
            if (!initResult.ok) {
                logger.warn('[TouchModeService] ⚠️ Advertencia al inicializar lector:', initResult.message);
                // Continuar de todos modos, puede que ya esté inicializado
            } else {
                logger.info('[TouchModeService] ✅ Lector inicializado correctamente');
            }

            // Iniciar modo touch en el backend
            logger.info('[TouchModeService] 🚀 Activando modo de captura continua en backend...');
            const result = await fetchJson(`${BIOMETRIC_SERVER}/api/touch/start`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            }) as { ok: boolean; message?: string; mode?: string };

            if (!result.ok) {
                logger.error('[TouchModeService] ❌ Error al iniciar modo touch:', result.message);
                this.transitionTo('ERROR', result.message || 'Error al iniciar modo touch');
                return {
                    success: false,
                    message: result.message || 'Error al iniciar modo touch'
                };
            }

            logger.info('[TouchModeService] ✅ Backend en modo:', result.mode || 'Continuous');

            // Cargar huellas de la BD al store del backend para que identify funcione
            logger.info('[TouchModeService] 📋 Cargando huellas de BD al store del backend...');
            await this.loadFingerprintsToBackendStore();

            // Conectar a eventos SSE
            logger.info('[TouchModeService] 📡 Conectando a eventos SSE...');
            this.connectToEvents();

            this.state.isActive = true;
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
     * Detener modo de captura continua
     */
    async stop(): Promise<{ success: boolean; message: string }> {
        try {
            // Detener modo touch en el backend
            const result = await fetchJson(`${BIOMETRIC_SERVER}/api/touch/stop`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            }) as { ok: boolean; message?: string };

            logger.info('[TouchModeService] Modo touch detenido correctamente');

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
            // Siempre desconectar eventos SSE y resetear estado activo local
            this.disconnectFromEvents();
            this.state.isActive = false;
            if (this.state.hardwareState !== 'ENROLLING') {
                this.transitionTo('IDLE', 'Modo touch detenido');
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

        this.eventSource.onmessage = (event: any) => {
            try {
                const data = JSON.parse(event.data);

                // Resetear contador de errores en eventos exitosos
                if (this.consecutiveErrors > 0) {
                    logger.info('[TouchModeService] Conexión SSE restaurada - Reseteando contador de errores');
                    this.consecutiveErrors = 0;
                }

                this.handleBiometricEvent(data);
            } catch (error) {
                logger.error('[TouchModeService] Error parsing SSE event:', error);
            }
        };

        this.eventSource.onerror = (error: any) => {
            logger.error('[TouchModeService] SSE error:', error);

            this.consecutiveErrors++;
            logger.warn(`[TouchModeService] Errores consecutivos: ${this.consecutiveErrors}/${this.MAX_CONSECUTIVE_ERRORS}`);

            // Si superamos el límite de errores, desactivar automáticamente
            if (this.consecutiveErrors >= this.MAX_CONSECUTIVE_ERRORS) {
                logger.error('[TouchModeService] ❌ LÍMITE DE ERRORES ALCANZADO - Desactivando servicio automáticamente');
                this.handleCriticalError('Se alcanzó el límite de errores en la comunicación con el lector');
                return;
            }

            // Intentar reconectar después de 3 segundos
            if (this.state.isActive) {
                if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
                this.reconnectTimer = setTimeout(() => {
                    this.reconnectTimer = null;
                    if (this.state.isActive && this.eventSource?.readyState === 2) { // 2 = CLOSED
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
     * Manejar eventos biométricos
     */
    private async handleBiometricEvent(data: any) {
        const eventType = data.eventType || '';

        logger.info('📩 [TouchModeService] Evento SSE recibido:', eventType);

        // Actualizar estado
        this.state.lastEventTime = new Date();

        // Emitir evento a handlers registrados
        this.eventHandlers.forEach(handler => {
            try {
                handler(eventType, data);
            } catch (error) {
                logger.error('[TouchModeService] Error in event handler:', error);
            }
        });

        // Procesar eventos específicos
        switch (eventType) {
            case 'FINGER_TOUCHED':
                this.state.totalTouches++;
                logger.info(`👆 [TouchModeService] DEDO DETECTADO en el lector (total: ${this.state.totalTouches})`);
                logger.info(`[TouchModeService] Capturando huella...`);
                break;

            case 'FINGERPRINT_READY':
                this.state.totalFingerprints++;
                logger.info(`✅ [TouchModeService] HUELLA CAPTURADA Y LISTA (total: ${this.state.totalFingerprints})`);
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

            if (employee.status !== 'active') {
                logger.warn(`⚠️ [TouchModeService] Empleado ${employee.first_name} ${employee.last_name} está inactivo.`);
                this.emitEvent('IDENTIFICATION_FAILED', {
                    message: `El empleado ${employee.first_name} ${employee.last_name} está inactivo`
                });
                return;
            }

            logger.info(`[TouchModeService] - Nombre: ${employee.first_name} ${employee.last_name}`);
            logger.info(`[TouchModeService] - Código: ${employee.employee_code}`);

            this.emitEvent('EMPLOYEE_IDENTIFIED', {
                employeeId,
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
                    timestamp: new Date(),
                    record,
                    score: identifyResult.score
                });

                logger.info(`✅ [TouchModeService] ENTRADA REGISTRADA EXITOSAMENTE`);
                logger.info(`[TouchModeService] - Hora: ${record.check_in_time}`);
                logger.info(`[TouchModeService] - Estado: ${record.status}`);
                if (employee) {
                    logger.info(`[TouchModeService] - Empleado: ${employee.first_name} ${employee.last_name}`);
                }

            } else if (!hasCheckedOut) {
                // Validar tiempo mínimo entre check-in y check-out (1 minuto)
                const now = new Date();
                const checkInDateTime = new Date(`${today} ${todayRecord.check_in_time}`);
                const diffMinutes = (now.getTime() - checkInDateTime.getTime()) / (1000 * 60);

                if (diffMinutes < 1) {
                    logger.info(`⏱️ [TouchModeService] CHECK-OUT MUY RÁPIDO - Debe esperar al menos 1 minuto desde el check-in`);
                    logger.info(`[TouchModeService] - Tiempo transcurrido: ${Math.floor(diffMinutes * 60)} segundos`);
                    this.emitEvent('CHECK_OUT_TOO_SOON', {
                        employeeId,
                        secondsElapsed: Math.floor(diffMinutes * 60),
                        minimumSeconds: 60
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
                    timestamp: new Date(),
                    record,
                    score: identifyResult.score
                });

                logger.info(`✅ [TouchModeService] SALIDA REGISTRADA EXITOSAMENTE`);
                logger.info(`[TouchModeService] - Hora: ${record.check_out_time}`);
                if (employee) {
                    logger.info(`[TouchModeService] - Empleado: ${employee.first_name} ${employee.last_name}`);
                }

            } else {
                logger.info(`ℹ️ [TouchModeService] EMPLEADO YA COMPLETÓ SU ASISTENCIA HOY`);
                logger.info(`[TouchModeService] - Entrada: ${todayRecord.check_in_time}`);
                logger.info(`[TouchModeService] - Salida: ${todayRecord.check_out_time}`);
                this.emitEvent('ALREADY_REGISTERED', { employeeId });
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
        this.transitionTo('ERROR', message);

        logger.error('❌❌❌ [TouchModeService] ERROR CRÍTICO DETECTADO ❌❌❌');
        logger.error(`[TouchModeService] Mensaje: ${message}`);
        logger.error('[TouchModeService] Desactivando modo automático por seguridad...');

        try {
            // Emitir evento de error crítico antes de desactivar
            this.emitEvent('CRITICAL_ERROR', {
                message,
                timestamp: new Date()
            });

            // Desactivar el servicio
            await this.stop();

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
        this.disconnectFromEvents();
        this.eventHandlers = [];
        this.state.isActive = false;
        this.transitionTo('IDLE', 'Servicio liberado');
    }
}
