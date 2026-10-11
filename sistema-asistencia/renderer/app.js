/**
 * Sistema de Asistencia - Renderer Application
 * Conecta la interfaz con el backend a través de la API expuesta por preload
 *
 * Script clásico (NO ES module): bajo Electron file:// los imports de módulos
 * fallan por CORS. Depende de los globales cargados por los <script> previos:
 *   window.logger, window.escapeHtml, window.sanitizeText/Phone/Email,
 *   window.FingerprintEnroller
 */

// ==================== OBSERVABILIDAD: TRAZADO ====================
// Buffer global accesible vía CDP. No interfiere con el flujo normal; solo observa.
window.__trace = [];
window.__traceStart = Date.now();
function T(type, label, data = {}) {
    const e = { t: Date.now() - window.__traceStart, type, label, data, rs: document.readyState, url: location.href };
    window.__trace.push(e);
    if (window.__trace.length > 1000) window.__trace.shift();
    try { console.log('[trace]', type, label, data); } catch {}
}
window.__dumpTrace = function () {
    try {
        const json = JSON.stringify({ metadata: { url: location.href, ua: navigator.userAgent, ts: Date.now() }, events: window.__trace });
        if (window.electronBridge?.dumpTrace) {
            window.electronBridge.dumpTrace(json).catch(() => {});
        }
        if (window.labBridge?.dumpTrace) {
            window.labBridge.dumpTrace(json).catch(() => {});
        }
    } catch {}
};
T('module-load', 'start');

// window.FingerprintEnroller lo crea js/controls/FingerprintEnroller.js (script clásico previo)
T('module-load', 'FingerprintEnroller disponible: ' + (typeof window.FingerprintEnroller !== 'undefined'));

let clockIntervalId = null;
let isInitialDataLoaded = false;
let initialDataLoadPromise = null;

// B4: liberar EventSource, intervalos y polling al cerrar la ventana (recurso del engine)
window.addEventListener('beforeunload', () => {
    T('shutdown', 'beforeunload fired');
    window.__dumpTrace();
    if (clockIntervalId) {
        clearInterval(clockIntervalId);
        clockIntervalId = null;
    }
    if (typeof touchModePollingInterval !== 'undefined' && touchModePollingInterval) {
        clearInterval(touchModePollingInterval);
        touchModePollingInterval = null;
    }
    if (typeof closeCameraModal === 'function') {
        closeCameraModal();
    }
    window.FingerprintEnroller?.disconnect();
});

// ==================== ESTADO GLOBAL ====================
let currentSection = 'dashboard';
let employees = [];
let todayRecords = [];
let departments = [];
let shifts = [];
let selectedEmployeeId = null;

// Estado del lector automático
let autoAttendanceState = {
    isListening: false,
    isEnrolling: false,
    lastCacheUpdate: null,
    employeeCount: 0
};

// Estado de Seguridad y Modo Kiosco
let systemSecurityState = {
    hasAdminPin: false,
    isUnlocked: false,
    kioskLockEnabled: false
};

// ==================== INICIALIZACIÓN ====================
// B.2: wrap defensivo contra cuelgues en IPC/servicios externos — la UI no se queda
// en "Inicializando..." si un servicio tarda demasiado.
const withTimeout = (promise, ms, label) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout (>${ms}ms)`)), ms)),
]).catch(err => {
    logger.warn(`${label} skipped:`, err.message);
    return null;
});

// B.3: capturar errores async no atrapados (incluye promesas en renderer que escapan)
window.addEventListener('unhandledrejection', e => {
    T('error', 'unhandledrejection', { msg: String(e?.reason?.message || e?.reason) });
    logger.error('Unhandled:', e.reason);
});
window.addEventListener('error', e => {
    T('error', 'global', { msg: e?.message, file: e?.filename, line: e?.lineno });
    logger.error('Error global:', e.message, e.filename, e.lineno);
});

document.addEventListener('DOMContentLoaded', async () => {
    T('dom', 'DOMContentLoaded fired');
    logger.info('🚀 Sistema de Asistencia - Iniciando...');

    // Configurar navegación
    setupNavigation();

    // Configurar reloj
    updateClock();
    if (clockIntervalId) clearInterval(clockIntervalId);
    clockIntervalId = setInterval(updateClock, 1000);

    // Cargar datos iniciales (con timeout 10s — engine puede tardar, no debe bloquear dashboard)
    T('data', 'loadInitialData start');
    initialDataLoadPromise = withTimeout(loadInitialData(), 10_000, 'loadInitialData').then(() => {
        isInitialDataLoaded = true;
    });
    await initialDataLoadPromise;
    T('data', 'loadInitialData done', {
        employees: typeof employees !== 'undefined' ? employees.length : null,
        departments: typeof departments !== 'undefined' ? departments.length : null,
        shifts: typeof shifts !== 'undefined' ? shifts.length : null,
    });

    // Inicializar modo touch (con timeout 10s — si el engine falla, dashboard sigue)
    T('touch', 'initializeTouchMode start');
    await withTimeout(initializeTouchMode(), 10_000, 'initializeTouchMode');
    T('touch', 'initializeTouchMode done');

    // Mostrar dashboard por defecto
    showSection('dashboard');

    logger.info('✅ Sistema listo');
});

// ==================== NAVEGACIÓN ====================
function setupNavigation() {
    const navItems = document.querySelectorAll('.nav-item');
    T('setup-nav', 'start', { navCount: navItems.length });

    navItems.forEach((item, i) => {
        item.addEventListener('click', async () => {
            T('nav-click', 'handler invoked', { section: item.dataset.section, idx: i });
            try {
                const section = item.dataset.section;
                if (isKioskNavigationBlocked(section)) {
                    showNotification('🔒 Modo Kiosco activo: Desbloquee con el PIN de Administrador para acceder a esta sección.', 'warning');
                    const unlocked = await promptAdminPinModal('Desbloquear Modo Kiosco');
                    if (!unlocked) return;
                }
                navItems.forEach(nav => nav.classList.remove('active'));
                item.classList.add('active');
                T('nav-click', 'active class added', { section });
                await showSection(section);
            } catch (e) {
                T('nav-click', 'error', { msg: e.message });
                logger.error('Nav click failed:', e);
                showNotification('Error al cambiar de sección', 'error');
            }
        });
        T('setup-nav', 'listener attached', { idx: i, section: item.dataset.section });
    });

    T('setup-nav', 'end', { attached: navItems.length });
    updateKioskTopbarUI();
}

function isKioskNavigationBlocked(targetSection) {
    if (!systemSecurityState.hasAdminPin) return false;
    if (!systemSecurityState.kioskLockEnabled) return false;
    if (systemSecurityState.isUnlocked) return false;
    // En modo kiosco solo se permite marcar asistencia y dashboard
    return targetSection !== 'check-in' && targetSection !== 'dashboard';
}

async function showSection(sectionName) {
    if (isKioskNavigationBlocked(sectionName)) {
        showNotification('🔒 Modo Kiosco activo: Desbloquee con el PIN de Administrador para acceder.', 'warning');
        const unlocked = await promptAdminPinModal('Desbloquear Modo Kiosco');
        if (!unlocked) return;
    }
    T('show-section', 'start', { section: sectionName, currentBefore: typeof currentSection !== 'undefined' ? currentSection : null });
    try {
        if (initialDataLoadPromise && !isInitialDataLoaded) {
            await initialDataLoadPromise;
        }
        currentSection = sectionName;

        // Ocultar todas las secciones
        document.querySelectorAll('.content-section').forEach(section => {
            section.classList.remove('active');
        });

        // Mostrar sección seleccionada
        const targetSection = document.getElementById(`${sectionName}-section`);
        T('show-section', 'target lookup', { section: sectionName, found: !!targetSection });
        if (targetSection) {
            targetSection.classList.add('active');
            T('show-section', 'activated', { section: sectionName });
        }

        // Actualizar título
        const titles = {
            'dashboard': 'Dashboard',
            'check-in': 'Marcar Asistencia',
            'employees': 'Empleados',
            'attendance': 'Registros de Asistencia',
            'departments': 'Departamentos',
            'shifts': 'Turnos',
            'reports': 'Reportes',
            'settings': 'Configuración'
        };
        const titleEl = document.getElementById('page-title');
        if (titleEl) titleEl.textContent = titles[sectionName] || 'Sistema';

        // B.2: wrap loaders con withTimeout — si cuelgan >5s, no bloquean el switch
        const LOAD_TIMEOUT = 5000;
        switch (sectionName) {
            case 'dashboard':
                withTimeout(loadDashboard(), LOAD_TIMEOUT, 'loadDashboard');
                break;
            case 'check-in':
                withTimeout(loadCheckInSection(), LOAD_TIMEOUT, 'loadCheckInSection');
                break;
            case 'employees':
                withTimeout(loadEmployeesSection(), LOAD_TIMEOUT, 'loadEmployeesSection');
                break;
            case 'attendance':
                withTimeout(loadAttendanceSection(), LOAD_TIMEOUT, 'loadAttendanceSection');
                break;
            case 'departments':
                withTimeout(loadDepartmentsSection(), LOAD_TIMEOUT, 'loadDepartmentsSection');
                break;
            case 'shifts':
                withTimeout(loadShiftsSection(), LOAD_TIMEOUT, 'loadShiftsSection');
                break;
            case 'reports':
                withTimeout(loadReportsSection(), LOAD_TIMEOUT, 'loadReportsSection');
                break;
            case 'settings':
                withTimeout(loadSettingsSection(), LOAD_TIMEOUT, 'loadSettingsSection');
                break;
        }
    } catch (e) {
        T('show-section', 'error', { msg: e.message });
        logger.error(`showSection(${sectionName}) failed:`, e);
        showNotification('Error al cambiar de sección', 'error');
    }
}

// ==================== RELOJ ====================
function updateClock() {
    const now = new Date();

    const dateStr = now.toLocaleDateString('es-ES', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });

    const timeStr = now.toLocaleTimeString('es-ES', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });

    const dateEl = document.getElementById('current-date');
    const timeEl = document.getElementById('current-time');

    if (dateEl) dateEl.textContent = dateStr;
    if (timeEl) timeEl.textContent = timeStr;
}

// ==================== CARGA DE DATOS ====================
async function loadInitialData() {
    try {
        // Cargar datos generales y registros del día en paralelo
        const [empList, deptList, shiftList, recordsToday] = await Promise.all([
            window.attendance.getEmployees({ status: 'active' }),
            window.attendance.getDepartments(),
            window.attendance.getShifts(),
            window.attendance.getTodayRecords ? window.attendance.getTodayRecords() : Promise.resolve(todayRecords)
        ]);

        employees = empList || [];
        departments = deptList || [];
        shifts = shiftList || [];
        if (Array.isArray(recordsToday)) {
            todayRecords = recordsToday;
        }

        logger.info(`✅ Datos cargados: ${employees.length} empleados activos, ${departments.length} departamentos, ${shifts.length} turnos`);
    } catch (error) {
        logger.error('❌ Error cargando datos iniciales:', error);
        showNotification('Error al cargar datos iniciales', 'error');
    }
}

// ==================== DASHBOARD ====================
async function loadDashboard() {
    try {
        const summary = await window.attendance.getDashboardSummary();
        const { stats, todayRecords: records } = summary;

        // Actualizar estadísticas
        updateStatsCards(stats);

        // Actualizar tabla de asistencia de hoy
        updateTodayRecordsTable(records);

        todayRecords = records;
    } catch (error) {
        logger.error('❌ Error cargando dashboard:', error);
        showNotification('Error al cargar dashboard', 'error');
    }
}

function updateStatsCards(stats) {
    document.getElementById('stat-present').textContent = stats.present || 0;
    document.getElementById('stat-late').textContent = stats.late || 0;
    document.getElementById('stat-absent').textContent = stats.absent || 0;
    document.getElementById('stat-percentage').textContent =
        `${Math.round(stats.present_percentage || 0)}%`;
}

function updateTodayRecordsTable(records) {
    const tbody = document.querySelector('#today-records-table tbody');
    if (!tbody) return;

    if (records.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 2rem; color: #666;">No hay registros de hoy</td></tr>';
        return;
    }

    tbody.innerHTML = records.map(record => `
        <tr>
            <td class="td-nowrap">${escapeHtml(record.employee_code) || '-'}</td>
            <td class="td-nowrap" style="font-weight: 500;">${escapeHtml(record.employee_name) || '-'}</td>
            <td>${escapeHtml(record.department_name) || '-'}</td>
            <td class="td-nowrap">${escapeHtml(record.check_in_time) || '-'}</td>
            <td class="td-nowrap">${escapeHtml(record.check_out_time) || '-'}</td>
            <td class="td-center-nowrap">${renderStatusBadge(record.status)}</td>
        </tr>
    `).join('');
}

function getStatusLabel(status) {
    const labels = {
        'present': 'Presente',
        'late': 'Tarde',
        'absent': 'Ausente',
        'excused': 'Justificado',
        'half_day': 'Medio día',
        'on_leave': 'Permiso'
    };
    return labels[status] || status;
}

function getStatusBadgeClass(status) {
    const classes = {
        'present': 'success',
        'late': 'warning',
        'absent': 'danger',
        'excused': 'info',
        'half_day': 'warning',
        'on_leave': 'info'
    };
    return classes[status] || 'info';
}

function renderStatusBadge(status) {
    return `<span class="badge badge-${getStatusBadgeClass(status)}">${escapeHtml(getStatusLabel(status))}</span>`;
}

// ==================== CHECK-IN SECTION ====================
async function loadCheckInSection() {
    const employeesList = document.getElementById('employees-list');
    if (!employeesList) return;

    // Hidratar inmediatamente el estado del panel biométrico al abrir la sección
    updateTouchModeUI();

    // Sincronizar registros de hoy para reflejar entradas/salidas en cada tarjeta
    try {
        if (window.attendance && typeof window.attendance.getTodayRecords === 'function') {
            const freshRecords = await window.attendance.getTodayRecords();
            if (Array.isArray(freshRecords)) {
                todayRecords = freshRecords;
            }
        }
    } catch (e) {
        logger.warn('[CheckIn] No se pudieron refrescar los registros del día:', e);
    }

    const settings = loadSavedSettings();
    if (!settings.allowManual) {
        employeesList.innerHTML = `
            <div style="padding: 35px 20px; text-align: center; background: #F8FAFC; border: 2px dashed #CBD5E1; border-radius: 12px;">
                <div style="font-size: 36px; margin-bottom: 10px;">🔒</div>
                <h4 style="margin: 0 0 8px; color: #1E293B; font-size: 16px;">Marcación Manual Deshabilitada</h4>
                <p style="margin: 0; color: #64748B; font-size: 13px; max-width: 460px; margin: 0 auto; line-height: 1.5;">
                    La directiva de seguridad del sistema exige verificación biométrica exclusiva.
                    Por favor utilice el sensor biométrico <strong>DP4500</strong> en el panel de Modo Automático.
                </p>
            </div>
        `;
        return;
    }

    // Filtrar exclusivamente empleados activos (evita contaminación desde loadEmployeesSection)
    const activeEmployees = (employees || []).filter(emp => !emp.status || emp.status === 'active');

    if (activeEmployees.length === 0) {
        employeesList.innerHTML = '<p style="text-align:center; padding: 2rem; color: #666;">No hay empleados activos</p>';
        return;
    }

    employeesList.innerHTML = `
        <div style="margin-bottom: 20px;">
            <input type="text" id="checkin-search-input" placeholder="🔍 Buscar empleado por nómina, nombre o departamento..."
                   style="padding: 10px 14px; border: 1px solid #E5E7EB; border-radius: 8px; width: 100%; max-width: 420px; font-size: 14px;"
                   onkeyup="filterCheckInEmployees(this.value)">
        </div>
        <div id="checkin-cards-container" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 15px;">
            ${renderCheckInCards(activeEmployees)}
        </div>
    `;
}

function renderCheckInCards(empList) {
    const activeList = (empList || []).filter(emp => !emp.status || emp.status === 'active');
    return activeList.map(emp => {
        const avatar = emp.photo_url
            ? `<img src="${escapeHtml(emp.photo_url)}" alt="Foto" style="width: 60px; height: 60px; border-radius: 50%; object-fit: cover; border: 2px solid #94A3B8; flex-shrink: 0;">`
            : `<div style="width: 60px; height: 60px; border-radius: 50%; background: #334155; border: 2px solid #CBD5E1; display: flex; align-items: center; justify-content: center; color: #F8FAFC; font-size: 22px; font-weight: 600; flex-shrink: 0;">
                   ${escapeHtml(getInitials(emp.first_name, emp.last_name))}
               </div>`;

        const todayRec = (todayRecords || []).find(r => r.employee_id === emp.id);
        let attendanceBadgeHTML = `<span style="padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; background: #F3F4F6; color: #6B7280; border: 1px solid #E5E7EB;">⚪ Sin registro hoy</span>`;
        if (todayRec && todayRec.check_in_time && todayRec.check_out_time) {
            attendanceBadgeHTML = `<span style="padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; background: #DBEAFE; color: #1E40AF; border: 1px solid #BFDBFE;">✅ Jornada completa (${escapeHtml(formatTime(todayRec.check_in_time))} - ${escapeHtml(formatTime(todayRec.check_out_time))})</span>`;
        } else if (todayRec && todayRec.check_in_time) {
            attendanceBadgeHTML = `<span style="padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; background: #DCFCE7; color: #166534; border: 1px solid #86EFAC;">🟢 Entrada: ${escapeHtml(formatTime(todayRec.check_in_time))}</span>`;
        }

        const fpCount = emp.fingerprints_count || 0;
        const fpBadgeHTML = fpCount > 0
            ? `<span style="padding: 2px 7px; border-radius: 999px; font-size: 10.5px; font-weight: 600; background: #F1F5F9; color: #334155; border: 1px solid #CBD5E1;">👆 ${fpCount} huella${fpCount > 1 ? 's' : ''}</span>`
            : `<span style="padding: 2px 7px; border-radius: 999px; font-size: 10.5px; font-weight: 600; background: #FEF3C7; color: #92400E; border: 1px solid #FDE68A;">⚠️ Sin huella</span>`;

        return `
            <div style="border: 2px solid #E5E7EB; border-radius: 12px; padding: 15px; cursor: pointer; transition: all 0.2s; background: white;"
                 onmouseover="this.style.borderColor='#475569'; this.style.boxShadow='0 4px 12px rgba(15,23,42,0.08)'"
                 onmouseout="this.style.borderColor='#E5E7EB'; this.style.boxShadow='none'"
                 onclick="selectEmployeeForCheckIn(${emp.id})">
                <div style="display: flex; align-items: center; gap: 15px;">
                    ${avatar}
                    <div style="flex: 1; min-width: 0;">
                        <div style="font-weight: 600; font-size: 16px; color: #1F2937; margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                            ${escapeHtml(emp.first_name)} ${escapeHtml(emp.last_name)}
                        </div>
                        <div style="font-size: 13px; color: #6B7280; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                            ${escapeHtml(emp.employee_code)} &bull; ${escapeHtml(emp.department_name)}
                        </div>
                        <div style="font-size: 12px; color: #9CA3AF; margin-top: 2px; white-space: nowrap;">
                            ${escapeHtml(emp.shift_name)}
                        </div>
                        <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px;">
                            ${attendanceBadgeHTML}
                            ${fpBadgeHTML}
                        </div>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

function filterCheckInEmployees(term) {
    const container = document.getElementById('checkin-cards-container');
    if (!container) return;
    const cleanTerm = (term || '').trim().toLowerCase();
    const activeEmployees = (employees || []).filter(emp => !emp.status || emp.status === 'active');
    const filtered = cleanTerm === ''
        ? activeEmployees
        : activeEmployees.filter(e => {
            const first = (e.first_name || '').toLowerCase();
            const last = (e.last_name || '').toLowerCase();
            const code = (e.employee_code || '').toLowerCase();
            const dept = (e.department_name || '').toLowerCase();
            return first.includes(cleanTerm) || last.includes(cleanTerm) || code.includes(cleanTerm) || dept.includes(cleanTerm);
        });
    container.innerHTML = filtered.length > 0
        ? renderCheckInCards(filtered)
        : '<p style="grid-column: 1 / -1; text-align: center; padding: 2rem; color: #9CA3AF;">No se encontraron empleados coincidentes</p>';
}

function getInitials(firstName, lastName) {
    return `${firstName?.charAt(0) || ''}${lastName?.charAt(0) || ''}`.toUpperCase();
}

