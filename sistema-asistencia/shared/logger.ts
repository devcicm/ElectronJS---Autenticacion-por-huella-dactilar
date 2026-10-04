/**
 * Logger con niveles — BE-20. Cero dependencias.
 * LOG_LEVEL=debug|info|warn|error (default: info).
 * Paridad: console.log->info, console.error->error, console.warn->warn;
 * con el nivel por defecto TODO mensaje existente sigue imprimiéndose.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const envLevel = (process.env.LOG_LEVEL || '').toLowerCase() as Level;
const threshold = LEVELS[envLevel] ?? LEVELS.info;

function emit(level: Level, args: unknown[]): void {
    if (LEVELS[level] < threshold) return;
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fn(`[${level.toUpperCase()}]`, ...args);
}

export const logger = {
    debug: (...args: unknown[]) => emit('debug', args),
    info: (...args: unknown[]) => emit('info', args),
    warn: (...args: unknown[]) => emit('warn', args),
    error: (...args: unknown[]) => emit('error', args),
};
