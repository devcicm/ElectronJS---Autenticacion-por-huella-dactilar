/**
 * Servicio Biométrico
 * Comunica con el motor biométrico (biometric-engine) para captura y verificación
 */
import { getDatabaseManager } from '../database/init.js';
import { FingerprintModel } from '../models/index.js';
const BIOMETRIC_SERVER = 'http://localhost:8080';
export class BiometricService {
    db = getDatabaseManager();
    fingerprintModel = new FingerprintModel(this.db);
    /**
     * Verificar si el servidor biométrico está disponible
     */
    async isServerAvailable() {
        try {
            const response = await fetch(`${BIOMETRIC_SERVER}/api/store-stats`, {
                signal: AbortSignal.timeout(3000)
            });
            return response.ok;
        }
        catch {
            return false;
        }
    }
    /**
     * Capturar huella dactilar
     */
    async captureFingerprint() {
        try {
            const response = await fetch(`${BIOMETRIC_SERVER}/api/capture`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            if (!response.ok) {
                return { success: false, message: 'Error al capturar huella' };
            }
            const data = await response.json();
            return {
                success: true,
                template: data.template,
                quality: data.quality || 0
            };
        }
        catch (error) {
            return {
                success: false,
                message: error.message || 'Error de conexión con el servidor biométrico'
            };
        }
    }
    /**
     * Enrollar huella para un empleado
     */
    async enrollFingerprint(employeeId, fingerPosition) {
        try {
            // Capturar 3 muestras para enrollment
            const samples = [];
            for (let i = 0; i < 3; i++) {
                const capture = await this.captureFingerprint();
                if (!capture.success || !capture.template) {
                    return {
                        success: false,
                        message: `Error en captura ${i + 1}: ${capture.message}`
                    };
                }
                samples.push(capture.template);
            }
            // Llamar al endpoint de enrollment
            const response = await fetch(`${BIOMETRIC_SERVER}/api/enroll`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ samples })
            });
            if (!response.ok) {
                return { success: false, message: 'Error en el enrollment' };
            }
            const data = await response.json();
            // Guardar template en la base de datos
            this.fingerprintModel.upsert({
                employee_id: employeeId,
                finger_position: fingerPosition,
                template_data: data.template,
                quality_score: data.quality || 0
            });
            return {
                success: true,
                message: 'Huella enrollada correctamente',
                quality: data.quality
            };
        }
        catch (error) {
            return {
                success: false,
                message: error.message || 'Error en enrollment'
            };
        }
    }
    /**
     * Verificar huella contra template almacenado
     */
    async verifyFingerprint(employeeId) {
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
            // Capturar huella actual
            const capture = await this.captureFingerprint();
            if (!capture.success || !capture.template) {
                return {
                    success: false,
                    verified: false,
                    message: capture.message || 'Error al capturar huella'
                };
            }
            // Verificar contra cada template guardado
            for (const fp of fingerprints) {
                const response = await fetch(`${BIOMETRIC_SERVER}/api/verify`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        template1: capture.template,
                        template2: fp.template_data
                    })
                });
                if (response.ok) {
                    const data = await response.json();
                    if (data.verified) {
                        return {
                            success: true,
                            verified: true,
                            message: 'Huella verificada correctamente',
                            score: data.score
                        };
                    }
                }
            }
            return {
                success: true,
                verified: false,
                message: 'La huella no coincide'
            };
        }
        catch (error) {
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
    async identifyEmployee() {
        try {
            // Capturar huella
            const capture = await this.captureFingerprint();
            if (!capture.success || !capture.template) {
                return {
                    success: false,
                    message: capture.message || 'Error al capturar huella'
                };
            }
            // Obtener todos los empleados con huellas
            const employeeIds = this.fingerprintModel.getEmployeesWithFingerprints();
            // Verificar contra cada empleado
            for (const empId of employeeIds) {
                const fingerprints = this.fingerprintModel.getByEmployee(empId);
                for (const fp of fingerprints) {
                    const response = await fetch(`${BIOMETRIC_SERVER}/api/verify`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            template1: capture.template,
                            template2: fp.template_data
                        })
                    });
                    if (response.ok) {
                        const data = await response.json();
                        if (data.verified) {
                            return {
                                success: true,
                                employeeId: empId,
                                message: 'Empleado identificado',
                                score: data.score
                            };
                        }
                    }
                }
            }
            return {
                success: true,
                message: 'No se encontró coincidencia'
            };
        }
        catch (error) {
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
        }
        catch {
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
        }
        catch {
            return null;
        }
    }
}
//# sourceMappingURL=BiometricService.js.map