async function selectEmployeeForCheckIn(employeeId) {
    selectedEmployeeId = employeeId;
    const employee = employees.find(e => e.id === employeeId);

    if (!employee) {
        showNotification('Empleado no encontrado', 'error');
        return;
    }

    if (employee.status && employee.status !== 'active') {
        showNotification(`El empleado ${employee.first_name} ${employee.last_name} no se encuentra activo`, 'warning');
        return;
    }

    // Verificar qué acciones puede realizar
    const [canCheckInResult, canCheckOutResult] = await Promise.all([
        window.attendance.canCheckIn(employeeId),
        window.attendance.canCheckOut(employeeId)
    ]);

    const modalAvatar = employee.photo_url
        ? `<img src="${escapeHtml(employee.photo_url)}" alt="Foto" style="width: 100px; height: 100px; border-radius: 50%; object-fit: cover; border: 3px solid #94A3B8; margin: 0 auto 15px; display: block; box-shadow: 0 4px 10px rgba(0,0,0,0.08);">`
        : `<div style="width: 100px; height: 100px; border-radius: 50%; background: #334155; border: 3px solid #CBD5E1; display: flex; align-items: center; justify-content: center; color: #F8FAFC; font-size: 38px; font-weight: 600; margin: 0 auto 15px; box-shadow: 0 4px 10px rgba(0,0,0,0.08);">
               ${getInitials(employee.first_name, employee.last_name)}
           </div>`;

    const modalContent = `
        <div class="modal active" onclick="if(event.target === this) closeModal()">
            <div class="modal-content">
                <div class="modal-header">
                    <h3>Registrar Asistencia</h3>
                    <button class="close-btn" onclick="closeModal()">&times;</button>
                </div>
                <div class="modal-body">
                    <div style="text-align: center; margin-bottom: 20px;">
                        ${modalAvatar}
                        <h3 style="margin: 0 0 5px; color: #1F2937;">${escapeHtml(employee.first_name)} ${escapeHtml(employee.last_name)}</h3>
                        <p style="color: #6B7280; margin: 0; font-weight: 600;">Nómina: ${escapeHtml(employee.employee_code)}</p>
                        <p style="color: #6B7280; margin: 5px 0 0; font-size: 13px;">${escapeHtml(employee.department_name)} &bull; ${escapeHtml(employee.shift_name)}</p>
                    </div>

                    <div id="checkin-modal-biometric-feedback" style="display: none; margin-bottom: 14px; padding: 12px 14px; border-radius: 8px; text-align: center; font-size: 13px; font-weight: 600;"></div>

                    <div style="display: flex; flex-direction: column; gap: 10px;">
                        ${canCheckInResult.can ? `
                            <button class="btn btn-success" onclick="performCheckIn()" style="width: 100%; padding: 15px; font-size: 16px; font-weight: 600; border-radius: 8px;">
                                ✓ Marcar Entrada
                            </button>
                        ` : `
                            <div style="padding: 12px; background: #FEF2F2; border: 1px solid #FECACA; border-radius: 8px; color: #991B1B; font-size: 14px;">
                                ⚠️ ${canCheckInResult.reason}
                            </div>
                        `}

                        ${canCheckOutResult.can ? `
                            <button class="btn btn-warning" onclick="performCheckOut()" style="width: 100%; padding: 15px; font-size: 16px; font-weight: 600; border-radius: 8px;">
                                ✓ Marcar Salida
                            </button>
                        ` : canCheckOutResult.reason ? `
                            <div style="padding: 12px; background: #FFFBEB; border: 1px solid #FDE68A; border-radius: 8px; color: #92400E; font-size: 14px;">
                                ℹ️ ${canCheckOutResult.reason}
                            </div>
                        ` : ''}
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-cancel" onclick="closeModal()">Cancelar</button>
                </div>
            </div>
        </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalContent);
}

// ==================== ATTENDANCE COOLDOWN (ANTI-DOUBLE CHECK-IN) ====================
const attendanceCooldownMap = new Map();

function checkAttendanceCooldown(employeeId) {
    const settings = loadSavedSettings();
    const cooldownSec = safeParseInt(settings.cooldownSeconds, 0);
    if (cooldownSec <= 0) return { allowed: true };
    const last = attendanceCooldownMap.get(employeeId);
    if (!last) return { allowed: true };
    const elapsedSec = (Date.now() - last) / 1000;
    if (elapsedSec < cooldownSec) {
        const remaining = Math.ceil(cooldownSec - elapsedSec);
        return { allowed: false, remaining };
    }
    return { allowed: true };
}

function recordAttendanceCooldown(employeeId) {
    if (employeeId) {
        attendanceCooldownMap.set(employeeId, Date.now());
    }
}

async function performCheckIn() {
    if (!selectedEmployeeId) return;

    const cd = checkAttendanceCooldown(selectedEmployeeId);
    if (!cd.allowed) {
        playNotificationSound('error');
        showNotification(`Marcación muy reciente: espere ${cd.remaining}s antes de registrar nuevamente`, 'warning');
        return;
    }

    const actionBtns = document.querySelectorAll('.modal.active button');
    actionBtns.forEach(btn => btn.disabled = true);
    const feedbackEl = document.getElementById('checkin-modal-biometric-feedback');

    try {
        // Intentar identificación biométrica si el servicio no fue detenido manualmente
        const biometricAvailable = touchModeState.stopReason === 'SERVICE_STOPPED_MANUALLY'
            ? false
            : await window.biometric.isServerAvailable();

        let fingerprintVerified = false;

        if (biometricAvailable) {
            if (feedbackEl) {
                feedbackEl.style.display = 'block';
                feedbackEl.style.background = '#EFF6FF';
                feedbackEl.style.border = '1px solid #93C5FD';
                feedbackEl.style.color = '#1D4ED8';
                feedbackEl.innerHTML = '👆 Coloque su dedo en el lector biométrico para verificar identidad...';
            }
            showNotification('Coloque el dedo en el lector...', 'info');

            const verifyResult = await window.biometric.verifyFingerprint(selectedEmployeeId);

            if (verifyResult.verified) {
                fingerprintVerified = true;
                if (feedbackEl) {
                    feedbackEl.style.background = '#ECFDF5';
                    feedbackEl.style.border = '1px solid #6EE7B7';
                    feedbackEl.style.color = '#065F46';
                    feedbackEl.innerHTML = '✓ Huella verificada correctamente';
                }
                showNotification('Huella verificada ✓', 'success');
            } else {
                const reasonMsg = verifyResult.message || 'Huella no verificada';
                if (feedbackEl) {
                    feedbackEl.style.background = '#FEF2F2';
                    feedbackEl.style.border = '1px solid #FCA5A5';
                    feedbackEl.style.color = '#991B1B';
                    feedbackEl.innerHTML = `⚠️ ${escapeHtml(reasonMsg)}`;
                }
                showNotification(`Advertencia: ${reasonMsg}`, 'warning');
            }
        }

        const settings = loadSavedSettings();
        if (settings.requireBiometric && !fingerprintVerified) {
            playNotificationSound('error');
            showNotification('Acceso denegado: La política del sistema exige verificación biométrica obligatoria.', 'error');
            actionBtns.forEach(btn => btn.disabled = false);
            return;
        }

        // Marcar entrada
        const result = await window.attendance.checkIn(selectedEmployeeId, fingerprintVerified);

        if (result.success) {
            recordAttendanceCooldown(selectedEmployeeId);
            playNotificationSound('check-in');
            showNotification(result.message, 'success');
            closeModal();
            await loadInitialData();
            if (currentSection === 'dashboard') {
                loadDashboard();
            } else if (currentSection === 'check-in') {
                loadCheckInSection();
            } else if (currentSection === 'attendance' || currentSection === 'records') {
                loadAttendanceSection();
            }
        } else {
            playNotificationSound('error');
            showNotification(result.message, 'error');
            actionBtns.forEach(btn => btn.disabled = false);
        }
    } catch (error) {
        logger.error('Error en check-in:', error);
        playNotificationSound('error');
        showNotification('Error al registrar entrada', 'error');
        actionBtns.forEach(btn => btn.disabled = false);
    }
}

async function performCheckOut() {
    if (!selectedEmployeeId) return;

    const cd = checkAttendanceCooldown(selectedEmployeeId);
    if (!cd.allowed) {
        playNotificationSound('error');
        showNotification(`Marcación muy reciente: espere ${cd.remaining}s antes de registrar nuevamente`, 'warning');
        return;
    }

    const actionBtns = document.querySelectorAll('.modal.active button');
    actionBtns.forEach(btn => btn.disabled = true);

    try {
        const result = await window.attendance.checkOut(selectedEmployeeId);

        if (result.success) {
            recordAttendanceCooldown(selectedEmployeeId);
            playNotificationSound('check-out');
            showNotification(result.message, 'success');
            closeModal();
            await loadInitialData();
            if (currentSection === 'dashboard') {
                loadDashboard();
            } else if (currentSection === 'check-in') {
                loadCheckInSection();
            } else if (currentSection === 'attendance' || currentSection === 'records') {
                loadAttendanceSection();
            }
        } else {
            playNotificationSound('error');
            showNotification(result.message, 'error');
            actionBtns.forEach(btn => btn.disabled = false);
        }
    } catch (error) {
        logger.error('Error en check-out:', error);
        playNotificationSound('error');
        showNotification('Error al registrar salida', 'error');
        actionBtns.forEach(btn => btn.disabled = false);
    }
}

function closeModal() {
    if (window.FingerprintEnroller?.isEnrolling) {
        window.FingerprintEnroller.disconnect();
    }
    document.querySelectorAll('.modal').forEach(modal => modal.remove());
    selectedEmployeeId = null;
}

// ==================== REUSABLE UI COMPONENT FACTORIES (DRY) ====================

function createModalShell({ title, bodyHTML, footerHTML = '', maxWidth = '700px' }) {
    return `
        <div class="modal active" onclick="if(event.target === this) closeModal()">
            <div class="modal-content" style="max-width: ${maxWidth};">
                <div class="modal-header">
                    <h3>${title}</h3>
                    <button class="close-btn" onclick="closeModal()">&times;</button>
                </div>
                <div class="modal-body">
                    ${bodyHTML}
                </div>
                ${footerHTML ? `<div class="modal-footer">${footerHTML}</div>` : ''}
            </div>
        </div>
    `;
}

function openModalShell(options) {
    const modalHTML = typeof options === 'string' ? options : createModalShell(options || {});
    document.body.insertAdjacentHTML('beforeend', modalHTML);
}

function renderDepartmentForm(dept = null) {
    const isEdit = !!dept;
    const prefix = isEdit ? 'edit-dept-' : 'dept-';
    const formId = isEdit ? 'edit-department-form' : 'add-department-form';
    const submitAction = isEdit ? `updateDepartment(${dept.id})` : 'saveDepartment()';
    const nameVal = dept ? escapeHtml(dept.name) : '';
    const descVal = dept && dept.description ? escapeHtml(dept.description) : '';
    const mgrVal = dept ? dept.manager_id : null;

    return `
        <form id="${formId}" onsubmit="event.preventDefault(); ${submitAction};">
            <div class="form-group">
                <label>Nombre del Departamento *</label>
                <input type="text" id="${prefix}name" class="form-control" value="${nameVal}" required>
            </div>
            <div class="form-group">
                <label>Descripción</label>
                <textarea id="${prefix}description" class="form-control" rows="3" placeholder="Descripción opcional del departamento">${descVal}</textarea>
            </div>
            <div class="form-group">
                <label>Responsable / Gerente (Opcional)</label>
                <select id="${prefix}manager" class="form-control">
                    <option value="">Sin asignar</option>
                    ${employees.map(emp => `<option value="${emp.id}" ${mgrVal === emp.id ? 'selected' : ''}>${escapeHtml(emp.first_name)} ${escapeHtml(emp.last_name)} (${escapeHtml(emp.employee_code)})</option>`).join('')}
                </select>
            </div>
        </form>
    `;
}

function renderShiftForm(shift = null) {
    const isEdit = !!shift;
    const prefix = isEdit ? 'edit-shift-' : 'shift-';
    const formId = isEdit ? 'edit-shift-form' : 'add-shift-form';
    const submitAction = isEdit ? `updateShift(${shift.id})` : 'saveShift()';
    const nameVal = shift ? escapeHtml(shift.name) : '';
    const startVal = shift ? shift.start_time : '';
    const endVal = shift ? shift.end_time : '';
    const tolVal = shift ? shift.tolerance_minutes : 10;
    const colorVal = shift ? (shift.color || '#334155') : '#334155';

    return `
        <form id="${formId}" onsubmit="event.preventDefault(); ${submitAction};">
            <div class="form-group">
                <label>Nombre del Turno *</label>
                <input type="text" id="${prefix}name" class="form-control" required placeholder="Ej: Turno Matutino" value="${nameVal}">
            </div>
            <div class="form-group">
                <label>Hora de Inicio *</label>
                <input type="time" id="${prefix}start-time" class="form-control" required value="${startVal}">
            </div>
            <div class="form-group">
                <label>Hora de Fin *</label>
                <input type="time" id="${prefix}end-time" class="form-control" required value="${endVal}">
            </div>
            <div class="form-group">
                <label>Tolerancia (minutos) *</label>
                <input type="number" id="${prefix}tolerance" class="form-control" min="0" max="60" value="${tolVal}" required>
                <small style="color: #6B7280;">Tiempo de gracia para llegadas tarde sin penalización</small>
            </div>
            <div class="form-group">
                <label>Color del Turno</label>
                <input type="color" id="${prefix}color" class="form-control" value="${colorVal}" style="height: 50px;">
            </div>
        </form>
    `;
}

function renderEmployeeForm(employee = null) {
    const isEdit = !!employee;
    const prefix = isEdit ? 'edit-emp-' : 'emp-';
    const formId = isEdit ? 'edit-employee-form' : 'add-employee-form';
    const submitAction = isEdit ? `updateEmployee(${employee.id})` : 'saveNewEmployee()';
    const photoUrl = employee ? escapeHtml(employee.photo_url || '') : '';
    const hasPhoto = Boolean(employee && employee.photo_url);

    return `
        <form id="${formId}" onsubmit="event.preventDefault(); ${submitAction};">
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                <!-- Fotografía del Empleado (Cámara / Archivo) -->
                <div class="form-group" style="grid-column: 1 / -1; background: #F9FAFB; padding: 12px; border-radius: 8px; border: 1px dashed #D1D5DB;">
                    <label style="font-weight: 600; margin-bottom: 8px; display: block; font-size: 13px;">Fotografía del Empleado (Cámara Web / Archivo)</label>
                    <div style="display: flex; align-items: center; gap: 15px; flex-wrap: wrap;">
                        <div id="${prefix}photo-preview-container" style="width: 64px; height: 64px; border-radius: 50%; overflow: hidden; background: #E5E7EB; border: 2px solid #9CA3AF; display: flex; align-items: center; justify-content: center;">
                            <img id="${prefix}photo-preview" src="${photoUrl}" style="width: 100%; height: 100%; object-fit: cover; ${hasPhoto ? '' : 'display: none;'}" alt="Vista previa">
                            <span id="${prefix}photo-placeholder" style="font-size: 26px; ${hasPhoto ? 'display: none;' : ''}">👤</span>
                        </div>
                        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                            <button type="button" class="btn" style="background: #1E293B; color: white; padding: 6px 12px; font-size: 12px;" onclick="openCameraModal('${prefix}photo-data', '${prefix}photo-preview', '${prefix}photo-placeholder', '${prefix}photo-clear-btn')">
                                📷 Tomar Foto
                            </button>
                            <label class="btn" style="background: #475569; color: white; padding: 6px 12px; font-size: 12px; cursor: pointer; margin: 0; display: inline-flex; align-items: center;">
                                📁 Subir Archivo
                                <input type="file" accept="image/*" style="display: none;" onchange="handlePhotoFileUpload(event, '${prefix}photo-data', '${prefix}photo-preview', '${prefix}photo-placeholder', '${prefix}photo-clear-btn')">
                            </label>
                            <button type="button" id="${prefix}photo-clear-btn" class="btn" style="background: #EF4444; color: white; padding: 6px 12px; font-size: 12px; ${hasPhoto ? '' : 'display: none;'}" onclick="clearEmployeePhoto('${prefix}photo-data', '${prefix}photo-preview', '${prefix}photo-placeholder', '${prefix}photo-clear-btn')">
                                🗑️ Quitar
                            </button>
                        </div>
                    </div>
                    <input type="hidden" id="${prefix}photo-data" value="${photoUrl}">
                </div>

                <div class="form-group">
                    <label>Código de Empleado *</label>
                    <input type="text" id="${prefix}code" class="form-control" value="${employee ? escapeHtml(employee.employee_code) : ''}" required>
                </div>
                <div class="form-group">
                    <label>Fecha de Contratación *</label>
                    <input type="date" id="${prefix}hire-date" class="form-control" value="${employee ? escapeHtml(employee.hire_date) : ''}" required>
                </div>
                <div class="form-group">
                    <label>Nombre(s) *</label>
                    <input type="text" id="${prefix}firstname" class="form-control" value="${employee ? escapeHtml(employee.first_name) : ''}" required>
                </div>
                <div class="form-group">
                    <label>Apellido(s) *</label>
                    <input type="text" id="${prefix}lastname" class="form-control" value="${employee ? escapeHtml(employee.last_name) : ''}" required>
                </div>
                <div class="form-group">
                    <label>Email *</label>
                    <input type="email" id="${prefix}email" class="form-control" value="${employee ? escapeHtml(employee.email) : ''}" required>
                </div>
                <div class="form-group">
                    <label>Teléfono</label>
                    <input type="tel" id="${prefix}phone" class="form-control" value="${employee && employee.phone ? escapeHtml(employee.phone) : ''}">
                </div>
                <div class="form-group">
                    <label>Departamento *</label>
                    <select id="${prefix}department" class="form-control" required>
                        <option value="">Seleccione...</option>
                        ${departments.map(dept => `<option value="${dept.id}" ${employee && dept.id === employee.department_id ? 'selected' : ''}>${escapeHtml(dept.name)}</option>`).join('')}
                    </select>
                </div>
                <div class="form-group">
                    <label>Turno *</label>
                    <select id="${prefix}shift" class="form-control" required>
                        <option value="">Seleccione...</option>
                        ${shifts.map(shift => `<option value="${shift.id}" ${employee && shift.id === employee.shift_id ? 'selected' : ''}>${escapeHtml(shift.name)}</option>`).join('')}
                    </select>
                </div>
                <div class="form-group">
                    <label>Puesto *</label>
                    <input type="text" id="${prefix}position" class="form-control" value="${employee ? escapeHtml(employee.position) : ''}" required>
                </div>
                ${isEdit ? `
                <div class="form-group">
                    <label>Estado *</label>
                    <select id="edit-emp-status" class="form-control" required>
                        <option value="active" ${employee.status === 'active' ? 'selected' : ''}>Activo</option>
                        <option value="inactive" ${employee.status === 'inactive' ? 'selected' : ''}>Inactivo</option>
                        <option value="suspended" ${employee.status === 'suspended' ? 'selected' : ''}>Suspendido</option>
                    </select>
                </div>
                ` : ''}
                <div class="form-group" style="${isEdit ? 'grid-column: 1 / -1;' : ''}">
                    <label>Modo de Captura de Huella</label>
                    <select id="${prefix}enrollment-mode" class="form-control">
                        <option value="simple" ${!employee || employee.enrollment_mode === 'simple' ? 'selected' : ''}>Simple (1 huella recomendada)</option>
                        <option value="advanced" ${employee && employee.enrollment_mode === 'advanced' ? 'selected' : ''}>Avanzado (10 huellas)</option>
                    </select>
                </div>
            </div>
        </form>
    `;
}

function renderReportModalShell({ title, accentColor = '#334155', bannerContentHTML, bodyContentHTML, maxWidth = '900px', onExcel = null }) {
    const excelBtnHTML = onExcel ? `
        <button class="btn btn-success" onclick="${onExcel}" style="background: #10B981; color: white;" title="Exportar reporte a Microsoft Excel (.csv)">📊 Exportar Excel (.csv)</button>
    ` : '';
    return createModalShell({
        title,
        maxWidth,
        bodyHTML: `
            <div class="banner-gradient" style="background: #F8FAFC; color: #0F172A; border: 1px solid #CBD5E1; border-left: 4px solid ${accentColor}; padding: 20px; border-radius: 10px; margin-bottom: 20px;">
                ${bannerContentHTML}
            </div>
            ${bodyContentHTML}
        `,
        footerHTML: `
            ${excelBtnHTML}
            <button class="btn btn-cancel" onclick="closeModal()">Cerrar</button>
            <button class="btn btn-primary" onclick="printReport()">🖨️ Imprimir</button>
        `
    });
}

// ==================== DRY UI & PIPELINE HELPERS ====================

/**
 * Helper para renderizar botones de exportación (Excel, PDF, Imprimir).
 */
function renderExportButtonsHTML({
    onExcel = 'exportQAToExcel()',
    onPDF = 'exportQAToPDF()',
    onPrint = null,
    isSmall = false
} = {}) {
    const pad = isSmall ? '6px 12px' : '8px 14px';
    const fsize = isSmall ? '12px' : '13px';
    const gap = isSmall ? '4px' : '6px';
    const printBtn = onPrint ? `
        <button class="btn btn-secondary" onclick="${onPrint}" style="padding: ${pad}; font-size: ${fsize}; display: inline-flex; align-items: center; gap: ${gap};" title="Imprimir directamente">
            <span>🖨️</span> Imprimir
        </button>
    ` : '';

    return `
        ${printBtn}
        <button class="btn btn-success" onclick="${onExcel}" style="padding: ${pad}; font-size: ${fsize}; background: #10B981; color: white; display: inline-flex; align-items: center; gap: ${gap};" title="Guardar en Microsoft Excel (.csv)">
            <span>📊</span> Guardar en Excel
        </button>
        <button class="btn btn-danger" onclick="${onPDF}" style="padding: ${pad}; font-size: ${fsize}; background: #DC2626; color: white; display: inline-flex; align-items: center; gap: ${gap};" title="Guardar como documento PDF">
            <span>📄</span> Guardar en PDF
        </button>
    `;
}

/**
 * Pipeline estandarizado para confirmación y eliminación de entidades con manejo de bloqueos, feedback y recarga.
 */
async function confirmAndDeleteEntity({
    entity,
    entityName,
    confirmMessage,
    blockReason,
    deleteFn,
    onSuccess,
    successMessage = `${entityName} eliminado exitosamente`
}) {
    if (!entity) {
        showNotification(`${entityName} no encontrado`, 'error');
        return;
    }

    if (blockReason) {
        showNotification(blockReason, 'warning');
        return;
    }

    const message = typeof confirmMessage === 'function' ? confirmMessage(entity) : confirmMessage;
    if (!confirm(message)) {
        return;
    }

    try {
        const result = await deleteFn();
        const isSuccess = typeof result === 'object' && result !== null ? Boolean(result.success) : Boolean(result);

        if (isSuccess) {
            showNotification(successMessage, 'success');
            if (typeof onSuccess === 'function') {
                await onSuccess();
            }
        } else {
            const errDetail = typeof result === 'object' && result?.message ? result.message : `Error al eliminar ${entityName.toLowerCase()}`;
            showNotification(errDetail, 'error');
        }
    } catch (error) {
        logger.error(`Error eliminando ${entityName.toLowerCase()}:`, error);
        showNotification(error?.message || `Error al eliminar ${entityName.toLowerCase()}`, 'error');
    }
}

/**
 * Ejecutor asíncrono para formularios con control automático de estado del botón de envío (loading/disable).
 */
async function withSubmitState(optionsOrAction, maybeAction) {
    let submitBtn;
    let loadingText = 'Guardando...';
    let actionFn;

    if (typeof optionsOrAction === 'function') {
        submitBtn = document.querySelector('.modal.active .btn-primary');
        actionFn = optionsOrAction;
    } else {
        const btn = optionsOrAction?.btn || optionsOrAction?.btnSelector || '.modal.active .btn-primary';
        submitBtn = typeof btn === 'string' ? document.querySelector(btn) : btn;
        loadingText = optionsOrAction?.loadingText || 'Guardando...';
        actionFn = optionsOrAction?.actionFn || maybeAction;
    }

    const originalText = submitBtn ? submitBtn.textContent : '';
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = loadingText;
    }

    try {
        return await actionFn(submitBtn);
    } finally {
        if (submitBtn && submitBtn.isConnected) {
            submitBtn.disabled = false;
            submitBtn.textContent = originalText;
        }
    }
}

// ==================== EMPLOYEES SECTION ====================
async function loadEmployeesSection() {
    const container = document.getElementById('employees-table-container');
    if (!container) return;

    // Recargar empleados
    employees = await window.attendance.getEmployees({});

    container.innerHTML = `
        <div style="margin-bottom: 16px; display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px;">
            <div style="flex: 1 1 240px; max-width: 380px;">
                <input type="text" id="employee-search" placeholder="🔍 Buscar empleado por nómina, nombre..."
                       style="padding: 10px 14px; border: 1px solid #E5E7EB; border-radius: 8px; width: 100%; box-sizing: border-box; font-size: 14px;"
                       onkeyup="filterEmployees(this.value)">
            </div>
            <button class="btn btn-primary" onclick="showAddEmployeeModal()" style="white-space: nowrap;">
                + Agregar Empleado
            </button>
        </div>

        <div class="table-container">
            <table class="data-table">
                <thead>
                    <tr>
                        <th class="td-nowrap" style="width: 1%;">Código</th>
                        <th>Nombre</th>
                        <th>Email</th>
                        <th>Departamento</th>
                        <th class="td-nowrap">Turno</th>
                        <th class="td-center-nowrap" style="width: 1%;">Huellas</th>
                        <th class="td-center-nowrap" style="width: 1%; min-width: 110px;">Modo</th>
                        <th class="td-center-nowrap" style="width: 1%;">Estado</th>
                        <th class="td-center-nowrap" style="width: 1%;">Acciones</th>
                    </tr>
                </thead>
                <tbody id="employees-table-body">
                    ${employees.map(renderEmployeeRow).join('')}
                </tbody>
            </table>
        </div>
    `;
}

function renderEmployeeRow(emp) {
    const enrollmentMode = emp.enrollment_mode || 'N/A';
    const enrollmentText = enrollmentMode === 'simple' ? 'Simple (1)' :
                         enrollmentMode === 'advanced' ? 'Avanzado (10)' :
                         'Sin definir';
    const enrollmentColor = enrollmentMode === 'simple' ? '#3B82F6' :
                          enrollmentMode === 'advanced' ? '#8B5CF6' :
                          '#9CA3AF';
    const statusClass = emp.status === 'active' ? 'success' : emp.status === 'suspended' ? 'warning' : 'danger';
    const statusText = emp.status === 'active' ? 'Activo' : emp.status === 'suspended' ? 'Suspendido' : 'Inactivo';

    const avatarHtml = emp.photo_url
        ? `<img src="${escapeHtml(emp.photo_url)}" alt="Foto" style="width: 28px; height: 28px; border-radius: 50%; object-fit: cover; border: 1px solid #D1D5DB; vertical-align: middle; flex-shrink: 0;">`
        : `<div style="width: 28px; height: 28px; border-radius: 50%; background: #E5E7EB; display: inline-flex; align-items: center; justify-content: center; font-size: 13px; vertical-align: middle; flex-shrink: 0;">👤</div>`;

    return `
    <tr>
        <td class="td-nowrap"><strong>${escapeHtml(emp.employee_code || '')}</strong></td>
        <td>
            <div style="display: flex; align-items: center; gap: 8px; white-space: nowrap;">
                ${avatarHtml}
                <span style="font-weight: 500;">${escapeHtml((emp.first_name || '') + ' ' + (emp.last_name || ''))}</span>
            </div>
        </td>
        <td>${escapeHtml(emp.email || '')}</td>
        <td>${escapeHtml(emp.department_name || '')}</td>
        <td class="td-nowrap">${escapeHtml(emp.shift_name || '')}</td>
        <td class="td-center-nowrap">${emp.fingerprints_count || 0}/10</td>
        <td class="td-center-nowrap">
            <span class="badge badge-mode" style="background: ${enrollmentColor}; color: white; padding: 4px 10px; border-radius: 9999px; font-size: 11px; font-weight: 600; white-space: nowrap; display: inline-flex; align-items: center; justify-content: center; line-height: 1.2; box-shadow: 0 1px 2px rgba(0,0,0,0.06);">
                ${enrollmentText}
            </span>
        </td>
        <td class="td-center-nowrap"><span class="badge badge-${statusClass}">${escapeHtml(statusText)}</span></td>
        <td class="td-center-nowrap">
            <div class="table-actions" style="display: inline-flex; align-items: center; justify-content: center; gap: 5px; white-space: nowrap;">
                <button class="btn" onclick="showEmployeeDetails(${emp.id})" style="padding: 5px 10px; font-size: 12px; background: #3B82F6; color: white; display: inline-flex; align-items: center; justify-content: center;" title="Ver detalles">👁️</button>
                <button class="btn" onclick="showEditEmployeeModal(${emp.id})" style="padding: 5px 10px; font-size: 12px; background: #10B981; color: white; display: inline-flex; align-items: center; justify-content: center;" title="Editar">✏️</button>
                <button class="btn" onclick="showEnrollFingerprintModal(${emp.id})" style="padding: 5px 10px; font-size: 12px; background: #8B5CF6; color: white; display: inline-flex; align-items: center; justify-content: center;" title="Registrar huella">👆</button>
                <button class="btn" onclick="deleteEmployee(${emp.id})" style="padding: 5px 10px; font-size: 12px; background: #EF4444; color: white; display: inline-flex; align-items: center; justify-content: center;" title="Eliminar">🗑️</button>
            </div>
        </td>
    </tr>
    `;
}

function filterEmployees(searchText) {
    const tbody = document.getElementById('employees-table-body');
    if (!tbody) return;

    const term = (searchText || '').trim().toLowerCase();
    const filtered = term === ''
        ? employees
        : employees.filter(emp => {
            const first = (emp.first_name || '').toLowerCase();
            const last = (emp.last_name || '').toLowerCase();
            const code = (emp.employee_code || '').toLowerCase();
            const email = (emp.email || '').toLowerCase();
            return first.includes(term) || last.includes(term) || code.includes(term) || email.includes(term);
        });

    tbody.innerHTML = filtered.map(renderEmployeeRow).join('');
}

// ============================================================================
// GESTIÓN DE FOTOGRAFÍA CON CÁMARA WEB / ARCHIVO
// ============================================================================
let activeCameraStream = null;

function openCameraModal(targetDataId, previewImgId, placeholderId, clearBtnId) {
    closeCameraModal();

    const cameraModalHTML = `
        <div id="camera-capture-modal" class="modal active" style="z-index: 10000; background: rgba(0,0,0,0.75);">
            <div class="modal-content" style="max-width: 440px; text-align: center; border-radius: 12px; overflow: hidden; padding: 0;">
                <div class="modal-header" style="background: #1F2937; color: white; padding: 12px 20px;">
                    <h3 style="margin: 0; font-size: 16px; display: flex; align-items: center; justify-content: center; gap: 8px;">
                        <span>📷</span> Capturar Fotografía de Empleado
                    </h3>
                    <button class="close-btn" style="color: white;" onclick="closeCameraModal()">&times;</button>
                </div>
                <div class="modal-body" style="padding: 20px; background: #111827;">
                    <div style="position: relative; width: 300px; height: 300px; margin: 0 auto; background: #000; border-radius: 16px; overflow: hidden; border: 2px solid #374151;">
                        <video id="camera-stream-video" autoplay playsinline style="width: 100%; height: 100%; object-fit: cover;"></video>
                        <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 190px; height: 230px; border: 2px dashed rgba(59, 130, 246, 0.85); border-radius: 50%; pointer-events: none; box-shadow: 0 0 0 9999px rgba(0,0,0,0.25);"></div>
                        <div id="camera-loading-msg" style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: #9CA3AF; font-size: 13px;">
                            Iniciando cámara web...
                        </div>
                    </div>
                    <div id="camera-error-msg" style="color: #F87171; margin-top: 12px; font-size: 13px; display: none;"></div>
                </div>
                <div class="modal-footer" style="padding: 15px; background: #1F2937; display: flex; justify-content: center; gap: 12px;">
                    <button type="button" class="btn" style="background: #4B5563; color: white;" onclick="closeCameraModal()">Cancelar</button>
                    <button type="button" id="btn-take-snapshot" class="btn btn-primary" style="background: #10B981; border: none; font-weight: 600;" onclick="takePhotoSnapshot('${targetDataId}', '${previewImgId}', '${placeholderId}', '${clearBtnId}')" disabled>
                        📸 Capturar Foto
                    </button>
                </div>
            </div>
        </div>
    `;

    document.body.insertAdjacentHTML('beforeend', cameraModalHTML);

    const videoEl = document.getElementById('camera-stream-video');
    const loadMsg = document.getElementById('camera-loading-msg');
    const errMsg = document.getElementById('camera-error-msg');
    const snapBtn = document.getElementById('btn-take-snapshot');

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        if (loadMsg) loadMsg.style.display = 'none';
        if (errMsg) {
            errMsg.textContent = 'Este entorno no soporta captura de cámara web.';
            errMsg.style.display = 'block';
        }
        return;
    }

    navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false
    })
    .then(stream => {
        activeCameraStream = stream;
        if (videoEl) {
            videoEl.srcObject = stream;
            videoEl.onloadedmetadata = () => {
                videoEl.play();
                if (loadMsg) loadMsg.style.display = 'none';
                if (snapBtn) snapBtn.disabled = false;
            };
        }
    })
    .catch(err => {
        logger.error('[Camera] Error accediendo a cámara:', err);
        if (loadMsg) loadMsg.style.display = 'none';
        if (errMsg) {
            errMsg.textContent = 'No se pudo acceder a la cámara web. Verifique permisos o conexión.';
            errMsg.style.display = 'block';
        }
    });
}

function takePhotoSnapshot(targetDataId, previewImgId, placeholderId, clearBtnId) {
    const videoEl = document.getElementById('camera-stream-video');
    if (!videoEl || !activeCameraStream) return;

    try {
        const canvas = document.createElement('canvas');
        canvas.width = 300;
        canvas.height = 300;
        const ctx = canvas.getContext('2d');

        const vWidth = videoEl.videoWidth || 300;
        const vHeight = videoEl.videoHeight || 300;
        const size = Math.min(vWidth, vHeight);
        const startX = (vWidth - size) / 2;
        const startY = (vHeight - size) / 2;

        ctx.drawImage(videoEl, startX, startY, size, size, 0, 0, 300, 300);

        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);

        const targetInput = document.getElementById(targetDataId);
        if (targetInput) targetInput.value = dataUrl;

        const previewImg = document.getElementById(previewImgId);
        const placeholder = document.getElementById(placeholderId);
        const clearBtn = document.getElementById(clearBtnId);

        if (previewImg) {
            previewImg.src = dataUrl;
            previewImg.style.display = 'block';
        }
        if (placeholder) placeholder.style.display = 'none';
        if (clearBtn) clearBtn.style.display = 'inline-block';

        showNotification('Fotografía capturada con éxito', 'success');
    } catch (e) {
        logger.error('[Camera] Error al capturar snapshot:', e);
        showNotification('Error procesando la fotografía', 'error');
    } finally {
        closeCameraModal();
    }
}

function closeCameraModal() {
    if (activeCameraStream) {
        try {
            activeCameraStream.getTracks().forEach(track => track.stop());
        } catch (_) {}
        activeCameraStream = null;
    }
    const modal = document.getElementById('camera-capture-modal');
    if (modal) modal.remove();
}

function handlePhotoFileUpload(event, targetDataId, previewImgId, placeholderId, clearBtnId) {
    const file = event.target?.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
        showNotification('Debe seleccionar un archivo de imagen válido', 'warning');
        return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = 300;
            canvas.height = 300;
            const ctx = canvas.getContext('2d');
            const size = Math.min(img.width, img.height);
            const startX = (img.width - size) / 2;
            const startY = (img.height - size) / 2;
            ctx.drawImage(img, startX, startY, size, size, 0, 0, 300, 300);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.85);

            const targetInput = document.getElementById(targetDataId);
            if (targetInput) targetInput.value = dataUrl;

            const previewImg = document.getElementById(previewImgId);
            const placeholder = document.getElementById(placeholderId);
            const clearBtn = document.getElementById(clearBtnId);

            if (previewImg) {
                previewImg.src = dataUrl;
                previewImg.style.display = 'block';
            }
            if (placeholder) placeholder.style.display = 'none';
            if (clearBtn) clearBtn.style.display = 'inline-block';

            showNotification('Imagen cargada correctamente', 'success');
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

function clearEmployeePhoto(targetDataId, previewImgId, placeholderId, clearBtnId) {
    const targetInput = document.getElementById(targetDataId);
    if (targetInput) targetInput.value = '';

    const previewImg = document.getElementById(previewImgId);
    const placeholder = document.getElementById(placeholderId);
    const clearBtn = document.getElementById(clearBtnId);

    if (previewImg) {
        previewImg.src = '';
        previewImg.style.display = 'none';
    }
    if (placeholder) placeholder.style.display = 'flex';
    if (clearBtn) clearBtn.style.display = 'none';
}

// Mostrar modal para agregar empleado
function showAddEmployeeModal() {
    openModalShell({
        title: 'Agregar Nuevo Empleado',
        maxWidth: '700px',
        bodyHTML: renderEmployeeForm(null),
        footerHTML: `
            <button class="btn btn-cancel" onclick="closeModal()">Cancelar</button>
            <button class="btn btn-primary" onclick="saveNewEmployee()">Guardar Empleado</button>
        `
    });

    // Establecer fecha de hoy por defecto
    const hireDateInput = document.getElementById('emp-hire-date');
    if (hireDateInput && !hireDateInput.value) {
        hireDateInput.valueAsDate = new Date();
    }
}

// Guardar nuevo empleado
async function saveNewEmployee() {
    const form = document.getElementById('add-employee-form');
    if (form && !form.reportValidity()) {
        return;
    }

    // Validar que todos los campos requeridos están llenos
    const requiredFields = [
        { id: 'emp-code', name: 'Código de empleado' },
        { id: 'emp-firstname', name: 'Nombre' },
        { id: 'emp-lastname', name: 'Apellido' },
        { id: 'emp-email', name: 'Correo electrónico' },
        { id: 'emp-department', name: 'Departamento' },
        { id: 'emp-shift', name: 'Turno' },
        { id: 'emp-position', name: 'Puesto' },
        { id: 'emp-hire-date', name: 'Fecha de contratación' }
    ];

    for (const field of requiredFields) {
        const value = document.getElementById(field.id).value;
        if (!value || value.trim() === '') {
            showNotification(`El campo "${field.name}" es requerido`, 'warning');
            document.getElementById(field.id).focus();
            return;
        }
    }

    // Validar formato de email
    const email = document.getElementById('emp-email').value;
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        showNotification('El formato del correo electrónico no es válido', 'warning');
        document.getElementById('emp-email').focus();
        return;
    }

    const deptId = safeParseInt(document.getElementById('emp-department').value, 0);
    const shiftId = safeParseInt(document.getElementById('emp-shift').value, 0);
    if (deptId <= 0) {
        showNotification('Debe seleccionar un departamento válido', 'warning');
        document.getElementById('emp-department').focus();
        return;
    }
    if (shiftId <= 0) {
        showNotification('Debe seleccionar un turno válido', 'warning');
        document.getElementById('emp-shift').focus();
        return;
    }

    const data = {
        employee_code: sanitizeText(document.getElementById('emp-code').value, 50),
        first_name: sanitizeText(document.getElementById('emp-firstname').value, 100),
        last_name: sanitizeText(document.getElementById('emp-lastname').value, 100),
        email: sanitizeEmail(email),
        phone: sanitizePhone(document.getElementById('emp-phone').value),
        department_id: deptId,
        shift_id: shiftId,
        position: sanitizeText(document.getElementById('emp-position').value, 100),
        hire_date: document.getElementById('emp-hire-date').value,
        status: 'active',
        photo_url: document.getElementById('emp-photo-data')?.value || null,
        enrollment_mode: document.getElementById('emp-enrollment-mode')?.value || 'simple'
    };

    await withSubmitState({ loadingText: 'Guardando...' }, async () => {
        try {
            const result = await window.attendance.createEmployee(data);

            if (result.success) {
                showNotification(result.message || 'Empleado creado exitosamente', 'success');
                closeModal();
                await loadInitialData();
                loadEmployeesSection();
            } else {
                showNotification(result.message || 'Error al crear empleado', 'error');
            }
        } catch (error) {
            logger.error('Error creando empleado:', error);
            showNotification(error.message || 'Error al crear empleado', 'error');
        }
    });
}

// Mostrar modal para editar empleado
function showEditEmployeeModal(employeeId) {
    const employee = employees.find(e => e.id === employeeId);
    if (!employee) {
        showNotification('Empleado no encontrado', 'error');
        return;
    }

    openModalShell({
        title: 'Editar Empleado',
        maxWidth: '700px',
        bodyHTML: renderEmployeeForm(employee),
        footerHTML: `
            <button class="btn btn-cancel" onclick="closeModal()">Cancelar</button>
            <button class="btn btn-primary" onclick="updateEmployee(${employeeId})">Actualizar Empleado</button>
        `
    });
}

// Actualizar empleado
async function updateEmployee(employeeId) {
    const form = document.getElementById('edit-employee-form');
    if (form && !form.reportValidity()) {
        return;
    }

    const requiredFields = [
        { id: 'edit-emp-code', name: 'Código de empleado' },
        { id: 'edit-emp-firstname', name: 'Nombre' },
        { id: 'edit-emp-lastname', name: 'Apellido' },
        { id: 'edit-emp-email', name: 'Correo electrónico' },
        { id: 'edit-emp-department', name: 'Departamento' },
        { id: 'edit-emp-shift', name: 'Turno' },
        { id: 'edit-emp-position', name: 'Puesto' },
        { id: 'edit-emp-hire-date', name: 'Fecha de contratación' },
        { id: 'edit-emp-status', name: 'Estado' }
    ];

    for (const field of requiredFields) {
        const value = document.getElementById(field.id).value;
        if (!value || value.trim() === '') {
            showNotification(`El campo "${field.name}" es requerido`, 'warning');
            document.getElementById(field.id).focus();
            return;
        }
    }

    const email = document.getElementById('edit-emp-email').value;
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        showNotification('El formato del correo electrónico no es válido', 'warning');
        document.getElementById('edit-emp-email').focus();
        return;
    }

    const submitBtn = document.querySelector('.modal.active .btn-primary');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Actualizando...';
    }

    const deptId = safeParseInt(document.getElementById('edit-emp-department').value, 0);
    const shiftId = safeParseInt(document.getElementById('edit-emp-shift').value, 0);
    if (deptId <= 0) {
        showNotification('Debe seleccionar un departamento válido', 'warning');
        document.getElementById('edit-emp-department').focus();
        return;
    }
    if (shiftId <= 0) {
        showNotification('Debe seleccionar un turno válido', 'warning');
        document.getElementById('edit-emp-shift').focus();
        return;
    }

    const data = {
        id: safeParseInt(employeeId, 0),
        employee_code: sanitizeText(document.getElementById('edit-emp-code').value, 50),
        first_name: sanitizeText(document.getElementById('edit-emp-firstname').value, 100),
        last_name: sanitizeText(document.getElementById('edit-emp-lastname').value, 100),
        email: sanitizeEmail(email),
        phone: sanitizePhone(document.getElementById('edit-emp-phone').value),
        department_id: deptId,
        shift_id: shiftId,
        position: sanitizeText(document.getElementById('edit-emp-position').value, 100),
        hire_date: document.getElementById('edit-emp-hire-date').value,
        status: document.getElementById('edit-emp-status').value,
        photo_url: document.getElementById('edit-emp-photo-data')?.value !== undefined ? (document.getElementById('edit-emp-photo-data').value || null) : undefined,
        enrollment_mode: document.getElementById('edit-emp-enrollment-mode')?.value || 'simple'
    };

    await withSubmitState({ loadingText: 'Actualizando...' }, async () => {
        try {
            const result = await window.attendance.updateEmployee(data);

            if (result.success) {
                showNotification(result.message || 'Empleado actualizado exitosamente', 'success');
                closeModal();
                await loadInitialData();
                loadEmployeesSection();
            } else {
                showNotification(result.message || 'Error al actualizar empleado', 'error');
            }
        } catch (error) {
            logger.error('Error actualizando empleado:', error);
            showNotification(error.message || 'Error al actualizar empleado', 'error');
        }
    });
}

// Eliminar empleado
async function deleteEmployee(employeeId) {
    const employee = employees.find(e => e.id === employeeId);
    await confirmAndDeleteEntity({
        entity: employee,
        entityName: 'Empleado',
        confirmMessage: (emp) =>
            `¿Está seguro de que desea eliminar al empleado?\n\n` +
            `${escapeHtml(emp.first_name)} ${escapeHtml(emp.last_name)} (${escapeHtml(emp.employee_code)})\n\n` +
            `Esta acción NO se puede deshacer. Se eliminarán también:\n` +
            `- Todos sus registros de asistencia\n` +
            `- Todas sus huellas registradas\n\n` +
            `¿Desea continuar?`,
        deleteFn: () => window.attendance.deleteEmployee(employeeId),
        onSuccess: async () => {
            await loadInitialData();
            loadEmployeesSection();
        }
    });
}

// Mostrar detalles de empleado
async function showEmployeeDetails(employeeId) {
    const employee = employees.find(e => e.id === employeeId);
    if (!employee) return;

    // Obtener huellas del empleado
    const fingerprints = await window.attendance.getEmployeeFingerprints(employeeId);

    const modalHTML = `
        <div class="modal active" onclick="if(event.target === this) closeModal()">
            <div class="modal-content" style="max-width: 600px;">
                <div class="modal-header">
                    <h3>Detalles del Empleado</h3>
                    <button class="close-btn" onclick="closeModal()">&times;</button>
                </div>
                <div class="modal-body">
                    <div style="text-align: center; margin-bottom: 30px;">
                        ${employee.photo_url 
                            ? `<img src="${escapeHtml(employee.photo_url)}" alt="Foto de ${escapeHtml(employee.first_name)}" style="width: 100px; height: 100px; border-radius: 50%; object-fit: cover; margin: 0 auto 15px; display: block; border: 3px solid #94A3B8; box-shadow: 0 4px 6px rgba(0,0,0,0.08);">`
                            : `<div style="width: 100px; height: 100px; border-radius: 50%; background: #334155; border: 3px solid #CBD5E1; display: flex; align-items: center; justify-content: center; color: #F8FAFC; font-size: 40px; font-weight: 600; margin: 0 auto 15px;">
                                ${getInitials(employee.first_name, employee.last_name)}
                               </div>`
                        }
                        <h3 style="margin: 0; color: #0F172A;">${escapeHtml(employee.first_name)} ${escapeHtml(employee.last_name)}</h3>
                        <p style="color: #64748B; margin-top: 4px;">Nómina / Matrícula: <strong>${escapeHtml(employee.employee_code)}</strong> (ID: #${employee.id})</p>
                    </div>

                    <div style="display: grid; gap: 15px;">
                        <div style="display: grid; grid-template-columns: 120px 1fr; gap: 10px; padding: 12px; background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 8px;">
                            <strong>Email:</strong> <span>${escapeHtml(employee.email || 'N/A')}</span>
                        </div>
                        <div style="display: grid; grid-template-columns: 120px 1fr; gap: 10px; padding: 12px; background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 8px;">
                            <strong>Teléfono:</strong> <span>${escapeHtml(employee.phone) || 'N/A'}</span>
                        </div>
                        <div style="display: grid; grid-template-columns: 120px 1fr; gap: 10px; padding: 12px; background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 8px;">
                            <strong>Departamento:</strong> <span>${escapeHtml(employee.department_name || 'Sin departamento')}</span>
                        </div>
                        <div style="display: grid; grid-template-columns: 120px 1fr; gap: 10px; padding: 12px; background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 8px;">
                            <strong>Turno:</strong> <span>${escapeHtml(employee.shift_name || 'Sin turno')}</span>
                        </div>
                        <div style="display: grid; grid-template-columns: 120px 1fr; gap: 10px; padding: 12px; background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 8px;">
                            <strong>Puesto:</strong> <span>${escapeHtml(employee.position || 'Colaborador')}</span>
                        </div>
                        <div style="display: grid; grid-template-columns: 120px 1fr; gap: 10px; padding: 12px; background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 8px;">
                            <strong>Huellas:</strong> <span>${fingerprints.length}/10 registradas</span>
                        </div>
                    </div>

                    ${fingerprints.length > 0 ? `
                        <div style="margin-top: 25px; border-top: 2px solid #E5E7EB; padding-top: 20px;">
                            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                                <h4 style="margin: 0; color: #374151;">Huellas Registradas (${fingerprints.length}/10)</h4>
                            </div>
                            <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; max-height: 400px; overflow-y: auto;">
                                ${fingerprints.map(fp => {
                                    const fingerNames = {
                                        'THUMB': 'Pulgar', 'INDEX': 'Índice', 'MIDDLE': 'Medio',
                                        'RING': 'Anular', 'PINKY': 'Meñique'
                                    };
                                    const handName = fp.hand === 'LEFT' ? 'Izquierda' : 'Derecha';
                                    const fingerIcon = fp.hand === 'LEFT' ? '🖐️' : '✋';
                                    const enrollDate = new Date(fp.enrolled_at).toLocaleDateString('es-ES', {
                                        year: 'numeric', month: 'short', day: 'numeric'
                                    });
                                    const qualityColor = fp.quality_score >= 70 ? '#10B981' : fp.quality_score >= 40 ? '#F59E0B' : '#EF4444';

                                    return `
                                        <div style="background: linear-gradient(135deg, #F9FAFB 0%, #FFFFFF 100%); border: 1px solid #E5E7EB; border-radius: 10px; padding: 14px; box-shadow: 0 2px 4px rgba(0,0,0,0.05); position: relative;">
                                            <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 10px;">
                                                <div style="display: flex; align-items: center; gap: 8px;">
                                                    <span style="font-size: 24px;">${fingerIcon}</span>
                                                    <div>
                                                        <div style="font-weight: 600; color: #1F2937; font-size: 14px;">
                                                            ${fingerNames[fp.finger_position] || fp.finger_position}
                                                        </div>
                                                        <div style="font-size: 12px; color: #6B7280;">Mano ${handName}</div>
                                                    </div>
                                                </div>
                                                <button onclick="deleteFingerprint(${fp.id}, ${employeeId})"
                                                        style="background: #FEE2E2; color: #DC2626; border: none; width: 24px; height: 24px; border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 14px; transition: all 0.2s;"
                                                        onmouseover="this.style.background='#DC2626'; this.style.color='white';"
                                                        onmouseout="this.style.background='#FEE2E2'; this.style.color='#DC2626';"
                                                        title="Eliminar huella">×</button>
                                            </div>

                                            <div style="display: grid; gap: 6px; font-size: 12px;">
                                                <div style="display: flex; justify-content: space-between; align-items: center;">
                                                    <span style="color: #6B7280;">Calidad:</span>
                                                    <div style="display: flex; align-items: center; gap: 6px;">
                                                        <div style="width: 60px; height: 6px; background: #E5E7EB; border-radius: 3px; overflow: hidden;">
                                                            <div style="width: ${fp.quality_score}%; height: 100%; background: ${qualityColor}; transition: width 0.3s;"></div>
                                                        </div>
                                                        <span style="font-weight: 600; color: ${qualityColor};">${fp.quality_score}%</span>
                                                    </div>
                                                </div>
                                                <div style="display: flex; justify-content: space-between;">
                                                    <span style="color: #6B7280;">Registrada:</span>
                                                    <span style="color: #374151; font-weight: 500;">${enrollDate}</span>
                                                </div>
                                                <div style="display: flex; justify-content: space-between;">
                                                    <span style="color: #6B7280;">ID Template:</span>
                                                    <span style="color: #374151; font-family: monospace; font-size: 11px;">#${fp.id}</span>
                                                </div>
                                            </div>
                                        </div>
                                    `;
                                }).join('')}
                            </div>
                        </div>
                    ` : `
                        <div style="margin-top: 25px; border-top: 2px solid #E5E7EB; padding-top: 20px; text-align: center;">
                            <div style="padding: 30px; background: #F9FAFB; border-radius: 10px; border: 2px dashed #D1D5DB;">
                                <div style="font-size: 48px; margin-bottom: 10px; opacity: 0.5;">👆</div>
                                <p style="color: #6B7280; margin: 0; font-size: 14px;">No hay huellas registradas para este empleado</p>
                                <p style="color: #9CA3AF; margin: 5px 0 0 0; font-size: 12px;">Haz clic en "Registrar Huella" para comenzar</p>
                            </div>
                        </div>
                    `}
                </div>
                <div class="modal-footer">
                    <button class="btn btn-danger" onclick="closeModal(); showEmployeeAbsenceHistoryModal('${employee.employee_code || employeeId}')" style="background: #EF4444; color: white;">📅 Historial de Faltas</button>
                    <button class="btn btn-primary" onclick="closeModal(); showEnrollFingerprintModal(${employeeId})">Registrar Huella</button>
                    <button class="btn btn-cancel" onclick="closeModal()">Cerrar</button>
                </div>
            </div>
        </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHTML);
}

// Eliminar huella dactilar
async function deleteFingerprint(fingerprintId, employeeId) {
    if (!confirm('¿Está seguro de que desea eliminar esta huella? Esta acción no se puede deshacer.')) {
        return;
    }

    try {
        const result = await window.attendance.deleteFingerprint(fingerprintId);

        if (result) {
            showNotification('Huella eliminada exitosamente', 'success');

            await loadInitialData();
            if (currentSection === 'employees') {
                await loadEmployeesSection();
            } else if (currentSection === 'check-in') {
                await loadCheckInSection();
            }

            if (window.touchMode && typeof window.touchMode.getLocalState === 'function') {
                const latestState = await window.touchMode.getLocalState();
                hydrateBiometricUI(latestState);
            }

            // Recargar el modal de detalles del empleado con contadores actualizados
            closeModal();
            setTimeout(() => showEmployeeDetails(employeeId), 250);
        } else {
            showNotification('Error al eliminar la huella', 'error');
        }
    } catch (error) {
        logger.error('Error al eliminar huella:', error);
        showNotification('Error al eliminar la huella', 'error');
    }
}

