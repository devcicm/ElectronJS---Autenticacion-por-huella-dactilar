/**
 * cdp-debug.mjs — Diagnóstico interactivo del renderer de Electron vía CDP.
 *
 * Uso:
 *   Terminal 1:  npm run debug
 *   Terminal 2:  node refactor/scripts/cdp-debug.mjs
 *
 * Output: JSON estructurado + resumen legible.
 * Sale con código 0 si todo OK, 1 si algo está colgado/falla.
 */
const TARGET = process.env.CDP_URL || 'http://localhost:9222';

const log = (...args) => console.log('[CDP]', ...args);

// 1. Discover renderer via /json
async function discoverPage() {
    const res = await fetch(`${TARGET}/json`);
    if (!res.ok) throw new Error(`Electron no responde en ${TARGET}`);
    const pages = await res.json();
    const renderer = pages.find(p => p.type === 'page' && p.webSocketDebuggerUrl);
    if (!renderer) throw new Error('No se encontro page del renderer');
    return renderer;
}

// 2. CDP client via WebSocket nativo
class CDPClient {
    constructor(wsUrl) {
        this.id = 0;
        this.pending = new Map();
        this.events = [];
        this.ws = new WebSocket(wsUrl);
        this.ws.addEventListener('message', e => this.onMessage(JSON.parse(e.data)));
        this.ws.addEventListener('open', () => this.onOpen());
        this._open = new Promise(r => this.ws.addEventListener('open', r, { once: true }));
        this._close = new Promise(r => this.ws.addEventListener('close', r, { once: true }));
    }
    onMessage(msg) {
        if (msg.id && this.pending.has(msg.id)) {
            const { resolve, reject } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
        } else if (msg.method && msg.method.startsWith('Log.')) {
            this.events.push(msg);
        } else if (msg.method && msg.method.startsWith('Runtime.consoleAPIC')) {
            this.events.push(msg);
        }
    }
    send(method, params = {}) {
        const id = ++this.id;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }
    async close() {
        this.ws.close();
        await this._close;
    }
    async waitOpen() { await this._open; }
}

// 3. Eval con timeout y captura de errores
async function evalInPage(client, expr, timeoutMs = 5000) {
    try {
        const r = await Promise.race([
            client.send('Runtime.evaluate', {
                expression: `(async () => { try { return ${expr}; } catch (e) { return { __error: String(e), __stack: e?.stack }; } })()`,
                returnByValue: true,
                awaitPromise: true,
            }),
            new Promise((_, rej) => setTimeout(() => rej(new Error(`eval timeout (>${timeoutMs}ms)`)), timeoutMs + 500)),
        ]);
        if (r.exceptionDetails) {
            return { __eval_error: r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails) };
        }
        return r.result?.value;
    } catch (e) {
        return { __eval_threw: e.message };
    }
}

