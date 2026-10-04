/**
 * Logger con niveles — BE-20 lado renderer (espejo de shared/logger.ts).
 * LOG_LEVEL desde localStorage('LOG_LEVEL'); default: info.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold = LEVELS.info;
try {
    const saved = localStorage.getItem('LOG_LEVEL');
    if (saved && LEVELS[saved.toLowerCase()]) threshold = LEVELS[saved.toLowerCase()];
} catch { /* storage no disponible: nivel por defecto */ }

function emit(level, args) {
    if (LEVELS[level] < threshold) return;
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fn(`[${level.toUpperCase()}]`, ...args);
}

export const logger = {
    debug: (...args) => emit('debug', args),
    info: (...args) => emit('info', args),
    warn: (...args) => emit('warn', args),
    error: (...args) => emit('error', args),
};