// Mostrar modal para enrollar huella
async function showEnrollFingerprintModal(employeeId) {
    // Validar antes de iniciar enrollment
    const canProceed = await validateBeforeEnrollment(employeeId);
    if (!canProceed) {
        return;
    }

    const employee = employees.find(e => e.id === employeeId);
    if (!employee) return;

    // Verificar si el servidor biométrico está disponible
    const isAvailable = await window.biometric.isServerAvailable();

    if (!isAvailable) {
        showNotification(
            'El servidor biométrico no está disponible. Asegúrate de que el lector de huellas esté conectado y el servidor esté iniciado.',
            'error',
            5000
        );
        return;
    }

    const modalHTML = `
        <div class="modal active" onclick="if(event.target === this) closeModal()">
            <div class="modal-content" style="max-width: 650px;">
                <div class="modal-header">
                    <h3>Registrar Huella Dactilar</h3>
                    <button class="close-btn" onclick="closeModal()">&times;</button>
                </div>
                <div class="modal-body">
                    <div style="text-align: center; margin-bottom: 20px;">
                        <h4>${escapeHtml(employee.first_name)} ${escapeHtml(employee.last_name)}</h4>
                        <p style="color: #6B7280;">${escapeHtml(employee.employee_code)}</p>
                    </div>

                    <div class="form-group" style="margin-top: 20px;">
                        <label><strong>Modo de Captura:</strong></label>
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px;">
                            <div id="simple-mode-card" style="border: 2px solid #3B82F6; border-radius: 8px; padding: 15px; cursor: pointer; background: #EFF6FF;"
                                 onclick="selectCaptureMode('simple')">
                                <input type="radio" name="capture-mode" value="simple" id="mode-simple" checked>
                                <label for="mode-simple" style="cursor: pointer; margin-left: 8px; user-select: none;">
                                    <strong>Modo Simple</strong><br>
                                    <small style="color: #666;">Captura 1 huella para asistencia diaria (Recomendado)</small>
                                </label>
                            </div>
                            <div id="advanced-mode-card" style="border: 2px solid #ddd; border-radius: 8px; padding: 15px; cursor: pointer;"
                                 onclick="selectCaptureMode('advanced')">
                                <input type="radio" name="capture-mode" value="advanced" id="mode-advanced">
                                <label for="mode-advanced" style="cursor: pointer; margin-left: 8px; user-select: none;">
                                    <strong>Modo Avanzado</strong><br>
                                    <small style="color: #666;">Captura 10 huellas para identificación completa</small>
                                </label>
                            </div>
                        </div>
                    </div>

                    <div id="simple-mode-section" style="margin-top: 20px;">
                        <div class="form-group">
                            <label>Seleccione el dedo a registrar:</label>
                            <select id="finger-select" class="form-control">
                                <option value="">Seleccione...</option>
                                <optgroup label="Mano Izquierda">
                                    <option value="LEFT:THUMB">Pulgar Izquierdo</option>
                                    <option value="LEFT:INDEX" selected>Índice Izquierdo (Recomendado)</option>
                                    <option value="LEFT:MIDDLE">Medio Izquierdo</option>
                                    <option value="LEFT:RING">Anular Izquierdo</option>
                                    <option value="LEFT:PINKY">Meñique Izquierdo</option>
                                </optgroup>
                                <optgroup label="Mano Derecha">
                                    <option value="RIGHT:THUMB">Pulgar Derecho</option>
                                    <option value="RIGHT:INDEX">Índice Derecho (Recomendado)</option>
                                    <option value="RIGHT:MIDDLE">Medio Derecho</option>
                                    <option value="RIGHT:RING">Anular Derecho</option>
                                    <option value="RIGHT:PINKY">Meñique Derecho</option>
                                </optgroup>
                            </select>
                        </div>
                    </div>

                    <div id="advanced-mode-section" style="margin-top: 20px; display: none;">
                        <p style="background: #FEF3C7; padding: 10px; border-radius: 6px; border-left: 4px solid #F59E0B;">
                            <strong>Modo Avanzado:</strong> Se capturarán las 10 huellas dactilares secuencialmente.
                            Este proceso toma aproximadamente 5-10 minutos. <br><small>Usado típicamente en consulados para verificación completa de identidad.</small>
                        </p>
                        <div id="fingers-progress" style="margin-top: 15px; display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 14px;">
                            <div id="progress-LEFT-THUMB">⬜ Pulgar Izquierdo</div>
                            <div id="progress-RIGHT-THUMB">⬜ Pulgar Derecho</div>
                            <div id="progress-LEFT-INDEX">⬜ Índice Izquierdo</div>
                            <div id="progress-RIGHT-INDEX">⬜ Índice Derecho</div>
                            <div id="progress-LEFT-MIDDLE">⬜ Medio Izquierdo</div>
                            <div id="progress-RIGHT-MIDDLE">⬜ Medio Derecho</div>
                            <div id="progress-LEFT-RING">⬜ Anular Izquierdo</div>
                            <div id="progress-RIGHT-RING">⬜ Anular Derecho</div>
                            <div id="progress-LEFT-PINKY">⬜ Meñique Izquierdo</div>
                            <div id="progress-RIGHT-PINKY">⬜ Meñique Derecho</div>
                        </div>
                    </div>

                    <div id="enroll-status" style="min-height: 100px; display: flex; align-items: center; justify-content: center; background: #F9FAFB; border-radius: 8px; margin: 20px 0; padding: 20px; text-align: center;">
                        <div>
                            <div style="font-size: 48px; margin-bottom: 10px;">👆</div>
                            <p style="color: #6B7280; margin: 0;">Seleccione un modo y presione "Iniciar Captura"</p>
                        </div>
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-cancel" onclick="window.FingerprintEnroller.disconnect(); closeModal()">Cancelar</button>
                    <button class="btn btn-primary" onclick="startFingerprintEnrollment(${employeeId})" id="start-enroll-btn">
                        Iniciar Captura
                    </button>
                </div>
            </div>
        </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHTML);
}

// Seleccionar modo de captura
function selectCaptureMode(mode) {
    const simpleRadio = document.getElementById('mode-simple');
    const advancedRadio = document.getElementById('mode-advanced');
    const simpleSection = document.getElementById('simple-mode-section');
    const advancedSection = document.getElementById('advanced-mode-section');
    const simpleModeCard = document.getElementById('simple-mode-card');
    const advancedModeCard = document.getElementById('advanced-mode-card');

    if (mode === 'simple') {
        simpleRadio.checked = true;
        simpleSection.style.display = 'block';
        advancedSection.style.display = 'none';

        simpleModeCard.style.borderColor = '#3B82F6';
        simpleModeCard.style.background = '#EFF6FF';
        advancedModeCard.style.borderColor = '#ddd';
        advancedModeCard.style.background = 'white';
    } else {
        advancedRadio.checked = true;
        simpleSection.style.display = 'none';
        advancedSection.style.display = 'block';

        advancedModeCard.style.borderColor = '#3B82F6';
        advancedModeCard.style.background = '#EFF6FF';
        simpleModeCard.style.borderColor = '#ddd';
        simpleModeCard.style.background = 'white';
    }
}

// Iniciar enrollamiento de huella
async function startFingerprintEnrollment(employeeId) {
    const mode = document.querySelector('input[name="capture-mode"]:checked').value;

    // Verificar si ya existen huellas para este empleado
    try {
        const existingFingerprints = await window.attendance.getEmployeeFingerprints(employeeId);

        if (existingFingerprints && existingFingerprints.length > 0) {
            // Determinar el modo previo basado en la cantidad de huellas
            const previousMode = existingFingerprints.length === 1 ? 'simple' : 'advanced';
            const previousModeText = previousMode === 'simple' ? 'Simple (1 huella)' : 'Avanzado (10 huellas)';
            const newModeText = mode === 'simple' ? 'Simple (1 huella)' : 'Avanzado (10 huellas)';

            // Mostrar modal de confirmación
            const confirmDelete = confirm(
                `Este empleado ya tiene ${existingFingerprints.length} huella(s) registrada(s) en modo ${previousModeText}.\n\n` +
                `¿Desea eliminar las huellas existentes y registrar nuevas huellas en modo ${newModeText}?`
            );

            if (!confirmDelete) {
                showNotification('Operación cancelada', 'info');
                return;
            }

            // Eliminar todas las huellas existentes
            const deleted = await window.attendance.deleteAllEmployeeFingerprints(employeeId);
            logger.info(`[Renderer] ${deleted} huellas eliminadas`);
            showNotification(`${deleted} huella(s) eliminada(s)`, 'success');

            // Esperar un momento antes de continuar
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    } catch (error) {
        logger.error('[Renderer] Error checking existing fingerprints:', error);
    }

    // Continuar con el enrollment según el modo seleccionado
    if (mode === 'simple') {
        await enrollSingleFingerprint(employeeId);
    } else {
        await enrollAllFingerprints(employeeId);
    }
}

// Modo Simple: Capturar una sola huella
async function enrollSingleFingerprint(employeeId) {
    const fingerSelect = document.getElementById('finger-select').value;

    if (!fingerSelect) {
        showNotification('Por favor seleccione un dedo', 'warning');
        return;
    }

    const [hand, position] = fingerSelect.split(':');
    const statusDiv = document.getElementById('enroll-status');
    const startBtn = document.getElementById('start-enroll-btn');

    startBtn.disabled = true;
    startBtn.textContent = 'Capturando...';

    // Construir el finger position string: "LEFT_INDEX", "RIGHT_THUMB", etc.
    const fingerPositionStr = `${hand}_${position}`;

    // Iniciar enrollment con progreso visual en tiempo real
    const enroller = window.FingerprintEnroller;
    enroller.startEnrollment(statusDiv);

    try {
        logger.info('[Renderer] Iniciando enrollment...');
        logger.info('[Renderer] Employee ID:', employeeId);
        logger.info('[Renderer] Finger position:', fingerPositionStr);

        const result = await window.biometric.enrollFingerprint(employeeId, fingerPositionStr);

        logger.info('[Renderer] Enrollment completado, resultado:', result);

        if (result.success) {
            enroller.finishEnrollment(true, '¡Huella registrada exitosamente!');
            showNotification('Huella registrada exitosamente', 'success');

            // Actualizar el campo enrollment_mode del empleado
            try {
                await window.attendance.updateEmployee({
                    id: employeeId,
                    enrollment_mode: 'simple'
                });
                logger.info('[Renderer] enrollment_mode actualizado a: simple');
            } catch (err) {
                logger.error('[Renderer] Error actualizando enrollment_mode:', err);
            }

            await loadInitialData();
            if (window.touchMode && typeof window.touchMode.getLocalState === 'function') {
                const latestState = await window.touchMode.getLocalState();
                hydrateBiometricUI(latestState);
            }

            setTimeout(() => {
                enroller.disconnect();
                closeModal();
                loadEmployeesSection();
            }, 2000);
        } else {
            const isAborted = result.message?.includes('aborted') || result.message?.includes('inactividad');
            const msg = isAborted
                ? 'Tiempo de inactividad agotado (20s). Presione reintentar y coloque su dedo.'
                : (result.message || 'Error al registrar huella');
            enroller.finishEnrollment(false, msg);
            startBtn.disabled = false;
            startBtn.textContent = 'Reintentar';
        }
    } catch (error) {
        logger.error('[Renderer] Error enrolling fingerprint:', error);
        logger.error('[Renderer] Error stack:', error.stack);
        const isAborted = error.message?.includes('aborted') || error.message?.includes('inactividad');
        const errMsg = isAborted
            ? 'Tiempo de inactividad agotado (20s). Presione reintentar y coloque su dedo.'
            : (error.message || 'Error de conexión con el lector');
        enroller.finishEnrollment(false, errMsg);
        startBtn.disabled = false;
        startBtn.textContent = 'Reintentar';
    }
}

// Modo Avanzado: Capturar las 10 huellas
async function enrollAllFingerprints(employeeId) {
    const fingers = [
        { hand: 'LEFT', position: 'THUMB', label: 'Pulgar Izquierdo', icon: '🖐️' },
        { hand: 'RIGHT', position: 'THUMB', label: 'Pulgar Derecho', icon: '✋' },
        { hand: 'LEFT', position: 'INDEX', label: 'Índice Izquierdo', icon: '🖐️' },
        { hand: 'RIGHT', position: 'INDEX', label: 'Índice Derecho', icon: '✋' },
        { hand: 'LEFT', position: 'MIDDLE', label: 'Medio Izquierdo', icon: '🖐️' },
        { hand: 'RIGHT', position: 'MIDDLE', label: 'Medio Derecho', icon: '✋' },
        { hand: 'LEFT', position: 'RING', label: 'Anular Izquierdo', icon: '🖐️' },
        { hand: 'RIGHT', position: 'RING', label: 'Anular Derecho', icon: '✋' },
        { hand: 'LEFT', position: 'PINKY', label: 'Meñique Izquierdo', icon: '🖐️' },
        { hand: 'RIGHT', position: 'PINKY', label: 'Meñique Derecho', icon: '✋' }
    ];

    const statusDiv = document.getElementById('enroll-status');
    const startBtn = document.getElementById('start-enroll-btn');
    startBtn.disabled = true;
    startBtn.textContent = 'Capturando...';

    const enroller = window.FingerprintEnroller;
    let completedCount = 0;

    for (let i = 0; i < fingers.length; i++) {
        // Verificar si el modal fue cerrado o el proceso cancelado
        if (!document.getElementById('enroll-status') || (!window.FingerprintEnroller?.isEnrolling && i > 0)) {
            logger.info('Proceso de enrolamiento cancelado por cierre del modal.');
            return;
        }

        const finger = fingers[i];
        const progressId = `progress-${finger.hand}-${finger.position}`;
        const progressDiv = document.getElementById(progressId);

        // Actualizar estado a "en progreso"
        if (progressDiv) {
            progressDiv.style.color = '#F59E0B';
            progressDiv.style.fontWeight = '600';
            progressDiv.innerHTML = `⏳ ${finger.label}`;
        }

        // Iniciar el enroller con UI completa de progreso
        statusDiv.innerHTML = `
            <div style="text-align: center; margin-bottom: 15px; padding: 15px; background: #EFF6FF; border-radius: 8px;">
                <div style="font-size: 36px; margin-bottom: 8px;">${finger.icon}</div>
                <h4 style="margin: 0; color: #1F2937;">${finger.label}</h4>
                <p style="color: #6B7280; font-size: 13px; margin: 5px 0 0 0;">Dedo ${i + 1} de 10 - ${Math.round((i / 10) * 100)}% completado</p>
            </div>
            <div id="finger-enroll-status"></div>
        `;

        const fingerStatusDiv = document.getElementById('finger-enroll-status');
        enroller.startEnrollment(fingerStatusDiv);

        try {
            // Construir el finger position string: "LEFT_INDEX", "RIGHT_THUMB", etc.
            const fingerPositionStr = `${finger.hand}_${finger.position}`;
            const result = await window.biometric.enrollFingerprint(employeeId, fingerPositionStr);

            if (!document.getElementById('enroll-status') || !window.FingerprintEnroller?.isEnrolling) {
                return;
            }

            if (result.success) {
                if (progressDiv) {
                    progressDiv.style.color = '#10B981';
                    progressDiv.innerHTML = `✅ ${finger.label}`;
                }
                completedCount++;
                enroller.finishEnrollment(true, `${finger.label} registrado exitosamente`);

                // Pausa para mostrar el éxito
                await new Promise(resolve => setTimeout(resolve, 1500));
            } else {
                if (progressDiv) {
                    progressDiv.style.color = '#EF4444';
                    progressDiv.innerHTML = `❌ ${finger.label}`;
                }
                const isAborted = result.message?.includes('aborted') || result.message?.includes('inactividad');
                const msg = isAborted ? 'Tiempo de inactividad agotado (20s)' : (result.message || 'Error al registrar');
                enroller.finishEnrollment(false, msg);
                showNotification(`Captura ${finger.label}: ${msg}`, 'warning', 3000);

                // Pausa antes de continuar
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        } catch (error) {
            if (!document.getElementById('enroll-status') || !window.FingerprintEnroller?.isEnrolling) {
                return;
            }
            logger.error(`Error enrolling ${finger.label}:`, error);
            if (progressDiv) {
                progressDiv.style.color = '#EF4444';
                progressDiv.innerHTML = `❌ ${finger.label}`;
            }
            const isAborted = error.message?.includes('aborted') || error.message?.includes('inactividad');
            const errMsg = isAborted ? 'Tiempo de inactividad agotado (20s)' : 'Error de conexión';
            enroller.finishEnrollment(false, errMsg);
            showNotification(`Captura ${finger.label}: ${errMsg}`, 'warning', 3000);

            // Pausa antes de continuar
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        if (!document.getElementById('enroll-status')) {
            return;
        }
    }

    if (!document.getElementById('enroll-status')) return;

    // Mostrar resumen final
    const successRate = Math.round((completedCount / 10) * 100);
    statusDiv.innerHTML = `
        <div style="text-align: center; padding: 30px;">
            <div style="font-size: 64px; margin-bottom: 15px;">${completedCount === 10 ? '🎉' : '✓'}</div>
            <h3 style="color: #10B981; margin: 0 0 10px 0;">Proceso Completado</h3>
            <div style="background: #F3F4F6; padding: 20px; border-radius: 10px; margin-top: 15px;">
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; text-align: left;">
                    <div>
                        <p style="color: #6B7280; font-size: 12px; margin: 0;">Huellas Exitosas</p>
                        <p style="color: #10B981; font-size: 24px; font-weight: 700; margin: 5px 0 0 0;">${completedCount}/10</p>
                    </div>
                    <div>
                        <p style="color: #6B7280; font-size: 12px; margin: 0;">Tasa de Éxito</p>
                        <p style="color: #3B82F6; font-size: 24px; font-weight: 700; margin: 5px 0 0 0;">${successRate}%</p>
                    </div>
                </div>
            </div>
            <p style="color: #6B7280; font-size: 13px; margin-top: 15px;">Cerrando automáticamente...</p>
        </div>
    `;

    showNotification(`Proceso completado: ${completedCount}/10 huellas registradas`, completedCount === 10 ? 'success' : 'warning');

    // Actualizar el campo enrollment_mode del empleado si al menos se registró una huella
    if (completedCount > 0) {
        try {
            await window.attendance.updateEmployee({
                id: employeeId,
                enrollment_mode: 'advanced'
            });
            logger.info('[Renderer] enrollment_mode actualizado a: advanced');
        } catch (err) {
            logger.error('[Renderer] Error actualizando enrollment_mode:', err);
        }
    }

    await loadInitialData();
    if (window.touchMode && typeof window.touchMode.getLocalState === 'function') {
        const latestState = await window.touchMode.getLocalState();
        hydrateBiometricUI(latestState);
    }

    setTimeout(() => {
        enroller.disconnect();
        closeModal();
        loadEmployeesSection();
    }, 3000);
}

// ==================== ATTENDANCE SECTION ====================
async function loadAttendanceSection(filters = {}) {
    try {
        const container = document.getElementById('attendance-records-container');
        if (!container) return;

        const records = await window.attendance.getAttendanceRecords(filters);

        container.innerHTML = `
            <div style="margin-bottom: 20px; background: white; padding: 15px; border-radius: 10px; border: 1px solid #E5E7EB; display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end;">
                <div>
                    <label style="display: block; font-size: 12px; font-weight: 600; color: #4B5563; margin-bottom: 4px;">Desde:</label>
                    <input type="date" id="att-filter-start" class="form-control" value="${filters.start_date || ''}" style="padding: 6px 10px; font-size: 13px;">
                </div>
                <div>
                    <label style="display: block; font-size: 12px; font-weight: 600; color: #4B5563; margin-bottom: 4px;">Hasta:</label>
                    <input type="date" id="att-filter-end" class="form-control" value="${filters.end_date || ''}" style="padding: 6px 10px; font-size: 13px;">
                </div>
                <div>
                    <label style="display: block; font-size: 12px; font-weight: 600; color: #4B5563; margin-bottom: 4px;">Estado:</label>
                    <select id="att-filter-status" class="form-control" style="padding: 6px 10px; font-size: 13px;">
                        <option value="">Todos los estados</option>
                        <option value="present" ${filters.status === 'present' ? 'selected' : ''}>Presente</option>
                        <option value="late" ${filters.status === 'late' ? 'selected' : ''}>Retardo</option>
                        <option value="absent" ${filters.status === 'absent' ? 'selected' : ''}>Ausente</option>
                    </select>
                </div>
                <div>
                    <label style="display: block; font-size: 12px; font-weight: 600; color: #4B5563; margin-bottom: 4px;">Departamento:</label>
                    <select id="att-filter-dept" class="form-control" style="padding: 6px 10px; font-size: 13px;">
                        <option value="">Todos los departamentos</option>
                        ${departments.map(d => `<option value="${d.id}" ${filters.department_id === d.id ? 'selected' : ''}>${escapeHtml(d.name)}</option>`).join('')}
                    </select>
                </div>
                <div style="display: flex; gap: 8px;">
                    <button class="btn btn-primary" onclick="applyAttendanceFilters()" style="padding: 7px 15px; font-size: 13px;">🔍 Filtrar</button>
                    <button class="btn" onclick="clearAttendanceFilters()" style="background: #E5E7EB; color: #374151; padding: 7px 15px; font-size: 13px;">Limpiar</button>
                </div>
            </div>

            <div class="table-container">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th class="td-nowrap" style="width: 1%;">Fecha</th>
                            <th>Empleado</th>
                            <th>Departamento</th>
                            <th class="td-nowrap" style="width: 1%;">Entrada</th>
                            <th class="td-nowrap" style="width: 1%;">Salida</th>
                            <th class="td-center-nowrap" style="width: 1%;">Estado</th>
                            <th class="td-center-nowrap" style="width: 1%;">Retraso</th>
                            <th class="td-center-nowrap" style="width: 1%;">Verificado</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${records.length > 0 ? records.map(rec => `
                            <tr>
                                <td class="td-nowrap">${escapeHtml(rec.date)}</td>
                                <td class="td-nowrap" style="font-weight: 500;">${escapeHtml(rec.employee_name)}</td>
                                <td>${escapeHtml(rec.department_name)}</td>
                                <td class="td-nowrap">${escapeHtml(rec.check_in_time || '-')}</td>
                                <td class="td-nowrap">${escapeHtml(rec.check_out_time || '-')}</td>
                                <td class="td-center-nowrap">${renderStatusBadge(rec.status)}</td>
                                <td class="td-center-nowrap">${rec.minutes_late ? rec.minutes_late + ' min' : '-'}</td>
                                <td class="td-center-nowrap">${rec.fingerprint_verified ? '✓' : '-'}</td>
                            </tr>
                        `).join('') : `
                            <tr>
                                <td colspan="8" style="text-align: center; padding: 2rem; color: #6B7280;">No se encontraron registros con los filtros seleccionados</td>
                            </tr>
                        `}
                    </tbody>
                </table>
            </div>
        `;
    } catch (error) {
        logger.error('Error cargando registros:', error);
    }
}

function applyAttendanceFilters() {
    const startDate = document.getElementById('att-filter-start')?.value || undefined;
    const endDate = document.getElementById('att-filter-end')?.value || undefined;
    const status = document.getElementById('att-filter-status')?.value || undefined;
    const deptRaw = parseInt(document.getElementById('att-filter-dept')?.value, 10);
    const department_id = Number.isFinite(deptRaw) && deptRaw > 0 ? deptRaw : undefined;

    const filters = {};
    if (startDate) filters.start_date = startDate;
    if (endDate) filters.end_date = endDate;
    if (status) filters.status = status;
    if (department_id) filters.department_id = department_id;

    loadAttendanceSection(filters);
}

function clearAttendanceFilters() {
    loadAttendanceSection({});
}

// ==================== DEPARTMENTS SECTION ====================
function loadDepartmentsSection() {
    const container = document.getElementById('departments-container');
    if (!container) return;

    // Precomputación funcional O(E) para conteos e índice de empleados
    const deptCounts = (window.countToMap || countToMap)(employees, e => e.department_id);
    const employeeMap = (window.indexToMap || indexToMap)(employees, e => e.id);

    container.innerHTML = `
        <div style="margin-bottom: 20px;">
            <button class="btn btn-primary" onclick="showAddDepartmentModal()">
                + Agregar Departamento
            </button>
        </div>

        <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr)); gap: 16px;">
            ${departments.map(dept => {
                const count = deptCounts.get(dept.id) || 0;
                const mgr = dept.manager_id ? employeeMap.get(dept.manager_id) : null;
                const mgrText = mgr ? ` • 👤 ${escapeHtml(mgr.first_name + ' ' + mgr.last_name)}` : '';

                return `
                <div style="background: white; border-radius: 12px; padding: 20px; border: 2px solid #E5E7EB; position: relative;">
                    <div style="position: absolute; top: 15px; right: 15px; display: flex; gap: 8px;">
                        <button onclick="showEditDepartmentModal(${dept.id})"
                                style="background: #10B981; color: white; border: none; padding: 6px 10px; border-radius: 6px; cursor: pointer; font-size: 12px;"
                                title="Editar">✏️</button>
                        <button onclick="deleteDepartment(${dept.id})"
                                style="background: #EF4444; color: white; border: none; padding: 6px 10px; border-radius: 6px; cursor: pointer; font-size: 12px;"
                                title="Eliminar">🗑️</button>
                    </div>
                    <div style="display: flex; align-items: center; gap: 15px; margin-bottom: 10px;">
                        <div style="width: 50px; height: 50px; border-radius: 12px; background: #EFF6FF; display: flex; align-items: center; justify-content: center; font-size: 24px;">
                            🏢
                        </div>
                        <div style="flex: 1; padding-right: 60px;">
                            <h4 style="margin: 0; color: #1F2937;">${escapeHtml(dept.name)}</h4>
                            <p style="margin: 5px 0 0; color: #6B7280; font-size: 13px;">
                                ${count} empleados${mgrText}
                            </p>
                        </div>
                    </div>
                    <p style="color: #6B7280; font-size: 14px; margin: 10px 0 0;">
                        ${dept.description || 'Sin descripción'}
                    </p>
                </div>
                `;
            }).join('')}
        </div>
    `;
}

// Mostrar modal para agregar departamento
function showAddDepartmentModal() {
    openModalShell({
        title: 'Agregar Departamento',
        maxWidth: '500px',
        bodyHTML: renderDepartmentForm(null),
        footerHTML: `
            <button class="btn btn-cancel" onclick="closeModal()">Cancelar</button>
            <button class="btn btn-primary" onclick="saveDepartment()">Guardar</button>
        `
    });
}

// Guardar departamento
async function saveDepartment() {
    const form = document.getElementById('add-department-form');
    if (form && !form.reportValidity()) return;

    const name = sanitizeText(document.getElementById('dept-name').value, 100);
    const description = sanitizeText(document.getElementById('dept-description').value, 500);
    const managerRaw = parseInt(document.getElementById('dept-manager')?.value, 10);
    const manager_id = Number.isFinite(managerRaw) && managerRaw > 0 ? managerRaw : null;

    if (!name) {
        showNotification('El nombre del departamento es requerido', 'warning');
        return;
    }

    await withSubmitState({ loadingText: 'Guardando...' }, async () => {
        try {
            const result = await window.attendance.createDepartment({ name, description, manager_id });

            if (result) {
                showNotification('Departamento creado exitosamente', 'success');
                closeModal();
                await loadInitialData();
                loadDepartmentsSection();
            } else {
                showNotification('Error al crear departamento', 'error');
            }
        } catch (error) {
            logger.error('Error creando departamento:', error);
            showNotification(error.message || 'Error al crear departamento', 'error');
        }
    });
}

// Mostrar modal para editar departamento
function showEditDepartmentModal(deptId) {
    const dept = departments.find(d => d.id === deptId);
    if (!dept) {
        showNotification('Departamento no encontrado', 'error');
        return;
    }

    openModalShell({
        title: 'Editar Departamento',
        maxWidth: '500px',
        bodyHTML: renderDepartmentForm(dept),
        footerHTML: `
            <button class="btn btn-cancel" onclick="closeModal()">Cancelar</button>
            <button class="btn btn-primary" onclick="updateDepartment(${deptId})">Actualizar</button>
        `
    });
}

// Actualizar departamento
async function updateDepartment(deptId) {
    const form = document.getElementById('edit-department-form');
    if (form && !form.reportValidity()) return;

    const name = sanitizeText(document.getElementById('edit-dept-name').value, 100);
    const description = sanitizeText(document.getElementById('edit-dept-description').value, 500);
    const managerRaw = parseInt(document.getElementById('edit-dept-manager')?.value, 10);
    const manager_id = Number.isFinite(managerRaw) && managerRaw > 0 ? managerRaw : null;

    if (!name) {
        showNotification('El nombre del departamento es requerido', 'warning');
        return;
    }

    await withSubmitState({ loadingText: 'Actualizando...' }, async () => {
        try {
            const result = await window.attendance.updateDepartment({
                id: deptId,
                name,
                description,
                manager_id
            });

            if (result) {
                showNotification('Departamento actualizado exitosamente', 'success');
                closeModal();
                await loadInitialData();
                loadDepartmentsSection();
            } else {
                showNotification('Error al actualizar departamento', 'error');
            }
        } catch (error) {
            logger.error('Error actualizando departamento:', error);
            showNotification(error.message || 'Error al actualizar departamento', 'error');
        }
    });
}

// Eliminar departamento
async function deleteDepartment(deptId) {
    const dept = departments.find(d => d.id === deptId);
    const employeesInDept = dept ? employees.filter(e => e.department_id === deptId) : [];
    const blockReason = employeesInDept.length > 0
        ? `No se puede eliminar el departamento "${escapeHtml(dept.name)}" porque tiene ${employeesInDept.length} empleado(s) asignado(s). Por favor, reasigne los empleados a otro departamento primero.`
        : undefined;

    await confirmAndDeleteEntity({
        entity: dept,
        entityName: 'Departamento',
        blockReason,
        confirmMessage: (d) =>
            `¿Está seguro de que desea eliminar el departamento?\n\n` +
            `${escapeHtml(d.name)}\n\n` +
            `Esta acción NO se puede deshacer.`,
        deleteFn: () => window.attendance.deleteDepartment(deptId),
        onSuccess: async () => {
            await loadInitialData();
            loadDepartmentsSection();
        }
    });
}

// ==================== SHIFTS SECTION ====================
function loadShiftsSection() {
    const container = document.getElementById('shifts-container');
    if (!container) return;

    // Precomputación funcional O(E) de turnos
    const shiftCounts = (window.countToMap || countToMap)(employees, e => e.shift_id);

    container.innerHTML = `
        <div style="margin-bottom: 20px;">
            <button class="btn btn-primary" onclick="showAddShiftModal()">
                + Agregar Turno
            </button>
        </div>

        <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr)); gap: 16px;">
            ${shifts.map(shift => {
                const count = shiftCounts.get(shift.id) || 0;

                return `
                <div style="background: white; border-radius: 12px; padding: 20px; border: 2px solid #E5E7EB; position: relative;">
                    <div style="position: absolute; top: 15px; right: 15px; display: flex; gap: 8px;">
                        <button onclick="showEditShiftModal(${shift.id})"
                                style="background: #10B981; color: white; border: none; padding: 6px 10px; border-radius: 6px; cursor: pointer; font-size: 12px;"
                                title="Editar">✏️</button>
                        <button onclick="deleteShift(${shift.id})"
                                style="background: #EF4444; color: white; border: none; padding: 6px 10px; border-radius: 6px; cursor: pointer; font-size: 12px;"
                                title="Eliminar">🗑️</button>
                    </div>
                    <div style="display: flex; align-items: center; gap: 15px; margin-bottom: 15px;">
                        <div style="width: 50px; height: 50px; border-radius: 12px; background: ${shift.color}15; display: flex; align-items: center; justify-content: center; font-size: 24px;">
                            🕐
                        </div>
                        <div style="flex: 1; padding-right: 60px;">
                            <h4 style="margin: 0; color: #1F2937;">${escapeHtml(shift.name)}</h4>
                            <p style="margin: 5px 0 0; color: #6B7280; font-size: 13px;">
                                ${count} empleados
                            </p>
                        </div>
                    </div>
                    <div style="display: grid; gap: 10px;">
                        <div style="padding: 10px; background: #F9FAFB; border-radius: 8px;">
                            <strong style="font-size: 13px; color: #6B7280;">Horario:</strong>
                            <div style="font-size: 16px; font-weight: 600; color: #1F2937; margin-top: 5px;">
                                ${shift.start_time} - ${shift.end_time}
                            </div>
                        </div>
                        <div style="padding: 10px; background: #F9FAFB; border-radius: 8px;">
                            <strong style="font-size: 13px; color: #6B7280;">Tolerancia:</strong>
                            <div style="font-size: 16px; font-weight: 600; color: #1F2937; margin-top: 5px;">
                                ${shift.tolerance_minutes} minutos
                            </div>
                        </div>
                    </div>
                </div>
                `;
            }).join('')}
        </div>
    `;
}

// Mostrar modal para agregar turno
function showAddShiftModal() {
    openModalShell({
        title: 'Agregar Turno',
        maxWidth: '500px',
        bodyHTML: renderShiftForm(null),
        footerHTML: `
            <button class="btn btn-cancel" onclick="closeModal()">Cancelar</button>
            <button class="btn btn-primary" onclick="saveShift()">Guardar</button>
        `
    });
}

// Guardar turno
async function saveShift() {
    const form = document.getElementById('add-shift-form');
    if (form && !form.reportValidity()) return;

    const name = sanitizeText(document.getElementById('shift-name').value, 100);
    const startTime = document.getElementById('shift-start-time').value;
    const endTime = document.getElementById('shift-end-time').value;
    const toleranceRaw = parseInt(document.getElementById('shift-tolerance').value, 10);
    const tolerance = Number.isFinite(toleranceRaw) && toleranceRaw >= 0 ? toleranceRaw : 10;
    const color = document.getElementById('shift-color').value;

    if (!name || !startTime || !endTime) {
        showNotification('Todos los campos son requeridos', 'warning');
        return;
    }

    await withSubmitState({ loadingText: 'Guardando...' }, async () => {
        try {
            const result = await window.attendance.createShift({
                name,
                start_time: startTime,
                end_time: endTime,
                tolerance_minutes: tolerance,
                color
            });

            if (result) {
                showNotification('Turno creado exitosamente', 'success');
                closeModal();
                await loadInitialData();
                loadShiftsSection();
            } else {
                showNotification('Error al crear turno', 'error');
            }
        } catch (error) {
            logger.error('Error creando turno:', error);
            showNotification(error.message || 'Error al crear turno', 'error');
        }
    });
}

// Mostrar modal para editar turno
function showEditShiftModal(shiftId) {
    const shift = shifts.find(s => s.id === shiftId);
    if (!shift) {
        showNotification('Turno no encontrado', 'error');
        return;
    }

    openModalShell({
        title: 'Editar Turno',
        maxWidth: '500px',
        bodyHTML: renderShiftForm(shift),
        footerHTML: `
            <button class="btn btn-cancel" onclick="closeModal()">Cancelar</button>
            <button class="btn btn-primary" onclick="updateShift(${shiftId})">Actualizar</button>
        `
    });
}

// Actualizar turno
async function updateShift(shiftId) {
    const form = document.getElementById('edit-shift-form');
    if (form && !form.reportValidity()) return;

    const name = sanitizeText(document.getElementById('edit-shift-name').value, 100);
    const startTime = document.getElementById('edit-shift-start-time').value;
    const endTime = document.getElementById('edit-shift-end-time').value;
    const toleranceRaw = parseInt(document.getElementById('edit-shift-tolerance').value, 10);
    const tolerance = Number.isFinite(toleranceRaw) && toleranceRaw >= 0 ? toleranceRaw : 0;
    const color = document.getElementById('edit-shift-color').value;

    if (!name || !startTime || !endTime) {
        showNotification('Todos los campos son requeridos', 'warning');
        return;
    }

    await withSubmitState({ loadingText: 'Actualizando...' }, async () => {
        try {
            const result = await window.attendance.updateShift({
                id: shiftId,
                name,
                start_time: startTime,
                end_time: endTime,
                tolerance_minutes: tolerance,
                color
            });

            if (result) {
                showNotification('Turno actualizado exitosamente', 'success');
                closeModal();
                await loadInitialData();
                loadShiftsSection();
            } else {
                showNotification('Error al actualizar turno', 'error');
            }
        } catch (error) {
            logger.error('Error actualizando turno:', error);
            showNotification(error.message || 'Error al actualizar turno', 'error');
        }
    });
}

// Eliminar turno
async function deleteShift(shiftId) {
    const shift = shifts.find(s => s.id === shiftId);
    const employeesInShift = shift ? employees.filter(e => e.shift_id === shiftId) : [];
    const blockReason = employeesInShift.length > 0
        ? `No se puede eliminar el turno "${escapeHtml(shift.name)}" porque tiene ${employeesInShift.length} empleado(s) asignado(s). Por favor, reasigne los empleados a otro turno primero.`
        : undefined;

    await confirmAndDeleteEntity({
        entity: shift,
        entityName: 'Turno',
        blockReason,
        confirmMessage: (s) =>
            `¿Está seguro de que desea eliminar el turno?\n\n` +
            `${escapeHtml(s.name)} (${s.start_time} - ${s.end_time})\n\n` +
            `Esta acción NO se puede deshacer.`,
        deleteFn: () => window.attendance.deleteShift(shiftId),
        onSuccess: async () => {
            await loadInitialData();
            loadShiftsSection();
        }
    });
}

// ==================== REPORTS SECTION & ANALYTICS EXPLORER ====================
const SPANISH_DAYS_NAMES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const SPANISH_MONTHS_NAMES = [
    'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
    'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
];

/**
 * Utilidad pura: Obtiene la fecha local YYYY-MM-DD sin desfase UTC
 */
function getLocalDateStrClient(dateObj = new Date()) {
    const y = dateObj.getFullYear();
    const m = String(dateObj.getMonth() + 1).padStart(2, '0');
    const d = String(dateObj.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/**
 * Utilidad pura: Obtiene el mes local YYYY-MM sin desfase UTC
 */
function getLocalMonthStrClient(dateObj = new Date()) {
    const y = dateObj.getFullYear();
    const m = String(dateObj.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
}

/**
 * Utilidad pura: Parsea una cadena YYYY-MM-DD en zona horaria local
 */
function parseLocalDateClient(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return new Date();
    const clean = dateStr.trim().split('T')[0];
    const parts = clean.split('-');
    if (parts.length === 3) {
        const y = parseInt(parts[0], 10);
        const m = parseInt(parts[1], 10);
        const d = parseInt(parts[2], 10);
        if (!Number.isNaN(y) && !Number.isNaN(m) && !Number.isNaN(d)) {
            return new Date(y, m - 1, d, 12, 0, 0);
        }
    }
    return new Date(dateStr);
}

/**
 * Utilidad pura: Formatea una fecha YYYY-MM-DD en español sin restar 1 día por UTC
 */
function formatReportDateEs(dateStr, options = undefined) {
    if (!dateStr) return '-';
    return parseLocalDateClient(dateStr).toLocaleDateString('es-ES', options);
}

/**
 * Sintetiza faltas en días operativos del sistema donde otros colaboradores registraron actividad
 * pero el empleado consultado no registró asistencia ni justificación.
 */
function enrichEmployeeRecordsWithOperatingAbsencesClient(allRecords, empRecords, employee) {
    const baseRecords = Array.isArray(empRecords) ? [...empRecords] : [];
    if (!Array.isArray(allRecords) || allRecords.length === 0 || !employee) {
        return baseRecords;
    }

    const empDates = new Set(baseRecords.map(r => r.date).filter(Boolean));
    const operatingDates = new Set(allRecords.map(r => r.date).filter(Boolean));
    const hireDate = (employee.hire_date || '').trim();

    for (const opDate of operatingDates) {
        if (empDates.has(opDate)) continue;
        if (hireDate && opDate < hireDate) continue;
        baseRecords.push({
            id: 0,
            employee_id: employee.id,
            date: opDate,
            check_in_time: null,
            check_out_time: null,
            status: 'absent',
            minutes_late: 0,
            minutes_overtime: 0,
            notes: 'Sin marcación registrada en jornada operativa',
            fingerprint_verified: 0
        });
    }

    return baseRecords.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
}

/**
 * Utilidad pura: Rango de semana de lunes a domingo para una fecha YYYY-MM-DD
 */
function getWeekRangeClient(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return { startDate: dateStr, endDate: dateStr, label: dateStr };
    const parts = dateStr.trim().split('-');
    if (parts.length < 3) return { startDate: dateStr, endDate: dateStr, label: dateStr };
    const y = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    const d = parseInt(parts[2], 10);
    const dateObj = new Date(y, m - 1, d);
    const dayIdx = dateObj.getDay();
    const diffToMonday = dayIdx === 0 ? -6 : 1 - dayIdx;
    const monday = new Date(y, m - 1, d + diffToMonday);
    const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
    const pad = n => String(n).padStart(2, '0');
    return {
        startDate: `${monday.getFullYear()}-${pad(monday.getMonth() + 1)}-${pad(monday.getDate())}`,
        endDate: `${sunday.getFullYear()}-${pad(sunday.getMonth() + 1)}-${pad(sunday.getDate())}`,
        label: `${pad(monday.getDate())}/${pad(monday.getMonth() + 1)} al ${pad(sunday.getDate())}/${pad(sunday.getMonth() + 1)}`
    };
}

/**
 * Agrupa días de inasistencia dentro de un mes por semanas cronológicas
 */
function groupAbsenceDaysByWeekClient(days) {
    if (!days || days.length === 0) return [];
    const weekMap = new Map();
    for (let i = 0; i < days.length; i++) {
        const item = days[i];
        const range = getWeekRangeClient(item.date);
        const existing = weekMap.get(range.startDate);
        if (existing) {
            existing.items.push(item);
        } else {
            weekMap.set(range.startDate, { range, items: [item] });
        }
    }
    const sorted = Array.from(weekMap.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    return sorted.map(([_, data], idx) => {
        const sortedItems = [...data.items].sort((a, b) => a.date.localeCompare(b.date));
        return {
            weekNumber: idx + 1,
            weekLabel: `Semana ${idx + 1} (${data.range.label})`,
            startDate: data.range.startDate,
            endDate: data.range.endDate,
            totalDays: sortedItems.length,
            days: sortedItems
        };
    });
}

/**
 * Calcula el historial analítico de faltas de un empleado:
 * - Suma de cada mes que tuvo falta del mes correspondiente
 * - Desglose de qué días faltó en la semana de ese mes
 */
function calcEmployeeAbsenceHistoryClient(records, employee) {
    const absences = (records || []).filter(r => r.status === 'absent');
    const dayDistribution = { 'Lunes': 0, 'Martes': 0, 'Miércoles': 0, 'Jueves': 0, 'Viernes': 0, 'Sábado': 0, 'Domingo': 0 };
    const monthBuckets = new Map();

    for (let i = 0; i < absences.length; i++) {
        const r = absences[i];
        if (!r.date) continue;
        const parts = r.date.trim().split('-');
        if (parts.length < 3) continue;
        const y = parseInt(parts[0], 10);
        const m = parseInt(parts[1], 10);
        const d = parseInt(parts[2], 10);
        const dObj = new Date(y, m - 1, d);
        const dayName = SPANISH_DAYS_NAMES[dObj.getDay()] || 'Desconocido';
        if (dayDistribution[dayName] !== undefined) {
            dayDistribution[dayName]++;
        }
        const monthKey = `${y}-${String(m).padStart(2, '0')}`;
        const dayItem = {
            id: r.id,
            employeeId: r.employee_id,
            date: r.date,
            dayOfWeek: dayName,
            dayOfMonth: d,
            formattedDate: `${dayName} ${String(d).padStart(2, '0')} de ${SPANISH_MONTHS_NAMES[m - 1] || 'Mes ' + m}`,
            notes: r.notes || ''
        };
        const curList = monthBuckets.get(monthKey);
        if (curList) curList.push(dayItem);
        else monthBuckets.set(monthKey, [dayItem]);
    }

    const sortedMonthKeys = Array.from(monthBuckets.keys()).sort((a, b) => b.localeCompare(a));
    let worstMonth = null;

    const months = sortedMonthKeys.map(mKey => {
        const [yearStr, monthStr] = mKey.split('-');
        const y = parseInt(yearStr, 10);
        const m = parseInt(monthStr, 10);
        const monthName = `${SPANISH_MONTHS_NAMES[m - 1] || 'Mes ' + m} ${y}`;
        const items = monthBuckets.get(mKey) || [];
        const total = items.length;
        if (!worstMonth || total > worstMonth.total) {
            worstMonth = { monthName, total };
        }
        const weeks = groupAbsenceDaysByWeekClient(items);
        return {
            monthKey: mKey,
            year: y,
            monthNumber: m,
            monthName,
            totalAbsences: total,
            weeks
        };
    });

    const totalAbsences = absences.length;
    const monthsWithAbsencesCount = months.length;
    const averagePerMonth = monthsWithAbsencesCount > 0 ? (totalAbsences / monthsWithAbsencesCount).toFixed(1) : '0';

    return {
        employee,
        totalAbsences,
        monthsWithAbsencesCount,
        averagePerMonth,
        worstMonth,
        months,
        dayOfWeekDistribution: dayDistribution
    };
}

/**
 * Carga la sección de reportes integrando el Explorador Inteligente & Historial de Faltas
 */
async function loadReportsSection() {
    const container = document.querySelector('#reports-section .card-body');
    if (!container) return;

    if (!employees || employees.length === 0) {
        try {
            await loadEmployees();
        } catch (_) {}
    }

    const todayStr = getLocalDateStrClient();
    const currentMonth = getLocalMonthStrClient();
    const defaultEmpCode = (employees && employees.length > 0 && employees[0].employee_code)
        ? employees[0].employee_code
        : 'EMP-001';

    const employeeOptions = (employees || [])
        .map(e => `<option value="${escapeHtml(e.employee_code)}">${escapeHtml(e.employee_code)} - ${escapeHtml(e.first_name)} ${escapeHtml(e.last_name)}</option>`)
        .join('');

    container.innerHTML = `
        <!-- CENTRO ANALÍTICO: EXPLORADOR DE FALTAS & Q&A DE DOMINIO -->
        <div style="background: white; border: 1px solid #CBD5E1; border-radius: 14px; padding: 24px; margin-bottom: 30px; box-shadow: 0 2px 6px rgba(15,23,42,0.04);">
            <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 15px; margin-bottom: 20px; border-bottom: 1px solid #E2E8F0; padding-bottom: 15px;">
                <div>
                    <h3 style="margin: 0; color: #0F172A; font-size: 20px; display: flex; align-items: center; gap: 10px;">
                        <span>🧠</span> Explorador Inteligente & Historial de Faltas
                    </h3>
                    <p style="margin: 4px 0 0; color: #64748B; font-size: 13px;">
                        Ingresa una nómina para calcular la suma de faltas por mes y días por semana, o haz preguntas en lenguaje natural sobre el personal.
                    </p>
                </div>
                <div style="display: flex; background: #F1F5F9; padding: 4px; border-radius: 10px; gap: 4px; border: 1px solid #E2E8F0;">
                    <button id="tab-btn-absences" class="btn" style="padding: 8px 18px; font-size: 13px; background: #1E293B; color: #F8FAFC; border-radius: 8px; font-weight: 600;" onclick="switchReportsSubTab('absences')">
                        📅 Historial de Faltas
                    </button>
                    <button id="tab-btn-qa" class="btn" style="padding: 8px 18px; font-size: 13px; background: transparent; color: #475569; border-radius: 8px; font-weight: 600;" onclick="switchReportsSubTab('qa')">
                        💬 Preguntas al Personal (NLP)
                    </button>
                </div>
            </div>

            <!-- SUB-TAB 1: HISTORIAL DE FALTAS -->
            <div id="subtab-content-absences">
                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 15px; margin-bottom: 20px; align-items: end;">
                    <div>
                        <label style="display: block; font-size: 12px; font-weight: 600; color: #334155; margin-bottom: 6px;">
                            Nómina / Matrícula o Nombre del Empleado:
                        </label>
                        <input type="text" id="absence-employee-input" class="form-control" placeholder="Ej: ${escapeHtml(defaultEmpCode)}..." onkeydown="if(event.key === 'Enter') onSearchEmployeeAbsences()">
                    </div>
                    <div>
                        <label style="display: block; font-size: 12px; font-weight: 600; color: #334155; margin-bottom: 6px;">
                            O Selecciona un Colaborador:
                        </label>
                        <select id="absence-employee-select" class="form-control" onchange="if(this.value) { document.getElementById('absence-employee-input').value = this.value; onSearchEmployeeAbsences(); }">
                            <option value="">-- Seleccionar de la plantilla --</option>
                            ${employeeOptions}
                        </select>
                    </div>
                    <div>
                        <button class="btn" style="width: 100%; height: 42px; background: #1E293B; color: #F8FAFC; display: flex; align-items: center; justify-content: center; gap: 8px; font-weight: 600;" onclick="onSearchEmployeeAbsences()">
                            <span>🔍</span> Consultar Historial de Faltas
                        </button>
                    </div>
                </div>
                <div id="absence-history-results-area">
                    <div style="text-align: center; padding: 35px 20px; background: #F8FAFC; border-radius: 12px; border: 2px dashed #CBD5E1; color: #64748B; font-size: 14px;">
                        <span style="font-size: 28px; display: block; margin-bottom: 8px;">📊</span>
                        Ingresa una nómina o selecciona un empleado para calcular la <strong>suma de faltas de cada mes</strong> y el <strong>desglose de días específicos por semana</strong>.
                    </div>
                </div>
            </div>

            <!-- SUB-TAB 2: PREGUNTAS Y RESPUESTAS (NLP) -->
            <div id="subtab-content-qa" style="display: none;">
                <div style="margin-bottom: 15px;">
                    <label style="display: block; font-size: 12px; font-weight: 600; color: #334155; margin-bottom: 6px;">
                        Formula una pregunta sobre el dominio de asistencia (empleado, faltas, tiempo, retardos):
                    </label>
                    <div style="display: flex; gap: 10px;">
                        <input type="text" id="qa-query-input" class="form-control" placeholder="Ej: ¿Qué días faltó el empleado ${escapeHtml(defaultEmpCode)} en la semana? o ¿Quién tiene más faltas?" onkeydown="if(event.key === 'Enter') onExecuteDomainQuestion()">
                        <button class="btn" style="background: #1E293B; color: #F8FAFC; white-space: nowrap; padding: 0 24px; font-weight: 600; display: flex; align-items: center; gap: 6px;" onclick="onExecuteDomainQuestion()">
                            <span>✨</span> Preguntar
                        </button>
                    </div>
                </div>
                <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 20px; align-items: center;">
                    <span style="font-size: 12px; color: #64748B; font-weight: 600;">Consultas rápidas:</span>
                    <button class="btn" style="background: #F1F5F9; color: #1E293B; border: 1px solid #CBD5E1; font-size: 12px; padding: 5px 12px; border-radius: 20px;" onclick="onQuickDomainQuestion('¿Qué días faltó el empleado ${escapeHtml(defaultEmpCode)} en la semana?')">
                        📅 ¿Qué días faltó ${escapeHtml(defaultEmpCode)} en la semana?
                    </button>
                    <button class="btn" style="background: #F1F5F9; color: #1E293B; border: 1px solid #CBD5E1; font-size: 12px; padding: 5px 12px; border-radius: 20px;" onclick="onQuickDomainQuestion('Historial de faltas de ${escapeHtml(defaultEmpCode)}')">
                        📊 Historial de faltas de ${escapeHtml(defaultEmpCode)}
                    </button>
                    <button class="btn" style="background: #F1F5F9; color: #1E293B; border: 1px solid #CBD5E1; font-size: 12px; padding: 5px 12px; border-radius: 20px;" onclick="onQuickDomainQuestion('¿Quién tiene más faltas en el personal?')">
                        🔴 ¿Quién tiene más faltas?
                    </button>
                    <button class="btn" style="background: #F1F5F9; color: #1E293B; border: 1px solid #CBD5E1; font-size: 12px; padding: 5px 12px; border-radius: 20px;" onclick="onQuickDomainQuestion('¿Cuánto tiempo trabajó el empleado ${escapeHtml(defaultEmpCode)}?')">
                        ⏱️ ¿Cuánto tiempo trabajó ${escapeHtml(defaultEmpCode)}?
                    </button>
                    <button class="btn" style="background: #F1F5F9; color: #1E293B; border: 1px solid #CBD5E1; font-size: 12px; padding: 5px 12px; border-radius: 20px;" onclick="onQuickDomainQuestion('retardos y minutos tarde de ${escapeHtml(defaultEmpCode)}')">
                        ⏰ Retardos de ${escapeHtml(defaultEmpCode)}
                    </button>
                    <button class="btn" style="background: #F1F5F9; color: #1E293B; border: 1px solid #CBD5E1; font-size: 12px; padding: 5px 12px; border-radius: 20px;" onclick="onQuickDomainQuestion('resumen general de personal faltas y tiempo')">
                        📈 Resumen global: personal, faltas y tiempo
                    </button>
                </div>
                <div id="qa-query-results-area">
                    <div style="text-align: center; padding: 35px 20px; background: #F8FAFC; border-radius: 12px; border: 2px dashed #CBD5E1; color: #64748B; font-size: 14px;">
                        <span style="font-size: 28px; display: block; margin-bottom: 8px;">💬</span>
                        Escribe tu pregunta o presiona una sugerencia para explorar los datos mediante palabras clave contextuales (<em>empleado, falta, tiempo, retardo, mes, semana</em>).
                    </div>
                </div>
            </div>
        </div>

        <h4 style="color: #334155; margin: 0 0 15px; font-size: 15px; font-weight: 600;">Reportes Tradicionales del Sistema:</h4>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px;">
            <!-- Reporte Diario -->
            <div style="background: white; border: 1px solid #CBD5E1; border-radius: 12px; padding: 24px; display: flex; flex-direction: column; justify-content: space-between; box-shadow: 0 1px 3px rgba(15,23,42,0.04);">
                <div>
                    <div style="font-size: 32px; margin-bottom: 10px;">📊</div>
                    <h3 style="margin: 0 0 8px; color: #0F172A;">Reporte Diario</h3>
                    <p style="color: #64748B; font-size: 13px; margin: 0 0 15px;">Resumen de asistencia del día</p>
                    <label style="display: block; font-size: 12px; font-weight: 600; color: #334155; margin-bottom: 4px;">Fecha:</label>
                    <input type="date" id="daily-report-date" class="form-control" value="${todayStr}" style="margin-bottom: 15px;">
                </div>
                <button class="btn" style="background: #1E293B; color: #F8FAFC; font-weight: 600;" onclick="generateDailyReport(document.getElementById('daily-report-date').value)">Generar Reporte Diario</button>
            </div>

            <!-- Reporte Semanal -->
            <div style="background: white; border: 1px solid #CBD5E1; border-radius: 12px; padding: 24px; display: flex; flex-direction: column; justify-content: space-between; box-shadow: 0 1px 3px rgba(15,23,42,0.04);">
                <div>
                    <div style="font-size: 32px; margin-bottom: 10px;">📅</div>
                    <h3 style="margin: 0 0 8px; color: #0F172A;">Reporte Semanal</h3>
                    <p style="color: #64748B; font-size: 13px; margin: 0 0 15px;">Asistencia de 7 días hasta la fecha de fin</p>
                    <label style="display: block; font-size: 12px; font-weight: 600; color: #334155; margin-bottom: 4px;">Fecha Fin:</label>
                    <input type="date" id="weekly-report-date" class="form-control" value="${todayStr}" style="margin-bottom: 15px;">
                </div>
                <button class="btn" style="background: #334155; color: #F8FAFC; font-weight: 600;" onclick="generateWeeklyReport(document.getElementById('weekly-report-date').value)">Generar Reporte Semanal</button>
            </div>

            <!-- Reporte Mensual -->
            <div style="background: white; border: 1px solid #CBD5E1; border-radius: 12px; padding: 24px; display: flex; flex-direction: column; justify-content: space-between; box-shadow: 0 1px 3px rgba(15,23,42,0.04);">
                <div>
                    <div style="font-size: 32px; margin-bottom: 10px;">📈</div>
                    <h3 style="margin: 0 0 8px; color: #0F172A;">Reporte Mensual</h3>
                    <p style="color: #64748B; font-size: 13px; margin: 0 0 15px;">Estadísticas del mes</p>
                    <label style="display: block; font-size: 12px; font-weight: 600; color: #334155; margin-bottom: 4px;">Mes y Año:</label>
                    <input type="month" id="monthly-report-month" class="form-control" value="${currentMonth}" style="margin-bottom: 15px;">
                </div>
                <button class="btn" style="background: #1E3A8A; color: #F8FAFC; font-weight: 600;" onclick="onGenerateMonthlyReportClick()">Generar Reporte Mensual</button>
            </div>

            <!-- Reporte Individual por Empleado -->
            <div style="background: white; border: 1px solid #CBD5E1; border-radius: 12px; padding: 24px; display: flex; flex-direction: column; justify-content: space-between; box-shadow: 0 1px 3px rgba(15,23,42,0.04);">
                <div>
                    <div style="font-size: 32px; margin-bottom: 10px;">👤</div>
                    <h3 style="margin: 0 0 8px; color: #0F172A;">Por Empleado</h3>
                    <p style="color: #64748B; font-size: 13px; margin: 0 0 15px;">Historial completo o por rango de fechas</p>
                </div>
                <button class="btn" style="background: #0F172A; color: #F8FAFC; font-weight: 600;" onclick="generateEmployeeReport()">Seleccionar Empleado y Fechas</button>
            </div>
        </div>
    `;
}

/**
 * Alterna entre subtabs en la sección de reportes
 */
function switchReportsSubTab(subTab) {
    const tabAbsences = document.getElementById('tab-btn-absences');
    const tabQA = document.getElementById('tab-btn-qa');
    const contentAbsences = document.getElementById('subtab-content-absences');
    const contentQA = document.getElementById('subtab-content-qa');

    if (subTab === 'absences') {
        if (tabAbsences) { tabAbsences.style.background = '#1E293B'; tabAbsences.style.color = '#F8FAFC'; }
        if (tabQA) { tabQA.style.background = 'transparent'; tabQA.style.color = '#475569'; }
        if (contentAbsences) contentAbsences.style.display = 'block';
        if (contentQA) contentQA.style.display = 'none';
    } else {
        if (tabQA) { tabQA.style.background = '#1E293B'; tabQA.style.color = '#F8FAFC'; }
        if (tabAbsences) { tabAbsences.style.background = 'transparent'; tabAbsences.style.color = '#475569'; }
        if (contentQA) contentQA.style.display = 'block';
        if (contentAbsences) contentAbsences.style.display = 'none';
    }
}

/**
 * Alterna el acordeón mensual de inasistencias
 */
function toggleMonthAbsenceAccordion(monthKey) {
    const content = document.getElementById(`accordion-content-${monthKey}`);
    const icon = document.getElementById(`accordion-icon-${monthKey}`);
    if (!content) return;
    if (content.style.display === 'none') {
        content.style.display = 'block';
        if (icon) icon.textContent = '▼';
    } else {
        content.style.display = 'none';
        if (icon) icon.textContent = '▶';
    }
}

// Estado en memoria de las últimas consultas realizadas (para exportación y descarga)
let currentAbsenceHistoryData = null;
let currentQAQueryResultData = null;

/**
 * Utilidad pura para disparar descarga de archivos desde el navegador
 */
function downloadFile(content, fileName, mimeType = 'text/csv;charset=utf-8;') {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', fileName);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

/**
 * Exporta el historial de faltas actual a formato CSV compatible con Microsoft Excel
 */
function exportAbsenceHistoryToExcel() {
    if (!currentAbsenceHistoryData) {
        showNotification('No hay datos de consulta para exportar a Excel', 'warning');
        return;
    }
    const h = currentAbsenceHistoryData;
    const lines = [];
    lines.push('REPORTE ANALÍTICO DE HISTORIAL DE FALTAS');
    lines.push(`Empleado;${h.employee.first_name} ${h.employee.last_name}`);
    lines.push(`Nómina / Matrícula;${h.employee.employee_code}`);
    lines.push(`Departamento;${h.employee.department_name || 'General'}`);
    lines.push(`Puesto;${h.employee.position || 'Colaborador'}`);
    lines.push(`Total Faltas Acumuladas;${h.totalAbsences}`);
    lines.push(`Meses con Inasistencias;${h.monthsWithAbsencesCount}`);
    lines.push(`Promedio Faltas / Mes;${h.averagePerMonth}`);
    lines.push(`Fecha de Emisión;${new Date().toISOString().split('T')[0]}`);
    lines.push('');
    lines.push('DESGLOSE DETALLADO DE INASISTENCIAS POR MES Y SEMANA');
    lines.push('Año-Mes;Mes;Semana;Día de la Semana;Fecha (YYYY-MM-DD);Notas / Justificación');

    for (let m = 0; m < h.months.length; m++) {
        const month = h.months[m];
        for (let w = 0; w < month.weeks.length; w++) {
            const week = month.weeks[w];
            for (let d = 0; d < week.days.length; d++) {
                const day = week.days[d];
                const cleanNote = (day.notes || '').replace(/;/g, ',').replace(/[\r\n]+/g, ' ');
                lines.push(`${month.monthKey};${month.monthName};${week.weekLabel};${day.dayOfWeek};${day.date};${cleanNote}`);
            }
        }
    }

    const csvContent = '\uFEFF' + lines.join('\r\n');
    const fileName = `Historial_Faltas_${h.employee.employee_code}_${new Date().toISOString().split('T')[0]}.csv`;
    downloadFile(csvContent, fileName);
    showNotification('Historial de faltas exportado a Excel exitosamente (.csv con formato internacional)', 'success');
}

/**
 * Guarda o imprime la consulta como documento PDF mediante el diálogo de Chromium
 */
function exportAbsenceHistoryToPDF() {
    if (!currentAbsenceHistoryData) {
        showNotification('No hay datos para exportar a PDF', 'warning');
        return;
    }
    showNotification('Abriendo diálogo de impresión. Selecciona "Guardar como PDF" como destino.', 'info');
    setTimeout(() => {
        window.print();
    }, 250);
}

/**
 * Imprime directamente la consulta de historial de faltas
 */
function printAbsenceHistory() {
    window.print();
}

/**
 * Exporta el resultado de la consulta Q&A a Excel
 */
function exportQAToExcel() {
    if (!currentQAQueryResultData) {
        showNotification('No hay consulta activa para exportar a Excel', 'warning');
        return;
    }
    const q = currentQAQueryResultData;
    const lines = [];
    lines.push('REPORTE DE CONSULTA DE ASISTENCIA Y PERSONAL');
    lines.push(`Pregunta Formulada;${q.query}`);
    lines.push(`Tipo de Consulta;${q.type || 'General'}`);
    lines.push(`Resumen Ejecutivo;${(q.summary || '').replace(/;/g, ',').replace(/[\r\n]+/g, ' ')}`);
    lines.push(`Fecha de Emisión;${new Date().toISOString().split('T')[0]}`);
    lines.push('');

    if (q.kpis && q.kpis.length > 0) {
        lines.push('MÉTRICAS CLAVE (KPI)');
        lines.push('Indicador;Valor');
        q.kpis.forEach(k => lines.push(`${k.label};${k.value}`));
        lines.push('');
    }

    if (q.data && Array.isArray(q.data)) {
        lines.push('REGISTROS Y DETALLES');
        if (q.type === 'ranking') {
            lines.push('Posición;Nómina;Empleado;Total Faltas');
            q.data.forEach((item, idx) => lines.push(`${idx + 1};${item.code};${item.name};${item.count}`));
        } else if (q.type === 'late') {
            lines.push('Fecha;Entrada;Minutos Tarde;Estado');
            q.data.forEach(r => lines.push(`${r.date};${r.check_in_time || '-'};${r.minutes_late || 0};${r.status}`));
        } else if (q.type === 'time') {
            lines.push('Fecha;Entrada;Salida;Minutos Extra;Estado');
            q.data.forEach(r => lines.push(`${r.date};${r.check_in_time || '-'};${r.check_out_time || '-'};${r.minutes_overtime || 0};${r.status}`));
        }
    }

    const csvContent = '\uFEFF' + lines.join('\r\n');
    downloadFile(csvContent, `Consulta_Personal_${new Date().toISOString().split('T')[0]}.csv`);
    showNotification('Resultado de la consulta exportado a Excel exitosamente', 'success');
}

/**
 * Guarda o imprime la consulta Q&A como PDF
 */
function exportQAToPDF() {
    if (!currentQAQueryResultData) {
        showNotification('No hay consulta activa para exportar a PDF', 'warning');
        return;
    }
    showNotification('Abriendo diálogo de impresión. Selecciona "Guardar como PDF" como destino.', 'info');
    setTimeout(() => {
        window.print();
    }, 250);
}

/**
 * Imprime directamente la consulta Q&A
 */
function printQAResult() {
    window.print();
}

/**
 * Renderiza el árbol visual de historial de faltas de un empleado
 */
function renderAbsenceHistoryHTMLClient(history) {
    currentAbsenceHistoryData = history;
    const emp = history.employee;
    const photoSrc = emp.photo_url || '';
    const initials = `${(emp.first_name || '')[0] || ''}${(emp.last_name || '')[0] || ''}`.toUpperCase();

    const avatarHtml = photoSrc
        ? `<img src="${photoSrc}" style="width: 56px; height: 56px; border-radius: 50%; object-fit: cover; border: 2px solid #EF4444;">`
        : `<div style="width: 56px; height: 56px; border-radius: 50%; background: #EF4444; color: white; display: flex; align-items: center; justify-content: center; font-size: 20px; font-weight: 700;">${initials}</div>`;

    // Día de mayor incidencia
    let mostFrequentDay = 'Ninguno';
    let maxDayVal = 0;
    if (history.dayOfWeekDistribution) {
        for (const [day, count] of Object.entries(history.dayOfWeekDistribution)) {
            if (count > maxDayVal) {
                maxDayVal = count;
                mostFrequentDay = `${day} (${count})`;
            }
        }
    }

    let monthsHTML = '';
    if (history.months.length === 0) {
        monthsHTML = `
            <div style="background: #ECFDF5; border: 2px solid #A7F3D0; border-radius: 12px; padding: 25px; text-align: center; color: #065F46;">
                <span style="font-size: 32px; display: block; margin-bottom: 8px;">🌟</span>
                <strong style="font-size: 16px;">¡Registro Impecable!</strong>
                <p style="margin: 6px 0 0; font-size: 13px;">Este empleado no registra ninguna inasistencia en el sistema. Cumplimiento del 100%.</p>
            </div>
        `;
    } else {
        monthsHTML = history.months.map(m => `
            <div style="margin-bottom: 16px; border: 1px solid #E5E7EB; border-radius: 12px; overflow: hidden; background: white; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
                <div style="background: #F8FAFC; padding: 14px 20px; display: flex; justify-content: space-between; align-items: center; cursor: pointer; border-bottom: 1px solid #E5E7EB;" onclick="toggleMonthAbsenceAccordion('${m.monthKey}')">
                    <div style="display: flex; align-items: center; gap: 12px;">
                        <span style="font-size: 20px;">📅</span>
                        <div>
                            <strong style="color: #1E293B; font-size: 15px;">${escapeHtml(m.monthName)}</strong>
                            <div style="font-size: 12px; color: #64748B;">${m.weeks.length} ${m.weeks.length === 1 ? 'semana con inasistencia' : 'semanas con inasistencias'}</div>
                        </div>
                    </div>
                    <div style="display: flex; align-items: center; gap: 12px;">
                        <span class="badge badge-danger" style="font-size: 13px; padding: 6px 14px; border-radius: 20px; font-weight: 700; background: #EF4444; color: white;">
                            Suma del mes: ${m.totalAbsences} ${m.totalAbsences === 1 ? 'falta' : 'faltas'}
                        </span>
                        <span id="accordion-icon-${m.monthKey}" style="font-size: 14px; color: #64748B;">▼</span>
                    </div>
                </div>
                <div id="accordion-content-${m.monthKey}" style="padding: 18px 20px;">
                    <p style="margin: 0 0 12px; font-size: 13px; color: #475569; font-weight: 600;">
                        🗓️ Desglose semanal: días específicos de falta en ${escapeHtml(m.monthName)}:
                    </p>
                    <div style="display: grid; gap: 12px;">
                        ${m.weeks.map(week => `
                            <div style="background: #FEF2F2; border-left: 4px solid #EF4444; border-radius: 8px; padding: 12px 16px;">
                                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                                    <span style="font-weight: 700; color: #991B1B; font-size: 13px;">${escapeHtml(week.weekLabel)}</span>
                                    <span style="background: #FEE2E2; color: #991B1B; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600;">
                                        ${week.totalDays} ${week.totalDays === 1 ? 'día' : 'días'}
                                    </span>
                                </div>
                                <div style="display: flex; flex-wrap: wrap; gap: 8px;">
                                    ${week.days.map(d => {
                                        const hasNote = Boolean(d.notes && d.notes.trim());
                                        const noteDisplay = hasNote ? `<span style="background: #FEF3C7; color: #92400E; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 500;" title="${escapeHtml(d.notes)}">📝 ${escapeHtml(d.notes)}</span>` : '';
                                        const btnLabel = hasNote ? '✏️ Editar' : '✏️ Justificar';
                                        const btnStyle = hasNote 
                                            ? 'background: #EFF6FF; color: #1D4ED8; border: 1px solid #BFDBFE;' 
                                            : 'background: #FEF2F2; color: #DC2626; border: 1px solid #FCA5A5;';
                                        return `
                                        <div style="background: white; border: 1px solid #E5E7EB; border-radius: 8px; padding: 8px 12px; display: inline-flex; align-items: center; gap: 8px; box-shadow: 0 1px 2px rgba(0,0,0,0.04); flex-wrap: wrap;">
                                            <span style="color: ${hasNote ? '#F59E0B' : '#DC2626'}; font-size: 12px;">${hasNote ? '🟡' : '🔴'}</span>
                                            <strong style="color: #1F2937; font-size: 13px;">${escapeHtml(d.dayOfWeek)}</strong>
                                            <span style="color: #4B5563; font-size: 13px;">${escapeHtml(d.formattedDate)}</span>
                                            ${noteDisplay}
                                            <button type="button" class="btn btn-sm" onclick="openJustifyAbsenceModal(${d.id || 0}, '${escapeHtml(d.date)}', ${emp.id || 0}, '${escapeHtml(emp.employee_code || '')}', '${escapeHtml(d.notes || '')}')" style="padding: 2px 8px; font-size: 11px; border-radius: 6px; cursor: pointer; font-weight: 600; ${btnStyle}" title="Justificar o registrar motivo de la falta con 1 clic">
                                                ${btnLabel}
                                            </button>
                                        </div>
                                        `;
                                    }).join('')}
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
            </div>
        `).join('');
    }

    return `
        <div style="background: white; border: 1px solid #E5E7EB; border-radius: 12px; padding: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.04);">
            <!-- HEADER DEL EMPLEADO Y BARRA DE EXPORTACIÓN -->
            <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 15px; margin-bottom: 20px; padding-bottom: 15px; border-bottom: 1px solid #F3F4F6;">
                <div style="display: flex; align-items: center; gap: 15px;">
                    ${avatarHtml}
                    <div>
                        <h4 style="margin: 0; font-size: 18px; color: #1F2937;">${escapeHtml(emp.first_name)} ${escapeHtml(emp.last_name)}</h4>
                        <div style="display: flex; gap: 10px; margin-top: 4px; font-size: 12px; color: #6B7280; flex-wrap: wrap;">
                            <span style="background: #EFF6FF; color: #1D4ED8; padding: 2px 8px; border-radius: 4px; font-weight: 600;">Nómina: ${escapeHtml(emp.employee_code)}</span>
                            <span>Departamento: <strong>${escapeHtml(emp.department_name || 'General')}</strong></span>
                            <span>Puesto: <strong>${escapeHtml(emp.position || 'Colaborador')}</strong></span>
                        </div>
                    </div>
                </div>
                <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                    ${renderExportButtonsHTML({
                        onExcel: 'exportAbsenceHistoryToExcel()',
                        onPDF: 'exportAbsenceHistoryToPDF()',
                        onPrint: 'printAbsenceHistory()',
                        isSmall: false
                    })}
                </div>
            </div>

            <!-- METRICAS / KPIS -->
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 24px;">
                <div style="background: #FEF2F2; border: 1px solid #FCA5A5; padding: 14px; border-radius: 10px; text-align: center;">
                    <div style="font-size: 26px; font-weight: 800; color: #DC2626;">${history.totalAbsences}</div>
                    <div style="font-size: 12px; color: #991B1B; font-weight: 600; margin-top: 2px;">Faltas Históricas</div>
                </div>
                <div style="background: #FFFBEB; border: 1px solid #FDE68A; padding: 14px; border-radius: 10px; text-align: center;">
                    <div style="font-size: 26px; font-weight: 800; color: #D97706;">${history.monthsWithAbsencesCount}</div>
                    <div style="font-size: 12px; color: #92400E; font-weight: 600; margin-top: 2px;">Meses con Inasistencia</div>
                </div>
                <div style="background: #EFF6FF; border: 1px solid #BFDBFE; padding: 14px; border-radius: 10px; text-align: center;">
                    <div style="font-size: 26px; font-weight: 800; color: #2563EB;">${history.averagePerMonth}</div>
                    <div style="font-size: 12px; color: #1E40AF; font-weight: 600; margin-top: 2px;">Promedio Faltas / Mes</div>
                </div>
                <div style="background: #FAF5FF; border: 1px solid #E9D5FF; padding: 14px; border-radius: 10px; text-align: center;">
                    <div style="font-size: 18px; font-weight: 800; color: #7E22CE; margin-top: 5px;">${escapeHtml(mostFrequentDay)}</div>
                    <div style="font-size: 12px; color: #6B21A8; font-weight: 600; margin-top: 4px;">Día Más Frecuente</div>
                </div>
            </div>

            <!-- LISTA DE MESES Y DESGLOSE SEMANAL -->
            <div style="margin-top: 10px;">
                <h5 style="margin: 0 0 15px; color: #374151; font-size: 14px; font-weight: 700;">
                    📈 Suma Mensual & Días de Inasistencia por Semana:
                </h5>
                ${monthsHTML}
            </div>
        </div>
    `;
}

