/**
 * Configuración única del servidor biométrico.
 * Dueño único del conocimiento D-01/N-05: puerto y URL base del engine.
 * Todo consumidor (Electron main, servicios, engine) importa/lee de aquí o
 * de la variable de entorno BIOMETRIC_PORT. Nunca hardcodear en otro sitio.
 */
export const BIOMETRIC_PORT = Number(process.env.BIOMETRIC_PORT) || 8080;
export const BIOMETRIC_SERVER = `http://localhost:${BIOMETRIC_PORT}`;