async function main() {
    log('descubriendo renderer en', TARGET);
    let page;
    try { page = await discoverPage(); }
    catch (e) { log('ERROR:', e.message); process.exit(1); }
    log('renderer encontrado:', page.title || '(sin titulo)');

    const client = new CDPClient(page.webSocketDebuggerUrl);
    await client.waitOpen();
    await client.send('Runtime.enable');
    await client.send('DOM.enable');
    await client.send('Log.enable');
    // Esperar a que el renderer termine su init (loadInitialData + initializeTouchMode tienen withTimeout 10s)
    await new Promise(r => setTimeout(r, 2000));

    // 1. DOM state
    const sections = await evalInPage(client, `
        Array.from(document.querySelectorAll('.content-section')).map(s => ({
            id: s.id,
            active: s.classList.contains('active'),
            display: getComputedStyle(s).display,
            height: s.getBoundingClientRect().height,
        }))
    `);

    // 2. App globals (pueden no estar definidos si el module fallo)
    const state = await evalInPage(client, `
        ({
            currentSection: typeof currentSection !== 'undefined' ? currentSection : '(no definido)',
            employeesCount: typeof employees !== 'undefined' ? employees.length : '(no definido)',
            departmentsCount: typeof departments !== 'undefined' ? departments.length : '(no definido)',
            shiftsCount: typeof shifts !== 'undefined' ? shifts.length : '(no definido)',
            todayRecordsCount: typeof todayRecords !== 'undefined' ? todayRecords.length : '(no definido)',
            fingerprintEnrollerExists: typeof window.FingerprintEnroller !== 'undefined',
            attendanceApiExists: typeof window.attendance !== 'undefined',
            attendanceApiKeys: typeof window.attendance !== 'undefined' ? Object.keys(window.attendance) : [],
            biometricApiExists: typeof window.biometric !== 'undefined',
            touchModeApiExists: typeof window.touchMode !== 'undefined',
            pageTitleText: document.getElementById('page-title')?.textContent ?? null,
        })
    `);

    // 3. IPC timing tests
    const ipcTests = {};
    const channels = [
        ['getEmployees',    () => window.attendance?.getEmployees({})],
        ['getDepartments',  () => window.attendance?.getDepartments?.()],
        ['getShifts',       () => window.attendance?.getShifts?.()],
        ['getDashboardSummary', () => window.attendance?.getDashboardSummary?.()],
        ['isServerAvailable', () => window.biometric?.isServerAvailable?.()],
    ];
    for (const [name, fn] of channels) {
        const start = Date.now();
        const result = await evalInPage(client, `
            (async () => {
                try {
                    if (!${JSON.stringify(fn.toString())}.call) return { skipped: true };
                    const r = await (${fn.toString()})();
                    return { ok: true, ms: ${Date.now()} - ${start}, type: typeof r };
                } catch (e) {
                    return { ok: false, ms: ${Date.now()} - ${start}, error: String(e?.message || e) };
                }
            })()
        `, 5000);
        ipcTests[name] = result;
    }

    // 4. Module load test
    const moduleTest = await evalInPage(client, `
        (async () => {
            try {
                const mod = await import('./js/logger.js');
                return { ok: true, keys: Object.keys(mod), hasLogger: typeof mod.logger !== 'undefined' };
            } catch (e) {
                return { ok: false, error: String(e?.message || e), stack: e?.stack?.split(String.fromCharCode(10)).slice(0, 3).join(' | ') };
            }
        })()
    `, 5000);

    // 5. DOM target list (elementos criticos)
    const targetElements = await evalInPage(client, `
        ({
            'dashboard-section': !!document.getElementById('dashboard-section'),
            'page-title': !!document.getElementById('page-title'),
            'current-time': !!document.getElementById('current-time'),
            'stat-present': !!document.getElementById('stat-present'),
            'stat-late': !!document.getElementById('stat-late'),
            'stat-absent': !!document.getElementById('stat-absent'),
            'today-records-table': !!document.getElementById('today-records-table'),
            'employees-list': !!document.getElementById('employees-list'),
            'attendance-records-container': !!document.getElementById('attendance-records-container'),
        })
    `);

    await client.close();

    // Resumen legible
    const report = { sections, state, ipcTests, moduleTest, targetElements };
    console.log('\n=== CDP DEBUG REPORT ===');
    console.log(JSON.stringify(report, null, 2));

    // Analisis automatico
    console.log('\n=== DIAGNOSIS ===');
    const issues = [];
    if (sections.find(s => s.id === 'dashboard-section')?.display === 'none') {
        issues.push('dashboard-section display=none (no visible)');
    } else {
        log('dashboard-section display=' + sections.find(s => s.id === 'dashboard-section')?.display);
    }
    for (const [name, r] of Object.entries(ipcTests)) {
        if (r.skipped) continue;
        if (r.ms > 3000) issues.push(`${name} lentO: ${r.ms}ms`);
        if (r.__eval_threw && /timeout/.test(r.__eval_threw)) issues.push(`${name} COLGADO: timeout`);
        if (r.error) issues.push(`${name} ERROR: ${r.error}`);
    }
    if (!moduleTest.ok) issues.push(`module load FAIL: ${moduleTest.error}`);
    if (!state.attendanceApiExists) issues.push('window.attendance NO EXISTE — preload no se cargo?');
    if (state.employeesCount === '(no definido)') issues.push('employees[] no inicializado — DOMContentLoaded no llego al final?');

    if (issues.length === 0) {
        log('sin issues detectados en CDP scan');
    } else {
        for (const i of issues) log('ISSUE:', i);
        process.exit(2);
    }
}

main().catch(e => { log('FATAL:', e.message); console.error(e); process.exit(1); });