/**
 * Consulta el historial de faltas ingresando nómina o seleccionando de la lista
 */
async function onSearchEmployeeAbsences() {
    const inputVal = (document.getElementById('absence-employee-input')?.value || '').trim();
    const selectVal = (document.getElementById('absence-employee-select')?.value || '').trim();
    const searchCode = inputVal || selectVal;

    const resultsArea = document.getElementById('absence-history-results-area');
    if (!resultsArea) return;

    if (!searchCode) {
        showNotification('Por favor ingresa o selecciona la nómina/matrícula del empleado', 'warning');
        return;
    }

    resultsArea.innerHTML = `
        <div style="text-align: center; padding: 40px; color: #64748B;">
            <div class="spinner"></div>
            <p style="margin-top: 10px;">Buscando y calculando historial de faltas de ${escapeHtml(searchCode)}...</p>
        </div>
    `;

    try {
        if (!employees || employees.length === 0) {
            await loadEmployees();
        }

        const normSearch = searchCode.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[-_\s]/g, '');
        let targetEmp = (employees || []).find(e => {
            const eCodeNorm = (e.employee_code || '').toLowerCase().replace(/[-_\s]/g, '');
            const idStr = String(e.id);
            const fullNameNorm = `${e.first_name || ''} ${e.last_name || ''}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
            return eCodeNorm === normSearch
                || (e.employee_code || '').toLowerCase() === searchCode.toLowerCase()
                || idStr === searchCode
                || fullNameNorm.includes(searchCode.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
        });

        if (!targetEmp && (normSearch === 'emp001' || normSearch === '001') && employees.length > 0) {
            targetEmp = employees[0];
        }

        if (!targetEmp) {
            resultsArea.innerHTML = `
                <div style="background: #FEF2F2; border: 1px solid #FCA5A5; border-radius: 10px; padding: 25px; text-align: center; color: #991B1B;">
                    <div style="font-size: 32px; margin-bottom: 8px;">❌</div>
                    <strong>No se encontró ningún empleado con la nómina o nombre "${escapeHtml(searchCode)}"</strong>
                    <p style="margin: 6px 0 0; font-size: 13px; color: #B91C1C;">Verifica la matrícula o selecciónalo desde la lista desplegable.</p>
                </div>
            `;
            return;
        }

        const [empRecords, allRecords] = await Promise.all([
            window.attendance.getAttendanceRecords({ employee_id: targetEmp.id }),
            window.attendance.getAttendanceRecords({})
        ]);
        const enrichedRecords = enrichEmployeeRecordsWithOperatingAbsencesClient(allRecords, empRecords, targetEmp);
        const history = calcEmployeeAbsenceHistoryClient(enrichedRecords, targetEmp);
        resultsArea.innerHTML = renderAbsenceHistoryHTMLClient(history);
        showNotification(`Historial de ${targetEmp.first_name} ${targetEmp.last_name} calculado`, 'success');
    } catch (err) {
        logger.error('Error al consultar faltas:', err);
        resultsArea.innerHTML = `
            <div style="background: #FEF2F2; border: 1px solid #FCA5A5; border-radius: 10px; padding: 20px; color: #991B1B;">
                Error al consultar registros de asistencia: ${escapeHtml(err.message)}
            </div>
        `;
    }
}

/**
 * Modal emergente con el historial de faltas de un empleado (invocable desde cualquier parte)
 */
async function showEmployeeAbsenceHistoryModal(employeeCodeOrId) {
    if (!employees || employees.length === 0) {
        await loadEmployees();
    }

    const codeStr = String(employeeCodeOrId || '').trim();
    const norm = codeStr.toLowerCase().replace(/[-_\s]/g, '');
    let emp = (employees || []).find(e => {
        const eCodeNorm = (e.employee_code || '').toLowerCase().replace(/[-_\s]/g, '');
        return eCodeNorm === norm || String(e.id) === codeStr || e.employee_code === codeStr;
    });
    if (!emp && (norm === 'emp001' || norm === '001') && employees.length > 0) {
        emp = employees[0];
    }

    if (!emp) {
        showNotification('Empleado no encontrado', 'error');
        return;
    }

    try {
        showNotification('Generando historial de faltas...', 'info');
        const [empRecords, allRecords] = await Promise.all([
            window.attendance.getAttendanceRecords({ employee_id: emp.id }),
            window.attendance.getAttendanceRecords({})
        ]);
        const enrichedRecords = enrichEmployeeRecordsWithOperatingAbsencesClient(allRecords, empRecords, emp);
        const history = calcEmployeeAbsenceHistoryClient(enrichedRecords, emp);

        openModalShell({
            title: `📅 Historial de Faltas: ${escapeHtml(emp.first_name)} ${escapeHtml(emp.last_name)} (${escapeHtml(emp.employee_code)})`,
            maxWidth: '950px',
            bodyHTML: renderAbsenceHistoryHTMLClient(history),
            footerHTML: `
                <button class="btn btn-secondary" onclick="printAbsenceHistory()">🖨️ Imprimir</button>
                <button class="btn btn-success" onclick="exportAbsenceHistoryToExcel()" style="background: #10B981; color: white;">📊 Guardar en Excel</button>
                <button class="btn btn-danger" onclick="exportAbsenceHistoryToPDF()" style="background: #DC2626; color: white;">📄 Guardar en PDF</button>
                <button class="btn btn-cancel" onclick="closeModal()">Cerrar</button>
            `
        });
    } catch (err) {
        logger.error('Error al abrir modal de faltas:', err);
        showNotification('Error al abrir el historial de faltas', 'error');
    }
}

/**
 * Abre el micro-modal dinámico para justificar una inasistencia (Escritura ágil 1-clic)
 */
function openJustifyAbsenceModal(recordId, dateStr, employeeId, employeeCode, currentNotes = '') {
    // Si ya existe un modal de justificación abierto, removerlo
    const existingModal = document.getElementById('justify-absence-modal-container');
    if (existingModal) existingModal.remove();

    const formattedDate = dateStr ? formatFullDateEsClient(dateStr, true) : 'Fecha no especificada';

    const modalHTML = `
        <div id="justify-absence-modal-container" class="modal active" style="z-index: 9999;" onclick="if(event.target === this) closeJustifyAbsenceModal()">
            <div class="modal-content" style="max-width: 520px; border-radius: 14px; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.2);">
                <div class="modal-header" style="background: #F8FAFC; border-bottom: 1px solid #E2E8F0; padding: 16px 20px; border-top-left-radius: 14px; border-top-right-radius: 14px; display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <h3 style="margin: 0; font-size: 17px; color: #0F172A; display: flex; align-items: center; gap: 8px;">
                            <span>✏️</span> Justificar Inasistencia
                        </h3>
                        <div style="font-size: 12px; color: #64748B; margin-top: 3px;">
                            Empleado: <strong>${escapeHtml(employeeCode)}</strong> &bull; ${escapeHtml(formattedDate)}
                        </div>
                    </div>
                    <button type="button" class="close-btn" onclick="closeJustifyAbsenceModal()" style="font-size: 22px; cursor: pointer; background: transparent; border: none; color: #64748B;">&times;</button>
                </div>
                <div class="modal-body" style="padding: 20px;">
                    <form id="justify-absence-form" onsubmit="event.preventDefault(); submitJustifyAbsence(${recordId}, '${escapeHtml(dateStr)}', ${employeeId}, '${escapeHtml(employeeCode)}');">
                        <div class="form-group" style="margin-bottom: 16px;">
                            <label style="display: block; font-size: 13px; font-weight: 600; color: #334155; margin-bottom: 6px;">
                                Tipo de Justificación / Motivo:
                            </label>
                            <select id="justify-reason-select" class="form-control" style="width: 100%; padding: 8px 12px; border: 1px solid #CBD5E1; border-radius: 8px; font-size: 13px;">
                                <option value="Incapacidad médica">🏥 Incapacidad médica (IMSS / Certificado)</option>
                                <option value="Permiso con goce de sueldo">📋 Permiso con goce de sueldo</option>
                                <option value="Vacaciones autorizadas">🏖️ Vacaciones autorizadas</option>
                                <option value="Asunto personal / Familiar">👨‍👩‍👧 Asunto personal o familiar</option>
                                <option value="Causa de fuerza mayor">⚡ Causa de fuerza mayor / Clima</option>
                                <option value="Comisión de trabajo">💼 Comisión laboral / Trabajo externo</option>
                                <option value="Otro motivo">✍️ Otro motivo justificado</option>
                            </select>
                        </div>

                        <div class="form-group" style="margin-bottom: 16px;">
                            <label style="display: block; font-size: 13px; font-weight: 600; color: #334155; margin-bottom: 6px;">
                                Estado resultante en registro:
                            </label>
                            <select id="justify-status-select" class="form-control" style="width: 100%; padding: 8px 12px; border: 1px solid #CBD5E1; border-radius: 8px; font-size: 13px;">
                                <option value="excused" selected>✅ Justificada (excused - Descuenta de faltas activas)</option>
                                <option value="on_leave">🏖️ Permiso / Licencia (on_leave)</option>
                                <option value="absent">⚠️ Mantener como Falta con nota explicativa (absent)</option>
                            </select>
                        </div>

                        <div class="form-group" style="margin-bottom: 16px;">
                            <label style="display: block; font-size: 13px; font-weight: 600; color: #334155; margin-bottom: 6px;">
                                Folio / Detalle o Comentario Adicional:
                            </label>
                            <textarea id="justify-notes-input" class="form-control" rows="3" placeholder="Ej: Folio médico #A-93821, o autorización de Dirección de Operaciones" style="width: 100%; padding: 8px 12px; border: 1px solid #CBD5E1; border-radius: 8px; font-size: 13px; font-family: inherit;">${escapeHtml(currentNotes)}</textarea>
                            <span style="font-size: 11px; color: #94A3B8; margin-top: 4px; display: block;">Se registrará automáticamente en el expediente de asistencia del empleado.</span>
                        </div>

                        <div id="justify-error-feedback" style="display: none; background: #FEF2F2; color: #991B1B; padding: 10px; border-radius: 6px; font-size: 12px; margin-bottom: 15px;"></div>
                    </form>
                </div>
                <div class="modal-footer" style="background: #F8FAFC; border-top: 1px solid #E2E8F0; padding: 14px 20px; display: flex; justify-content: flex-end; gap: 10px; border-bottom-left-radius: 14px; border-bottom-right-radius: 14px;">
                    <button type="button" class="btn btn-secondary" onclick="closeJustifyAbsenceModal()" style="padding: 8px 16px; font-size: 13px; border-radius: 6px;">
                        Cancelar
                    </button>
                    <button type="button" id="btn-save-justify" class="btn btn-primary" onclick="submitJustifyAbsence(${recordId}, '${escapeHtml(dateStr)}', ${employeeId}, '${escapeHtml(employeeCode)}')" style="padding: 8px 18px; font-size: 13px; border-radius: 6px; background: #1E293B; font-weight: 600; display: inline-flex; align-items: center; gap: 6px;">
                        <span>💾</span> Guardar Justificación
                    </button>
                </div>
            </div>
        </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHTML);
    const textarea = document.getElementById('justify-notes-input');
    if (textarea) textarea.focus();
}

/**
 * Cierra el micro-modal de justificación
 */
function closeJustifyAbsenceModal() {
    const modal = document.getElementById('justify-absence-modal-container');
    if (modal) modal.remove();
}

/**
 * Envía la justificación a persistir en la base de datos (Data Science / Escritura ágil)
 */
async function submitJustifyAbsence(recordId, dateStr, employeeId, employeeCode) {
    const reasonSelect = document.getElementById('justify-reason-select');
    const statusSelect = document.getElementById('justify-status-select');
    const notesInput = document.getElementById('justify-notes-input');
    const saveBtn = document.getElementById('btn-save-justify');
    const feedback = document.getElementById('justify-error-feedback');

    if (!reasonSelect || !statusSelect || !notesInput) return;

    const selectedReason = reasonSelect.value;
    const selectedStatus = statusSelect.value || 'excused';
    const detailNotes = notesInput.value.trim();

    // Construir nota final concatenada
    let finalNote = selectedReason;
    if (detailNotes && detailNotes !== selectedReason) {
        finalNote = `${selectedReason} - ${detailNotes}`;
    }

    try {
        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.innerHTML = '<span>⏳</span> Guardando...';
        }

        const payload = {
            action: 'justify',
            recordId: recordId > 0 ? recordId : undefined,
            employeeId: employeeId > 0 ? employeeId : undefined,
            date: dateStr,
            notes: finalNote,
            status: selectedStatus
        };

        const result = await window.attendance.getAttendanceRecords(payload);

        if (result && result.success === false) {
            throw new Error(result.message || 'Error al guardar la justificación');
        }

        showNotification(`Falta del ${dateStr} justificada con éxito`, 'success');
        closeJustifyAbsenceModal();

        // Refrescar vistas activas en tiempo real:
        // 1. Si hay un contenedor de resultados en la pestaña de reportes, refrescarlo:
        const resultsArea = document.getElementById('absence-history-results-area');
        if (resultsArea && resultsArea.innerHTML.trim() !== '') {
            onSearchEmployeeAbsences();
        }

        // 2. Si hay un modal abierto con el historial de faltas de este empleado:
        const openHistoryModals = document.querySelectorAll('.modal.active');
        if (openHistoryModals.length > 0) {
            for (let m of openHistoryModals) {
                if (m.id !== 'justify-absence-modal-container') {
                    m.remove();
                    showEmployeeAbsenceHistoryModal(employeeCode || employeeId);
                    break;
                }
            }
        }

    } catch (err) {
        logger.error('Error al justificar falta:', err);
        if (feedback) {
            feedback.textContent = `Error: ${err.message || 'No se pudo guardar la justificación'}`;
            feedback.style.display = 'block';
        }
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.innerHTML = '<span>💾</span> Guardar Justificación';
        }
    }
}

