/**
 * Configuración única del servidor biométrico.
 * Dueño único del conocimiento D-01/N-05/N-02: puerto, URL, umbrales y timeouts
 * del engine. Todo consumidor (Electron main, servicios, engine) importa/lee
 * de aquí o de la variable de entorno equivalente. Nunca hardcodear en otro sitio.
 */
export const BIOMETRIC_PORT = Number(process.env.BIOMETRIC_PORT) || 8080;
export const BIOMETRIC_SERVER = `http://localhost:${BIOMETRIC_PORT}`;

/** Umbral de calidad (FARN) usado por DigitalPersona DP4500. */
export const DEFAULT_TARGET_FARN = 21474;

/** Timeouts por operación (ms). Documentados por nombre para evitar literales sueltos. */
export const TIMEOUT_CAPTURE_MS   = 10_000;
export const TIMEOUT_ENROLL_MS    = 30_000;
export const TIMEOUT_VERIFY_MS    = 15_000;
export const TIMEOUT_IDENTIFY_MS  = 15_000;

/** Timeout por defecto para llamadas HTTP al engine (cubre start/stop/status/init/etc). */
export const HTTP_DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Helper `fetch` con timeout (AbortSignal) — evita cuelgues indefinidos si el engine
 * tarda o falla. Lanza `AbortError` tras `timeoutMs`. Retorna la respuesta JSON parseada
 * o tira el error original del fetch.
 */
export async function fetchJson(url: string, init: RequestInit = {}, timeoutMs: number = HTTP_DEFAULT_TIMEOUT_MS): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { ...init, signal: controller.signal });
        return await response.json();
    } finally {
        clearTimeout(timer);
    }
}
