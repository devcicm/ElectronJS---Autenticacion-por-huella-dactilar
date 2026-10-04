/**
 * Servicio Biométrico
 * Comunica con el motor biométrico (biometric-engine) para captura y verificación
 */

import { getDatabaseManager } from '../database/init.js';
import { FingerprintModel } from '../models/index.js';
import { FingerPosition } from '../types/index.js';
import { BIOMETRIC_SERVER } from '../shared/biometric-config.js';
import { logger } from '../shared/logger.js';

export class BiometricService {
    private db = getDatabaseManager();
    private fingerprintModel = new FingerprintModel(this.db);
    private readerInitialized = false;

    /**
     * Verificar si el servidor biométrico está disponible
     */
    async isServerAvailable(): Promise<boolean> {
        try {
            const response = await fetch(`${BIOMETRIC_SERVER}/api/store-stats`, {
                signal: AbortSignal.timeout(3000)
            });
            return response.ok;
        } catch {
            return false;
        }
    }

    /**
     * Inicializar el lector de huellas
     */
    private async initializeReader(): Promise<{ ok: boolean; error?: string }> {
        if (this.readerInitialized) {
            return { ok: true };
        }

        try {
            // Inicializar el lector
            const response = await fetch(`${BIOMETRIC_SERVER}/api/init`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });

            const data = await response.json() as { ok: boolean; error?: string };

            if (data.ok) {
                this.readerInitialized = true;
                logger.info('✅ Lector de huellas inicializado');
            }

            return data;
        } catch (error: any) {
            return { ok: false, error: error.message || 'Error al inicializar el lector' };
        }
    }

    /**
     * Comparar dos templates de huellas
     * NOTA: El backend no soporta comparación directa de templates
     * Este método está deprecated y no debe usarse
     */
    async compareTemplates(template1: string, template2: string): Promise<{
        isMatch: boolean;
        score?: number;
    }> {
        logger.warn('⚠️ compareTemplates está deprecated - el backend no soporta comparación directa');
        return { isMatch: false };
    }

    /**
     * Capturar huella dactilar
     */
    async captureFingerprint(): Promise<{
        success: boolean;
        templateData?: string;
        template?: string;
        quality?: number;
        message?: string;
    }> {
        try {
            // Inicializar el lector si no está inicializado
            const init = await this.initializeReader();
            if (!init.ok) {
                return {
                    success: false,
                    message: init.error || 'No se pudo inicializar el lector de huellas'
                };
            }

            const response = await fetch(`${BIOMETRIC_SERVER}/api/single`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ timeoutMs: 10000 })
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({})) as { error?: string };
                return {
                    success: false,
                    message: errorData.error || 'Error al capturar huella'
                };
            }

            const data = await response.json() as { ok: boolean; template?: string; quality?: number; error?: string };

            if (!data.ok || !data.template) {
                return {
                    success: false,
                    message: data.error || 'No se pudo capturar la huella'
                };
            }

            return {
                success: true,
                template: data.template,
                templateData: data.template,  // Agregar alias para AutoAttendanceService
                quality: data.quality || 0
            };
        } catch (error: any) {
            return {
                success: false,
                message: error.message || 'Error de conexión con el servidor biométrico'
            };
        }
    }

    /**
     * Enrollar huella para un empleado
     */
    async enrollFingerprint(
        employeeId: number,
        fingerPosition: FingerPosition
    ): Promise<{
        success: boolean;
        message: string;
        quality?: number;
    }> {
        try {
            // Inicializar el lector si no está inicializado
            const init = await this.initializeReader();
            if (!init.ok) {
                return {
                    success: false,
                    message: init.error || 'No se pudo inicializar el lector de huellas'
                };
            }

            // Crear un tag único para esta huella
            const tag = `employee_${employeeId}_${fingerPosition}`;
            logger.info(`[BiometricService] Iniciando enrollment para: ${tag}`);

            // Llamar al endpoint de enrollment (el servidor captura múltiples muestras automáticamente)
            const response = await fetch(`${BIOMETRIC_SERVER}/api/enroll`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    tag: tag,
                    timeoutMs: 30000,  // 30 segundos timeout
                    targetFarn: 21474,  // Umbral de calidad
                    maxRetriesPerSample: 3,
                    maxSamples: 4
                })
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({})) as { error?: string };
                return {
                    success: false,
                    message: errorData.error || 'Error en el enrollment'
                };
            }

            const data = await response.json() as {
                ok: boolean;
                templateBase64?: string;
                quality?: number;
                error?: string;
            };

            if (!data.ok || !data.templateBase64) {
                return {
                    success: false,
                    message: data.error || 'No se pudo completar el enrollment'
                };
            }

            // Guardar el template real en la base de datos para comparación local
            // Split fingerPosition into hand and finger_position
            // fingerPosition format: "LEFT_INDEX", "RIGHT_THUMB", etc.
            const [hand, ...fingerParts] = fingerPosition.split('_');
            const finger = fingerParts.join('_') as FingerPosition;

            this.fingerprintModel.upsert({
                employee_id: employeeId,
                finger_position: finger,
                hand: hand as 'LEFT' | 'RIGHT',
                template_data: data.templateBase64, // Guardamos el template real para comparación
                quality_score: data.quality || 0
            });

            logger.info(`✅ Huella enrollada exitosamente para: ${tag}`);

            return {
                success: true,
                message: 'Huella enrollada correctamente',
                quality: data.quality
            };
        } catch (error: any) {
            return {
                success: false,
                message: error.message || 'Error en enrollment'
            };
        }
    }

    /**
     * Verificar huella contra template almacenado
     */
    async verifyFingerprint(employeeId: number): Promise<{
        success: boolean;
        verified: boolean;
        message: string;
        score?: number;
    }> {
        try {
            // Obtener templates del empleado
            const fingerprints = this.fingerprintModel.getByEmployee(employeeId);

            if (fingerprints.length === 0) {
                return {
                    success: false,
                    verified: false,
                    message: 'El empleado no tiene huellas registradas'
                };
            }

            // Preparar array de fingerprints para el backend
            const fingerprintArray = fingerprints.map(fp => ({
                userId: employeeId.toString(),
                hand: fp.hand,
                finger: fp.finger_position,
                templateBase64: fp.template_data,
                format: 'ISO'
            }));

            // Llamar al endpoint de verificación múltiple
            // Este endpoint captura del lector y compara contra los templates
            const response = await fetch(`${BIOMETRIC_SERVER}/api/external/verify-multiple`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    fingerprints: fingerprintArray,
                    timeoutMs: 15000,
                    targetFarn: 21474
                })
            });

            if (!response.ok) {
                return {
                    success: false,
                    verified: false,
                    message: 'Error en la comunicación con el servidor biométrico'
                };
            }

            const data = await response.json() as {
                ok: boolean;
                matched: boolean;
                userId?: string;
                score?: number;
                error?: string;
            };

            if (data.ok && data.matched) {
                return {
                    success: true,
                    verified: true,
                    message: 'Huella verificada correctamente',
                    score: data.score
                };
            }

            return {
                success: true,
                verified: false,
                message: 'La huella no coincide'
            };
        } catch (error: any) {
            return {
                success: false,
                verified: false,
                message: error.message || 'Error en verificación'
            };
        }
    }

    /**
     * Identificar empleado por huella
     * Busca en toda la base de datos de templates
     */
    async identifyEmployee(): Promise<{
        success: boolean;
        employeeId?: number;
        message: string;
        score?: number;
    }> {
        try {
            // Obtener todos los empleados con huellas
            const employeeIds = this.fingerprintModel.getEmployeesWithFingerprints();

            if (employeeIds.length === 0) {
                return {
                    success: false,
                    message: 'No hay empleados con huellas registradas'
                };
            }

            // Preparar array de fingerprints para el backend
            const fingerprintArray: Array<{
                userId: string;
                hand: string;
                finger: string;
                templateBase64: string;
                format: string;
            }> = [];

            for (const empId of employeeIds) {
                const fingerprints = this.fingerprintModel.getByEmployee(empId);
                for (const fp of fingerprints) {
                    fingerprintArray.push({
                        userId: empId.toString(),
                        hand: fp.hand,
                        finger: fp.finger_position,
                        templateBase64: fp.template_data,
                        format: 'ISO'
                    });
                }
            }

            // Llamar al endpoint de verificación múltiple
            // Este endpoint captura del lector y compara contra todos los templates
            const response = await fetch(`${BIOMETRIC_SERVER}/api/external/verify-multiple`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    fingerprints: fingerprintArray,
                    timeoutMs: 15000,
                    targetFarn: 21474
                })
            });

            if (!response.ok) {
                return {
                    success: false,
                    message: 'Error en la comunicación con el servidor biométrico'
                };
            }

            const data = await response.json() as {
                ok: boolean;
                matched: boolean;
                userId?: string;
                score?: number;
                error?: string;
            };

            if (data.ok && data.matched && data.userId) {
                return {
                    success: true,
                    employeeId: parseInt(data.userId),
                    message: 'Empleado identificado',
                    score: data.score
                };
            }

            return {
                success: true,
                message: 'No se encontró coincidencia'
            };
        } catch (error: any) {
            return {
                success: false,
                message: error.message || 'Error en identificación'
            };
        }
    }

    /**
     * Obtener estadísticas del lector
     */
    async getReaderStats() {
        try {
            const response = await fetch(`${BIOMETRIC_SERVER}/api/store-stats`);
            if (response.ok) {
                return await response.json();
            }
            return null;
        } catch {
            return null;
        }
    }

    /**
     * Obtener información del dispositivo
     */
    async getDeviceInfo() {
        try {
            const response = await fetch(`${BIOMETRIC_SERVER}/api/device-info`);
            if (response.ok) {
                return await response.json();
            }
            return null;
        } catch {
            return null;
        }
    }
}