/**
 * Ejecuta una consulta formulada en lenguaje natural
 */
async function onExecuteDomainQuestion() {
    const query = (document.getElementById('qa-query-input')?.value || '').trim();
    if (!query) {
        showNotification('Por favor escribe una pregunta sobre el personal', 'warning');
        return;
    }
    await processAndRenderDomainQuestion(query);
}

/**
 * Ejecuta una pregunta sugerida rápida
 */
async function onQuickDomainQuestion(questionText) {
    const input = document.getElementById('qa-query-input');
    if (input) input.value = questionText;
    await processAndRenderDomainQuestion(questionText);
}

/**
 * Motor de procesamiento y renderizado de preguntas de dominio (NLP & Data Science)
 */
async function processAndRenderDomainQuestion(rawQuery) {
    const resultsArea = document.getElementById('qa-query-results-area');
    if (!resultsArea) return;

    resultsArea.innerHTML = `
        <div style="text-align: center; padding: 40px; color: #64748B;">
            <div class="spinner"></div>
            <p style="margin-top: 10px;">Analizando consulta y correlacionando registros...</p>
        </div>
    `;

    try {
        if (!employees || employees.length === 0) await loadEmployees();
        const attendanceRecords = await window.attendance.getAttendanceRecords();

        // Normalización y extracción de palabras clave
        const norm = rawQuery.toLowerCase()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/[¿?¡!.,:;]/g, ' ').replace(/\s+/g, ' ').trim();

        const checkW = words => words.some(w => new RegExp(`\\b${w}\\b`).test(norm));
        const hasAbsence = checkW(['falta', 'faltas', 'falto', 'ausente', 'ausentes', 'ausencia', 'ausencias', 'inasistencia', 'inasistencias']);
        const hasLate = checkW(['retardo', 'retardos', 'tarde', 'tardanza', 'tardanzas', 'demora', 'retraso', 'impuntual']);
        const hasTime = checkW(['tiempo', 'hora', 'horas', 'jornada', 'trabajadas', 'trabajado', 'sobretiempo', 'duracion']);
        const hasRanking = checkW(['mas', 'menos', 'top', 'mayor', 'menor', 'quien', 'cuales', 'ranking']);

        // Localizar empleado por código, nombre completo o nombre/apellido individual
        let targetEmp = null;
        for (let i = 0; i < employees.length; i++) {
            const e = employees[i];
            const codeNorm = (e.employee_code || '').toLowerCase().replace(/[-_]/g, '');
            if (e.employee_code && (
                new RegExp(`\\b${e.employee_code.toLowerCase().replace('-', '[-_]?')}\\b`, 'i').test(norm) ||
                new RegExp(`\\b${codeNorm}\\b`, 'i').test(norm.replace(/[-_]/g, ''))
            )) {
                targetEmp = e;
                break;
            }
            const fName = `${e.first_name || ''} ${e.last_name || ''}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
            if (fName.length > 3 && norm.includes(fName)) {
                targetEmp = e;
                break;
            }
            const nameTokens = fName.split(/\s+/).filter(t => t.length >= 3);
            if (nameTokens.some(token => new RegExp(`\\b${token}\\b`, 'i').test(norm))) {
                targetEmp = e;
                break;
            }
        }

        // Alias de compatibilidad si el usuario escribió EMP-001
        if (!targetEmp && /\bemp[-_]?0*1\b/i.test(norm) && employees.length > 0) {
            targetEmp = employees[0];
        }

        // Caso 1: Historial o días de falta de un empleado
        if (targetEmp && (hasAbsence || /dias|semana|mes|historial/i.test(norm) || (!hasTime && !hasLate))) {
            const empRecords = attendanceRecords.filter(r => r.employee_id === targetEmp.id);
            const enrichedEmpRecords = enrichEmployeeRecordsWithOperatingAbsencesClient(attendanceRecords, empRecords, targetEmp);
            const history = calcEmployeeAbsenceHistoryClient(enrichedEmpRecords, targetEmp);
            resultsArea.innerHTML = `
                <div style="background: white; border: 1px solid #CBD5E1; border-radius: 12px; padding: 20px; box-shadow: 0 2px 4px rgba(15,23,42,0.04);">
                    <div style="background: #F8FAFC; border: 1px solid #CBD5E1; border-left: 4px solid #334155; padding: 12px 16px; border-radius: 6px; margin-bottom: 20px;">
                        <strong style="color: #0F172A; font-size: 14px;">💬 Respuesta Contextual:</strong>
                        <p style="margin: 4px 0 0; color: #334155; font-size: 13px;">
                            ${history.totalAbsences === 0 
                                ? `El colaborador ${escapeHtml(targetEmp.first_name)} ${escapeHtml(targetEmp.last_name)} (${escapeHtml(targetEmp.employee_code)}) no registra ninguna falta en el sistema.`
                                : `El empleado ${escapeHtml(targetEmp.first_name)} ${escapeHtml(targetEmp.last_name)} (${escapeHtml(targetEmp.employee_code)}) acumula <strong>${history.totalAbsences} faltas</strong> en <strong>${history.monthsWithAbsencesCount} mes(es)</strong>, con un promedio de ${history.averagePerMonth} faltas por mes.`
                            }
                        </p>
                    </div>
                    ${renderAbsenceHistoryHTMLClient(history)}
                </div>
            `;
            return;
        }

        // Caso 2: Retardos de un empleado
        if (targetEmp && hasLate) {
            const lates = attendanceRecords.filter(r => r.employee_id === targetEmp.id && r.status === 'late');
            const totalMins = lates.reduce((acc, r) => acc + (r.minutes_late || 0), 0);
            const summary = lates.length === 0 
                ? `${targetEmp.first_name} ${targetEmp.last_name} (${targetEmp.employee_code}) no registra retardos. Mantiene 100% de puntualidad en sus jornadas registradas.`
                : `El colaborador ${targetEmp.first_name} ${targetEmp.last_name} acumula ${lates.length} llegadas tarde con un total de ${totalMins} minutos de demora acumulada.`;

            currentQAQueryResultData = {
                query: rawQuery,
                type: 'late',
                summary,
                kpis: [
                    { label: 'Total Retardos', value: lates.length },
                    { label: 'Minutos Tarde Acumulados', value: `${totalMins} min` }
                ],
                data: lates
            };

            resultsArea.innerHTML = `
                <div style="background: white; border: 1px solid #CBD5E1; border-radius: 12px; padding: 20px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; border-bottom: 1px solid #E2E8F0; padding-bottom: 10px; flex-wrap: wrap; gap: 8px;">
                        <span style="font-weight: 700; color: #0F172A; font-size: 14px;">Análisis de Impuntualidad (${escapeHtml(targetEmp.first_name)} ${escapeHtml(targetEmp.last_name)})</span>
                        <div style="display: flex; gap: 8px;">
                            ${renderExportButtonsHTML({ onPrint: 'printQAResult()', isSmall: true })}
                        </div>
                    </div>
                    <div style="background: #F8FAFC; border: 1px solid #CBD5E1; border-left: 4px solid #D97706; padding: 12px 16px; border-radius: 6px; margin-bottom: 20px;">
                        <strong style="color: #92400E; font-size: 14px;">💬 Análisis de Impuntualidad:</strong>
                        <p style="margin: 4px 0 0; color: #334155; font-size: 13px;">
                            ${escapeHtml(summary)}
                        </p>
                    </div>
                    <table class="data-table">
                        <thead>
                            <tr><th>Fecha</th><th>Entrada</th><th>Minutos Tarde</th><th>Estado</th></tr>
                        </thead>
                        <tbody>
                            ${lates.map(r => `
                                <tr>
                                    <td>${escapeHtml(r.date)}</td>
                                    <td>${escapeHtml(r.check_in_time || '-')}</td>
                                    <td><span class="badge badge-warning">${r.minutes_late || 0} min</span></td>
                                    <td><span class="badge badge-warning">Tarde</span></td>
                                </tr>
                            `).join('') || '<tr><td colspan="4" style="text-align:center; color: #64748B;">Sin retardos registrados (100% puntualidad)</td></tr>'}
                        </tbody>
                    </table>
                </div>
            `;
            return;
        }

        // Caso 3: Tiempo trabajado de un empleado
        if (targetEmp && hasTime) {
            const attended = attendanceRecords.filter(r => r.employee_id === targetEmp.id && (r.status === 'present' || r.status === 'late'));
            let totalMins = attended.length * 480;
            let overtimeMins = attended.reduce((acc, r) => acc + (r.minutes_overtime || 0), 0);
            const totalHours = (totalMins / 60).toFixed(1);
            const otHours = (overtimeMins / 60).toFixed(1);
            const summary = `${targetEmp.first_name} ${targetEmp.last_name} (${targetEmp.employee_code}) ha laborado aproximadamente ${totalHours} horas en ${attended.length} jornadas registradas, con ${otHours} horas de sobretiempo.`;

            currentQAQueryResultData = {
                query: rawQuery,
                type: 'time',
                summary,
                kpis: [
                    { label: 'Tiempo Laborado', value: `${totalHours} hrs` },
                    { label: 'Días Asistidos', value: attended.length },
                    { label: 'Sobretiempo Extra', value: `${otHours} hrs` }
                ],
                data: attended
            };

            resultsArea.innerHTML = `
                <div style="background: white; border: 1px solid #CBD5E1; border-radius: 12px; padding: 20px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; border-bottom: 1px solid #E2E8F0; padding-bottom: 10px; flex-wrap: wrap; gap: 8px;">
                        <span style="font-weight: 700; color: #0F172A; font-size: 14px;">Balance de Tiempo Laborado (${escapeHtml(targetEmp.first_name)} ${escapeHtml(targetEmp.last_name)})</span>
                        <div style="display: flex; gap: 8px;">
                            ${renderExportButtonsHTML({ onPrint: 'printQAResult()', isSmall: true })}
                        </div>
                    </div>
                    <div style="background: #F8FAFC; border: 1px solid #CBD5E1; border-left: 4px solid #059669; padding: 12px 16px; border-radius: 6px; margin-bottom: 20px;">
                        <strong style="color: #065F46; font-size: 14px;">💬 Balance de Tiempo Laborado:</strong>
                        <p style="margin: 4px 0 0; color: #334155; font-size: 13px;">
                            ${escapeHtml(summary)}
                        </p>
                    </div>
                    <div class="metric-card-grid" style="margin-bottom: 20px;">
                        <div style="background: #F8FAFC; border: 1px solid #CBD5E1; padding: 15px; border-radius: 8px; text-align: center;">
                            <div style="font-size: 24px; font-weight: 800; color: #0F172A;">${totalHours} hrs</div>
                            <div style="font-size: 12px; color: #475569; font-weight: 600;">Tiempo Laborado</div>
                        </div>
                        <div style="background: #F8FAFC; border: 1px solid #CBD5E1; padding: 15px; border-radius: 8px; text-align: center;">
                            <div style="font-size: 24px; font-weight: 800; color: #1E3A8A;">${attended.length}</div>
                            <div style="font-size: 12px; color: #475569; font-weight: 600;">Días Asistidos</div>
                        </div>
                        <div style="background: #F8FAFC; border: 1px solid #CBD5E1; padding: 15px; border-radius: 8px; text-align: center;">
                            <div style="font-size: 24px; font-weight: 800; color: #B45309;">${otHours} hrs</div>
                            <div style="font-size: 12px; color: #475569; font-weight: 600;">Sobretiempo (Extra)</div>
                        </div>
                    </div>
                    ${attended.length > 0 ? `
                        <table class="data-table">
                            <thead>
                                <tr><th>Fecha</th><th>Entrada</th><th>Salida</th><th>Estado</th></tr>
                            </thead>
                            <tbody>
                                ${attended.map(r => `
                                    <tr>
                                        <td>${escapeHtml(r.date)}</td>
                                        <td>${escapeHtml(r.check_in_time || '-')}</td>
                                        <td>${escapeHtml(r.check_out_time || '-')}</td>
                                        <td>${renderStatusBadge(r.status)}</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    ` : ''}
                </div>
            `;
            return;
        }

        // Caso 4: Ranking de faltas (Top ausentismo)
        if (hasRanking && hasAbsence) {
            const ranking = (employees || [])
                .map(emp => {
                    const empRecs = attendanceRecords.filter(r => r.employee_id === emp.id);
                    const enriched = enrichEmployeeRecordsWithOperatingAbsencesClient(attendanceRecords, empRecs, emp);
                    const absentCount = enriched.filter(r => r.status === 'absent').length;
                    return {
                        id: emp.id,
                        code: emp.employee_code || `EMP-${emp.id}`,
                        name: `${emp.first_name} ${emp.last_name}`,
                        count: absentCount
                    };
                })
                .sort((a, b) => b.count - a.count)
                .slice(0, 5);

            const summary = ranking.length > 0 && ranking[0].count > 0
                ? `El colaborador con más faltas acumuladas es ${ranking[0].name} (${ranking[0].code}) con ${ranking[0].count} inasistencia(s).`
                : 'Ningún colaborador activo registra faltas en las jornadas operativas del sistema.';

            currentQAQueryResultData = {
                query: rawQuery,
                type: 'ranking',
                summary,
                kpis: [
                    { label: 'Líder en Faltas', value: ranking[0]?.name || 'N/A' },
                    { label: 'Faltas Registradas', value: ranking[0]?.count || 0 }
                ],
                data: ranking
            };

            resultsArea.innerHTML = `
                <div style="background: white; border: 1px solid #CBD5E1; border-radius: 12px; padding: 20px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; border-bottom: 1px solid #E2E8F0; padding-bottom: 10px; flex-wrap: wrap; gap: 8px;">
                        <span style="font-weight: 700; color: #0F172A; font-size: 14px;">Ranking de Ausentismo</span>
                        <div style="display: flex; gap: 8px;">
                            ${renderExportButtonsHTML({ onPrint: 'printQAResult()', isSmall: true })}
                        </div>
                    </div>
                    <div style="background: #F8FAFC; border: 1px solid #CBD5E1; border-left: 4px solid #DC2626; padding: 12px 16px; border-radius: 6px; margin-bottom: 20px;">
                        <strong style="color: #991B1B; font-size: 14px;">💬 Ranking de Ausentismo:</strong>
                        <p style="margin: 4px 0 0; color: #334155; font-size: 13px;">
                            ${escapeHtml(summary)}
                        </p>
                    </div>
                    <div style="display: grid; gap: 10px;">
                        ${ranking.map((item, idx) => `
                            <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; background: #F8FAFC; border-radius: 8px; border: 1px solid #CBD5E1;">
                                <div style="display: flex; align-items: center; gap: 12px;">
                                    <span style="font-weight: 800; color: #475569; width: 24px;">#${idx + 1}</span>
                                    <div>
                                        <strong style="color: #0F172A;">${escapeHtml(item.name)}</strong>
                                        <span style="color: #64748B; font-size: 12px; margin-left: 6px;">(${escapeHtml(item.code)})</span>
                                    </div>
                                </div>
                                <span class="badge ${item.count > 0 ? 'badge-danger' : 'badge-success'}" style="font-size: 13px; font-weight: 700; padding: 6px 12px;">${item.count} ${item.count === 1 ? 'falta' : 'faltas'}</span>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;
            return;
        }

        // Caso 5: Resumen global / multivariable
        const absCount = attendanceRecords.filter(r => r.status === 'absent').length;
        const lateCount = attendanceRecords.filter(r => r.status === 'late').length;
        const presentCount = attendanceRecords.filter(r => r.status === 'present').length;
        const total = attendanceRecords.length;
        const attRate = total > 0 ? (((presentCount + lateCount) / total) * 100).toFixed(1) : '100.0';
        const summary = `Plantilla de ${employees.length} colaboradores con una tasa de asistencia acumulada de ${attRate}% en ${total} registros históricos (${presentCount} asistencias puntuales, ${lateCount} retardos y ${absCount} ausencias registradas).`;

        currentQAQueryResultData = {
            query: rawQuery,
            type: 'global',
            summary,
            kpis: [
                { label: 'Plantilla Total', value: employees.length },
                { label: 'Tasa Asistencia', value: `${attRate}%` },
                { label: 'Total Inasistencias', value: absCount },
                { label: 'Total Retardos', value: lateCount }
            ],
            data: []
        };

        resultsArea.innerHTML = `
            <div style="background: white; border: 1px solid #CBD5E1; border-radius: 12px; padding: 20px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; border-bottom: 1px solid #E2E8F0; padding-bottom: 10px; flex-wrap: wrap; gap: 8px;">
                    <span style="font-weight: 700; color: #0F172A; font-size: 14px;">Panorama General de Asistencia</span>
                    <div style="display: flex; gap: 8px;">
                        ${renderExportButtonsHTML({ onPrint: 'printQAResult()', isSmall: true })}
                    </div>
                </div>
                <div style="background: #F8FAFC; border: 1px solid #CBD5E1; border-left: 4px solid #334155; padding: 12px 16px; border-radius: 6px; margin-bottom: 20px;">
                    <strong style="color: #0F172A; font-size: 14px;">💬 Panorama General de Asistencia:</strong>
                    <p style="margin: 4px 0 0; color: #334155; font-size: 13px;">
                        ${escapeHtml(summary)}
                    </p>
                </div>
                <div class="metric-card-grid">
                    <div style="background: #F8FAFC; border: 1px solid #CBD5E1; padding: 15px; border-radius: 8px; text-align: center;">
                        <div style="font-size: 24px; font-weight: 800; color: #0F172A;">${employees.length}</div>
                        <div style="font-size: 12px; color: #475569; font-weight: 600;">Plantilla Total</div>
                    </div>
                    <div style="background: #F8FAFC; border: 1px solid #CBD5E1; padding: 15px; border-radius: 8px; text-align: center;">
                        <div style="font-size: 24px; font-weight: 800; color: #047857;">${attRate}%</div>
                        <div style="font-size: 12px; color: #475569; font-weight: 600;">Tasa de Asistencia</div>
                    </div>
                    <div style="background: #F8FAFC; border: 1px solid #CBD5E1; padding: 15px; border-radius: 8px; text-align: center;">
                        <div style="font-size: 24px; font-weight: 800; color: #B91C1C;">${absCount}</div>
                        <div style="font-size: 12px; color: #475569; font-weight: 600;">Total Inasistencias</div>
                    </div>
                    <div style="background: #F8FAFC; border: 1px solid #CBD5E1; padding: 15px; border-radius: 8px; text-align: center;">
                        <div style="font-size: 24px; font-weight: 800; color: #B45309;">${lateCount}</div>
                        <div style="font-size: 12px; color: #475569; font-weight: 600;">Total Retardos</div>
                    </div>
                </div>
            </div>
        `;
    } catch (err) {
        logger.error('Error al procesar pregunta:', err);
        resultsArea.innerHTML = `
            <div style="background: #FEF2F2; border: 1px solid #FCA5A5; border-radius: 10px; padding: 20px; color: #991B1B;">
                Error al procesar la pregunta: ${escapeHtml(err.message)}
            </div>
        `;
    }
}

function onGenerateMonthlyReportClick() {
    const val = document.getElementById('monthly-report-month')?.value;
    if (val && val.includes('-')) {
        const [yearStr, monthStr] = val.split('-');
        generateMonthlyReport(parseInt(yearStr, 10), parseInt(monthStr, 10));
    } else {
        generateMonthlyReport();
    }
}

