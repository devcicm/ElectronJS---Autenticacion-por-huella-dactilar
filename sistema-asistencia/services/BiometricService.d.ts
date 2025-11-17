/**
 * Servicio Biométrico
 * Comunica con el motor biométrico (biometric-engine) para captura y verificación
 */
import { FingerPosition } from '../types/index.js';
export declare class BiometricService {
    private db;
    private fingerprintModel;
    /**
     * Verificar si el servidor biométrico está disponible
     */
    isServerAvailable(): Promise<boolean>;
    /**
     * Capturar huella dactilar
     */
    captureFingerprint(): Promise<{
        success: boolean;
        template?: string;
        quality?: number;
        message?: string;
    }>;
    /**
     * Enrollar huella para un empleado
     */
    enrollFingerprint(employeeId: number, fingerPosition: FingerPosition): Promise<{
        success: boolean;
        message: string;
        quality?: number;
    }>;
    /**
     * Verificar huella contra template almacenado
     */
    verifyFingerprint(employeeId: number): Promise<{
        success: boolean;
        verified: boolean;
        message: string;
        score?: number;
    }>;
    /**
     * Identificar empleado por huella
     * Busca en toda la base de datos de templates
     */
    identifyEmployee(): Promise<{
        success: boolean;
        employeeId?: number;
        message: string;
        score?: number;
    }>;
    /**
     * Obtener estadísticas del lector
     */
    getReaderStats(): Promise<unknown>;
    /**
     * Obtener información del dispositivo
     */
    getDeviceInfo(): Promise<unknown>;
}
//# sourceMappingURL=BiometricService.d.ts.map