async function generateDailyReport(date) {
    try {
        showNotification('Generando reporte diario...', 'info');
        const report = await window.reports.generateDaily(date || undefined);
        lastDailyReportData = report;

        const bannerContentHTML = `
            <h4 style="margin: 0 0 12px; font-size: 19px; color: #0F172A; text-transform: capitalize;">
                ${formatReportDateEs(report.date, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
            </h4>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-top: 12px;">
                <div style="background: #FFFFFF; border: 1px solid #CBD5E1; border-left: 4px solid #059669; padding: 12px; border-radius: 8px; text-align: center;">
                    <div style="font-size: 26px; font-weight: 700; color: #047857;">${report.stats.present}</div>
                    <div style="font-size: 12px; color: #475569; font-weight: 600;">Presentes</div>
                </div>
                <div style="background: #FFFFFF; border: 1px solid #CBD5E1; border-left: 4px solid #D97706; padding: 12px; border-radius: 8px; text-align: center;">
                    <div style="font-size: 26px; font-weight: 700; color: #B45309;">${report.stats.late}</div>
                    <div style="font-size: 12px; color: #475569; font-weight: 600;">Tarde</div>
                </div>
                <div style="background: #FFFFFF; border: 1px solid #CBD5E1; border-left: 4px solid #DC2626; padding: 12px; border-radius: 8px; text-align: center;">
                    <div style="font-size: 26px; font-weight: 700; color: #B91C1C;">${report.stats.absent}</div>
                    <div style="font-size: 12px; color: #475569; font-weight: 600;">Ausentes</div>
                </div>
                <div style="background: #FFFFFF; border: 1px solid #CBD5E1; border-left: 4px solid #334155; padding: 12px; border-radius: 8px; text-align: center;">
                    <div style="font-size: 26px; font-weight: 700; color: #0F172A;">${report.stats.verified}</div>
                    <div style="font-size: 12px; color: #475569; font-weight: 600;">Verificados</div>
                </div>
            </div>
        `;

        const bodyContentHTML = `
            <div style="margin-bottom: 20px;">
                <h4 style="margin-bottom: 15px; color: #0F172A;">Estadísticas Generales</h4>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                    <div style="padding: 15px; background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 8px;">
                        <div style="color: #64748B; font-size: 13px;">Total Empleados Activos</div>
                        <div style="font-size: 24px; font-weight: 600; color: #0F172A;">${report.totalEmployees}</div>
                    </div>
                    <div style="padding: 15px; background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 8px;">
                        <div style="color: #64748B; font-size: 13px;">Promedio Retraso</div>
                        <div style="font-size: 24px; font-weight: 600; color: #0F172A;">${report.stats.avgLateMinutes} min</div>
                    </div>
                </div>
            </div>

            ${report.records.length > 0 ? `
                <div>
                    <h4 style="margin-bottom: 15px; color: #0F172A;">Detalle de Asistencias de Plantilla (${report.records.length})</h4>
                    <div style="max-height: 400px; overflow-y: auto;">
                        <table style="width: 100%; font-size: 13px;">
                            <thead style="position: sticky; top: 0; background: #F8FAFC;">
                                <tr>
                                    <th>Empleado</th>
                                    <th>Departamento</th>
                                    <th>Entrada</th>
                                    <th>Salida</th>
                                    <th>Estado</th>
                                    <th>Verificado</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${report.records.map(rec => `
                                    <tr>
                                        <td><strong>${escapeHtml(rec.employee_name || '-')}</strong></td>
                                        <td>${escapeHtml(rec.department_name || '-')}</td>
                                        <td>${escapeHtml(rec.check_in_time || '-')}</td>
                                        <td>${escapeHtml(rec.check_out_time || '-')}</td>
                                        <td>${renderStatusBadge(rec.status)}</td>
                                        <td style="text-align: center;">${rec.fingerprint_verified ? '✓' : '-'}</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
            ` : '<p style="text-align:center; padding: 2rem; color: #64748B;">No hay registros para este día</p>'}
        `;

        const modalHTML = renderReportModalShell({
            title: '📊 Reporte Diario de Asistencia',
            accentColor: '#1E293B',
            bannerContentHTML,
            bodyContentHTML,
            maxWidth: '900px',
            onExcel: 'exportDailyReportToExcel()'
        });
        document.body.insertAdjacentHTML('beforeend', modalHTML);
    } catch (error) {
        logger.error('Error generando reporte diario:', error);
        showNotification('Error al generar el reporte diario', 'error');
    }
}

async function generateWeeklyReport(endDate) {
    try {
        showNotification('Generando reporte semanal...', 'info');
        const report = await window.reports.generateWeekly(endDate || undefined);
        lastWeeklyReportData = report;

        const bannerContentHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; margin-bottom: 14px;">
                <div>
                    <div style="font-size: 12px; font-weight: 600; color: #64748B; text-transform: uppercase; letter-spacing: 0.5px;">Período Consultado</div>
                    <h4 style="margin: 4px 0 0; font-size: 18px; color: #0F172A;">
                        ${formatReportDateEs(report.startDate)} — ${formatReportDateEs(report.endDate)}
                    </h4>
                </div>
            </div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                <div style="background: #FFFFFF; border: 1px solid #CBD5E1; padding: 12px 16px; border-radius: 8px;">
                    <div style="font-size: 12px; color: #64748B; font-weight: 600;">Total Registros en la Semana</div>
                    <div style="font-size: 26px; font-weight: 700; color: #0F172A; margin-top: 4px;">${report.totalRecords}</div>
                </div>
                <div style="background: #FFFFFF; border: 1px solid #CBD5E1; padding: 12px 16px; border-radius: 8px;">
                    <div style="font-size: 12px; color: #64748B; font-weight: 600;">Promedio Diario</div>
                    <div style="font-size: 26px; font-weight: 700; color: #0F172A; margin-top: 4px;">${Math.round(report.avgDailyAttendance)}</div>
                </div>
            </div>
        `;

        const bodyContentHTML = `
            ${report.dailyStats.length > 0 ? `
                <div style="margin-bottom: 25px;">
                    <h4 style="margin-bottom: 15px; color: #0F172A;">Resumen Diario</h4>
                    <table style="width: 100%;">
                        <thead>
                            <tr>
                                <th>Fecha</th>
                                <th>Total</th>
                                <th>Presentes</th>
                                <th>Tarde</th>
                                <th>Ausentes</th>
                                <th>Verificados</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${report.dailyStats.map(day => `
                                <tr>
                                    <td>${formatReportDateEs(day.date, { weekday: 'short', day: 'numeric', month: 'short' })}</td>
                                    <td><strong>${day.total}</strong></td>
                                    <td><span class="badge badge-success">${day.present}</span></td>
                                    <td><span class="badge badge-warning">${day.late}</span></td>
                                    <td><span class="badge badge-danger">${day.absent}</span></td>
                                    <td>${day.verified}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            ` : ''}

            <div>
                <h4 style="margin-bottom: 15px; color: #0F172A;">Todos los Registros (${report.records.length})</h4>
                ${report.records.length > 0 ? `
                <div style="max-height: 300px; overflow-y: auto;">
                    <table style="width: 100%; font-size: 13px;">
                        <thead style="position: sticky; top: 0; background: #F8FAFC;">
                            <tr>
                                <th>Fecha</th>
                                <th>Empleado</th>
                                <th>Entrada</th>
                                <th>Estado</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${report.records.map(rec => `
                                <tr>
                                    <td>${formatReportDateEs(rec.date, { day: '2-digit', month: '2-digit', year: 'numeric' })}</td>
                                    <td>${escapeHtml(rec.employee_name || '-')}</td>
                                    <td>${escapeHtml(rec.check_in_time || '-')}</td>
                                    <td>${renderStatusBadge(rec.status)}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
                ` : '<p style="text-align:center; padding: 1.5rem; color: #64748B; background: #F8FAFC; border: 1px dashed #CBD5E1; border-radius: 8px;">No se registraron marcaciones en este rango de 7 días.</p>'}
            </div>
        `;

        const modalHTML = renderReportModalShell({
            title: '📅 Reporte Semanal de Asistencia',
            accentColor: '#334155',
            bannerContentHTML,
            bodyContentHTML,
            maxWidth: '900px',
            onExcel: 'exportWeeklyReportToExcel()'
        });
        document.body.insertAdjacentHTML('beforeend', modalHTML);
    } catch (error) {
        logger.error('Error generando reporte semanal:', error);
        showNotification('Error al generar el reporte semanal', 'error');
    }
}

async function generateMonthlyReport(year, month) {
    try {
        showNotification('Generando reporte mensual...', 'info');
        const report = await window.reports.generateMonthly(year || undefined, month || undefined);
        lastMonthlyReportData = report;

        const bannerContentHTML = `
            <h4 style="margin: 0 0 14px; font-size: 20px; color: #0F172A; text-transform: capitalize;">${escapeHtml(report.monthName)}</h4>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(125px, 1fr)); gap: 12px;">
                <div style="background: #FFFFFF; border: 1px solid #CBD5E1; border-left: 4px solid #334155; padding: 12px; border-radius: 8px; text-align: center;">
                    <div style="font-size: 24px; font-weight: 700; color: #0F172A;">${report.totalStats.totalRecords}</div>
                    <div style="font-size: 11px; color: #475569; font-weight: 600;">Total Registros</div>
                </div>
                <div style="background: #FFFFFF; border: 1px solid #CBD5E1; border-left: 4px solid #059669; padding: 12px; border-radius: 8px; text-align: center;">
                    <div style="font-size: 24px; font-weight: 700; color: #047857;">${report.totalStats.present}</div>
                    <div style="font-size: 11px; color: #475569; font-weight: 600;">Presentes</div>
                </div>
                <div style="background: #FFFFFF; border: 1px solid #CBD5E1; border-left: 4px solid #D97706; padding: 12px; border-radius: 8px; text-align: center;">
                    <div style="font-size: 24px; font-weight: 700; color: #B45309;">${report.totalStats.late}</div>
                    <div style="font-size: 11px; color: #475569; font-weight: 600;">Tarde</div>
                </div>
                <div style="background: #FFFFFF; border: 1px solid #CBD5E1; border-left: 4px solid #DC2626; padding: 12px; border-radius: 8px; text-align: center;">
                    <div style="font-size: 24px; font-weight: 700; color: #B91C1C;">${report.totalStats.absent}</div>
                    <div style="font-size: 11px; color: #475569; font-weight: 600;">Ausentes</div>
                </div>
                <div style="background: #FFFFFF; border: 1px solid #CBD5E1; border-left: 4px solid #1E3A8A; padding: 12px; border-radius: 8px; text-align: center;">
                    <div style="font-size: 24px; font-weight: 700; color: #1E3A8A;">${report.totalStats.verified}</div>
                    <div style="font-size: 11px; color: #475569; font-weight: 600;">Verificados</div>
                </div>
            </div>
        `;

        const bodyContentHTML = `
            ${report.employeeStats.length > 0 ? `
                <div>
                    <h4 style="margin-bottom: 15px; color: #0F172A;">Estadísticas por Empleado (${report.employeeStats.length})</h4>
                    <div style="max-height: 500px; overflow-y: auto;">
                        <table style="width: 100%; font-size: 13px;">
                            <thead style="position: sticky; top: 0; background: #F8FAFC;">
                                <tr>
                                    <th>Código</th>
                                    <th>Empleado</th>
                                    <th>Días</th>
                                    <th>Presente</th>
                                    <th>Tarde</th>
                                    <th>Ausente</th>
                                    <th>Retraso (min)</th>
                                    <th>% Asistencia</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${report.employeeStats.map(emp => {
                                    const attendanceRate = safeParseFloat(emp.attendanceRate, 0);
                                    const rateColor = attendanceRate >= 95 ? '#047857' : attendanceRate >= 80 ? '#B45309' : '#B91C1C';
                                    return `
                                    <tr>
                                        <td><strong>${escapeHtml(emp.employeeCode)}</strong></td>
                                        <td>${escapeHtml(emp.employeeName)}</td>
                                        <td><strong>${emp.totalDays}</strong></td>
                                        <td><span class="badge badge-success">${emp.presentDays}</span></td>
                                        <td><span class="badge badge-warning">${emp.lateDays}</span></td>
                                        <td><span class="badge badge-danger">${emp.absentDays}</span></td>
                                        <td>${emp.totalLateMinutes}</td>
                                        <td><span style="color: ${rateColor}; font-weight: 700;">${emp.attendanceRate}%</span></td>
                                    </tr>
                                    `;
                                }).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
            ` : '<p style="text-align:center; padding: 2rem; color: #64748B;">No hay datos para este mes</p>'}
        `;

        const modalHTML = renderReportModalShell({
            title: '📈 Reporte Mensual de Asistencia',
            accentColor: '#1E3A8A',
            bannerContentHTML,
            bodyContentHTML,
            maxWidth: '1000px',
            onExcel: 'exportMonthlyReportToExcel()'
        });
        document.body.insertAdjacentHTML('beforeend', modalHTML);
    } catch (error) {
        logger.error('Error generando reporte mensual:', error);
        showNotification('Error al generar el reporte mensual', 'error');
    }
}

async function generateEmployeeReport() {
    if (!employees || employees.length === 0) {
        try {
            await loadEmployees();
        } catch (_) {}
    }

    // Mostrar selector de empleado y período
    const bodyHTML = `
        <div class="form-group">
            <label>Seleccione el empleado *:</label>
            <select id="report-employee-select" class="form-control" required>
                <option value="">Seleccione...</option>
                ${employees.map(emp => `
                    <option value="${emp.id}">${escapeHtml(emp.first_name)} ${escapeHtml(emp.last_name)} (${escapeHtml(emp.employee_code)})</option>
                `).join('')}
            </select>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-top: 15px;">
            <div class="form-group">
                <label>Fecha Desde (Opcional — vacío = todo el historial):</label>
                <input type="date" id="report-emp-start" class="form-control">
            </div>
            <div class="form-group">
                <label>Fecha Hasta (Opcional — vacío = hasta hoy):</label>
                <input type="date" id="report-emp-end" class="form-control">
            </div>
        </div>
    `;
    const footerHTML = `
        <button class="btn btn-cancel" onclick="closeModal()">Cancelar</button>
        <button class="btn" style="background: #1E293B; color: #F8FAFC; font-weight: 600;" onclick="showEmployeeReportDetails()">Generar Reporte</button>
    `;
    openModalShell({
        title: '👤 Seleccionar Empleado y Período',
        maxWidth: '600px',
        bodyHTML,
        footerHTML
    });
}

async function showEmployeeReportDetails() {
    const employeeId = document.getElementById('report-employee-select')?.value;
    if (!employeeId) {
        showNotification('Por favor seleccione un empleado', 'warning');
        return;
    }
    const startDate = document.getElementById('report-emp-start')?.value || undefined;
    const endDate = document.getElementById('report-emp-end')?.value || undefined;

    try {
        closeModal();
        showNotification('Generando reporte del empleado...', 'info');
        const report = await window.reports.generateEmployee(safeParseInt(employeeId, 0), startDate, endDate);
        lastEmployeeReportData = report;

        const deptLabel = report.employee.department_name || 'Sin departamento';
        const shiftLabel = report.employee.shift_name || 'Sin turno';

        const bannerContentHTML = `
            <div style="display: flex; align-items: center; gap: 20px; margin-bottom: 15px;">
                <div style="width: 72px; height: 72px; border-radius: 50%; background: #334155; border: 3px solid #CBD5E1; color: #F8FAFC; display: flex; align-items: center; justify-content: center; font-size: 28px; font-weight: 700; flex-shrink: 0;">
                    ${getInitials(report.employee.first_name, report.employee.last_name)}
                </div>
                <div>
                    <h3 style="margin: 0; font-size: 22px; color: #0F172A;">${escapeHtml(report.employee.first_name)} ${escapeHtml(report.employee.last_name)}</h3>
                    <div style="color: #475569; font-size: 13px; margin-top: 5px; font-weight: 500;">
                        Nómina: <strong>${escapeHtml(report.employee.employee_code)}</strong> &bull; ${escapeHtml(deptLabel)} &bull; ${escapeHtml(shiftLabel)}
                    </div>
                </div>
            </div>
            <div style="border-top: 1px solid #CBD5E1; padding-top: 12px; font-size: 13px; color: #334155; font-weight: 600;">
                Período consultado: ${formatReportDateEs(report.period.startDate)} — ${formatReportDateEs(report.period.endDate)}
            </div>
        `;

        const bodyContentHTML = `
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 15px; margin-bottom: 25px;">
                <div style="padding: 15px; background: #F8FAFC; border: 1px solid #CBD5E1; border-radius: 8px; border-left: 4px solid #059669;">
                    <div style="color: #475569; font-size: 12px; font-weight: 600; margin-bottom: 5px;">Registros Totales</div>
                    <div style="font-size: 28px; font-weight: 700; color: #047857;">${report.stats.totalDays}</div>
                </div>
                <div style="padding: 15px; background: #F8FAFC; border: 1px solid #CBD5E1; border-radius: 8px; border-left: 4px solid #D97706;">
                    <div style="color: #475569; font-size: 12px; font-weight: 600; margin-bottom: 5px;">Días Tarde</div>
                    <div style="font-size: 28px; font-weight: 700; color: #B45309;">${report.stats.lateDays}</div>
                </div>
                <div style="padding: 15px; background: #F8FAFC; border: 1px solid #CBD5E1; border-radius: 8px; border-left: 4px solid #DC2626;">
                    <div style="color: #475569; font-size: 12px; font-weight: 600; margin-bottom: 5px;">Días Ausente</div>
                    <div style="font-size: 28px; font-weight: 700; color: #B91C1C;">${report.stats.absentDays}</div>
                </div>
                <div style="padding: 15px; background: #F8FAFC; border: 1px solid #CBD5E1; border-radius: 8px; border-left: 4px solid #1E3A8A;">
                    <div style="color: #475569; font-size: 12px; font-weight: 600; margin-bottom: 5px;">% Asistencia</div>
                    <div style="font-size: 28px; font-weight: 700; color: #1E3A8A;">${report.stats.attendanceRate}%</div>
                </div>
            </div>

            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 25px;">
                <div style="padding: 15px; background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 8px;">
                    <div style="color: #64748B; font-size: 13px; margin-bottom: 8px;">Retraso Promedio</div>
                    <div style="font-size: 20px; font-weight: 600; color: #0F172A;">${report.stats.avgLateMinutes} minutos</div>
                    <div style="color: #64748B; font-size: 12px; margin-top: 5px;">Total: ${report.stats.totalLateMinutes} min</div>
                </div>
                <div style="padding: 15px; background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 8px;">
                    <div style="color: #64748B; font-size: 13px; margin-bottom: 8px;">Tiempo Extra Promedio</div>
                    <div style="font-size: 20px; font-weight: 600; color: #0F172A;">${report.stats.avgOvertimeMinutes} minutos</div>
                    <div style="color: #64748B; font-size: 12px; margin-top: 5px;">Total: ${report.stats.totalOvertimeMinutes} min</div>
                </div>
                <div style="padding: 15px; background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 8px;">
                    <div style="color: #64748B; font-size: 13px; margin-bottom: 8px;">Verificaciones Biométricas</div>
                    <div style="font-size: 20px; font-weight: 600; color: #0F172A;">${report.stats.verifiedDays}/${report.stats.totalDays}</div>
                </div>
                <div style="padding: 15px; background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 8px;">
                    <div style="color: #64748B; font-size: 13px; margin-bottom: 8px;">Huellas Registradas</div>
                    <div style="font-size: 20px; font-weight: 600; color: #0F172A;">${report.fingerprints}/10</div>
                </div>
            </div>

            ${report.records.length > 0 ? `
                <div>
                    <h4 style="margin-bottom: 15px; color: #0F172A;">Historial de Asistencia (${report.records.length} registros)</h4>
                    <div style="max-height: 350px; overflow-y: auto;">
                        <table style="width: 100%; font-size: 13px;">
                            <thead style="position: sticky; top: 0; background: #F8FAFC;">
                                <tr>
                                    <th>Fecha</th>
                                    <th>Entrada</th>
                                    <th>Salida</th>
                                    <th>Estado</th>
                                    <th>Retraso</th>
                                    <th>Verificado</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${report.records.map(rec => `
                                    <tr>
                                        <td>${formatReportDateEs(rec.date)}</td>
                                        <td>${escapeHtml(rec.check_in_time || '-')}</td>
                                        <td>${escapeHtml(rec.check_out_time || '-')}</td>
                                        <td>${renderStatusBadge(rec.status)}</td>
                                        <td>${rec.minutes_late ? rec.minutes_late + ' min' : '-'}</td>
                                        <td style="text-align: center;">${rec.fingerprint_verified ? '✓' : '-'}</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
            ` : '<p style="text-align:center; padding: 2rem; color: #64748B;">No hay registros en el período seleccionado</p>'}
        `;

        const modalHTML = renderReportModalShell({
            title: '👤 Reporte Individual de Empleado',
            accentColor: '#0F172A',
            bannerContentHTML,
            bodyContentHTML,
            maxWidth: '900px',
            onExcel: 'exportEmployeeReportToExcel()'
        });
        document.body.insertAdjacentHTML('beforeend', modalHTML);
    } catch (error) {
        logger.error('Error generando reporte de empleado:', error);
        showNotification('Error al generar el reporte del empleado', 'error');
    }
}

function printReport() {
    window.print();
}

// Variables en memoria para exportación de reportes a Excel
let lastDailyReportData = null;
let lastWeeklyReportData = null;
let lastMonthlyReportData = null;
let lastEmployeeReportData = null;

function exportDailyReportToExcel() {
    if (!lastDailyReportData) {
        showNotification('No hay datos del reporte diario para exportar', 'warning');
        return;
    }
    const r = lastDailyReportData;
    const lines = [];
    lines.push('REPORTE DIARIO DE ASISTENCIA');
    lines.push(`Fecha;${r.date}`);
    lines.push(`Total Empleados;${r.totalEmployees}`);
    lines.push(`Presentes;${r.stats.present}`);
    lines.push(`Tarde;${r.stats.late}`);
    lines.push(`Ausentes;${r.stats.absent}`);
    lines.push(`Verificados Biométrica;${r.stats.verified}`);
    lines.push(`Promedio Retraso (min);${r.stats.avgLateMinutes}`);
    lines.push('');
    lines.push('DETALLE DE ASISTENCIAS');
    lines.push('Empleado;Departamento;Entrada;Salida;Estado;Verificado');
    for (const rec of (r.records || [])) {
        lines.push(`"${rec.employee_name || '-'}";"${rec.department_name || '-'}";"${rec.check_in_time || '-'}";"${rec.check_out_time || '-'}";"${rec.status || '-'}";"${rec.fingerprint_verified ? 'SÍ' : 'NO'}"`);
    }
    const csv = '\uFEFF' + lines.join('\r\n');
    downloadFile(csv, `Reporte_Diario_${r.date}.csv`);
    showNotification('Reporte diario exportado a Excel exitosamente (.csv)', 'success');
}

function exportWeeklyReportToExcel() {
    if (!lastWeeklyReportData) {
        showNotification('No hay datos del reporte semanal para exportar', 'warning');
        return;
    }
    const r = lastWeeklyReportData;
    const lines = [];
    lines.push('REPORTE SEMANAL DE ASISTENCIA');
    lines.push(`Período;${r.startDate} a ${r.endDate}`);
    lines.push(`Total Registros;${r.totalRecords}`);
    lines.push(`Promedio Diario;${Math.round(r.avgDailyAttendance || 0)}`);
    lines.push('');
    lines.push('RESUMEN DIARIO');
    lines.push('Fecha;Total;Presentes;Tarde;Ausentes;Verificados');
    for (const d of (r.dailyStats || [])) {
        lines.push(`"${d.date}";"${d.total}";"${d.present}";"${d.late}";"${d.absent}";"${d.verified}"`);
    }
    lines.push('');
    lines.push('TODOS LOS REGISTROS');
    lines.push('Fecha;Empleado;Entrada;Estado');
    for (const rec of (r.records || [])) {
        lines.push(`"${rec.date}";"${rec.employee_name || '-'}";"${rec.check_in_time || '-'}";"${rec.status || '-'}"`);
    }
    const csv = '\uFEFF' + lines.join('\r\n');
    downloadFile(csv, `Reporte_Semanal_${r.startDate}_${r.endDate}.csv`);
    showNotification('Reporte semanal exportado a Excel exitosamente (.csv)', 'success');
}

function exportMonthlyReportToExcel() {
    if (!lastMonthlyReportData) {
        showNotification('No hay datos del reporte mensual para exportar', 'warning');
        return;
    }
    const r = lastMonthlyReportData;
    const lines = [];
    lines.push('REPORTE MENSUAL DE ASISTENCIA');
    lines.push(`Mes;${r.monthName}`);
    lines.push(`Total Registros;${r.totalStats.totalRecords}`);
    lines.push(`Presentes;${r.totalStats.present}`);
    lines.push(`Tarde;${r.totalStats.late}`);
    lines.push(`Ausentes;${r.totalStats.absent}`);
    lines.push(`Verificados;${r.totalStats.verified}`);
    lines.push('');
    lines.push('ESTADÍSTICAS POR EMPLEADO');
    lines.push('Código;Empleado;Días Totales;Presente;Tarde;Ausente;Retraso (min);% Asistencia');
    for (const emp of (r.employeeStats || [])) {
        lines.push(`"${emp.employeeCode}";"${emp.employeeName}";"${emp.totalDays}";"${emp.presentDays}";"${emp.lateDays}";"${emp.absentDays}";"${emp.totalLateMinutes}";"${emp.attendanceRate}%"`);
    }
    const csv = '\uFEFF' + lines.join('\r\n');
    downloadFile(csv, `Reporte_Mensual_${(r.monthName || 'mes').replace(/\s+/g, '_')}.csv`);
    showNotification('Reporte mensual exportado a Excel exitosamente (.csv)', 'success');
}

function exportEmployeeReportToExcel() {
    if (!lastEmployeeReportData) {
        showNotification('No hay datos del reporte de empleado para exportar', 'warning');
        return;
    }
    const r = lastEmployeeReportData;
    const lines = [];
    lines.push('REPORTE INDIVIDUAL DE EMPLEADO');
    lines.push(`Empleado;${r.employee.first_name} ${r.employee.last_name}`);
    lines.push(`Nómina;${r.employee.employee_code}`);
    lines.push(`Departamento;${r.employee.department_name || 'Sin departamento'}`);
    lines.push(`Turno;${r.employee.shift_name || 'Sin turno'}`);
    lines.push(`Período;${r.period.startDate} a ${r.period.endDate}`);
    lines.push(`Días Registrados;${r.stats.totalDays}`);
    lines.push(`Días Presente;${r.stats.presentDays}`);
    lines.push(`Días Tarde;${r.stats.lateDays}`);
    lines.push(`Días Ausente;${r.stats.absentDays}`);
    lines.push(`Tasa Asistencia;${r.stats.attendanceRate}%`);
    lines.push(`Minutos Tarde Totales;${r.stats.totalLateMinutes}`);
    lines.push(`Tiempo Extra (min);${r.stats.totalOvertimeMinutes}`);
    lines.push('');
    lines.push('HISTORIAL DE ASISTENCIA');
    lines.push('Fecha;Entrada;Salida;Estado;Retraso (min);Verificado Biométrico');
    for (const rec of (r.records || [])) {
        lines.push(`"${rec.date}";"${rec.check_in_time || '-'}";"${rec.check_out_time || '-'}";"${rec.status || '-'}";"${rec.minutes_late || 0}";"${rec.fingerprint_verified ? 'SÍ' : 'NO'}"`);
    }
    const csv = '\uFEFF' + lines.join('\r\n');
    downloadFile(csv, `Reporte_Empleado_${r.employee.employee_code}_${r.period.startDate}_${r.period.endDate}.csv`);
    showNotification('Reporte de empleado exportado a Excel exitosamente (.csv)', 'success');
}

// ==================== SETTINGS SECTION ====================

function handleBiometricPolicyChange(checked) {
    const manualCheckbox = document.getElementById('setting-allow-manual');
    const notice = document.getElementById('biometric-policy-notice');
    if (manualCheckbox) {
        if (checked) {
            manualCheckbox.checked = false;
            manualCheckbox.disabled = true;
            if (notice) notice.style.display = 'block';
        } else {
            manualCheckbox.disabled = false;
            if (notice) notice.style.display = 'none';
        }
    }
}

function handleNotificationMasterChange(checked) {
    const lateAlerts = document.getElementById('setting-late-alerts');
    const bioFailAlerts = document.getElementById('setting-biometric-fail-alerts');
    const subContainer = document.getElementById('sub-alerts-container');
    if (lateAlerts) lateAlerts.disabled = !checked;
    if (bioFailAlerts) bioFailAlerts.disabled = !checked;
    if (subContainer) subContainer.style.opacity = checked ? '1' : '0.5';
}

async function loadSettingsSection() {
    const container = document.querySelector('#settings-section .card-body');
    if (!container) return;

    // Sincronizar con SQLite (system_config) si está disponible en window.config
    try {
        if (window.config && typeof window.config.get === 'function') {
            const cfg = await window.config.get();
            if (cfg && cfg.systemConfig && Object.keys(cfg.systemConfig).length > 0) {
                const sc = cfg.systemConfig;
                systemSecurityState.hasAdminPin = sc.has_admin_pin === '1';
                systemSecurityState.kioskLockEnabled = sc.kiosk_lock_enabled === '1';
                const current = loadSavedSettings();
                const merged = {
                    ...current,
                    absentTime: sc.auto_mark_absent_time || current.absentTime,
                    gracePeriodMinutes: sc.grace_period_minutes ? safeParseInt(sc.grace_period_minutes, 10) : current.gracePeriodMinutes,
                    requireCheckout: sc.require_checkout !== undefined ? sc.require_checkout === '1' : current.requireCheckout,
                    allowManual: sc.allow_manual_entry !== undefined ? sc.allow_manual_entry === '1' : current.allowManual,
                    requireBiometric: sc.require_biometric !== undefined ? sc.require_biometric === '1' : current.requireBiometric,
                    cooldownSeconds: sc.cooldown_seconds ? safeParseInt(sc.cooldown_seconds, 60) : current.cooldownSeconds,
                    captureTimeoutSeconds: sc.capture_timeout_seconds ? safeParseInt(sc.capture_timeout_seconds, 20) : current.captureTimeoutSeconds,
                    audioFeedback: sc.audio_feedback !== undefined ? sc.audio_feedback === '1' : current.audioFeedback,
                    successDuration: sc.success_duration ? safeParseInt(sc.success_duration, 4) : current.successDuration,
                    enableNotifications: sc.notification_enabled !== undefined ? sc.notification_enabled === '1' : current.enableNotifications,
                    lateAlerts: sc.late_alerts !== undefined ? sc.late_alerts === '1' : current.lateAlerts,
                    biometricFailAlerts: sc.biometric_fail_alerts !== undefined ? sc.biometric_fail_alerts === '1' : current.biometricFailAlerts,
                    autoStartListening: sc.auto_start_listening !== undefined ? sc.auto_start_listening === '1' : current.autoStartListening,
                    kioskLock: sc.kiosk_lock_enabled !== undefined ? sc.kiosk_lock_enabled === '1' : current.kioskLock,
                    workDays: sc.work_days ? sc.work_days.split(',').map(n => safeParseInt(n, 1)) : current.workDays,
                    autoBackupsDir: sc.auto_backups_dir || '',
                    autoBackupsCount: sc.auto_backups_count || '0'
                };
                localStorage.setItem('attendance_settings', JSON.stringify(merged));
            }
        }
    } catch (e) {
        logger.warn('No se pudo sincronizar configuración desde SQLite:', e);
    }

    // Cargar configuración guardada
    const settings = loadSavedSettings();
    const isBioReq = !!settings.requireBiometric;
    const isNotifOn = !!settings.enableNotifications;

    container.innerHTML = `
        <div style="max-width: 800px; margin: 0 auto;">
            <div class="banner-gradient" style="background: #F8FAFC; color: #0F172A; border: 1px solid #CBD5E1; border-left: 4px solid #334155; margin-bottom: 24px;">
                <h3 style="margin: 0 0 6px; font-size: 20px; color: #0F172A;">⚙️ Configuración del Sistema</h3>
                <p style="margin: 0; color: #475569; font-size: 14px;">Administre las directivas de control de asistencia, hardware biométrico y experiencia operativa.</p>
            </div>

            <!-- Card 1: Asistencia y Políticas -->
            <div class="card" style="margin-bottom: 20px;">
                <div class="card-header">
                    <h4 style="margin: 0;">📋 Políticas de Asistencia</h4>
                </div>
                <div class="card-body">
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
                        <div class="form-group" style="margin-bottom: 15px;">
                            <label><strong>Hora para ausencias automáticas</strong></label>
                            <input type="time" id="setting-absent-time" class="form-control" value="${escapeHtml(settings.absentTime)}">
                            <small style="color: #6B7280; font-size: 12px;">Hora a partir de la cual se computa falta para quienes no marcaron.</small>
                        </div>

                        <div class="form-group" style="margin-bottom: 15px;">
                            <label><strong>Tolerancia de retardo (minutos)</strong></label>
                            <input type="number" id="setting-grace-period" class="form-control" min="0" max="60" value="${settings.gracePeriodMinutes}">
                            <small style="color: #6B7280; font-size: 12px;">Margen de cortesía antes de registrar retardo (SQLite: grace_period_minutes).</small>
                        </div>
                    </div>

                    <div class="form-group" style="margin-bottom: 15px;">
                        <label style="display: flex; align-items: center; gap: 10px; cursor: pointer;">
                            <input type="checkbox" id="setting-require-checkout" ${settings.requireCheckout ? 'checked' : ''}>
                            <span><strong>Requiere registrar salida</strong></span>
                        </label>
                        <small style="color: #6B7280; margin-left: 28px; display: block;">Los empleados deben fichar tanto su entrada como su salida de jornada.</small>
                    </div>

                    <div class="form-group" style="margin-bottom: 15px;">
                        <label style="display: flex; align-items: center; gap: 10px; cursor: pointer;">
                            <input type="checkbox" id="setting-require-biometric" ${isBioReq ? 'checked' : ''}
                                   onchange="handleBiometricPolicyChange(this.checked)">
                            <span><strong>Verificación biométrica obligatoria (Política estricta)</strong></span>
                        </label>
                        <small style="color: #6B7280; margin-left: 28px; display: block;">Bloquea cualquier registro si la huella no coincide o el lector no está disponible.</small>
                    </div>

                    <div class="form-group" style="margin-bottom: 10px;">
                        <label style="display: flex; align-items: center; gap: 10px; cursor: pointer;">
                            <input type="checkbox" id="setting-allow-manual" ${settings.allowManual && !isBioReq ? 'checked' : ''} ${isBioReq ? 'disabled' : ''}>
                            <span><strong>Permitir marcación manual en pantalla</strong></span>
                        </label>
                        <small style="color: #6B7280; margin-left: 28px; display: block;">Permite a los empleados seleccionar su nombre desde la lista en pantalla.</small>
                    </div>

                    <div id="biometric-policy-notice" style="display: ${isBioReq ? 'block' : 'none'}; padding: 12px 14px; background: #EFF6FF; border-left: 4px solid #3B82F6; border-radius: 6px; font-size: 13px; color: #1E40AF; margin-top: 10px;">
                        ℹ️ <strong>Candado de seguridad activo:</strong> La marcación manual se encuentra deshabilitada automáticamente porque la verificación biométrica es obligatoria.
                    </div>
                </div>
            </div>

            <!-- Card 2: Lector Biométrico DP4500 -->
            <div class="card" style="margin-bottom: 20px;">
                <div class="card-header">
                    <h4 style="margin: 0;">🎧 Lector de Huellas (DP4500) y Operación</h4>
                </div>
                <div class="card-body">
                    <div class="form-group" style="margin-bottom: 15px;">
                        <label style="display: flex; align-items: center; gap: 10px; cursor: pointer;">
                            <input type="checkbox" id="setting-auto-start-listening" ${settings.autoStartListening ? 'checked' : ''}>
                            <span><strong>Iniciar escucha continua automáticamente al arrancar</strong></span>
                        </label>
                        <small style="color: #6B7280; margin-left: 28px; display: block;">El lector DP4500 se activa de inmediato en segundo plano para identificar huellas.</small>
                    </div>

                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 15px;">
                        <div class="form-group">
                            <label><strong>Tiempo de espera por captura</strong></label>
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <input type="number" id="setting-capture-timeout" class="form-control" style="width: 100px;" min="10" max="60" value="${settings.captureTimeoutSeconds || 20}">
                                <span style="color: #4B5563; font-size: 13px;">segundos</span>
                            </div>
                            <small style="color: #6B7280; font-size: 12px;">Espera máxima para apoyar el dedo antes de cancelar.</small>
                        </div>

                        <div class="form-group">
                            <label><strong>Tiempo anti-doble marcación (Cooldown)</strong></label>
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <input type="number" id="setting-cooldown-seconds" class="form-control" style="width: 100px;" min="0" max="300" value="${settings.cooldownSeconds || 60}">
                                <span style="color: #4B5563; font-size: 13px;">segundos</span>
                            </div>
                            <small style="color: #6B7280; font-size: 12px;">Margen de espera entre marcaciones consecutivas del mismo empleado.</small>
                        </div>
                    </div>

                    <div class="form-group" style="margin-bottom: 0;">
                        <label style="display: flex; align-items: center; gap: 10px; cursor: pointer;">
                            <input type="checkbox" id="setting-audio-feedback" ${settings.audioFeedback ? 'checked' : ''}>
                            <span><strong>Confirmación auditiva (Beep de asistencia)</strong></span>
                        </label>
                        <small style="color: #6B7280; margin-left: 28px; display: block;">Emite un tono acústico armónico al validar la huella o un tono grave de alerta si falla.</small>
                    </div>
                </div>
            </div>

            <!-- Card 3: Notificaciones y Pantalla -->
            <div class="card" style="margin-bottom: 20px;">
                <div class="card-header">
                    <h4 style="margin: 0;">🔔 Notificaciones y Pantalla</h4>
                </div>
                <div class="card-body">
                    <div class="form-group" style="margin-bottom: 15px;">
                        <label style="display: flex; align-items: center; gap: 10px; cursor: pointer;">
                            <input type="checkbox" id="setting-notifications" ${isNotifOn ? 'checked' : ''}
                                   onchange="handleNotificationMasterChange(this.checked)">
                            <span><strong>Activar notificaciones del sistema (Maestro)</strong></span>
                        </label>
                    </div>

                    <div id="sub-alerts-container" style="opacity: ${isNotifOn ? '1' : '0.5'}; transition: opacity 0.2s; margin-left: 28px; display: flex; flex-direction: column; gap: 12px; margin-bottom: 15px;">
                        <label style="display: flex; align-items: center; gap: 10px; cursor: pointer;">
                            <input type="checkbox" id="setting-late-alerts" ${settings.lateAlerts ? 'checked' : ''} ${!isNotifOn ? 'disabled' : ''}>
                            <span>Alertar cuando un empleado llega tarde</span>
                        </label>

                        <label style="display: flex; align-items: center; gap: 10px; cursor: pointer;">
                            <input type="checkbox" id="setting-biometric-fail-alerts" ${settings.biometricFailAlerts ? 'checked' : ''} ${!isNotifOn ? 'disabled' : ''}>
                            <span>Alertar cuando falla la verificación biométrica</span>
                        </label>
                    </div>

                    <div class="form-group" style="margin-bottom: 0;">
                        <label><strong>Duración de mensaje en pantalla</strong></label>
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <input type="number" id="setting-success-duration" class="form-control" style="width: 100px;" min="2" max="10" value="${settings.successDuration || 4}">
                            <span style="color: #4B5563; font-size: 13px;">segundos (predeterminado: 4s)</span>
                        </div>
                        <small style="color: #6B7280; font-size: 12px;">Tiempo de permanencia del banner de confirmación en pantalla.</small>
                    </div>
                </div>
            </div>

            <!-- Card 4: Seguridad y Modo Kiosco -->
            <div class="card" style="margin-bottom: 20px; border: 1px solid #CBD5E1;">
                <div class="card-header" style="background: #F8FAFC; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap;">
                    <h4 style="margin: 0; color: #0F172A; display: flex; align-items: center; gap: 8px;">
                        🔐 Seguridad y Modo Kiosco
                    </h4>
                    <span style="font-size: 12px; font-weight: 700; padding: 3px 8px; border-radius: 999px; background: ${systemSecurityState.hasAdminPin ? '#DCFCE7' : '#FEF3C7'}; color: ${systemSecurityState.hasAdminPin ? '#166534' : '#92400E'};">
                        ${systemSecurityState.hasAdminPin ? (systemSecurityState.isUnlocked ? '🔓 PIN Activo (Sesión Abierta)' : '🔒 PIN Activo (Protegido)') : '⚠️ Sin PIN Configurado'}
                    </span>
                </div>
                <div class="card-body">
                    <p style="font-size: 13.5px; color: #475569; margin: 0 0 16px;">
                        Proteja las configuraciones críticas, la exportación/restauración de la base de datos y limite la navegación en pantalla mediante un PIN de Administrador (almacenado con hash SHA-256 seguro).
                    </p>
                    <div style="display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 16px;">
                        <button type="button" class="btn" onclick="openAdminPinSetupModal()"
                                style="background: #1E293B; color: #F8FAFC; font-weight: 600; font-size: 13px; padding: 8px 14px;">
                            ${systemSecurityState.hasAdminPin ? '🔑 Cambiar / Eliminar PIN de Administrador' : '➕ Configurar PIN de Administrador'}
                        </button>
                        ${systemSecurityState.hasAdminPin ? `
                            <button type="button" class="btn" onclick="toggleAdminLockManual()"
                                    style="background: ${systemSecurityState.isUnlocked ? '#DC2626' : '#059669'}; color: white; font-weight: 600; font-size: 13px; padding: 8px 14px;">
                                ${systemSecurityState.isUnlocked ? '🔒 Bloquear Sesión Ahora' : '🔓 Desbloquear Sesión con PIN'}
                            </button>
                        ` : ''}
                    </div>

                    <div class="form-group" style="margin-bottom: 0; padding-top: 12px; border-top: 1px solid #E2E8F0;">
                        <label style="display: flex; align-items: center; gap: 10px; cursor: pointer;">
                            <input type="checkbox" id="setting-kiosk-lock" ${settings.kioskLock ? 'checked' : ''} ${!systemSecurityState.hasAdminPin ? 'disabled' : ''}>
                            <span><strong>Activar Modo Kiosco Estricto (Restringe navegación a "Marcar Asistencia")</strong></span>
                        </label>
                        <small style="color: #6B7280; margin-left: 28px; display: block;">
                            ${systemSecurityState.hasAdminPin
                                ? 'Al activarse, las secciones de Empleados, Turnos, Reportes y Ajustes quedan bloqueadas hasta ingresar el PIN.'
                                : 'Debe configurar primero un PIN de Administrador para poder activar el Modo Kiosco.'}
                        </small>
                    </div>
                </div>
            </div>

            <!-- Card 5: Días Laborables y Corte de Faltas -->
            <div class="card" style="margin-bottom: 20px; border: 1px solid #CBD5E1;">
                <div class="card-header" style="background: #F8FAFC; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap;">
                    <h4 style="margin: 0; color: #0F172A; display: flex; align-items: center; gap: 8px;">
                        📅 Días Laborables y Automatización de Faltas
                    </h4>
                </div>
                <div class="card-body">
                    <p style="font-size: 13.5px; color: #475569; margin: 0 0 14px;">
                        Seleccione los días de la semana en los cuales opera el corte automático de faltas. Los días no marcados serán omitidos por el planificador de fondo.
                    </p>
                    <div style="display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 18px;" data-role="work-days-checkboxes">
                        ${[
                            { id: 1, label: 'Lun' },
                            { id: 2, label: 'Mar' },
                            { id: 3, label: 'Mié' },
                            { id: 4, label: 'Jue' },
                            { id: 5, label: 'Vie' },
                            { id: 6, label: 'Sáb' },
                            { id: 0, label: 'Dom' }
                        ].map(d => {
                            const isChecked = (settings.workDays || [1,2,3,4,5]).includes(d.id);
                            return `
                                <label style="display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; background: #F8FAFC; border: 1px solid #CBD5E1; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 600;">
                                    <input type="checkbox" class="work-day-chk" data-day="${d.id}" ${isChecked ? 'checked' : ''}>
                                    <span>${d.label}</span>
                                </label>
                            `;
                        }).join('')}
                    </div>

                    <div style="padding: 14px; background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 8px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px;">
                        <div>
                            <strong style="color: #0F172A; font-size: 13.5px;">⚡ Ejecución Manual del Corte de Faltas:</strong>
                            <p style="margin: 2px 0 0; color: #64748B; font-size: 12px;">Computa inasistencias de la jornada actual para quienes no tengan registro de entrada.</p>
                        </div>
                        <button type="button" class="btn" onclick="executeAbsentCutoffNow()"
                                style="background: #334155; color: white; font-size: 12.5px; padding: 7px 14px; font-weight: 600;">
                            ⚡ Realizar Corte de Faltas Ahora
                        </button>
                    </div>
                </div>
            </div>

            <!-- Card 6: Respaldos de Base de Datos y Resiliencia -->
            <div class="card" style="margin-bottom: 20px; border: 1px solid #CBD5E1;">
                <div class="card-header" style="background: #F8FAFC;">
                    <h4 style="margin: 0; color: #0F172A; display: flex; align-items: center; gap: 8px;">
                        💾 Copias de Seguridad y Restauración de Base de Datos
                    </h4>
                </div>
                <div class="card-body">
                    <p style="font-size: 13.5px; color: #475569; margin: 0 0 14px;">
                        El sistema genera respaldos automáticos diarios fuera del repositorio (carpeta segura del sistema operativo) con rotación continua de 7 días. También puede exportar o restaurar archivos SQLite manualmente.
                    </p>

                    <div style="background: #F8FAFC; border: 1px solid #CBD5E1; border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; font-size: 12.5px; color: #334155;">
                        <div><strong>Directorio de respaldos automáticos:</strong> <code style="background: white; padding: 2px 6px; border: 1px solid #CBD5E1; border-radius: 4px;">${escapeHtml(settings.autoBackupsDir || 'Carpeta del Sistema Operativo')}</code></div>
                        <div style="margin-top: 4px;"><strong>Copias automáticas conservadas:</strong> ${settings.autoBackupsCount || '0'} respaldo(s)</div>
                    </div>

                    <div style="display: flex; gap: 10px; flex-wrap: wrap;">
                        <button type="button" class="btn" onclick="handleExportDatabaseBackup()"
                                style="background: #059669; color: white; font-weight: 600; font-size: 13px; padding: 8px 14px;">
                            💾 Exportar Respaldo SQLite Seguro
                        </button>
                        <button type="button" class="btn" onclick="handleRestoreDatabaseBackup()"
                                style="background: #2563EB; color: white; font-weight: 600; font-size: 13px; padding: 8px 14px;">
                            📥 Restaurar Base de Datos desde Respaldo
                        </button>
                    </div>
                </div>
            </div>

            <!-- Card 7: Dispositivo Biométrico y Controladores -->
            <div class="card" style="margin-bottom: 20px; border: 1px solid #DBEAFE;">
                <div class="card-header" style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; background: linear-gradient(135deg, #EFF6FF 0%, #F8FAFC 100%);">
                    <h4 style="margin: 0; color: #1E3A8A; display: flex; align-items: center; gap: 8px;">
                        🔌 Dispositivo Biométrico y Versión de Controladores
                    </h4>
                    <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                        <button type="button" class="btn" data-role="biometric-service-toggle-btn" onclick="toggleBiometricServiceManual()"
                                style="padding: 6px 12px; font-size: 12px; background: ${touchModeState.serverOnline === false ? '#059669' : '#DC2626'}; color: white; border-radius: 6px;">
                            ${touchModeState.serverOnline === false ? '⚡ Prender Servicio del Lector' : '🛑 Detener Servicio del Lector'}
                        </button>
                        <button type="button" class="btn" onclick="refreshBiometricDeviceInfo(true)"
                                style="padding: 6px 12px; font-size: 12px; background: #2563EB; color: white; border-radius: 6px;">
                            🔄 Verificar / Actualizar
                        </button>
                        <button type="button" class="btn" onclick="showDeviceDiagnosticsModal()"
                                style="padding: 6px 12px; font-size: 12px; background: #1E293B; color: white; border-radius: 6px;">
                            🔍 Abrir Modal de Propiedades y Drivers
                        </button>
                    </div>
                </div>
                <div class="card-body" data-role="biometric-diagnostics-container">
                    ${buildBiometricHardwareDiagnosticsHTML(biometricDeviceInfo)}
                </div>
            </div>

            <!-- Card 8: Información del Sistema -->
            <div class="card" style="margin-bottom: 20px;">
                <div class="card-header">
                    <h4 style="margin: 0;">ℹ️ Información del Sistema</h4>
                </div>
                <div class="card-body">
                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px;">
                        <div class="metric-box">
                            <div class="metric-box-title">Versión del Sistema</div>
                            <div class="metric-box-value" style="font-size: 18px; color: #1F2937;">1.0.0</div>
                        </div>
                        <div class="metric-box">
                            <div class="metric-box-title">Empleados Activos</div>
                            <div class="metric-box-value" style="font-size: 18px; color: #1F2937;">${employees.length}</div>
                        </div>
                        <div class="metric-box">
                            <div class="metric-box-title">Departamentos</div>
                            <div class="metric-box-value" style="font-size: 18px; color: #1F2937;">${departments.length}</div>
                        </div>
                        <div class="metric-box">
                            <div class="metric-box-title">Turnos Registrados</div>
                            <div class="metric-box-value" style="font-size: 18px; color: #1F2937;">${shifts.length}</div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Card 9: Gestión de Datos (Zona de Peligro) -->
            <div class="card" style="margin-bottom: 24px; border: 2px solid #FEE2E2;">
                <div class="card-header" style="background: #FEE2E2;">
                    <h4 style="margin: 0; color: #991B1B;">🗑️ Gestión de Datos</h4>
                </div>
                <div class="card-body">
                    <div style="padding: 15px; background: #FEF2F2; border-radius: 8px; border-left: 4px solid #EF4444; margin-bottom: 15px;">
                        <div style="font-size: 13px; color: #991B1B;">
                            <strong>⚠️ Zona de Peligro:</strong> Las siguientes acciones son permanentes y no se pueden deshacer.
                        </div>
                    </div>

                    <div style="background: white; padding: 15px; border-radius: 8px; border: 1px solid #E5E7EB;">
                        <h5 style="margin: 0 0 8px; color: #1F2937;">Resetear Base de Datos</h5>
                        <p style="margin: 0 0 15px; font-size: 14px; color: #6B7280;">
                            Elimina los datos personalizados del sistema conservando la estructura base. Esta acción es irreversible.
                        </p>
                        <button class="btn" onclick="resetDatabase()"
                                style="background: #DC2626; color: white; font-weight: 600;">
                            🗑️ Resetear Toda la Base de Datos
                        </button>
                    </div>
                </div>
            </div>

            <div style="display: flex; gap: 12px; justify-content: flex-end; margin-bottom: 30px;">
                <button class="btn btn-cancel" onclick="resetSettings()">
                    Restaurar Valores Predeterminados
                </button>
                <button class="btn btn-primary" onclick="saveSettings()">
                    💾 Guardar Configuración
                </button>
            </div>
        </div>
    `;

    refreshBiometricDeviceInfo(false);
}

function loadSavedSettings() {
    const defaultSettings = {
        absentTime: '09:00',
        gracePeriodMinutes: 10,
        requireCheckout: true,
        allowManual: true,
        requireBiometric: false,
        cooldownSeconds: 60,
        captureTimeoutSeconds: 20,
        audioFeedback: true,
        successDuration: 4,
        enableNotifications: true,
        lateAlerts: true,
        biometricFailAlerts: false,
        autoStartListening: true,
        kioskLock: false,
        workDays: [1, 2, 3, 4, 5],
        autoBackupsDir: '',
        autoBackupsCount: '0'
    };

    try {
        const saved = localStorage.getItem('attendance_settings');
        const parsed = safeParseJson(saved, null);
        return parsed && typeof parsed === 'object' ? safeClone({ ...defaultSettings, ...parsed }) : defaultSettings;
    } catch {
        return defaultSettings;
    }
}

async function saveSettings() {
    try {
        const oldSettings = loadSavedSettings();
        const reqBio = safeParseBoolean(document.getElementById('setting-require-biometric')?.checked, false);
        const allowMan = reqBio ? false : safeParseBoolean(document.getElementById('setting-allow-manual')?.checked, true);
        const kioskChecked = safeParseBoolean(document.getElementById('setting-kiosk-lock')?.checked, false);

        const workDayInputs = document.querySelectorAll('.work-day-chk');
        const selectedWorkDays = [];
        workDayInputs.forEach(input => {
            if (input.checked) {
                selectedWorkDays.push(safeParseInt(input.dataset.day, 1));
            }
        });
        const finalWorkDays = selectedWorkDays.length > 0 ? selectedWorkDays : [1, 2, 3, 4, 5];

        const newSettings = {
            absentTime: document.getElementById('setting-absent-time')?.value || '09:00',
            gracePeriodMinutes: safeParseInt(document.getElementById('setting-grace-period')?.value, 10),
            requireCheckout: safeParseBoolean(document.getElementById('setting-require-checkout')?.checked, true),
            allowManual: allowMan,
            requireBiometric: reqBio,
            cooldownSeconds: safeParseInt(document.getElementById('setting-cooldown-seconds')?.value, 60),
            captureTimeoutSeconds: safeParseInt(document.getElementById('setting-capture-timeout')?.value, 20),
            audioFeedback: safeParseBoolean(document.getElementById('setting-audio-feedback')?.checked, true),
            successDuration: safeParseInt(document.getElementById('setting-success-duration')?.value, 4),
            enableNotifications: safeParseBoolean(document.getElementById('setting-notifications')?.checked, true),
            lateAlerts: safeParseBoolean(document.getElementById('setting-late-alerts')?.checked, true),
            biometricFailAlerts: safeParseBoolean(document.getElementById('setting-biometric-fail-alerts')?.checked, false),
            autoStartListening: safeParseBoolean(document.getElementById('setting-auto-start-listening')?.checked, true),
            kioskLock: kioskChecked,
            workDays: finalWorkDays,
            autoBackupsDir: oldSettings.autoBackupsDir || '',
            autoBackupsCount: oldSettings.autoBackupsCount || '0'
        };

        localStorage.setItem('attendance_settings', JSON.stringify(newSettings));
        systemSecurityState.kioskLockEnabled = kioskChecked;
        updateKioskTopbarUI();

        // Sincronizar simultáneamente con la base de datos SQLite (system_config)
        if (window.config && typeof window.config.get === 'function') {
            try {
                await window.config.get({
                    auto_mark_absent_time: newSettings.absentTime,
                    grace_period_minutes: String(newSettings.gracePeriodMinutes),
                    require_checkout: newSettings.requireCheckout ? '1' : '0',
                    allow_manual_entry: newSettings.allowManual ? '1' : '0',
                    require_biometric: newSettings.requireBiometric ? '1' : '0',
                    cooldown_seconds: String(newSettings.cooldownSeconds),
                    capture_timeout_seconds: String(newSettings.captureTimeoutSeconds),
                    audio_feedback: newSettings.audioFeedback ? '1' : '0',
                    success_duration: String(newSettings.successDuration),
                    notification_enabled: newSettings.enableNotifications ? '1' : '0',
                    late_alerts: newSettings.lateAlerts ? '1' : '0',
                    biometric_fail_alerts: newSettings.biometricFailAlerts ? '1' : '0',
                    auto_start_listening: newSettings.autoStartListening ? '1' : '0',
                    kiosk_lock_enabled: newSettings.kioskLock ? '1' : '0',
                    work_days: finalWorkDays.join(',')
                });
            } catch (e) {
                logger.warn('Error sincronizando configuración a SQLite:', e);
            }
        }

        // Si cambió la configuración de auto-start, aplicar cambio inmediatamente
        if (oldSettings.autoStartListening !== newSettings.autoStartListening && window.touchMode) {
            const state = await window.touchMode.getLocalState();

            if (newSettings.autoStartListening && !state.isActive) {
                const result = await window.touchMode.start();
                if (result.success) {
                    showNotification('Configuración guardada y modo automático iniciado', 'success');
                } else {
                    showNotification(`Configuración guardada. ${result.message}`, 'warning');
                }
            } else if (!newSettings.autoStartListening && state.isActive) {
                const result = await window.touchMode.stop();
                if (result.success) {
                    showNotification('Configuración guardada y modo automático detenido', 'success');
                } else {
                    showNotification('Configuración guardada', 'success');
                }
            } else {
                showNotification('Configuración guardada exitosamente', 'success');
            }
        } else {
            showNotification('Configuración guardada exitosamente', 'success');
        }

        // Si la sección activa es check-in, recargar para reflejar cambios en allowManual
        if (currentSection === 'check-in') {
            loadCheckInSection();
        }

        logger.info('Configuración guardada:', newSettings);
    } catch (error) {
        logger.error('Error guardando configuración:', error);
        showNotification('Error al guardar la configuración', 'error');
    }
}

async function resetSettings() {
    if (confirm('¿Está seguro de que desea restaurar los valores predeterminados? Esta acción no se puede deshacer.')) {
        localStorage.removeItem('attendance_settings');
        if (window.config && typeof window.config.get === 'function') {
            try {
                await window.config.get({
                    auto_mark_absent_time: '09:00',
                    grace_period_minutes: '10',
                    require_checkout: '1',
                    allow_manual_entry: '1',
                    require_biometric: '0',
                    cooldown_seconds: '60',
                    capture_timeout_seconds: '20',
                    audio_feedback: '1',
                    success_duration: '4',
                    notification_enabled: '1',
                    late_alerts: '1',
                    biometric_fail_alerts: '0',
                    auto_start_listening: '1'
                });
            } catch (e) {
                logger.warn('Error restableciendo configuración en SQLite:', e);
            }
        }
        showNotification('Configuración restaurada a valores predeterminados', 'success');
        loadSettingsSection();
        if (currentSection === 'check-in') {
            loadCheckInSection();
        }
    }
}

async function resetDatabase() {
    const confirmText = '⚠️ ADVERTENCIA CRÍTICA ⚠️\n\n' +
        'Esta acción eliminará PERMANENTEMENTE:\n\n' +
        '• Todos los empleados registrados\n' +
        '• Todos los departamentos\n' +
        '• Todos los turnos de trabajo\n' +
        '• Todos los registros de asistencia\n' +
        '• Todas las huellas dactilares registradas\n\n' +
        'Esta operación NO SE PUEDE DESHACER.\n\n' +
        '¿Está COMPLETAMENTE SEGURO de que desea continuar?';

    if (!confirm(confirmText)) {
        return;
    }

    // Doble confirmación con modal personalizado
    const confirmed = await showConfirmationModal(
        'Confirmación de Reseteo',
        'Para confirmar esta acción destructiva, escriba exactamente la palabra: <strong>RESTABLECER</strong>',
        'RESTABLECER'
    );

    if (!confirmed) {
        showNotification('Operación cancelada - Texto de confirmación incorrecto', 'warning');
        return;
    }

    try {
        logger.info('🗑️ Iniciando reseteo completo de base de datos...');
        showNotification('Reseteando base de datos...', 'info');

        // Llamar al IPC handler para resetear la base de datos
        const result = await window.attendance.resetDatabase();

        if (result.success) {
            showNotification('✅ Base de datos reseteada completamente', 'success');
            localStorage.removeItem('attendance_settings');

            // Recargar todos los datos iniciales
            await loadInitialData();

            // Navegar automáticamente al dashboard para mostrar que está vacío
            logger.info('📊 Navegando al dashboard para mostrar datos limpios...');
            showSection('dashboard');

            // Reiniciar Touch Mode después del reset
            logger.info('🔄 Reiniciando Touch Mode después del reset...');
            try {
                // Detener Touch Mode si está activo
                const currentState = await window.touchMode.getLocalState();
                if (currentState.isActive) {
                    logger.info('⏸️ Deteniendo Touch Mode actual...');
                    await window.touchMode.stop();
                    stopTouchModePolling();
                    await new Promise(resolve => setTimeout(resolve, 500)); // Esperar 500ms
                }

                // Reiniciar Touch Mode
                logger.info('▶️ Reiniciando Touch Mode...');
                const startResult = await window.touchMode.start();

                if (startResult.success) {
                    logger.info('✅ Touch Mode reiniciado exitosamente');
                    const newState = await window.touchMode.getLocalState();
                    touchModeState = newState;
                    updateTouchModeUI();
                    startTouchModePolling();
                    showNotification('Touch Mode reiniciado', 'info');
                } else {
                    logger.warn('⚠️ No se pudo reiniciar Touch Mode:', startResult.message);
                }
            } catch (touchModeError) {
                logger.error('❌ Error al reiniciar Touch Mode:', touchModeError);
            }

            logger.info('✅ Base de datos reseteada y datos recargados');
        } else {
            showNotification('Error al resetear la base de datos: ' + (result.message || 'Error desconocido'), 'error');
        }
    } catch (error) {
        logger.error('Error al resetear base de datos:', error);
        showNotification('Error crítico al resetear la base de datos', 'error');
    }
}

// Función auxiliar para mostrar modal de confirmación
function showConfirmationModal(title, message, expectedText) {
    return new Promise((resolve) => {
        // Crear modal
        const modal = document.createElement('div');
        modal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.7);
            display: flex;
            justify-content: center;
            align-items: center;
            z-index: 10000;
        `;

        modal.innerHTML = `
            <div style="background: white; padding: 30px; border-radius: 12px; max-width: 500px; width: 90%; box-shadow: 0 4px 20px rgba(0,0,0,0.3);">
                <h3 style="margin: 0 0 20px; color: #DC2626; font-size: 20px;">${title}</h3>
                <p style="margin: 0 0 20px; color: #374151; line-height: 1.6;">${message}</p>
                <input type="text" id="confirmInput"
                    style="width: 100%; padding: 12px; border: 2px solid #E5E7EB; border-radius: 6px; font-size: 14px; margin-bottom: 20px; box-sizing: border-box;"
                    placeholder="Escriba aquí...">
                <div style="display: flex; gap: 10px; justify-content: flex-end;">
                    <button id="cancelBtn" style="padding: 10px 20px; background: #6B7280; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 600;">
                        Cancelar
                    </button>
                    <button id="confirmBtn" style="padding: 10px 20px; background: #DC2626; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 600;">
                        Confirmar
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        const input = modal.querySelector('#confirmInput');
        const confirmBtn = modal.querySelector('#confirmBtn');
        const cancelBtn = modal.querySelector('#cancelBtn');

        // Enfocar el input
        setTimeout(() => input.focus(), 100);

        const cleanup = () => {
            document.body.removeChild(modal);
        };

        confirmBtn.onclick = () => {
            const value = input.value.trim();
            cleanup();
            resolve(value === expectedText);
        };

        cancelBtn.onclick = () => {
            cleanup();
            resolve(false);
        };

        // Permitir confirmar con Enter
        input.onkeyup = (e) => {
            if (e.key === 'Enter') {
                confirmBtn.click();
            } else if (e.key === 'Escape') {
                cancelBtn.click();
            }
        };

        // Cerrar al hacer click fuera del modal
        modal.onclick = (e) => {
            if (e.target === modal) {
                cancelBtn.click();
            }
        };
    });
}

// ==================== SEGURIDAD, MODO KIOSCO Y RESPALDOS ====================

function updateKioskTopbarUI() {
    const topbarRight = document.querySelector('.topbar-right');
    if (!topbarRight) return;

    let pill = document.querySelector('[data-role="admin-kiosk-lock-pill"]');
    if (!systemSecurityState.hasAdminPin) {
        if (pill) pill.remove();
        return;
    }

    if (!pill) {
        pill = document.createElement('div');
        pill.setAttribute('data-role', 'admin-kiosk-lock-pill');
        pill.style.cssText = 'display: inline-flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; font-size: 12px; font-weight: 600; padding: 5px 12px; border-radius: 999px; transition: all 0.2s ease;';
        topbarRight.insertBefore(pill, topbarRight.firstChild);
        pill.addEventListener('click', () => toggleAdminLockManual());
    }

    if (systemSecurityState.isUnlocked) {
        pill.style.background = '#DCFCE7';
        pill.style.color = '#15803D';
        pill.style.border = '1px solid #86EFAC';
        pill.title = 'Sesión de Administrador Desbloqueada. Clic para bloquear.';
        pill.innerHTML = '<span>🔓 Admin Desbloqueado</span>';
    } else {
        pill.style.background = systemSecurityState.kioskLockEnabled ? '#FEF2F2' : '#F1F5F9';
        pill.style.color = systemSecurityState.kioskLockEnabled ? '#B91C1C' : '#475569';
        pill.style.border = systemSecurityState.kioskLockEnabled ? '1px solid #FCA5A5' : '1px solid #CBD5E1';
        pill.title = systemSecurityState.kioskLockEnabled ? 'Modo Kiosco Activo (Bloqueado). Clic para desbloquear con PIN.' : 'Administración Protegida. Clic para desbloquear.';
        pill.innerHTML = `<span>🔒 ${systemSecurityState.kioskLockEnabled ? 'Modo Kiosco Bloqueado' : 'PIN Protegido'}</span>`;
    }
}

async function promptAdminPinModal(promptTitle = 'Autenticación de Administrador') {
    if (!systemSecurityState.hasAdminPin) return true;
    if (systemSecurityState.isUnlocked) return true;

    return new Promise((resolve) => {
        const modal = document.createElement('div');
        modal.className = 'modal active';
        modal.style.zIndex = '10001';

        modal.innerHTML = `
            <div class="modal-content" style="max-width: 420px; border-radius: 12px; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.25);">
                <div class="modal-header" style="background: #0F172A; color: white; padding: 16px 20px; border-top-left-radius: 12px; border-top-right-radius: 12px; display: flex; justify-content: space-between; align-items: center;">
                    <h3 style="margin: 0; font-size: 16px; display: flex; align-items: center; gap: 8px;">
                        <span>🔐</span> ${escapeHtml(promptTitle)}
                    </h3>
                    <button type="button" class="close-btn admin-pin-cancel-btn" style="color: #94A3B8; font-size: 20px; background: transparent; border: none; cursor: pointer;">&times;</button>
                </div>
                <div class="modal-body" style="padding: 20px;">
                    <p style="font-size: 13.5px; color: #475569; margin: 0 0 14px;">
                        Ingrese su PIN de Administrador para autorizar esta operación:
                    </p>
                    <div class="form-group" style="margin-bottom: 12px;">
                        <input type="password" id="admin-pin-dialog-input" class="form-control" placeholder="••••" maxlength="16" autofocus style="font-size: 20px; letter-spacing: 6px; text-align: center; padding: 10px;">
                    </div>
                    <div id="admin-pin-dialog-error" style="display: none; color: #DC2626; font-size: 12.5px; margin-bottom: 10px; font-weight: 600; text-align: center;"></div>
                </div>
                <div class="modal-footer" style="padding: 12px 20px; background: #F8FAFC; border-top: 1px solid #E2E8F0; display: flex; justify-content: flex-end; gap: 10px; border-bottom-left-radius: 12px; border-bottom-right-radius: 12px;">
                    <button type="button" class="btn btn-cancel admin-pin-cancel-btn">Cancelar</button>
                    <button type="button" class="btn btn-primary" id="admin-pin-submit-btn" style="background: #1E293B; font-weight: 600;">Verificar PIN</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);
        const pinInput = modal.querySelector('#admin-pin-dialog-input');
        const errorDiv = modal.querySelector('#admin-pin-dialog-error');
        const submitBtn = modal.querySelector('#admin-pin-submit-btn');
        const cancelBtns = modal.querySelectorAll('.admin-pin-cancel-btn');

        pinInput?.focus();

        const cleanup = () => {
            modal.remove();
        };

        cancelBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                cleanup();
                resolve(false);
            });
        });

        const tryVerify = async () => {
            const entered = pinInput?.value || '';
            if (!entered) {
                if (errorDiv) {
                    errorDiv.textContent = 'Ingrese el PIN';
                    errorDiv.style.display = 'block';
                }
                return;
            }

            submitBtn.disabled = true;
            submitBtn.textContent = 'Verificando...';

            try {
                const res = await window.config.get({
                    __action: 'verify_admin_pin',
                    pin: entered
                });

                if (res && res.valid) {
                    systemSecurityState.isUnlocked = true;
                    updateKioskTopbarUI();
                    cleanup();
                    showNotification('🔓 Sesión de administrador desbloqueada', 'success');
                    resolve(true);
                } else {
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'Verificar PIN';
                    if (errorDiv) {
                        errorDiv.textContent = res?.message || 'PIN incorrecto. Intente de nuevo.';
                        errorDiv.style.display = 'block';
                    }
                    if (pinInput) {
                        pinInput.value = '';
                        pinInput.focus();
                    }
                }
            } catch (err) {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Verificar PIN';
                if (errorDiv) {
                    errorDiv.textContent = 'Error de comunicación: ' + err.message;
                    errorDiv.style.display = 'block';
                }
            }
        };

        submitBtn?.addEventListener('click', tryVerify);
        pinInput?.addEventListener('keyup', (e) => {
            if (e.key === 'Enter') tryVerify();
            if (e.key === 'Escape') {
                cleanup();
                resolve(false);
            }
        });
    });
}

async function toggleAdminLockManual() {
    if (!systemSecurityState.hasAdminPin) {
        openAdminPinSetupModal();
        return;
    }

    if (systemSecurityState.isUnlocked) {
        try {
            await window.config.get({ __action: 'lock_admin_session' });
            systemSecurityState.isUnlocked = false;
            updateKioskTopbarUI();
            showNotification('🔒 Sesión de administrador bloqueada', 'info');
            if (systemSecurityState.kioskLockEnabled && currentSection !== 'check-in' && currentSection !== 'dashboard') {
                showSection('check-in');
            }
        } catch (e) {
            logger.error('Error al bloquear sesión:', e);
        }
    } else {
        await promptAdminPinModal('Desbloquear Sesión de Administrador');
    }
}

function openAdminPinSetupModal() {
    const hasPin = systemSecurityState.hasAdminPin;
    const currentPinFieldHTML = hasPin ? `
        <div class="form-group" style="margin-bottom: 15px;">
            <label style="display: block; font-size: 13px; font-weight: 600; color: #334155; margin-bottom: 6px;">
                PIN Actual *
            </label>
            <input type="password" id="modal-current-admin-pin" class="form-control" placeholder="••••" maxlength="16" style="letter-spacing: 4px;">
        </div>
    ` : '';

    const bodyHTML = `
        <form id="admin-pin-setup-form" onsubmit="event.preventDefault(); submitAdminPinSetup();">
            <p style="font-size: 13.5px; color: #475569; margin: 0 0 16px;">
                ${hasPin
                    ? 'Puede actualizar su PIN actual o eliminarlo por completo si ya no requiere protección.'
                    : 'Establezca un PIN numérico o alfanumérico seguro (4 a 16 caracteres) para proteger funciones sensibles.'}
            </p>
            ${currentPinFieldHTML}
            <div class="form-group" style="margin-bottom: 15px;">
                <label style="display: block; font-size: 13px; font-weight: 600; color: #334155; margin-bottom: 6px;">
                    ${hasPin ? 'Nuevo PIN (dejar en blanco para conservar el actual)' : 'Nuevo PIN *'}
                </label>
                <input type="password" id="modal-new-admin-pin" class="form-control" placeholder="••••" maxlength="16" style="letter-spacing: 4px;">
            </div>
            <div class="form-group" style="margin-bottom: 18px;">
                <label style="display: block; font-size: 13px; font-weight: 600; color: #334155; margin-bottom: 6px;">
                    Confirmar Nuevo PIN
                </label>
                <input type="password" id="modal-confirm-admin-pin" class="form-control" placeholder="••••" maxlength="16" style="letter-spacing: 4px;">
            </div>

            <div class="form-group" style="margin-bottom: 15px; padding-top: 10px; border-top: 1px solid #E2E8F0;">
                <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px;">
                    <input type="checkbox" id="modal-enable-kiosk-chbox" ${systemSecurityState.kioskLockEnabled ? 'checked' : ''}>
                    <span>Activar Modo Kiosco Estricto</span>
                </label>
            </div>

            <div id="modal-admin-pin-feedback" style="display: none; padding: 10px; border-radius: 6px; font-size: 12.5px; font-weight: 600; margin-bottom: 12px;"></div>
        </form>
    `;

    const removeBtnHTML = hasPin ? `
        <button type="button" class="btn" onclick="submitRemoveAdminPin()" style="background: #DC2626; color: white; font-size: 12.5px; margin-right: auto;">
            🗑️ Eliminar PIN
        </button>
    ` : '';

    const footerHTML = `
        ${removeBtnHTML}
        <button type="button" class="btn btn-cancel" onclick="closeModal()">Cancelar</button>
        <button type="button" class="btn btn-primary" onclick="submitAdminPinSetup()" style="background: #1E293B; font-weight: 600;">
            💾 Guardar PIN
        </button>
    `;

    openModalShell({
        title: hasPin ? '🔑 Administrar PIN de Seguridad' : '➕ Configurar PIN de Seguridad',
        maxWidth: '500px',
        bodyHTML,
        footerHTML
    });
}

async function submitAdminPinSetup() {
    const currentPin = document.getElementById('modal-current-admin-pin')?.value || '';
    const newPin = document.getElementById('modal-new-admin-pin')?.value || '';
    const confirmPin = document.getElementById('modal-confirm-admin-pin')?.value || '';
    const kioskLock = document.getElementById('modal-enable-kiosk-chbox')?.checked ? '1' : '0';
    const feedback = document.getElementById('modal-admin-pin-feedback');

    const showModalError = (msg) => {
        if (feedback) {
            feedback.style.display = 'block';
            feedback.style.background = '#FEE2E2';
            feedback.style.color = '#B91C1C';
            feedback.textContent = msg;
        }
    };

    if (newPin.length < 4 || newPin.length > 16) {
        showModalError('El nuevo PIN debe tener entre 4 y 16 caracteres.');
        return;
    }
    if (newPin !== confirmPin) {
        showModalError('El nuevo PIN y su confirmación no coinciden.');
        return;
    }

    try {
        const res = await window.config.get({
            __action: 'set_admin_pin',
            currentPin,
            newPin,
            kioskLock
        });

        if (res && res.success) {
            systemSecurityState.hasAdminPin = true;
            systemSecurityState.isUnlocked = true;
            systemSecurityState.kioskLockEnabled = kioskLock === '1';
            updateKioskTopbarUI();
            closeModal();
            showNotification('✅ PIN de Administrador configurado exitosamente', 'success');
            loadSettingsSection();
        } else {
            showModalError(res?.message || 'Error al guardar el PIN');
        }
    } catch (e) {
        showModalError('Error al contactar el proceso principal: ' + e.message);
    }
}

async function submitRemoveAdminPin() {
    const currentPin = document.getElementById('modal-current-admin-pin')?.value || '';
    if (!confirm('¿Está seguro de que desea eliminar el PIN de Administrador? Las funciones sensibles quedarán desprotegidas.')) {
        return;
    }

    try {
        const res = await window.config.get({
            __action: 'set_admin_pin',
            currentPin,
            remove: '1'
        });

        if (res && res.success) {
            systemSecurityState.hasAdminPin = false;
            systemSecurityState.isUnlocked = false;
            systemSecurityState.kioskLockEnabled = false;
            updateKioskTopbarUI();
            closeModal();
            showNotification('PIN de Administrador eliminado correctamente', 'info');
            loadSettingsSection();
        } else {
            const feedback = document.getElementById('modal-admin-pin-feedback');
            if (feedback) {
                feedback.style.display = 'block';
                feedback.style.background = '#FEE2E2';
                feedback.style.color = '#B91C1C';
                feedback.textContent = res?.message || 'PIN actual incorrecto.';
            }
        }
    } catch (e) {
        logger.error('Error eliminando PIN:', e);
        showNotification('Error eliminando PIN: ' + e.message, 'error');
    }
}

async function executeAbsentCutoffNow() {
    const authorized = await promptAdminPinModal('Autorizar Corte de Faltas');
    if (!authorized) return;

    try {
        showNotification('⚡ Ejecutando corte de faltas...', 'info');
        const res = await window.attendance.getAttendanceRecords({ action: 'mark_absentees' });
        if (res && res.success) {
            showNotification(`✅ Corte ejecutado: ${res.count || 0} inasistencia(s) registradas`, 'success');
            if (currentSection === 'dashboard') loadDashboard();
            if (currentSection === 'attendance') loadAttendanceSection();
        } else {
            showNotification('Error al ejecutar corte de faltas: ' + (res?.message || 'Error desconocido'), 'error');
        }
    } catch (e) {
        logger.error('Error al ejecutar corte de faltas:', e);
        showNotification('Error al ejecutar corte de faltas: ' + e.message, 'error');
    }
}

async function handleExportDatabaseBackup() {
    const authorized = await promptAdminPinModal('Autorizar Exportación de Base de Datos');
    if (!authorized) return;

    try {
        showNotification('💾 Preparando exportación segura de base de datos SQLite...', 'info');
        const res = await window.config.get({
            __action: 'backup_database',
            __pin: ''
        });

        if (res && res.success) {
            showNotification(`✅ Base de datos respaldada en: ${res.filePath}`, 'success');
        } else if (res && res.canceled) {
            showNotification('Exportación cancelada', 'info');
        } else {
            showNotification('Error al exportar respaldo: ' + (res?.message || 'Error desconocido'), 'error');
        }
    } catch (e) {
        logger.error('Error exportando base de datos:', e);
        showNotification('Error al exportar base de datos: ' + e.message, 'error');
    }
}

async function handleRestoreDatabaseBackup() {
    const authorized = await promptAdminPinModal('Autorizar Restauración de Base de Datos');
    if (!authorized) return;

    const warnMsg = '⚠️ ADVERTENCIA CRÍTICA DE RESTAURACIÓN ⚠️\n\n' +
        'Restaurar una base de datos reemplazará los datos actuales por los del archivo seleccionado.\n' +
        'El sistema tomará automáticamente un respaldo preventivo antes de la sustitución.\n\n' +
        '¿Desea proceder a seleccionar el archivo SQLite?';
    if (!confirm(warnMsg)) return;

    try {
        showNotification('📥 Seleccionando y validando archivo de respaldo SQLite...', 'info');
        const res = await window.config.get({
            __action: 'restore_database',
            __pin: ''
        });

        if (res && res.success) {
            showNotification('✅ Base de datos restaurada y sincronizada exitosamente', 'success');
            await loadInitialData();
            showSection('dashboard');
        } else if (res && res.canceled) {
            showNotification('Restauración cancelada', 'info');
        } else {
            showNotification('Error al restaurar: ' + (res?.message || 'Archivo no válido'), 'error');
        }
    } catch (e) {
        logger.error('Error restaurando base de datos:', e);
        showNotification('Error al restaurar base de datos: ' + e.message, 'error');
    }
}

// ==================== AUTO ATTENDANCE (MODO AUTOMÁTICO) ====================

// ==================== TOUCH MODE (MODO AUTOMÁTICO) ====================

let touchModeState = {
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

let biometricDeviceInfo = null;
let touchModePollingInterval = null;

/**
 * Clasificar el estado actual de la máquina de estados biométrica (Eventos Controlados vs No Controlados)
 */
function getBiometricVisualState() {
    const serverOnline = touchModeState.serverOnline !== false;
    const stopReason = touchModeState.stopReason || 'NONE';
    const hwState = touchModeState.hardwareState || 'IDLE';
    const isReaderConnected = touchModeState.readerConnected !== undefined
        ? Boolean(touchModeState.readerConnected)
        : Boolean(biometricDeviceInfo?.connected ?? touchModeState.isActive);

    // 1. Servicio detenido manualmente (Evento Controlado)
    if (stopReason === 'SERVICE_STOPPED_MANUALLY') {
        return {
            code: 'SERVICE_STOPPED_MANUALLY',
            eventKind: 'CONTROLADO (Manual)',
            dotColor: '#64748B',
            pulse: false,
            titleColor: '#334155',
            bgColor: '#F1F5F9',
            borderColor: '#94A3B8',
            sidebarTitle: 'Servicio Detenido',
            sidebarSub: 'Apagado manual controlado',
            bannerTitle: '⏸️ Servicio Biométrico Apagado (Paro Manual Controlado)',
            bannerSub: 'El servicio del lector fue detenido manualmente. Préndalo para habilitar la lectura USB.'
        };
    }

    // 2. Servicio cortado inesperadamente (Evento No Controlado)
    if (!serverOnline || stopReason === 'UNEXPECTED_SERVICE_DROP') {
        return {
            code: 'UNEXPECTED_SERVICE_DROP',
            eventKind: 'NO CONTROLADO (Corte Inesperado)',
            dotColor: '#DC2626',
            pulse: false,
            titleColor: '#991B1B',
            bgColor: '#FEF2F2',
            borderColor: '#DC2626',
            sidebarTitle: 'Servicio Cortado',
            sidebarSub: 'Caída inesperada del motor',
            bannerTitle: '🚨 Servicio Biométrico Cortado Inesperadamente (No Controlado)',
            bannerSub: 'La comunicación con el servicio del lector se interrumpió de forma inesperada. Reconectando o préndalo manualmente.'
        };
    }

    // 3. Lector USB desconectado físicamente (Evento No Controlado)
    if (!isReaderConnected || stopReason === 'UNEXPECTED_USB_DISCONNECT') {
        return {
            code: 'UNEXPECTED_USB_DISCONNECT',
            eventKind: 'NO CONTROLADO (Desconexión Física USB)',
            dotColor: '#EF4444',
            pulse: false,
            titleColor: '#991B1B',
            bgColor: '#FEF2F2',
            borderColor: '#EF4444',
            sidebarTitle: 'Lector Desconectado',
            sidebarSub: 'Cable USB desconectado',
            bannerTitle: '🔌❌ Lector Biométrico Desconectado (Evento No Controlado)',
            bannerSub: 'No se detecta el lector en el puerto USB. Conéctelo para reanudar automáticamente (0% Polling).'
        };
    }

    // 4. Enrolamiento o pausa por operación 1:1 (Evento Controlado)
    if (hwState === 'ENROLLING' || stopReason === 'OPERATION_PAUSE') {
        return {
            code: 'OPERATION_PAUSE',
            eventKind: 'CONTROLADO (Operación en curso)',
            dotColor: '#2563EB',
            pulse: true,
            titleColor: '#1E40AF',
            bgColor: '#EFF6FF',
            borderColor: '#3B82F6',
            sidebarTitle: 'Operación Biométrica',
            sidebarSub: 'Captura / Enrolamiento activo',
            bannerTitle: '🔵 En Operación Biométrica (Pausa Controlada)',
            bannerSub: 'La escucha continua está en pausa controlada mientras se realiza una captura o registro individual.'
        };
    }

    // 5. Inicializando / Auto-recuperando
    if (hwState === 'STARTING') {
        return {
            code: 'STARTING',
            eventKind: 'TRANSICIÓN FSM',
            dotColor: '#3B82F6',
            pulse: true,
            titleColor: '#1D4ED8',
            bgColor: '#EFF6FF',
            borderColor: '#60A5FA',
            sidebarTitle: 'Sincronizando Lector...',
            sidebarSub: 'Activando captura continua',
            bannerTitle: '🔄 Inicializando Modo Continuo...',
            bannerSub: touchModeState.statusMessage || 'Sincronizando lector y plantillas biométricas...'
        };
    }

    // 6. Escucha continua activa (Operación Normal)
    if (touchModeState.isActive) {
        return {
            code: 'TOUCH_CONTINUOUS',
            eventKind: 'ACTIVO (Tiempo Real)',
            dotColor: '#10B981',
            pulse: true,
            titleColor: '#065F46',
            bgColor: '#ECFDF5',
            borderColor: '#10B981',
            sidebarTitle: 'Escucha Continua',
            sidebarSub: 'Monitoreo activo en vivo',
            bannerTitle: '🟢 Lector Activo en Escucha Continua',
            bannerSub: 'Escuchando eventos de huella e interrupciones de hardware USB en tiempo real.'
        };
    }

    // 7. Lector conectado pero escucha detenida manualmente o sin huellas (Evento Controlado)
    return {
        code: 'MANUAL_STOP',
        eventKind: 'CONTROLADO (En Espera)',
        dotColor: '#F59E0B',
        pulse: false,
        titleColor: '#92400E',
        bgColor: '#FFFBEB',
        borderColor: '#F59E0B',
        sidebarTitle: 'Conectado (En espera)',
        sidebarSub: stopReason === 'NO_FINGERPRINTS' ? 'Sin huellas registradas' : 'Escucha detenida manualmente',
        bannerTitle: '🟡 Lector Conectado en Espera (Paro Controlado)',
        bannerSub: stopReason === 'NO_FINGERPRINTS'
            ? 'Lector USB listo. Registre al menos una huella para activar el modo continuo.'
            : 'El lector USB está listo, pero la escucha continua fue detenida manualmente.'
    };
}

/**
 * Hidratar de forma centralizada el estado de la máquina biométrica y refrescar todos los componentes UI
 */
function hydrateBiometricUI(partialState = null, deviceInfoSnapshot = null) {
    if (partialState && typeof partialState === 'object') {
        touchModeState = {
            ...touchModeState,
            ...partialState
        };
    }

    if (deviceInfoSnapshot && typeof deviceInfoSnapshot === 'object') {
        biometricDeviceInfo = deviceInfoSnapshot;
        if (touchModeState.serverOnline !== false) {
            touchModeState.readerConnected = Boolean(deviceInfoSnapshot.connected);
        }
        touchModeState.readerModel = deviceInfoSnapshot.model || touchModeState.readerModel;
        touchModeState.readerSerial = deviceInfoSnapshot.serial || touchModeState.readerSerial;
        touchModeState.readerFirmware = deviceInfoSnapshot.firmware || touchModeState.readerFirmware;
    }

    updateSidebarReaderStatus();
    updateTouchModeUI();

    // Hidratar contenedores de diagnóstico abiertos (Modal y Tarjeta en Configuración)
    document.querySelectorAll('[data-role="biometric-diagnostics-container"]').forEach(container => {
        container.innerHTML = buildBiometricHardwareDiagnosticsHTML(biometricDeviceInfo);
    });

    // Hidratar botones de prendido/detención manual del servicio
    const isServiceOffline = touchModeState.serverOnline === false || touchModeState.stopReason === 'SERVICE_STOPPED_MANUALLY' || touchModeState.stopReason === 'UNEXPECTED_SERVICE_DROP';
    document.querySelectorAll('[data-role="biometric-service-toggle-btn"]').forEach(btn => {
        btn.style.background = isServiceOffline ? '#059669' : '#DC2626';
        btn.innerHTML = isServiceOffline ? '⚡ Prender Servicio del Lector' : '🛑 Detener Servicio del Lector';
    });

    if (touchModeState.isActive) {
        if (!touchModePollingInterval) {
            startTouchModePolling();
        }
    } else {
        stopTouchModePolling();
    }
}

/**
 * Consultar información real del dispositivo físico y versiones de controladores
 */
async function refreshBiometricDeviceInfo(notifyOnFinish = false) {
    try {
        if (window.touchMode && typeof window.touchMode.getLocalState === 'function') {
            const latestState = await window.touchMode.getLocalState();
            if (latestState) {
                touchModeState = { ...touchModeState, ...latestState };
            }
        }

        // Si el servicio fue detenido manualmente, no consultar el servidor HTTP hasta que se prenda
        if (touchModeState.stopReason === 'SERVICE_STOPPED_MANUALLY') {
            if (biometricDeviceInfo) {
                biometricDeviceInfo = {
                    ...biometricDeviceInfo,
                    connected: false,
                    readerStatus: 'SERVICE_STOPPED_MANUALLY',
                    isTouchActive: false,
                    captureMode: 'Servicio Apagado (Manual)'
                };
            }
            hydrateBiometricUI();
            if (notifyOnFinish) {
                showNotification('⏸️ El servicio del lector está detenido manualmente. Préndalo primero.', 'info');
            }
            return biometricDeviceInfo;
        }

        if (!window.biometric || typeof window.biometric.getDeviceInfo !== 'function') {
            hydrateBiometricUI();
            return null;
        }

        const raw = await window.biometric.getDeviceInfo();
        const info = raw && raw.info ? raw.info : raw;
        if (info && typeof info === 'object') {
            touchModeState.serverOnline = true;
            hydrateBiometricUI(null, info);
        } else {
            // Si getDeviceInfo devolvió null, verificar si el servidor cayó
            const available = window.biometric.isServerAvailable ? await window.biometric.isServerAvailable() : false;
            if (!available && touchModeState.stopReason !== 'SERVICE_STOPPED_MANUALLY') {
                touchModeState.serverOnline = false;
                touchModeState.isActive = false;
                touchModeState.stopReason = 'UNEXPECTED_SERVICE_DROP';
                touchModeState.hardwareState = 'ERROR';
            } else {
                touchModeState.readerConnected = false;
            }
            hydrateBiometricUI();
        }

        if (notifyOnFinish) {
            if (touchModeState.serverOnline === false) {
                showNotification('🚨 El servicio biométrico no responde. Puede prenderlo desde el panel.', 'error');
            } else if (biometricDeviceInfo && biometricDeviceInfo.connected) {
                showNotification(
                    `🔌 Lector detectado: ${biometricDeviceInfo.model} (FW v${biometricDeviceInfo.firmware || 'N/A'} | Driver USB v${biometricDeviceInfo.drivers?.usbDriverVersion || 'N/A'})`,
                    'success'
                );
            } else {
                showNotification(
                    '🔴 No se detectó ningún lector biométrico conectado por USB',
                    'warning'
                );
            }
        }
        return biometricDeviceInfo;
    } catch (error) {
        logger.warn('[UI] No se pudo consultar información del lector:', error);
        hydrateBiometricUI();
        if (notifyOnFinish) {
            showNotification('Error al consultar información del lector biométrico', 'error');
        }
        return null;
    }
}

/**
 * Controlar manualmente el prendido / apagado del servicio biométrico (Evento Controlado)
 */
async function toggleBiometricServiceManual() {
    try {
        if (!window.biometricServer) {
            showNotification('Control de servicio biométrico no disponible', 'error');
            return;
        }

        const isOffline = touchModeState.serverOnline === false ||
            touchModeState.stopReason === 'SERVICE_STOPPED_MANUALLY' ||
            touchModeState.stopReason === 'UNEXPECTED_SERVICE_DROP';

        if (isOffline) {
            showNotification('⚡ Iniciando servicio del lector biométrico...', 'info');
            const res = await window.biometricServer.start();
            if (res && res.success) {
                playNotificationSound('check-in');
                showNotification('✅ Servicio biométrico iniciado y sincronizado', 'success');
                const latestState = await window.touchMode.getLocalState();
                hydrateBiometricUI(latestState);
                await refreshBiometricDeviceInfo(false);
            } else {
                showNotification('❌ No se pudo iniciar el servicio: ' + (res?.message || 'Error desconocido'), 'error');
            }
        } else {
            showNotification('🛑 Deteniendo servicio del lector biométrico manualmente...', 'info');
            const res = await window.biometricServer.stop();
            if (res && res.success) {
                stopTouchModePolling();
                const latestState = await window.touchMode.getLocalState();
                hydrateBiometricUI({
                    ...latestState,
                    isActive: false,
                    serverOnline: false,
                    stopReason: 'SERVICE_STOPPED_MANUALLY',
                    hardwareState: 'IDLE',
                    statusMessage: 'Servicio biométrico detenido manualmente'
                });
                showNotification('⏸️ Servicio del lector detenido manualmente (Evento Controlado)', 'info');
            } else {
                showNotification('⚠️ ' + (res?.message || 'No se pudo detener el servicio'), 'warning');
            }
        }
    } catch (error) {
        logger.error('[UI] Error alternando servicio biométrico:', error);
        showNotification('Error al controlar el servicio biométrico: ' + error.message, 'error');
    }
}

/**
 * Actualizar el indicador de estado de conexión en el pie del sidebar
 */
function updateSidebarReaderStatus() {
    const statusBox = document.querySelector('.sidebar-footer .connection-status');
    if (!statusBox) return;

    statusBox.style.cursor = 'pointer';
    statusBox.title = 'Clic para abrir el modal de detalles del dispositivo y versión de controladores';
    statusBox.onclick = () => showDeviceDiagnosticsModal();

    const visual = getBiometricVisualState();
    const modelShort = (biometricDeviceInfo?.model || touchModeState.readerModel || 'Lector DP4500')
        .replace('Fingerprint Reader', '')
        .trim();
    const fw = biometricDeviceInfo?.firmware || touchModeState.readerFirmware || '';
    const drvVer = biometricDeviceInfo?.drivers?.usbDriverVersion || '';

    const detailLine = visual.code === 'TOUCH_CONTINUOUS' || visual.code === 'MANUAL_STOP' || visual.code === 'OPERATION_PAUSE'
        ? `${escapeHtml(modelShort)}${fw && fw !== 'N/A' ? ` · FW ${escapeHtml(fw)}` : ''}`
        : escapeHtml(visual.sidebarSub);

    statusBox.innerHTML = `
        <div class="status-indicator" style="background: ${visual.dotColor}; animation: ${visual.pulse ? 'pulse 2s infinite' : 'none'}; box-shadow: 0 0 6px ${visual.dotColor}80; flex-shrink: 0;"></div>
        <div style="overflow: hidden;">
            <div style="font-weight: 700; color: ${visual.titleColor}; font-size: 12px; display: flex; align-items: center; gap: 4px;">
                <span>${escapeHtml(visual.sidebarTitle)}</span>
            </div>
            <div style="color: #4B5563; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                ${detailLine}
            </div>
            <div style="color: #2563EB; font-size: 10px; font-weight: 600; margin-top: 2px;">
                🔍 Propiedades y Drivers${drvVer && drvVer !== 'No detectado' ? ` (v${escapeHtml(drvVer)})` : ''}
            </div>
        </div>
    `;
}

/**
 * Construir HTML con datos reales del dispositivo físico, FSM y versiones de controladores
 */
function buildBiometricHardwareDiagnosticsHTML(info) {
    const visual = getBiometricVisualState();
    const hwState = touchModeState.hardwareState || 'IDLE';
    const stopReason = touchModeState.stopReason || 'NONE';

    const fsmBanner = `
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; padding: 12px 16px; background: ${visual.bgColor}; border: 1.5px solid ${visual.borderColor}; border-radius: 8px; margin-bottom: 14px;">
            <div>
                <div style="font-weight: 700; color: ${visual.titleColor}; font-size: 13px;">
                    ${escapeHtml(visual.bannerTitle)}
                </div>
                <div style="font-size: 12px; color: #475569; margin-top: 3px;">
                    ${escapeHtml(visual.bannerSub)}
                </div>
            </div>
            <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 4px; font-size: 11px;">
                <span style="padding: 2px 8px; border-radius: 999px; font-weight: 700; background: white; color: ${visual.titleColor}; border: 1px solid ${visual.borderColor};">
                    FSM: ${escapeHtml(hwState)} · ${escapeHtml(visual.eventKind)}
                </span>
                <span style="color: #64748B;">
                    Causa / Estado: <code>${escapeHtml(stopReason)}</code>
                </span>
            </div>
        </div>
    `;

    if (!info) {
        return `
            ${fsmBanner}
            <div style="padding: 18px; background: #F8FAFC; border: 1px dashed #CBD5E1; border-radius: 8px; text-align: center; color: #475569;">
                ${touchModeState.serverOnline === false
                    ? 'El servicio biométrico se encuentra apagado o sin conexión. Presione "⚡ Prender Servicio del Lector" para consultar el hardware.'
                    : 'Consultando estado del lector biométrico y versión de controladores...'}
            </div>
        `;
    }

    const isConnected = Boolean(info.connected) && touchModeState.serverOnline !== false && touchModeState.stopReason !== 'SERVICE_STOPPED_MANUALLY';
    const drv = info.drivers || {};
    const caps = info.capabilities || {};
    const checkedTime = info.checkedAt
        ? new Date(info.checkedAt).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        : new Date().toLocaleTimeString('es-ES');

    const statusBadge = isConnected
        ? `<span style="display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; border-radius: 999px; font-size: 12px; font-weight: 700; background: #DCFCE7; color: #166534; border: 1px solid #86EFAC;">
               <span style="width: 8px; height: 8px; border-radius: 50%; background: #16A34A;"></span>
               HARDWARE USB CONECTADO (${escapeHtml(String(touchModeState.isActive ? 'LISTENING_CONTINUOUS' : (info.readerStatus || 'READY')))})
           </span>`
        : `<span style="display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; border-radius: 999px; font-size: 12px; font-weight: 700; background: #FEE2E2; color: #991B1B; border: 1px solid #FCA5A5;">
               <span style="width: 8px; height: 8px; border-radius: 50%; background: #DC2626;"></span>
               ${touchModeState.stopReason === 'SERVICE_STOPPED_MANUALLY' ? 'SERVICIO DETENIDO MANUALMENTE' : (touchModeState.serverOnline === false ? 'SERVICIO BIOMÉTRICO CAÍDO' : 'DESCONECTADO DEL PUERTO USB')}
           </span>`;

    const capBadges = [
        { label: 'Captura Biométrica', ok: caps.canCapture !== false },
        { label: 'Extracción Minucias', ok: caps.extractFeatures !== false },
        { label: 'Verificación 1:1', ok: caps.canMatch !== false },
        { label: 'Identificación 1:N', ok: caps.canIdentify !== false },
        { label: 'Gestión Energía', ok: Boolean(caps.hasPowerManagement) },
        { label: 'Calibración Sensor', ok: Boolean(caps.hasCalibration) },
        { label: 'Estándar FBI PIV', ok: Boolean(caps.pivCompliant) }
    ].map(c => `
        <span style="padding: 4px 10px; border-radius: 6px; font-size: 11px; font-weight: 600; background: ${c.ok ? '#EFF6FF' : '#F3F4F6'}; color: ${c.ok ? '#1D4ED8' : '#6B7280'}; border: 1px solid ${c.ok ? '#BFDBFE' : '#E5E7EB'};">
            ${c.ok ? '✓' : '•'} ${escapeHtml(c.label)}
        </span>
    `).join('');

    return `
        ${fsmBanner}
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; padding: 10px 14px; background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 8px; margin-bottom: 14px;">
            <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
                ${statusBadge}
                <span style="font-size: 12px; color: #475569;">
                    Modo actual: <strong>${escapeHtml(touchModeState.isActive ? 'Captura Continua (Touch)' : (info.captureMode || 'En espera'))}</strong>
                </span>
            </div>
            <div style="font-size: 11px; color: #64748B;">
                Última lectura: <strong>${escapeHtml(checkedTime)}</strong> (CM_Register_Notification + INotifyPropertyChanged · 0% Polling)
            </div>
        </div>

        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(290px, 1fr)); gap: 16px;">
            <!-- Columna 1: Datos del Hardware Físico -->
            <div style="background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 8px; padding: 14px;">
                <h5 style="margin: 0 0 12px; color: #0F172A; font-size: 13px; text-transform: uppercase; letter-spacing: 0.4px; border-bottom: 1px solid #E2E8F0; padding-bottom: 6px;">
                    📟 Datos del Dispositivo Físico
                </h5>
                <div style="display: flex; flex-direction: column; gap: 8px; font-size: 13px;">
                    <div style="display: flex; justify-content: space-between; gap: 8px;">
                        <span style="color: #64748B;">Modelo:</span>
                        <strong style="color: #0F172A; text-align: right;">${escapeHtml(info.model || 'U.are.U 4500')}</strong>
                    </div>
                    <div style="display: flex; justify-content: space-between; gap: 8px;">
                        <span style="color: #64748B;">Fabricante:</span>
                        <strong style="color: #0F172A; text-align: right;">${escapeHtml(info.vendor || 'DigitalPersona, Inc.')}</strong>
                    </div>
                    <div style="display: flex; justify-content: space-between; gap: 8px;">
                        <span style="color: #64748B;">VID / PID USB:</span>
                        <code style="background: #E2E8F0; padding: 1px 6px; border-radius: 4px; font-weight: 700; color: #1E293B;">
                            ${escapeHtml(info.vendorId || '0x05BA')} / ${escapeHtml(info.productId || '0x000A')}
                        </code>
                    </div>
                    <div style="display: flex; justify-content: space-between; gap: 8px;">
                        <span style="color: #64748B;">Serie / GUID Hardware:</span>
                        <code style="font-size: 11px; background: #E2E8F0; padding: 2px 6px; border-radius: 4px; color: #0F172A; word-break: break-all; text-align: right;">
                            ${escapeHtml(info.serial || 'N/A')}
                        </code>
                    </div>
                    <div style="display: flex; justify-content: space-between; gap: 8px;">
                        <span style="color: #64748B;">Versión de Firmware:</span>
                        <strong style="color: #1D4ED8;">v${escapeHtml(info.firmware || 'N/A')}</strong>
                    </div>
                    <div style="display: flex; justify-content: space-between; gap: 8px;">
                        <span style="color: #64748B;">Revisión de Hardware:</span>
                        <strong style="color: #0F172A;">v${escapeHtml(info.hardwareRevision || 'N/A')}</strong>
                    </div>
                    <div style="display: flex; justify-content: space-between; gap: 8px;">
                        <span style="color: #64748B;">Tecnología y Resolución:</span>
                        <strong style="color: #0F172A; text-align: right;">${escapeHtml(info.technology || 'Óptico')} · ${escapeHtml(info.resolution || '500 DPI')}</strong>
                    </div>
                    <div style="display: flex; justify-content: space-between; gap: 8px;">
                        <span style="color: #64748B;">Dimensiones Sensor:</span>
                        <span style="color: #334155; font-weight: 600; text-align: right;">${escapeHtml(String(info.imageWidth || 355))}×${escapeHtml(String(info.imageHeight || 391))} px (${escapeHtml(info.captureArea || '15.8 × 12.7 mm')})</span>
                    </div>
                </div>
            </div>

            <!-- Columna 2: Versiones de Controladores y SDK -->
            <div style="background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 8px; padding: 14px;">
                <h5 style="margin: 0 0 12px; color: #0F172A; font-size: 13px; text-transform: uppercase; letter-spacing: 0.4px; border-bottom: 1px solid #E2E8F0; padding-bottom: 6px;">
                    🛠️ Propiedades y Versiones de Controladores (Drivers y SDK)
                </h5>
                <div style="display: flex; flex-direction: column; gap: 8px; font-size: 13px;">
                    <div style="display: flex; justify-content: space-between; gap: 8px;">
                        <span style="color: #64748B;">Driver USB Windows (<code style="font-size:11px;">${escapeHtml(drv.usbService || 'usbdpfp')}</code>):</span>
                        <strong style="color: #047857;">v${escapeHtml(drv.usbDriverVersion || info.driver || 'N/A')}</strong>
                    </div>
                    <div style="display: flex; justify-content: space-between; gap: 8px;">
                        <span style="color: #64748B;">Proveedor y Fecha Driver:</span>
                        <strong style="color: #0F172A; text-align: right;">${escapeHtml(drv.usbDriverProvider || 'HID Global')} (${escapeHtml(drv.usbDriverDate || 'N/A')})</strong>
                    </div>
                    <div style="display: flex; justify-content: space-between; gap: 8px;">
                        <span style="color: #64748B;">Descripción Windows Device:</span>
                        <span style="color: #334155; font-size: 12px; font-weight: 600; text-align: right;">${escapeHtml(drv.usbDeviceDescription || 'U.are.U 4500')}</span>
                    </div>
                    <div style="display: flex; justify-content: space-between; gap: 8px;">
                        <span style="color: #64748B;">Controlador Nativo (<code style="font-size:11px;">dpfpdd.dll</code>):</span>
                        <strong style="color: #1D4ED8;">v${escapeHtml(drv.dpfpddVersion || 'N/A')}</strong>
                    </div>
                    <div style="display: flex; justify-content: space-between; gap: 8px;">
                        <span style="color: #64748B;">Motor FingerJet (<code style="font-size:11px;">dpfj.dll</code>):</span>
                        <strong style="color: #1D4ED8;">v${escapeHtml(drv.dpfjVersion || 'N/A')}${drv.systemDpfjVersion && drv.systemDpfjVersion !== drv.dpfjVersion ? ` (Sys32: v${escapeHtml(drv.systemDpfjVersion)})` : ''}</strong>
                    </div>
                    <div style="display: flex; justify-content: space-between; gap: 8px;">
                        <span style="color: #64748B;">SDK .NET (<code style="font-size:11px;">DPUruNet.dll</code>):</span>
                        <strong style="color: #1D4ED8;">v${escapeHtml(drv.dpUruNetVersion || 'N/A')}</strong>
                    </div>
                    <div style="display: flex; justify-content: space-between; gap: 8px;">
                        <span style="color: #64748B;">Entorno Runtime CLR:</span>
                        <span style="color: #334155; font-weight: 600; text-align: right;">${escapeHtml(info.platform || drv.clrVersion || '.NET Framework 4.7.2')}</span>
                    </div>
                    <div style="display: flex; justify-content: space-between; gap: 8px;">
                        <span style="color: #64748B;">ID Interno USB:</span>
                        <code style="font-size: 10px; color: #475569; text-align: right; word-break: break-all;">${escapeHtml(info.deviceName || 'N/A')}</code>
                    </div>
                </div>
            </div>
        </div>

        <div style="margin-top: 14px; padding-top: 12px; border-top: 1px solid #E2E8F0;">
            <div style="font-size: 11px; color: #64748B; font-weight: 600; margin-bottom: 8px; text-transform: uppercase;">
                Capacidades Reportadas por el Dispositivo:
            </div>
            <div style="display: flex; flex-wrap: wrap; gap: 6px;">
                ${capBadges}
            </div>
        </div>
    `;
}

/**
 * Mostrar modal emergente con la ficha técnica completa del lector, propiedades del driver y control del servicio
 */
async function showDeviceDiagnosticsModal() {
    const existingContainer = document.querySelector('.modal [data-role="biometric-diagnostics-container"]');
    const isServiceOffline = touchModeState.serverOnline === false ||
        touchModeState.stopReason === 'SERVICE_STOPPED_MANUALLY' ||
        touchModeState.stopReason === 'UNEXPECTED_SERVICE_DROP';

    if (!existingContainer) {
        // Cerrar cualquier otro modal previo y abrir el modal usando la fábrica estándar openModalShell
        closeModal();
        openModalShell({
            title: '🔌 Ficha Técnica del Lector Biométrico y Propiedades del Driver',
            maxWidth: '880px',
            bodyHTML: `
                <div data-role="biometric-diagnostics-container">
                    ${buildBiometricHardwareDiagnosticsHTML(biometricDeviceInfo)}
                </div>
            `,
            footerHTML: `
                <button type="button" class="btn" data-role="biometric-service-toggle-btn" onclick="toggleBiometricServiceManual()"
                        style="background: ${isServiceOffline ? '#059669' : '#DC2626'}; color: white;">
                    ${isServiceOffline ? '⚡ Prender Servicio del Lector' : '🛑 Detener Servicio del Lector'}
                </button>
                <button type="button" class="btn" onclick="refreshBiometricDeviceInfo(true)"
                        style="background: #2563EB; color: white;">
                    🔄 Actualizar Datos USB y Drivers
                </button>
                <button type="button" class="btn btn-cancel" onclick="closeModal()">
                    Cerrar
                </button>
            `
        });
    }

    await refreshBiometricDeviceInfo(false);
}

/**
 * Inicializar modo touch e hidratación reactiva
 */
async function initializeTouchMode() {
    try {
        logger.info('🚀 Inicializando Touch Mode...');

        // 1. Configurar listener para errores críticos no controlados
        if (window.touchMode.onCriticalError) {
            window.touchMode.onCriticalError((data) => {
                logger.error('❌❌❌ ERROR CRÍTICO EN MODO AUTOMÁTICO ❌❌❌');
                logger.error('Mensaje:', data.message);

                showNotification(
                    '🚨 Corte No Controlado: ' + data.message,
                    'error'
                );

                hydrateBiometricUI(data.state || {
                    isActive: false,
                    serverOnline: false,
                    hardwareState: 'ERROR',
                    stopReason: 'UNEXPECTED_SERVICE_DROP',
                    statusMessage: data.message
                });
            });
            logger.info('[UI] Listener de errores críticos configurado');
        }

        // 2. Configurar listener unificado para Broadcast de FSM, Plug & Play, Servicio y Asistencias
        if (window.touchMode.onAttendanceRegistered) {
            window.touchMode.onAttendanceRegistered(async (eventData) => {
                logger.info('📩 [UI] Evento biométrico recibido:', eventData);

                const { type, data } = eventData;

                // A. Cambio de estado de la máquina (FSM)
                if (type === 'STATE_CHANGED') {
                    if (data?.state) {
                        hydrateBiometricUI(data.state);
                    }
                    return;
                }

                // B. Cambio de estado del servicio biométrico (Controlado manual vs Caída inesperada)
                if (type === 'SERVICE_STATUS_CHANGED') {
                    if (data?.state) {
                        hydrateBiometricUI(data.state);
                    }
                    if (data?.online === false) {
                        if (data.manual) {
                            showNotification('⏸️ Servicio biométrico detenido manualmente.', 'info');
                        } else {
                            playNotificationSound('error');
                            showNotification(
                                '🚨 El servicio biométrico se cortó inesperadamente (Evento No Controlado).',
                                'error'
                            );
                        }
                    } else if (data?.online === true) {
                        await refreshBiometricDeviceInfo(false);
                    }
                    return;
                }

                // C. Desconexión física del lector USB (Evento No Controlado)
                if (type === 'READER_DISCONNECTED') {
                    playNotificationSound('error');
                    hydrateBiometricUI(data?.state || {
                        isActive: false,
                        readerConnected: false,
                        hardwareState: 'ERROR',
                        stopReason: 'UNEXPECTED_USB_DISCONNECT',
                        statusMessage: data?.message || 'Lector USB desconectado'
                    });
                    showNotification(
                        '🔌❌ Lector biométrico desconectado del puerto USB (Corte No Controlado). Conecte el cable para reanudar.',
                        'error'
                    );
                    await refreshBiometricDeviceInfo(false);
                    return;
                }

                // D. Conexión física del lector USB (Evento Plug & Play)
                if (type === 'READER_CONNECTED') {
                    playNotificationSound('check-in');
                    const devInfo = data?.data || null;
                    hydrateBiometricUI(
                        data?.state || { readerConnected: true },
                        devInfo
                    );
                    const devModel = devInfo?.model || 'DigitalPersona U.are.U 4500';
                    const devFw = devInfo?.firmware ? ` (FW v${devInfo.firmware})` : '';
                    showNotification(
                        `🔌✅ Lector biométrico conectado: ${devModel}${devFw}`,
                        'success'
                    );
                    await refreshBiometricDeviceInfo(false);

                    // Sincronizar UI tras la auto-reanudación del servicio en segundo plano
                    setTimeout(async () => {
                        try {
                            const updatedState = await window.touchMode.getLocalState();
                            hydrateBiometricUI(updatedState);
                            await refreshBiometricDeviceInfo(false);
                        } catch (e) {
                            logger.warn('[UI] Error sincronizando estado tras reconexión USB:', e);
                        }
                    }, 900);
                    return;
                }

                // E. Eventos de toque en vivo y validación de huella
                if (type === 'FINGER_TOUCHED') {
                    if (data?.state) {
                        hydrateBiometricUI(data.state);
                    }
                    return;
                }

                if (type === 'IDENTIFICATION_FAILED') {
                    playNotificationSound('not-identified');
                    showNotification('⚠️ Huella no identificada: ' + (data?.message || 'Intente nuevamente'), 'warning');
                    return;
                }

                if (type === 'AUTO_REGISTER_ERROR') {
                    playNotificationSound('error');
                    showNotification('❌ Error al procesar registro automático: ' + (data?.error || 'Error desconocido'), 'error');
                    return;
                }

                if (type === 'CHECK_OUT_TOO_SOON') {
                    const empLabel = data?.employeeName ? `${data.employeeName}: ` : '';
                    const elapsedSec = (typeof data?.elapsedMs === 'number')
                        ? (data.elapsedMs / 1000).toFixed(1)
                        : (data?.secondsElapsed || 0);
                    const minSec = (typeof data?.minimumMs === 'number')
                        ? Math.round(data.minimumMs / 1000)
                        : 60;
                    showNotification(
                        `⏱️ ${empLabel}Debe esperar al menos ${minSec}s desde la entrada para registrar salida (${elapsedSec}s transcurridos).`,
                        'info'
                    );
                    return;
                }

                if (type === 'ALREADY_REGISTERED') {
                    const empLabel = data?.employeeName ? `${data.employeeName} (${data.employeeCode || ''})` : 'Este empleado';
                    showNotification(
                        `ℹ️ ${empLabel} ya completó su entrada y salida el día de hoy.`,
                        'info'
                    );
                    return;
                }

                // F. Mostrar notificación enriquecida al registrar asistencia
                if (type === 'CHECK_IN_REGISTERED') {
                    playNotificationSound('check-in');
                    const empPrefix = data?.employeeName
                        ? `${data.employeeName}${data.employeeCode ? ` (${data.employeeCode})` : ''} — `
                        : 'Huella identificada — ';
                    showNotification(
                        `✅ ${empPrefix}Entrada registrada a las ${data.record.check_in_time}${data.record.status === 'late' ? ' (Retardo)' : ''}`,
                        data.record.status === 'late' ? 'warning' : 'success'
                    );
                } else if (type === 'CHECK_OUT_REGISTERED') {
                    playNotificationSound('check-out');
                    const empPrefix = data?.employeeName
                        ? `${data.employeeName}${data.employeeCode ? ` (${data.employeeCode})` : ''} — `
                        : 'Huella identificada — ';
                    showNotification(
                        `✅ ${empPrefix}Salida registrada a las ${data.record.check_out_time}`,
                        'success'
                    );
                }

                // Recargar la vista actual según la sección activa
                logger.info('[UI] Recargando datos de asistencia...');
                setTimeout(async () => {
                    await loadInitialData();

                    if (currentSection === 'dashboard') {
                        loadDashboard();
                    } else if (currentSection === 'records' || currentSection === 'attendance') {
                        loadAttendanceSection();
                    } else if (currentSection === 'check-in') {
                        loadCheckInSection();
                    }
                }, 500);
            });
            logger.info('[UI] Listener de asistencias, FSM y eventos USB configurado');
        }

        // 3. Consultar estado físico del dispositivo y estado local inicial
        const state = await window.touchMode.getLocalState();
        hydrateBiometricUI(state);
        await refreshBiometricDeviceInfo(false);

        // 4. Auto-iniciar el modo automático si no está activo y está habilitado en configuración
        const savedSettings = loadSavedSettings();
        if (!touchModeState.isActive && savedSettings.autoStartListening !== false && touchModeState.stopReason !== 'SERVICE_STOPPED_MANUALLY') {
            logger.info('🔄 Auto-iniciando Modo Automático de Asistencia...');
            const result = await window.touchMode.start();

            const newState = await window.touchMode.getLocalState();
            hydrateBiometricUI(newState);
            await refreshBiometricDeviceInfo(false);

            if (result.success) {
                logger.info('✅ Modo automático auto-iniciado exitosamente');
                showNotification('Modo Automático de Asistencia activado', 'success');
            } else {
                if (result.message && result.message.includes('Servidor biométrico no disponible')) {
                    logger.warn('⚠️ Servidor biométrico no disponible - Touch Mode no iniciado');
                } else {
                    logger.error('❌ Error al auto-iniciar modo automático:', result.message);
                    showNotification('Atención: ' + result.message, 'warning');
                }
            }
        } else if (touchModeState.isActive) {
            logger.info('ℹ️ Modo automático ya estaba activo');
            startTouchModePolling();
        }

        logger.info('✅ Touch Mode inicializado');
    } catch (error) {
        logger.error('❌ Error inicializando Touch Mode:', error);
        showNotification('Error al inicializar modo automático: ' + error.message, 'error');
        hydrateBiometricUI();
    }
}

/**
 * Alternar modo touch (automático) — Evento Controlado por el usuario
 */
async function toggleAutoAttendance() {
    try {
        // Si el servicio biométrico estaba detenido manualmente o caído, prenderlo primero al iniciar modo automático
        if (!touchModeState.isActive && (touchModeState.serverOnline === false || touchModeState.stopReason === 'SERVICE_STOPPED_MANUALLY')) {
            if (window.biometricServer && typeof window.biometricServer.start === 'function') {
                showNotification('⚡ Iniciando servicio biométrico y activando escucha continua...', 'info');
                const srvRes = await window.biometricServer.start();
                if (!srvRes || !srvRes.success) {
                    showNotification(srvRes?.message || 'No se pudo iniciar el servicio biométrico', 'error');
                    return;
                }
            }
        }

        if (touchModeState.isActive) {
            logger.info('🛑 [UI] Deteniendo modo automático manualmente...');
            const result = await window.touchMode.stop();
            if (result.success) {
                logger.info('✅ [UI] Modo automático detenido exitosamente');
                showNotification('⏸️ Modo automático detenido manualmente (Evento Controlado)', 'info');
                stopTouchModePolling();
            } else {
                logger.error('❌ [UI] Error al detener:', result.message);
                showNotification(result.message || 'Error al detener modo automático', 'error');
            }
        } else {
            logger.info('🚀 [UI] Iniciando modo automático...');
            const result = await window.touchMode.start();
            if (result.success) {
                logger.info('✅ [UI] Modo automático iniciado exitosamente');
                showNotification(result.message || 'Modo automático iniciado - El lector está escuchando', 'success');
                startTouchModePolling();
            } else {
                logger.error('❌ [UI] Error al iniciar:', result.message);
                showNotification(result.message || 'Error al iniciar modo automático', 'error');
            }
        }

        const state = await window.touchMode.getLocalState();
        hydrateBiometricUI(state);
        await refreshBiometricDeviceInfo(false);

    } catch (error) {
        logger.error('❌ [UI] Error alternando modo automático:', error);
        showNotification('Error al controlar el modo automático: ' + error.message, 'error');
    }
}

/**
 * Iniciar polling ligero de contadores locales
 */
function startTouchModePolling() {
    if (touchModePollingInterval) {
        clearInterval(touchModePollingInterval);
    }

    touchModePollingInterval = setInterval(async () => {
        try {
            const state = await window.touchMode.getLocalState();
            const previousState = { ...touchModeState };

            if (state.totalFingerprints > previousState.totalFingerprints) {
                logger.info(`✅ [UI] Nueva huella procesada (total: ${state.totalFingerprints})`);
                if (currentSection === 'dashboard') {
                    setTimeout(() => loadDashboard(), 1000);
                }
            }

            if (state.totalTouches > previousState.totalTouches) {
                logger.info(`👆 [UI] Dedo detectado en el lector (total: ${state.totalTouches})`);
            }

            hydrateBiometricUI(state);
        } catch (error) {
            logger.error('❌ [UI] Error polling touch mode state:', error);
        }
    }, 1500);
}

/**
 * Detener polling de estado
 */
function stopTouchModePolling() {
    if (touchModePollingInterval) {
        clearInterval(touchModePollingInterval);
        touchModePollingInterval = null;
    }
}

/**
 * Actualizar UI del modo touch en la sección "Marcar Asistencia"
 */
function updateTouchModeUI() {
    const statusIndicator = document.getElementById('auto-attendance-status');
    const toggleBtn = document.getElementById('toggle-auto-attendance-btn');

    if (!statusIndicator || !toggleBtn) return;

    const visual = getBiometricVisualState();
    const modelText = biometricDeviceInfo?.model || touchModeState.readerModel || 'DigitalPersona U.are.U 4500';
    const fwText = biometricDeviceInfo?.firmware || touchModeState.readerFirmware || '';
    const drvText = biometricDeviceInfo?.drivers?.usbDriverVersion || '';
    const isServiceOffline = touchModeState.serverOnline === false ||
        touchModeState.stopReason === 'SERVICE_STOPPED_MANUALLY' ||
        touchModeState.stopReason === 'UNEXPECTED_SERVICE_DROP';

    const statsLine = visual.code === 'TOUCH_CONTINUOUS'
        ? `Toques: ${touchModeState.totalTouches} | Huellas: ${touchModeState.totalFingerprints}${fwText ? ` | FW v${escapeHtml(fwText)}` : ''}${drvText ? ` | Driver v${escapeHtml(drvText)}` : ''}`
        : `${escapeHtml(visual.bannerSub)}${fwText && visual.code === 'MANUAL_STOP' ? ` (FW v${escapeHtml(fwText)} · Driver v${escapeHtml(drvText || 'N/A')})` : ''}`;

    statusIndicator.innerHTML = `
        <div style="display: flex; flex-direction: column; gap: 12px; padding: 15px; background: ${visual.bgColor}; border-radius: 10px; border: 2px solid ${visual.borderColor};">
            <div style="display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 10px;">
                <div style="display: flex; align-items: center; gap: 10px;">
                    <div style="width: 12px; height: 12px; background: ${visual.dotColor}; border-radius: 50%; flex-shrink: 0; ${visual.pulse ? 'animation: pulse 2s infinite;' : ''}"></div>
                    <div>
                        <div style="font-weight: 700; color: ${visual.titleColor}; font-size: 14px;">
                            ${escapeHtml(visual.bannerTitle)} — ${escapeHtml(modelText)}
                        </div>
                        <div style="font-size: 12.5px; color: #334155; margin-top: 3px;">
                            ${statsLine}
                        </div>
                    </div>
                </div>
                <span style="padding: 3px 9px; border-radius: 999px; font-size: 11px; font-weight: 700; background: white; color: ${visual.titleColor}; border: 1px solid ${visual.borderColor};">
                    FSM: ${escapeHtml(touchModeState.hardwareState || 'IDLE')} · ${escapeHtml(visual.eventKind)}
                </span>
            </div>
            <div style="display: flex; gap: 8px; flex-wrap: wrap; padding-top: 8px; border-top: 1px solid ${visual.borderColor}40;">
                <button type="button" class="btn" onclick="showDeviceDiagnosticsModal()"
                        style="padding: 6px 12px; font-size: 12px; background: #1E293B; color: white; border-radius: 6px;">
                    🔌 Ver Dispositivo y Propiedades del Driver
                </button>
            </div>
        </div>
    `;

    if (touchModeState.isActive) {
        toggleBtn.innerHTML = '🔴 Detener Escucha Continua (Paro Manual)';
        toggleBtn.className = 'btn';
        toggleBtn.style.background = '#EF4444';
        toggleBtn.style.color = 'white';
    } else {
        toggleBtn.innerHTML = isServiceOffline
            ? '🟢 Prender Servicio e Iniciar Modo Automático'
            : '🟢 Iniciar Escucha Continua (Modo Automático)';
        toggleBtn.className = 'btn btn-primary';
        toggleBtn.style.background = '';
        toggleBtn.style.color = '';
    }
}

/**
 * Manejar registro automático de asistencia
 */
async function handleAutoAttendanceRegistration(data) {
    const { type, employee, result, message } = data;

    // Reproducir sonido (opcional)
    playNotificationSound(type);

    // Mostrar notificación
    if (type === 'check-in') {
        showNotification(
            `✅ ${escapeHtml(employee.first_name)} ${escapeHtml(employee.last_name)} - Entrada registrada ${result.record.status === 'late' ? '(tarde)' : ''}`,
            result.record.status === 'late' ? 'warning' : 'success'
        );
    } else if (type === 'check-out') {
        showNotification(
            `✅ ${escapeHtml(employee.first_name)} ${escapeHtml(employee.last_name)} - Salida registrada`,
            'success'
        );
    } else if (type === 'already-registered') {
        showNotification(
            `ℹ️ ${escapeHtml(employee.first_name)} ${escapeHtml(employee.last_name)} - ${message}`,
            'info'
        );
    } else if (type === 'not-identified') {
        showNotification(
            '❌ Huella no identificada en el sistema',
            'error'
        );
    } else if (type === 'error') {
        showNotification(
            `❌ Error: ${message}`,
            'error'
        );
    }

    // Recargar registros del día según la sección activa
    if (currentSection === 'dashboard' || currentSection === 'records' || currentSection === 'attendance' || currentSection === 'check-in') {
        setTimeout(async () => {
            await loadInitialData();
            if (currentSection === 'dashboard') {
                loadDashboard();
            } else if (currentSection === 'records' || currentSection === 'attendance') {
                loadAttendanceSection();
            } else if (currentSection === 'check-in') {
                loadCheckInSection();
            }
        }, 1000);
    }
}

/**
 * Cargar sección de registros (alias para loadAttendanceSection)
 */
function loadRecordsSection() {
    return loadAttendanceSection();
}

/**
 * Reproducir sonido de notificación
 */
function playNotificationSound(type) {
    const settings = loadSavedSettings();
    if (!settings.audioFeedback) return;

    try {
        const context = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = context.createOscillator();
        const gainNode = context.createGain();

        oscillator.connect(gainNode);
        gainNode.connect(context.destination);

        if (type === 'check-in' || type === 'check-out') {
            // Sonido de éxito armónico
            oscillator.frequency.setValueAtTime(587.33, context.currentTime);
            oscillator.frequency.setValueAtTime(880, context.currentTime + 0.08);
            gainNode.gain.setValueAtTime(0.2, context.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.01, context.currentTime + 0.25);
            oscillator.start(context.currentTime);
            oscillator.stop(context.currentTime + 0.25);
        } else if (type === 'error' || type === 'not-identified') {
            // Sonido de advertencia/error
            oscillator.frequency.setValueAtTime(220, context.currentTime);
            oscillator.frequency.setValueAtTime(196, context.currentTime + 0.1);
            gainNode.gain.setValueAtTime(0.2, context.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.01, context.currentTime + 0.3);
            oscillator.start(context.currentTime);
            oscillator.stop(context.currentTime + 0.3);
        }
    } catch (error) {
        // Ignorar errores de audio
    }
}

/**
 * Validar antes de iniciar enrollment (sin matar TouchMode con MANUAL_STOP;
 * la pausa controlada OPERATION_PAUSE y su reanudación automática ocurren en biometric:enrollFingerprint)
 */
async function validateBeforeEnrollment(employeeId) {
    try {
        if (!window.touchMode) return true;
        const state = await window.touchMode.getLocalState();
        if (state) {
            hydrateBiometricUI(state);
        }

        if (state && state.stopReason === 'SERVICE_STOPPED_MANUALLY') {
            const wantStart = confirm(
                '⏸️ El servicio del lector biométrico fue detenido manualmente.\n\n' +
                '¿Desea prender el servicio ahora para poder registrar la huella?'
            );
            if (wantStart) {
                await toggleBiometricServiceManual();
                const afterState = await window.touchMode.getLocalState();
                return afterState?.serverOnline !== false;
            }
            return false;
        }

        if (state && (state.readerConnected === false || state.stopReason === 'UNEXPECTED_USB_DISCONNECT')) {
            showNotification(
                '🔌❌ El lector biométrico está desconectado del puerto USB. Conecte el dispositivo antes de registrar huellas.',
                'error'
            );
            return false;
        }

        return true;
    } catch (error) {
        logger.error('Error validando enrollment con TouchMode:', error);
        return true;
    }
}

// ==================== NOTIFICACIONES ====================
function showNotification(message, type = 'info') {
    // Remover notificaciones anteriores
    document.querySelectorAll('.notification').forEach(n => n.remove());

    const colors = {
        'success': '#10B981',
        'error': '#EF4444',
        'warning': '#F59E0B',
        'info': '#3B82F6'
    };

    const notification = document.createElement('div');
    notification.className = 'notification';
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: white;
        padding: 15px 20px;
        border-radius: 12px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        border-left: 4px solid ${colors[type]};
        z-index: 10000;
        max-width: 400px;
        animation: slideIn 0.3s ease-out;
    `;
    notification.textContent = message;

    const style = document.createElement('style');
    style.textContent = `
        @keyframes slideIn {
            from {
                transform: translateX(400px);
                opacity: 0;
            }
            to {
                transform: translateX(0);
                opacity: 1;
            }
        }
    `;
    document.head.appendChild(style);
    document.body.appendChild(notification);

    const settings = loadSavedSettings();
    const duration = Math.max(2, safeParseInt(settings.successDuration, 4)) * 1000;

    setTimeout(() => {
        notification.style.animation = 'slideIn 0.3s ease-out reverse';
        setTimeout(() => notification.remove(), 300);
    }, duration);
}

// ==================== UTILIDADES ====================
function formatTime(timeString) {
    if (!timeString) return '-';
    return timeString.substring(0, 5); // HH:MM
}

function formatDate(dateString) {
    if (!dateString) return '-';
    return parseLocalDateClient(dateString).toLocaleDateString('es-ES');
}

// FE-01: exposicion explicita requerida por handlers onclick inline (contrato DOM preservado).
// En modulo ES estas funciones ya no son globals implicitas.
Object.assign(window, {
    closeModal,
    deleteDepartment,
    deleteEmployee,
    deleteFingerprint,
    deleteShift,
    generateDailyReport,
    generateEmployeeReport,
    generateMonthlyReport,
    generateWeeklyReport,
    performCheckIn,
    performCheckOut,
    printReport,
    resetDatabase,
    resetSettings,
    saveDepartment,
    saveNewEmployee,
    saveSettings,
    saveShift,
    selectCaptureMode,
    selectEmployeeForCheckIn,
    showAddDepartmentModal,
    showAddEmployeeModal,
    showAddShiftModal,
    showEditDepartmentModal,
    showEditEmployeeModal,
    showEditShiftModal,
    showEmployeeDetails,
    showEmployeeReportDetails,
    showEnrollFingerprintModal,
    startFingerprintEnrollment,
    updateDepartment,
    updateEmployee,
    updateShift,
    toggleAutoAttendance,
    loadRecordsSection,
    switchReportsSubTab,
    toggleMonthAbsenceAccordion,
    onSearchEmployeeAbsences,
    showEmployeeAbsenceHistoryModal,
    onExecuteDomainQuestion,
    onQuickDomainQuestion,
    calcEmployeeAbsenceHistoryClient,
    getWeekRangeClient,
    groupAbsenceDaysByWeekClient,
    exportAbsenceHistoryToExcel,
    exportAbsenceHistoryToPDF,
    printAbsenceHistory,
    exportQAToExcel,
    exportQAToPDF,
    printQAResult,
    downloadFile,
    openJustifyAbsenceModal,
    closeJustifyAbsenceModal,
    submitJustifyAbsence,
    filterCheckInEmployees,
    renderCheckInCards,
    handleBiometricPolicyChange,
    handleNotificationMasterChange,
    refreshBiometricDeviceInfo,
    showDeviceDiagnosticsModal,
    exportDailyReportToExcel,
    exportWeeklyReportToExcel,
    exportMonthlyReportToExcel,
    exportEmployeeReportToExcel,
    updateKioskTopbarUI,
    promptAdminPinModal,
    toggleAdminLockManual,
    openAdminPinSetupModal,
    submitAdminPinSetup,
    submitRemoveAdminPin,
    executeAbsentCutoffNow,
    handleExportDatabaseBackup,
    handleRestoreDatabaseBackup,
});
