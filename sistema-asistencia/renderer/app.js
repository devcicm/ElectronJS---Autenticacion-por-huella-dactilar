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
}

async function showSection(sectionName) {
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
        // Cargar datos generales
        [employees, departments, shifts] = await Promise.all([
            window.attendance.getEmployees({ status: 'active' }),
            window.attendance.getDepartments(),
            window.attendance.getShifts()
        ]);

        logger.info(`✅ Datos cargados: ${employees.length} empleados, ${departments.length} departamentos, ${shifts.length} turnos`);
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
            <td>${escapeHtml(record.employee_code) || '-'}</td>
            <td>${escapeHtml(record.employee_name) || '-'}</td>
            <td>${escapeHtml(record.department_name) || '-'}</td>
            <td>${escapeHtml(record.check_in_time) || '-'}</td>
            <td>${escapeHtml(record.check_out_time) || '-'}</td>
            <td><span class="badge badge-${getStatusBadgeClass(record.status)}">${getStatusLabel(record.status)}</span></td>
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

// ==================== CHECK-IN SECTION ====================
async function loadCheckInSection() {
    // Cargar empleados activos
    const employeesList = document.getElementById('employees-list');
    if (!employeesList) return;

    if (employees.length === 0) {
        employeesList.innerHTML = '<p style="text-align:center; padding: 2rem; color: #666;">No hay empleados activos</p>';
        return;
    }

    employeesList.innerHTML = `
        <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 15px;">
            ${employees.map(emp => `
                <div style="border: 2px solid #E5E7EB; border-radius: 12px; padding: 15px; cursor: pointer; transition: all 0.2s; background: white;"
                     onmouseover="this.style.borderColor='#3B82F6'; this.style.boxShadow='0 4px 12px rgba(59,130,246,0.2)'"
                     onmouseout="this.style.borderColor='#E5E7EB'; this.style.boxShadow='none'"
                     onclick="selectEmployeeForCheckIn(${emp.id})">
                    <div style="display: flex; align-items: center; gap: 15px;">
                        <div style="width: 60px; height: 60px; border-radius: 50%; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); display: flex; align-items: center; justify-content: center; color: white; font-size: 24px; font-weight: 600;">
                            ${escapeHtml(getInitials(emp.first_name, emp.last_name))}
                        </div>
                        <div style="flex: 1;">
                            <div style="font-weight: 600; font-size: 16px; color: #1F2937; margin-bottom: 4px;">
                                ${escapeHtml(emp.first_name)} ${escapeHtml(emp.last_name)}
                            </div>
                            <div style="font-size: 13px; color: #6B7280;">
                                ${escapeHtml(emp.employee_code)} • ${escapeHtml(emp.department_name)}
                            </div>
                            <div style="font-size: 12px; color: #9CA3AF; margin-top: 2px;">
                                ${escapeHtml(emp.shift_name)}
                            </div>
                        </div>
                    </div>
                </div>
            `).join('')}
        </div>
    `;
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

    // Verificar qué acciones puede realizar
    const [canCheckInResult, canCheckOutResult] = await Promise.all([
        window.attendance.canCheckIn(employeeId),
        window.attendance.canCheckOut(employeeId)
    ]);

    const modalContent = `
        <div class="modal active" onclick="if(event.target === this) closeModal()">
            <div class="modal-content">
                <div class="modal-header">
                    <h3>Registrar Asistencia</h3>
                    <button class="close-btn" onclick="closeModal()">&times;</button>
                </div>
                <div class="modal-body">
                    <div style="text-align: center; margin-bottom: 30px;">
                        <div style="width: 100px; height: 100px; border-radius: 50%; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); display: flex; align-items: center; justify-content: center; color: white; font-size: 40px; font-weight: 600; margin: 0 auto 15px;">
                            ${getInitials(employee.first_name, employee.last_name)}
                        </div>
                        <h3 style="margin: 0 0 5px; color: #1F2937;">${escapeHtml(employee.first_name)} ${escapeHtml(employee.last_name)}</h3>
                        <p style="color: #6B7280; margin: 0;">${escapeHtml(employee.employee_code)}</p>
                        <p style="color: #6B7280; margin: 5px 0 0;">${escapeHtml(employee.department_name)} • ${escapeHtml(employee.shift_name)}</p>
                    </div>

                    <div style="display: flex; flex-direction: column; gap: 10px;">
                        ${canCheckInResult.can ? `
                            <button class="btn btn-success" onclick="performCheckIn()" style="width: 100%; padding: 15px; font-size: 16px;">
                                ✓ Marcar Entrada
                            </button>
                        ` : `
                            <div style="padding: 12px; background: #FEF2F2; border: 1px solid #FECACA; border-radius: 8px; color: #991B1B;">
                                ⚠️ ${canCheckInResult.reason}
                            </div>
                        `}

                        ${canCheckOutResult.can ? `
                            <button class="btn btn-warning" onclick="performCheckOut()" style="width: 100%; padding: 15px; font-size: 16px;">
                                ✓ Marcar Salida
                            </button>
                        ` : canCheckOutResult.reason ? `
                            <div style="padding: 12px; background: #FFFBEB; border: 1px solid #FDE68A; border-radius: 8px; color: #92400E;">
                                ℹ️ ${canCheckOutResult.reason}
                            </div>
                        ` : ''}
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn" onclick="closeModal()" style="background: #6B7280; color: white;">Cancelar</button>
                </div>
            </div>
        </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalContent);
}

async function performCheckIn() {
    if (!selectedEmployeeId) return;

    const actionBtns = document.querySelectorAll('.modal.active button');
    actionBtns.forEach(btn => btn.disabled = true);

    try {
        // Intentar identificación biométrica
        const biometricAvailable = await window.biometric.isServerAvailable();

        let fingerprintVerified = false;

        if (biometricAvailable) {
            showNotification('Coloque el dedo en el lector...', 'info');

            const verifyResult = await window.biometric.verifyFingerprint(selectedEmployeeId);

            if (verifyResult.verified) {
                fingerprintVerified = true;
                showNotification('Huella verificada ✓', 'success');
            } else {
                showNotification('Advertencia: Huella no verificada', 'warning');
            }
        }

        // Marcar entrada
        const result = await window.attendance.checkIn(selectedEmployeeId, fingerprintVerified);

        if (result.success) {
            showNotification(result.message, 'success');
            closeModal();
            if (currentSection === 'dashboard') {
                loadDashboard();
            } else if (currentSection === 'check-in') {
                loadCheckInSection();
            }
        } else {
            showNotification(result.message, 'error');
            actionBtns.forEach(btn => btn.disabled = false);
        }
    } catch (error) {
        logger.error('Error en check-in:', error);
        showNotification('Error al registrar entrada', 'error');
        actionBtns.forEach(btn => btn.disabled = false);
    }
}

async function performCheckOut() {
    if (!selectedEmployeeId) return;

    const actionBtns = document.querySelectorAll('.modal.active button');
    actionBtns.forEach(btn => btn.disabled = true);

    try {
        const result = await window.attendance.checkOut(selectedEmployeeId);

        if (result.success) {
            showNotification(result.message, 'success');
            closeModal();
            if (currentSection === 'dashboard') {
                loadDashboard();
            } else if (currentSection === 'check-in') {
                loadCheckInSection();
            }
        } else {
            showNotification(result.message, 'error');
            actionBtns.forEach(btn => btn.disabled = false);
        }
    } catch (error) {
        logger.error('Error en check-out:', error);
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

// ==================== EMPLOYEES SECTION ====================
async function loadEmployeesSection() {
    const container = document.getElementById('employees-table-container');
    if (!container) return;

    // Recargar empleados
    employees = await window.attendance.getEmployees({});

    container.innerHTML = `
        <div style="margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center;">
            <div>
                <input type="text" id="employee-search" placeholder="Buscar empleado..."
                       style="padding: 10px; border: 1px solid #E5E7EB; border-radius: 8px; width: 300px;"
                       onkeyup="filterEmployees(this.value)">
            </div>
            <button class="btn btn-primary" onclick="showAddEmployeeModal()">
                + Agregar Empleado
            </button>
        </div>

        <div class="table-container">
            <table>
                <thead>
                    <tr>
                        <th>Código</th>
                        <th>Nombre</th>
                        <th>Email</th>
                        <th>Departamento</th>
                        <th>Turno</th>
                        <th>Huellas</th>
                        <th>Modo</th>
                        <th>Estado</th>
                        <th>Acciones</th>
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
        ? `<img src="${escapeHtml(emp.photo_url)}" alt="Foto" style="width: 28px; height: 28px; border-radius: 50%; object-fit: cover; border: 1px solid #D1D5DB; vertical-align: middle;">`
        : `<div style="width: 28px; height: 28px; border-radius: 50%; background: #E5E7EB; display: inline-flex; align-items: center; justify-content: center; font-size: 13px; vertical-align: middle;">👤</div>`;

    return `
    <tr>
        <td><strong>${escapeHtml(emp.employee_code || '')}</strong></td>
        <td>
            <div style="display: flex; align-items: center; gap: 8px;">
                ${avatarHtml}
                <span>${escapeHtml((emp.first_name || '') + ' ' + (emp.last_name || ''))}</span>
            </div>
        </td>
        <td>${escapeHtml(emp.email || '')}</td>
        <td>${escapeHtml(emp.department_name || '')}</td>
        <td>${escapeHtml(emp.shift_name || '')}</td>
        <td style="text-align: center;">${emp.fingerprints_count || 0}/10</td>
        <td style="text-align: center;">
            <span style="background: ${enrollmentColor}; color: white; padding: 4px 10px; border-radius: 12px; font-size: 11px; font-weight: 600;">
                ${enrollmentText}
            </span>
        </td>
        <td><span class="badge badge-${statusClass}">${escapeHtml(statusText)}</span></td>
        <td>
            <button class="btn" onclick="showEmployeeDetails(${emp.id})" style="padding: 5px 10px; font-size: 12px; margin-right: 3px; background: #3B82F6; color: white;" title="Ver detalles">👁️</button>
            <button class="btn" onclick="showEditEmployeeModal(${emp.id})" style="padding: 5px 10px; font-size: 12px; margin-right: 3px; background: #10B981; color: white;" title="Editar">✏️</button>
            <button class="btn" onclick="showEnrollFingerprintModal(${emp.id})" style="padding: 5px 10px; font-size: 12px; margin-right: 3px; background: #8B5CF6; color: white;" title="Registrar huella">👆</button>
            <button class="btn" onclick="deleteEmployee(${emp.id})" style="padding: 5px 10px; font-size: 12px; background: #EF4444; color: white;" title="Eliminar">🗑️</button>
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
    const modalHTML = `
        <div class="modal active" onclick="if(event.target === this) closeModal()">
            <div class="modal-content" style="max-width: 700px;">
                <div class="modal-header">
                    <h3>Agregar Nuevo Empleado</h3>
                    <button class="close-btn" onclick="closeModal()">&times;</button>
                </div>
                <div class="modal-body">
                    <form id="add-employee-form" onsubmit="event.preventDefault(); saveNewEmployee();">
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                            <!-- Fotografía del Empleado (Cámara / Archivo) -->
                            <div class="form-group" style="grid-column: 1 / -1; background: #F9FAFB; padding: 12px; border-radius: 8px; border: 1px dashed #D1D5DB;">
                                <label style="font-weight: 600; margin-bottom: 8px; display: block; font-size: 13px;">Fotografía del Empleado (Cámara Web / Archivo)</label>
                                <div style="display: flex; align-items: center; gap: 15px; flex-wrap: wrap;">
                                    <div id="emp-photo-preview-container" style="width: 64px; height: 64px; border-radius: 50%; overflow: hidden; background: #E5E7EB; border: 2px solid #9CA3AF; display: flex; align-items: center; justify-content: center;">
                                        <img id="emp-photo-preview" src="" style="width: 100%; height: 100%; object-fit: cover; display: none;" alt="Vista previa">
                                        <span id="emp-photo-placeholder" style="font-size: 26px;">👤</span>
                                    </div>
                                    <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                                        <button type="button" class="btn" style="background: #2563EB; color: white; padding: 6px 12px; font-size: 12px;" onclick="openCameraModal('emp-photo-data', 'emp-photo-preview', 'emp-photo-placeholder', 'emp-photo-clear-btn')">
                                            📷 Tomar Foto
                                        </button>
                                        <label class="btn" style="background: #4B5563; color: white; padding: 6px 12px; font-size: 12px; cursor: pointer; margin: 0; display: inline-flex; align-items: center;">
                                            📁 Subir Archivo
                                            <input type="file" accept="image/*" style="display: none;" onchange="handlePhotoFileUpload(event, 'emp-photo-data', 'emp-photo-preview', 'emp-photo-placeholder', 'emp-photo-clear-btn')">
                                        </label>
                                        <button type="button" id="emp-photo-clear-btn" class="btn" style="background: #EF4444; color: white; padding: 6px 12px; font-size: 12px; display: none;" onclick="clearEmployeePhoto('emp-photo-data', 'emp-photo-preview', 'emp-photo-placeholder', 'emp-photo-clear-btn')">
                                            🗑️ Quitar
                                        </button>
                                    </div>
                                </div>
                                <input type="hidden" id="emp-photo-data" value="">
                            </div>

                            <div class="form-group">
                                <label>Código de Empleado *</label>
                                <input type="text" id="emp-code" class="form-control" required>
                            </div>
                            <div class="form-group">
                                <label>Fecha de Contratación *</label>
                                <input type="date" id="emp-hire-date" class="form-control" required>
                            </div>
                            <div class="form-group">
                                <label>Nombre(s) *</label>
                                <input type="text" id="emp-firstname" class="form-control" required>
                            </div>
                            <div class="form-group">
                                <label>Apellido(s) *</label>
                                <input type="text" id="emp-lastname" class="form-control" required>
                            </div>
                            <div class="form-group">
                                <label>Email *</label>
                                <input type="email" id="emp-email" class="form-control" required>
                            </div>
                            <div class="form-group">
                                <label>Teléfono</label>
                                <input type="tel" id="emp-phone" class="form-control">
                            </div>
                            <div class="form-group">
                                <label>Departamento *</label>
                                <select id="emp-department" class="form-control" required>
                                    <option value="">Seleccione...</option>
                                    ${departments.map(dept => `<option value="${dept.id}">${escapeHtml(dept.name)}</option>`).join('')}
                                </select>
                            </div>
                            <div class="form-group">
                                <label>Turno *</label>
                                <select id="emp-shift" class="form-control" required>
                                    <option value="">Seleccione...</option>
                                    ${shifts.map(shift => `<option value="${shift.id}">${escapeHtml(shift.name)}</option>`).join('')}
                                </select>
                            </div>
                            <div class="form-group">
                                <label>Puesto *</label>
                                <input type="text" id="emp-position" class="form-control" required>
                            </div>
                            <div class="form-group">
                                <label>Modo de Captura de Huella</label>
                                <select id="emp-enrollment-mode" class="form-control">
                                    <option value="simple" selected>Simple (1 huella recomendada)</option>
                                    <option value="advanced">Avanzado (10 huellas)</option>
                                </select>
                            </div>
                        </div>
                    </form>
                </div>
                <div class="modal-footer">
                    <button class="btn" onclick="closeModal()" style="background: #6B7280; color: white;">Cancelar</button>
                    <button class="btn btn-primary" onclick="saveNewEmployee()">Guardar Empleado</button>
                </div>
            </div>
        </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHTML);

    // Establecer fecha de hoy por defecto
    document.getElementById('emp-hire-date').valueAsDate = new Date();
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

    const submitBtn = document.querySelector('.modal.active .btn-primary');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Guardando...';
    }

    try {
        const result = await window.attendance.createEmployee(data);

        if (result.success) {
            showNotification(result.message || 'Empleado creado exitosamente', 'success');
            closeModal();
            await loadInitialData();
            loadEmployeesSection();
        } else {
            showNotification(result.message || 'Error al crear empleado', 'error');
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Guardar Empleado';
            }
        }
    } catch (error) {
        logger.error('Error creando empleado:', error);
        showNotification(error.message || 'Error al crear empleado', 'error');
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Guardar Empleado';
        }
    }
}

// Mostrar modal para editar empleado
function showEditEmployeeModal(employeeId) {
    const employee = employees.find(e => e.id === employeeId);
    if (!employee) {
        showNotification('Empleado no encontrado', 'error');
        return;
    }

    const modalHTML = `
        <div class="modal active" onclick="if(event.target === this) closeModal()">
            <div class="modal-content" style="max-width: 700px;">
                <div class="modal-header">
                    <h3>Editar Empleado</h3>
                    <button class="close-btn" onclick="closeModal()">&times;</button>
                </div>
                <div class="modal-body">
                    <form id="edit-employee-form" onsubmit="event.preventDefault(); updateEmployee(${employeeId});">
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                            <!-- Fotografía del Empleado (Cámara / Archivo) -->
                            <div class="form-group" style="grid-column: 1 / -1; background: #F9FAFB; padding: 12px; border-radius: 8px; border: 1px dashed #D1D5DB;">
                                <label style="font-weight: 600; margin-bottom: 8px; display: block; font-size: 13px;">Fotografía del Empleado (Cámara Web / Archivo)</label>
                                <div style="display: flex; align-items: center; gap: 15px; flex-wrap: wrap;">
                                    <div id="edit-emp-photo-preview-container" style="width: 64px; height: 64px; border-radius: 50%; overflow: hidden; background: #E5E7EB; border: 2px solid #9CA3AF; display: flex; align-items: center; justify-content: center;">
                                        <img id="edit-emp-photo-preview" src="${escapeHtml(employee.photo_url || '')}" style="width: 100%; height: 100%; object-fit: cover; ${employee.photo_url ? '' : 'display: none;'}" alt="Vista previa">
                                        <span id="edit-emp-photo-placeholder" style="font-size: 26px; ${employee.photo_url ? 'display: none;' : ''}">👤</span>
                                    </div>
                                    <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                                        <button type="button" class="btn" style="background: #2563EB; color: white; padding: 6px 12px; font-size: 12px;" onclick="openCameraModal('edit-emp-photo-data', 'edit-emp-photo-preview', 'edit-emp-photo-placeholder', 'edit-emp-photo-clear-btn')">
                                            📷 Tomar Foto
                                        </button>
                                        <label class="btn" style="background: #4B5563; color: white; padding: 6px 12px; font-size: 12px; cursor: pointer; margin: 0; display: inline-flex; align-items: center;">
                                            📁 Subir Archivo
                                            <input type="file" accept="image/*" style="display: none;" onchange="handlePhotoFileUpload(event, 'edit-emp-photo-data', 'edit-emp-photo-preview', 'edit-emp-photo-placeholder', 'edit-emp-photo-clear-btn')">
                                        </label>
                                        <button type="button" id="edit-emp-photo-clear-btn" class="btn" style="background: #EF4444; color: white; padding: 6px 12px; font-size: 12px; ${employee.photo_url ? '' : 'display: none;'}" onclick="clearEmployeePhoto('edit-emp-photo-data', 'edit-emp-photo-preview', 'edit-emp-photo-placeholder', 'edit-emp-photo-clear-btn')">
                                            🗑️ Quitar
                                        </button>
                                    </div>
                                </div>
                                <input type="hidden" id="edit-emp-photo-data" value="${escapeHtml(employee.photo_url || '')}">
                            </div>

                            <div class="form-group">
                                <label>Código de Empleado *</label>
                                <input type="text" id="edit-emp-code" class="form-control" value="${escapeHtml(employee.employee_code)}" required>
                            </div>
                            <div class="form-group">
                                <label>Fecha de Contratación *</label>
                                <input type="date" id="edit-emp-hire-date" class="form-control" value="${escapeHtml(employee.hire_date)}" required>
                            </div>
                            <div class="form-group">
                                <label>Nombre(s) *</label>
                                <input type="text" id="edit-emp-firstname" class="form-control" value="${escapeHtml(employee.first_name)}" required>
                            </div>
                            <div class="form-group">
                                <label>Apellido(s) *</label>
                                <input type="text" id="edit-emp-lastname" class="form-control" value="${escapeHtml(employee.last_name)}" required>
                            </div>
                            <div class="form-group">
                                <label>Email *</label>
                                <input type="email" id="edit-emp-email" class="form-control" value="${escapeHtml(employee.email)}" required>
                            </div>
                            <div class="form-group">
                                <label>Teléfono</label>
                                <input type="tel" id="edit-emp-phone" class="form-control" value="${employee.phone ? escapeHtml(employee.phone) : ''}">
                            </div>
                            <div class="form-group">
                                <label>Departamento *</label>
                                <select id="edit-emp-department" class="form-control" required>
                                    ${departments.map(dept => `<option value="${dept.id}" ${dept.id === employee.department_id ? 'selected' : ''}>${escapeHtml(dept.name)}</option>`).join('')}
                                </select>
                            </div>
                            <div class="form-group">
                                <label>Turno *</label>
                                <select id="edit-emp-shift" class="form-control" required>
                                    ${shifts.map(shift => `<option value="${shift.id}" ${shift.id === employee.shift_id ? 'selected' : ''}>${escapeHtml(shift.name)}</option>`).join('')}
                                </select>
                            </div>
                            <div class="form-group">
                                <label>Puesto *</label>
                                <input type="text" id="edit-emp-position" class="form-control" value="${escapeHtml(employee.position)}" required>
                            </div>
                            <div class="form-group">
                                <label>Estado *</label>
                                <select id="edit-emp-status" class="form-control" required>
                                    <option value="active" ${employee.status === 'active' ? 'selected' : ''}>Activo</option>
                                    <option value="inactive" ${employee.status === 'inactive' ? 'selected' : ''}>Inactivo</option>
                                    <option value="suspended" ${employee.status === 'suspended' ? 'selected' : ''}>Suspendido</option>
                                </select>
                            </div>
                            <div class="form-group" style="grid-column: 1 / -1;">
                                <label>Modo de Captura de Huella</label>
                                <select id="edit-emp-enrollment-mode" class="form-control">
                                    <option value="simple" ${employee.enrollment_mode === 'simple' ? 'selected' : ''}>Simple (1 huella recomendada)</option>
                                    <option value="advanced" ${employee.enrollment_mode === 'advanced' ? 'selected' : ''}>Avanzado (10 huellas)</option>
                                </select>
                            </div>
                        </div>
                    </form>
                </div>
                <div class="modal-footer">
                    <button class="btn" onclick="closeModal()" style="background: #6B7280; color: white;">Cancelar</button>
                    <button class="btn btn-primary" onclick="updateEmployee(${employeeId})">Actualizar Empleado</button>
                </div>
            </div>
        </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHTML);
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

    try {
        const result = await window.attendance.updateEmployee(data);

        if (result.success) {
            showNotification(result.message || 'Empleado actualizado exitosamente', 'success');
            closeModal();
            await loadInitialData();
            loadEmployeesSection();
        } else {
            showNotification(result.message || 'Error al actualizar empleado', 'error');
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Actualizar Empleado';
            }
        }
    } catch (error) {
        logger.error('Error actualizando empleado:', error);
        showNotification(error.message || 'Error al actualizar empleado', 'error');
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Actualizar Empleado';
        }
    }
}

// Eliminar empleado
async function deleteEmployee(employeeId) {
    const employee = employees.find(e => e.id === employeeId);
    if (!employee) {
        showNotification('Empleado no encontrado', 'error');
        return;
    }

    const confirmDelete = confirm(
        `¿Está seguro de que desea eliminar al empleado?\n\n` +
        `${escapeHtml(employee.first_name)} ${escapeHtml(employee.last_name)} (${escapeHtml(employee.employee_code)})\n\n` +
        `Esta acción NO se puede deshacer. Se eliminarán también:\n` +
        `- Todos sus registros de asistencia\n` +
        `- Todas sus huellas registradas\n\n` +
        `¿Desea continuar?`
    );

    if (!confirmDelete) {
        return;
    }

    try {
        const result = await window.attendance.deleteEmployee(employeeId);

        if (result) {
            showNotification('Empleado eliminado exitosamente', 'success');
            await loadInitialData();
            loadEmployeesSection();
        } else {
            showNotification('Error al eliminar empleado', 'error');
        }
    } catch (error) {
        logger.error('Error eliminando empleado:', error);
        showNotification(error.message || 'Error al eliminar empleado', 'error');
    }
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
                            ? `<img src="${escapeHtml(employee.photo_url)}" alt="Foto de ${escapeHtml(employee.first_name)}" style="width: 100px; height: 100px; border-radius: 50%; object-fit: cover; margin: 0 auto 15px; display: block; border: 3px solid #3B82F6; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">`
                            : `<div style="width: 100px; height: 100px; border-radius: 50%; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); display: flex; align-items: center; justify-content: center; color: white; font-size: 40px; font-weight: 600; margin: 0 auto 15px;">
                                ${getInitials(employee.first_name, employee.last_name)}
                               </div>`
                        }
                        <h3 style="margin: 0;">${escapeHtml(employee.first_name)} ${escapeHtml(employee.last_name)}</h3>
                        <p style="color: #6B7280; margin-top: 4px;">Nómina / Matrícula: <strong>${escapeHtml(employee.employee_code)}</strong> (ID: #${employee.id})</p>
                    </div>

                    <div style="display: grid; gap: 15px;">
                        <div style="display: grid; grid-template-columns: 120px 1fr; gap: 10px; padding: 12px; background: #F9FAFB; border-radius: 8px;">
                            <strong>Email:</strong> <span>${escapeHtml(employee.email)}</span>
                        </div>
                        <div style="display: grid; grid-template-columns: 120px 1fr; gap: 10px; padding: 12px; background: #F9FAFB; border-radius: 8px;">
                            <strong>Teléfono:</strong> <span>${escapeHtml(employee.phone) || 'N/A'}</span>
                        </div>
                        <div style="display: grid; grid-template-columns: 120px 1fr; gap: 10px; padding: 12px; background: #F9FAFB; border-radius: 8px;">
                            <strong>Departamento:</strong> <span>${escapeHtml(employee.department_name)}</span>
                        </div>
                        <div style="display: grid; grid-template-columns: 120px 1fr; gap: 10px; padding: 12px; background: #F9FAFB; border-radius: 8px;">
                            <strong>Turno:</strong> <span>${escapeHtml(employee.shift_name)}</span>
                        </div>
                        <div style="display: grid; grid-template-columns: 120px 1fr; gap: 10px; padding: 12px; background: #F9FAFB; border-radius: 8px;">
                            <strong>Puesto:</strong> <span>${escapeHtml(employee.position)}</span>
                        </div>
                        <div style="display: grid; grid-template-columns: 120px 1fr; gap: 10px; padding: 12px; background: #F9FAFB; border-radius: 8px;">
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
                    <button class="btn" onclick="closeModal()" style="background: #6B7280; color: white;">Cerrar</button>
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

            // Recargar el modal de detalles del empleado
            closeModal();
            setTimeout(() => showEmployeeDetails(employeeId), 300);
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
                    <button class="btn" onclick="window.FingerprintEnroller.disconnect(); closeModal()" style="background: #6B7280; color: white;">Cancelar</button>
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
        if (!document.getElementById('enroll-status') || !window.FingerprintEnroller?.isEnrolling) {
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

        if (!document.getElementById('enroll-status') || !window.FingerprintEnroller?.isEnrolling) {
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
                <table>
                    <thead>
                        <tr>
                            <th>Fecha</th>
                            <th>Empleado</th>
                            <th>Departamento</th>
                            <th>Entrada</th>
                            <th>Salida</th>
                            <th>Estado</th>
                            <th>Retraso</th>
                            <th>Verificado</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${records.length > 0 ? records.map(rec => `
                            <tr>
                                <td>${escapeHtml(rec.date)}</td>
                                <td>${escapeHtml(rec.employee_name)}</td>
                                <td>${escapeHtml(rec.department_name)}</td>
                                <td>${escapeHtml(rec.check_in_time || '-')}</td>
                                <td>${escapeHtml(rec.check_out_time || '-')}</td>
                                <td><span class="badge badge-${getStatusBadgeClass(rec.status)}">${escapeHtml(getStatusLabel(rec.status))}</span></td>
                                <td>${rec.minutes_late ? rec.minutes_late + ' min' : '-'}</td>
                                <td style="text-align: center;">${rec.fingerprint_verified ? '✓' : '-'}</td>
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

        <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 20px;">
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
    const modalHTML = `
        <div class="modal active" onclick="if(event.target === this) closeModal()">
            <div class="modal-content" style="max-width: 500px;">
                <div class="modal-header">
                    <h3>Agregar Departamento</h3>
                    <button class="close-btn" onclick="closeModal()">&times;</button>
                </div>
                <div class="modal-body">
                    <form id="add-department-form" onsubmit="event.preventDefault(); saveDepartment();">
                        <div class="form-group">
                            <label>Nombre del Departamento *</label>
                            <input type="text" id="dept-name" class="form-control" required>
                        </div>
                        <div class="form-group">
                            <label>Descripción</label>
                            <textarea id="dept-description" class="form-control" rows="3" placeholder="Descripción opcional del departamento"></textarea>
                        </div>
                        <div class="form-group">
                            <label>Responsable / Gerente (Opcional)</label>
                            <select id="dept-manager" class="form-control">
                                <option value="">Sin asignar</option>
                                ${employees.map(emp => `<option value="${emp.id}">${escapeHtml(emp.first_name)} ${escapeHtml(emp.last_name)} (${escapeHtml(emp.employee_code)})</option>`).join('')}
                            </select>
                        </div>
                    </form>
                </div>
                <div class="modal-footer">
                    <button class="btn" onclick="closeModal()" style="background: #6B7280; color: white;">Cancelar</button>
                    <button class="btn btn-primary" onclick="saveDepartment()">Guardar</button>
                </div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHTML);
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

    const submitBtn = document.querySelector('.modal.active .btn-primary');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Guardando...';
    }

    try {
        const result = await window.attendance.createDepartment({ name, description, manager_id });

        if (result) {
            showNotification('Departamento creado exitosamente', 'success');
            closeModal();
            await loadInitialData();
            loadDepartmentsSection();
        } else {
            showNotification('Error al crear departamento', 'error');
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Guardar';
            }
        }
    } catch (error) {
        logger.error('Error creando departamento:', error);
        showNotification(error.message || 'Error al crear departamento', 'error');
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Guardar';
        }
    }
}

// Mostrar modal para editar departamento
function showEditDepartmentModal(deptId) {
    const dept = departments.find(d => d.id === deptId);
    if (!dept) {
        showNotification('Departamento no encontrado', 'error');
        return;
    }

    const modalHTML = `
        <div class="modal active" onclick="if(event.target === this) closeModal()">
            <div class="modal-content" style="max-width: 500px;">
                <div class="modal-header">
                    <h3>Editar Departamento</h3>
                    <button class="close-btn" onclick="closeModal()">&times;</button>
                </div>
                <div class="modal-body">
                    <form id="edit-department-form" onsubmit="event.preventDefault(); updateDepartment(${deptId});">
                        <div class="form-group">
                            <label>Nombre del Departamento *</label>
                            <input type="text" id="edit-dept-name" class="form-control" value="${escapeHtml(dept.name)}" required>
                        </div>
                        <div class="form-group">
                            <label>Descripción</label>
                            <textarea id="edit-dept-description" class="form-control" rows="3">${dept.description ? escapeHtml(dept.description) : ''}</textarea>
                        </div>
                        <div class="form-group">
                            <label>Responsable / Gerente (Opcional)</label>
                            <select id="edit-dept-manager" class="form-control">
                                <option value="">Sin asignar</option>
                                ${employees.map(emp => `<option value="${emp.id}" ${dept.manager_id === emp.id ? 'selected' : ''}>${escapeHtml(emp.first_name)} ${escapeHtml(emp.last_name)} (${escapeHtml(emp.employee_code)})</option>`).join('')}
                            </select>
                        </div>
                    </form>
                </div>
                <div class="modal-footer">
                    <button class="btn" onclick="closeModal()" style="background: #6B7280; color: white;">Cancelar</button>
                    <button class="btn btn-primary" onclick="updateDepartment(${deptId})">Actualizar</button>
                </div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHTML);
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

    const submitBtn = document.querySelector('.modal.active .btn-primary');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Actualizando...';
    }

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
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Actualizar';
            }
        }
    } catch (error) {
        logger.error('Error actualizando departamento:', error);
        showNotification(error.message || 'Error al actualizar departamento', 'error');
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Actualizar';
        }
    }
}

// Eliminar departamento
async function deleteDepartment(deptId) {
    const dept = departments.find(d => d.id === deptId);
    if (!dept) {
        showNotification('Departamento no encontrado', 'error');
        return;
    }

    const employeesInDept = employees.filter(e => e.department_id === deptId);

    if (employeesInDept.length > 0) {
        showNotification(
            `No se puede eliminar el departamento "${escapeHtml(dept.name)}" porque tiene ${employeesInDept.length} empleado(s) asignado(s). ` +
            `Por favor, reasigne los empleados a otro departamento primero.`,
            'warning'
        );
        return;
    }

    const confirmDelete = confirm(
        `¿Está seguro de que desea eliminar el departamento?\n\n` +
        `${escapeHtml(dept.name)}\n\n` +
        `Esta acción NO se puede deshacer.`
    );

    if (!confirmDelete) {
        return;
    }

    try {
        const result = await window.attendance.deleteDepartment(deptId);

        if (result) {
            showNotification('Departamento eliminado exitosamente', 'success');
            await loadInitialData();
            loadDepartmentsSection();
        } else {
            showNotification('Error al eliminar departamento', 'error');
        }
    } catch (error) {
        logger.error('Error eliminando departamento:', error);
        showNotification(error.message || 'Error al eliminar departamento', 'error');
    }
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

        <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 20px;">
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
    const modalHTML = `
        <div class="modal active" onclick="if(event.target === this) closeModal()">
            <div class="modal-content" style="max-width: 500px;">
                <div class="modal-header">
                    <h3>Agregar Turno</h3>
                    <button class="close-btn" onclick="closeModal()">&times;</button>
                </div>
                <div class="modal-body">
                    <form id="add-shift-form" onsubmit="event.preventDefault(); saveShift();">
                        <div class="form-group">
                            <label>Nombre del Turno *</label>
                            <input type="text" id="shift-name" class="form-control" required placeholder="Ej: Turno Matutino">
                        </div>
                        <div class="form-group">
                            <label>Hora de Inicio *</label>
                            <input type="time" id="shift-start-time" class="form-control" required>
                        </div>
                        <div class="form-group">
                            <label>Hora de Fin *</label>
                            <input type="time" id="shift-end-time" class="form-control" required>
                        </div>
                        <div class="form-group">
                            <label>Tolerancia (minutos) *</label>
                            <input type="number" id="shift-tolerance" class="form-control" min="0" max="60" value="10" required>
                            <small style="color: #6B7280;">Tiempo de gracia para llegadas tarde sin penalización</small>
                        </div>
                        <div class="form-group">
                            <label>Color del Turno</label>
                            <input type="color" id="shift-color" class="form-control" value="#3B82F6" style="height: 50px;">
                        </div>
                    </form>
                </div>
                <div class="modal-footer">
                    <button class="btn" onclick="closeModal()" style="background: #6B7280; color: white;">Cancelar</button>
                    <button class="btn btn-primary" onclick="saveShift()">Guardar</button>
                </div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHTML);
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

    const submitBtn = document.querySelector('.modal.active .btn-primary');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Guardando...';
    }

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
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Guardar';
            }
        }
    } catch (error) {
        logger.error('Error creando turno:', error);
        showNotification(error.message || 'Error al crear turno', 'error');
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Guardar';
        }
    }
}

// Mostrar modal para editar turno
function showEditShiftModal(shiftId) {
    const shift = shifts.find(s => s.id === shiftId);
    if (!shift) {
        showNotification('Turno no encontrado', 'error');
        return;
    }

    const modalHTML = `
        <div class="modal active" onclick="if(event.target === this) closeModal()">
            <div class="modal-content" style="max-width: 500px;">
                <div class="modal-header">
                    <h3>Editar Turno</h3>
                    <button class="close-btn" onclick="closeModal()">&times;</button>
                </div>
                <div class="modal-body">
                    <form id="edit-shift-form" onsubmit="event.preventDefault(); updateShift(${shiftId});">
                        <div class="form-group">
                            <label>Nombre del Turno *</label>
                            <input type="text" id="edit-shift-name" class="form-control" value="${escapeHtml(shift.name)}" required>
                        </div>
                        <div class="form-group">
                            <label>Hora de Inicio *</label>
                            <input type="time" id="edit-shift-start-time" class="form-control" value="${shift.start_time}" required>
                        </div>
                        <div class="form-group">
                            <label>Hora de Fin *</label>
                            <input type="time" id="edit-shift-end-time" class="form-control" value="${shift.end_time}" required>
                        </div>
                        <div class="form-group">
                            <label>Tolerancia (minutos) *</label>
                            <input type="number" id="edit-shift-tolerance" class="form-control" min="0" max="60" value="${shift.tolerance_minutes}" required>
                        </div>
                        <div class="form-group">
                            <label>Color del Turno</label>
                            <input type="color" id="edit-shift-color" class="form-control" value="${shift.color || '#3B82F6'}" style="height: 50px;">
                        </div>
                    </form>
                </div>
                <div class="modal-footer">
                    <button class="btn" onclick="closeModal()" style="background: #6B7280; color: white;">Cancelar</button>
                    <button class="btn btn-primary" onclick="updateShift(${shiftId})">Actualizar</button>
                </div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHTML);
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

    const submitBtn = document.querySelector('.modal.active .btn-primary');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Actualizando...';
    }

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
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Actualizar';
            }
        }
    } catch (error) {
        logger.error('Error actualizando turno:', error);
        showNotification(error.message || 'Error al actualizar turno', 'error');
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Actualizar';
        }
    }
}

// Eliminar turno
async function deleteShift(shiftId) {
    const shift = shifts.find(s => s.id === shiftId);
    if (!shift) {
        showNotification('Turno no encontrado', 'error');
        return;
    }

    const employeesInShift = employees.filter(e => e.shift_id === shiftId);

    if (employeesInShift.length > 0) {
        showNotification(
            `No se puede eliminar el turno "${escapeHtml(shift.name)}" porque tiene ${employeesInShift.length} empleado(s) asignado(s). ` +
            `Por favor, reasigne los empleados a otro turno primero.`,
            'warning'
        );
        return;
    }

    const confirmDelete = confirm(
        `¿Está seguro de que desea eliminar el turno?\n\n` +
        `${escapeHtml(shift.name)} (${shift.start_time} - ${shift.end_time})\n\n` +
        `Esta acción NO se puede deshacer.`
    );

    if (!confirmDelete) {
        return;
    }

    try {
        const result = await window.attendance.deleteShift(shiftId);

        if (result) {
            showNotification('Turno eliminado exitosamente', 'success');
            await loadInitialData();
            loadShiftsSection();
        } else {
            showNotification('Error al eliminar turno', 'error');
        }
    } catch (error) {
        logger.error('Error eliminando turno:', error);
        showNotification(error.message || 'Error al eliminar turno', 'error');
    }
}

// ==================== REPORTS SECTION & ANALYTICS EXPLORER ====================
const SPANISH_DAYS_NAMES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const SPANISH_MONTHS_NAMES = [
    'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
    'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
];

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

    const todayStr = new Date().toISOString().split('T')[0];
    const currentMonth = new Date().toISOString().slice(0, 7);

    const employeeOptions = (employees || [])
        .map(e => `<option value="${escapeHtml(e.employee_code)}">${escapeHtml(e.employee_code)} - ${escapeHtml(e.first_name)} ${escapeHtml(e.last_name)}</option>`)
        .join('');

    container.innerHTML = `
        <!-- CENTRO ANALÍTICO: EXPLORADOR DE FALTAS & Q&A DE DOMINIO -->
        <div style="background: white; border: 2px solid #E5E7EB; border-radius: 14px; padding: 24px; margin-bottom: 30px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05);">
            <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 15px; margin-bottom: 20px; border-bottom: 1px solid #F3F4F6; padding-bottom: 15px;">
                <div>
                    <h3 style="margin: 0; color: #1F2937; font-size: 20px; display: flex; align-items: center; gap: 10px;">
                        <span>🧠</span> Explorador Inteligente & Historial de Faltas
                    </h3>
                    <p style="margin: 4px 0 0; color: #6B7280; font-size: 13px;">
                        Ingresa una nómina para calcular la suma de faltas por mes y días por semana, o haz preguntas en lenguaje natural sobre el personal.
                    </p>
                </div>
                <div style="display: flex; background: #F3F4F6; padding: 4px; border-radius: 10px; gap: 4px;">
                    <button id="tab-btn-absences" class="btn" style="padding: 8px 18px; font-size: 13px; background: #3B82F6; color: white; border-radius: 8px; font-weight: 600;" onclick="switchReportsSubTab('absences')">
                        📅 Historial de Faltas
                    </button>
                    <button id="tab-btn-qa" class="btn" style="padding: 8px 18px; font-size: 13px; background: transparent; color: #4B5563; border-radius: 8px; font-weight: 600;" onclick="switchReportsSubTab('qa')">
                        💬 Preguntas al Personal (NLP)
                    </button>
                </div>
            </div>

            <!-- SUB-TAB 1: HISTORIAL DE FALTAS -->
            <div id="subtab-content-absences">
                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 15px; margin-bottom: 20px; align-items: end;">
                    <div>
                        <label style="display: block; font-size: 12px; font-weight: 600; color: #374151; margin-bottom: 6px;">
                            Nómina / Matrícula del Empleado:
                        </label>
                        <input type="text" id="absence-employee-input" class="form-control" placeholder="Ej: EMP-001 o 001..." onkeydown="if(event.key === 'Enter') onSearchEmployeeAbsences()">
                    </div>
                    <div>
                        <label style="display: block; font-size: 12px; font-weight: 600; color: #374151; margin-bottom: 6px;">
                            O Selecciona un Colaborador:
                        </label>
                        <select id="absence-employee-select" class="form-control" onchange="if(this.value) { document.getElementById('absence-employee-input').value = this.value; onSearchEmployeeAbsences(); }">
                            <option value="">-- Seleccionar de la plantilla --</option>
                            ${employeeOptions}
                        </select>
                    </div>
                    <div>
                        <button class="btn btn-danger" style="width: 100%; height: 42px; display: flex; align-items: center; justify-content: center; gap: 8px; font-weight: 600;" onclick="onSearchEmployeeAbsences()">
                            <span>🔍</span> Consultar Historial de Faltas
                        </button>
                    </div>
                </div>
                <div id="absence-history-results-area">
                    <div style="text-align: center; padding: 35px 20px; background: #F9FAFB; border-radius: 12px; border: 2px dashed #E5E7EB; color: #6B7280; font-size: 14px;">
                        <span style="font-size: 28px; display: block; margin-bottom: 8px;">📊</span>
                        Ingresa una nómina o selecciona un empleado para calcular la <strong>suma de faltas de cada mes</strong> y el <strong>desglose de días específicos por semana</strong>.
                    </div>
                </div>
            </div>

            <!-- SUB-TAB 2: PREGUNTAS Y RESPUESTAS (NLP) -->
            <div id="subtab-content-qa" style="display: none;">
                <div style="margin-bottom: 15px;">
                    <label style="display: block; font-size: 12px; font-weight: 600; color: #374151; margin-bottom: 6px;">
                        Formula una pregunta sobre el dominio de asistencia (empleado, faltas, tiempo, retardos):
                    </label>
                    <div style="display: flex; gap: 10px;">
                        <input type="text" id="qa-query-input" class="form-control" placeholder="Ej: ¿Qué días faltó el empleado EMP-001 en la semana? o ¿Quién tiene más faltas este mes?" onkeydown="if(event.key === 'Enter') onExecuteDomainQuestion()">
                        <button class="btn btn-primary" style="white-space: nowrap; padding: 0 24px; font-weight: 600; display: flex; align-items: center; gap: 6px;" onclick="onExecuteDomainQuestion()">
                            <span>✨</span> Preguntar
                        </button>
                    </div>
                </div>
                <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 20px; align-items: center;">
                    <span style="font-size: 12px; color: #6B7280; font-weight: 600;">Consultas rápidas:</span>
                    <button class="btn" style="background: #EFF6FF; color: #1D4ED8; border: 1px solid #BFDBFE; font-size: 12px; padding: 5px 12px; border-radius: 20px;" onclick="onQuickDomainQuestion('¿Qué días faltó el empleado EMP-001 en la semana?')">
                        📅 ¿Qué días faltó EMP-001 en la semana?
                    </button>
                    <button class="btn" style="background: #EFF6FF; color: #1D4ED8; border: 1px solid #BFDBFE; font-size: 12px; padding: 5px 12px; border-radius: 20px;" onclick="onQuickDomainQuestion('Historial de faltas de EMP-001')">
                        📊 Historial de faltas de EMP-001
                    </button>
                    <button class="btn" style="background: #EFF6FF; color: #1D4ED8; border: 1px solid #BFDBFE; font-size: 12px; padding: 5px 12px; border-radius: 20px;" onclick="onQuickDomainQuestion('¿Quién tiene más faltas en el personal?')">
                        🔴 ¿Quién tiene más faltas?
                    </button>
                    <button class="btn" style="background: #EFF6FF; color: #1D4ED8; border: 1px solid #BFDBFE; font-size: 12px; padding: 5px 12px; border-radius: 20px;" onclick="onQuickDomainQuestion('¿Cuánto tiempo trabajó el empleado EMP-001?')">
                        ⏱️ ¿Cuánto tiempo trabajó EMP-001?
                    </button>
                    <button class="btn" style="background: #EFF6FF; color: #1D4ED8; border: 1px solid #BFDBFE; font-size: 12px; padding: 5px 12px; border-radius: 20px;" onclick="onQuickDomainQuestion('retardos y minutos tarde de EMP-001')">
                        ⏰ Retardos de EMP-001
                    </button>
                    <button class="btn" style="background: #EFF6FF; color: #1D4ED8; border: 1px solid #BFDBFE; font-size: 12px; padding: 5px 12px; border-radius: 20px;" onclick="onQuickDomainQuestion('resumen general de personal faltas y tiempo')">
                        📈 Resumen global: personal, faltas y tiempo
                    </button>
                </div>
                <div id="qa-query-results-area">
                    <div style="text-align: center; padding: 35px 20px; background: #F9FAFB; border-radius: 12px; border: 2px dashed #E5E7EB; color: #6B7280; font-size: 14px;">
                        <span style="font-size: 28px; display: block; margin-bottom: 8px;">💬</span>
                        Escribe tu pregunta o presiona una sugerencia para explorar los datos mediante palabras clave contextuales (<em>empleado, falta, tiempo, retardo, mes, semana</em>).
                    </div>
                </div>
            </div>
        </div>

        <h4 style="color: #4B5563; margin: 0 0 15px; font-size: 15px; font-weight: 600;">Reportes Tradicionales del Sistema:</h4>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px;">
            <!-- Reporte Diario -->
            <div style="background: white; border: 2px solid #E5E7EB; border-radius: 12px; padding: 24px; display: flex; flex-direction: column; justify-content: space-between;">
                <div>
                    <div style="font-size: 36px; margin-bottom: 10px;">📊</div>
                    <h3 style="margin: 0 0 8px; color: #1F2937;">Reporte Diario</h3>
                    <p style="color: #6B7280; font-size: 13px; margin: 0 0 15px;">Resumen de asistencia del día</p>
                    <label style="display: block; font-size: 12px; font-weight: 600; color: #4B5563; margin-bottom: 4px;">Fecha:</label>
                    <input type="date" id="daily-report-date" class="form-control" value="${todayStr}" style="margin-bottom: 15px;">
                </div>
                <button class="btn btn-primary" onclick="generateDailyReport(document.getElementById('daily-report-date').value)">Generar Reporte Diario</button>
            </div>

            <!-- Reporte Semanal -->
            <div style="background: white; border: 2px solid #E5E7EB; border-radius: 12px; padding: 24px; display: flex; flex-direction: column; justify-content: space-between;">
                <div>
                    <div style="font-size: 36px; margin-bottom: 10px;">📅</div>
                    <h3 style="margin: 0 0 8px; color: #1F2937;">Reporte Semanal</h3>
                    <p style="color: #6B7280; font-size: 13px; margin: 0 0 15px;">Asistencia de 7 días hasta la fecha de fin</p>
                    <label style="display: block; font-size: 12px; font-weight: 600; color: #4B5563; margin-bottom: 4px;">Fecha Fin:</label>
                    <input type="date" id="weekly-report-date" class="form-control" value="${todayStr}" style="margin-bottom: 15px;">
                </div>
                <button class="btn btn-primary" style="background: #8B5CF6;" onclick="generateWeeklyReport(document.getElementById('weekly-report-date').value)">Generar Reporte Semanal</button>
            </div>

            <!-- Reporte Mensual -->
            <div style="background: white; border: 2px solid #E5E7EB; border-radius: 12px; padding: 24px; display: flex; flex-direction: column; justify-content: space-between;">
                <div>
                    <div style="font-size: 36px; margin-bottom: 10px;">📈</div>
                    <h3 style="margin: 0 0 8px; color: #1F2937;">Reporte Mensual</h3>
                    <p style="color: #6B7280; font-size: 13px; margin: 0 0 15px;">Estadísticas del mes</p>
                    <label style="display: block; font-size: 12px; font-weight: 600; color: #4B5563; margin-bottom: 4px;">Mes y Año:</label>
                    <input type="month" id="monthly-report-month" class="form-control" value="${currentMonth}" style="margin-bottom: 15px;">
                </div>
                <button class="btn btn-primary" style="background: #0EA5E9;" onclick="onGenerateMonthlyReportClick()">Generar Reporte Mensual</button>
            </div>

            <!-- Reporte Individual por Empleado -->
            <div style="background: white; border: 2px solid #E5E7EB; border-radius: 12px; padding: 24px; display: flex; flex-direction: column; justify-content: space-between;">
                <div>
                    <div style="font-size: 36px; margin-bottom: 10px;">👤</div>
                    <h3 style="margin: 0 0 8px; color: #1F2937;">Por Empleado</h3>
                    <p style="color: #6B7280; font-size: 13px; margin: 0 0 15px;">Historial de un empleado con rango opcional</p>
                </div>
                <button class="btn btn-primary" style="background: #EC4899;" onclick="generateEmployeeReport()">Seleccionar Empleado y Fechas</button>
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
        if (tabAbsences) { tabAbsences.style.background = '#3B82F6'; tabAbsences.style.color = 'white'; }
        if (tabQA) { tabQA.style.background = 'transparent'; tabQA.style.color = '#4B5563'; }
        if (contentAbsences) contentAbsences.style.display = 'block';
        if (contentQA) contentQA.style.display = 'none';
    } else {
        if (tabQA) { tabQA.style.background = '#3B82F6'; tabQA.style.color = 'white'; }
        if (tabAbsences) { tabAbsences.style.background = 'transparent'; tabAbsences.style.color = '#4B5563'; }
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

/**
 * Renderiza el árbol visual de historial de faltas de un empleado
 */
function renderAbsenceHistoryHTMLClient(history) {
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
                                    ${week.days.map(d => `
                                        <div style="background: white; border: 1px solid #FCA5A5; border-radius: 6px; padding: 6px 12px; display: inline-flex; align-items: center; gap: 6px; box-shadow: 0 1px 2px rgba(0,0,0,0.04);">
                                            <span style="color: #DC2626; font-size: 12px;">🔴</span>
                                            <strong style="color: #1F2937; font-size: 13px;">${escapeHtml(d.dayOfWeek)}</strong>
                                            <span style="color: #4B5563; font-size: 13px;">${escapeHtml(d.formattedDate)}</span>
                                            ${d.notes ? `<span style="color: #6B7280; font-size: 11px; font-style: italic;">(${escapeHtml(d.notes)})</span>` : ''}
                                        </div>
                                    `).join('')}
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
            <!-- HEADER DEL EMPLEADO -->
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
                <div>
                    <button class="btn btn-secondary" onclick="printReport()" style="padding: 8px 16px; font-size: 13px; display: flex; align-items: center; gap: 6px;">
                        <span>🖨️</span> Imprimir Historial
                    </button>
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
        <div style="text-align: center; padding: 40px; color: #6B7280;">
            <div class="spinner"></div>
            <p style="margin-top: 10px;">Buscando y calculando historial de faltas de ${escapeHtml(searchCode)}...</p>
        </div>
    `;

    try {
        if (!employees || employees.length === 0) {
            await loadEmployees();
        }

        const normSearch = searchCode.toLowerCase().replace(/[-_\s]/g, '');
        const targetEmp = (employees || []).find(e => {
            const eCodeNorm = (e.employee_code || '').toLowerCase().replace(/[-_\s]/g, '');
            const idStr = String(e.id);
            return eCodeNorm === normSearch || e.employee_code.toLowerCase() === searchCode.toLowerCase() || idStr === searchCode;
        });

        if (!targetEmp) {
            resultsArea.innerHTML = `
                <div style="background: #FEF2F2; border: 1px solid #FCA5A5; border-radius: 10px; padding: 25px; text-align: center; color: #991B1B;">
                    <div style="font-size: 32px; margin-bottom: 8px;">❌</div>
                    <strong>No se encontró ningún empleado con la nómina o código "${escapeHtml(searchCode)}"</strong>
                    <p style="margin: 6px 0 0; font-size: 13px; color: #B91C1C;">Verifica la matrícula o selecciónalo desde la lista desplegable.</p>
                </div>
            `;
            return;
        }

        const records = await window.attendance.getAttendanceRecords({ employee_id: targetEmp.id });
        const history = calcEmployeeAbsenceHistoryClient(records, targetEmp);
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
    const emp = (employees || []).find(e => {
        const eCodeNorm = (e.employee_code || '').toLowerCase().replace(/[-_\s]/g, '');
        return eCodeNorm === norm || String(e.id) === codeStr || e.employee_code === codeStr;
    });

    if (!emp) {
        showNotification('Empleado no encontrado', 'error');
        return;
    }

    try {
        showNotification('Generando historial de faltas...', 'info');
        const records = await window.attendance.getAttendanceRecords({ employee_id: emp.id });
        const history = calcEmployeeAbsenceHistoryClient(records, emp);

        const modalHTML = `
            <div class="modal active" onclick="if(event.target === this) closeModal()">
                <div class="modal-content" style="max-width: 950px;">
                    <div class="modal-header">
                        <h3>📅 Historial de Faltas: ${escapeHtml(emp.first_name)} ${escapeHtml(emp.last_name)} (${escapeHtml(emp.employee_code)})</h3>
                        <button class="close-btn" onclick="closeModal()">&times;</button>
                    </div>
                    <div class="modal-body">
                        ${renderAbsenceHistoryHTMLClient(history)}
                    </div>
                    <div class="modal-footer">
                        <button class="btn btn-secondary" onclick="printReport()">🖨️ Imprimir</button>
                        <button class="btn" onclick="closeModal()" style="background: #6B7280; color: white;">Cerrar</button>
                    </div>
                </div>
            </div>
        `;
        document.body.insertAdjacentHTML('beforeend', modalHTML);
    } catch (err) {
        logger.error('Error al abrir modal de faltas:', err);
        showNotification('Error al abrir el historial de faltas', 'error');
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
        <div style="text-align: center; padding: 40px; color: #6B7280;">
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

        // Localizar empleado
        let targetEmp = null;
        for (let i = 0; i < employees.length; i++) {
            const e = employees[i];
            const codeNorm = e.employee_code.toLowerCase().replace(/[-_]/g, '');
            if (new RegExp(`\\b${e.employee_code.toLowerCase().replace('-', '[-_]?')}\\b`, 'i').test(norm) ||
                new RegExp(`\\b${codeNorm}\\b`, 'i').test(norm.replace(/[-_]/g, ''))) {
                targetEmp = e;
                break;
            }
            const fName = `${e.first_name} ${e.last_name}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
            if (fName.length > 3 && norm.includes(fName)) {
                targetEmp = e;
                break;
            }
        }

        // Caso 1: Historial o días de falta de un empleado
        if (targetEmp && (hasAbsence || /dias|semana|mes|historial/i.test(norm) || (!hasTime && !hasLate))) {
            const empRecords = attendanceRecords.filter(r => r.employee_id === targetEmp.id);
            const history = calcEmployeeAbsenceHistoryClient(empRecords, targetEmp);
            resultsArea.innerHTML = `
                <div style="background: white; border: 1px solid #E5E7EB; border-radius: 12px; padding: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.05);">
                    <div style="background: #EFF6FF; border-left: 4px solid #3B82F6; padding: 12px 16px; border-radius: 6px; margin-bottom: 20px;">
                        <strong style="color: #1E40AF; font-size: 14px;">💬 Respuesta Contextual:</strong>
                        <p style="margin: 4px 0 0; color: #1E3A8A; font-size: 13px;">
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
            resultsArea.innerHTML = `
                <div style="background: white; border: 1px solid #E5E7EB; border-radius: 12px; padding: 20px;">
                    <div style="background: #FFFBEB; border-left: 4px solid #F59E0B; padding: 12px 16px; border-radius: 6px; margin-bottom: 20px;">
                        <strong style="color: #92400E; font-size: 14px;">💬 Análisis de Impuntualidad:</strong>
                        <p style="margin: 4px 0 0; color: #78350F; font-size: 13px;">
                            ${lates.length === 0 
                                ? `${escapeHtml(targetEmp.first_name)} ${escapeHtml(targetEmp.last_name)} no registra retardos. Mantiene 100% de puntualidad.`
                                : `El colaborador acumula <strong>${lates.length} llegadas tarde</strong> con un total de <strong>${totalMins} minutos</strong> de demora acumulada.`
                            }
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
                            `).join('') || '<tr><td colspan="4" style="text-align:center;">Sin retardos</td></tr>'}
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

            resultsArea.innerHTML = `
                <div style="background: white; border: 1px solid #E5E7EB; border-radius: 12px; padding: 20px;">
                    <div style="background: #ECFDF5; border-left: 4px solid #10B981; padding: 12px 16px; border-radius: 6px; margin-bottom: 20px;">
                        <strong style="color: #065F46; font-size: 14px;">💬 Balance de Tiempo Laborado:</strong>
                        <p style="margin: 4px 0 0; color: #047857; font-size: 13px;">
                            ${escapeHtml(targetEmp.first_name)} ${escapeHtml(targetEmp.last_name)} ha laborado aproximadamente <strong>${totalHours} horas</strong> en <strong>${attended.length} jornadas</strong> registradas, con <strong>${otHours} horas</strong> de sobretiempo.
                        </p>
                    </div>
                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 15px;">
                        <div style="background: #F0FDF4; border: 1px solid #BBF7D0; padding: 15px; border-radius: 8px; text-align: center;">
                            <div style="font-size: 24px; font-weight: 800; color: #16A34A;">${totalHours} hrs</div>
                            <div style="font-size: 12px; color: #15803D;">Tiempo Laborado</div>
                        </div>
                        <div style="background: #EFF6FF; border: 1px solid #BFDBFE; padding: 15px; border-radius: 8px; text-align: center;">
                            <div style="font-size: 24px; font-weight: 800; color: #2563EB;">${attended.length}</div>
                            <div style="font-size: 12px; color: #1E40AF;">Días Asistidos</div>
                        </div>
                        <div style="background: #FFFBEB; border: 1px solid #FDE68A; padding: 15px; border-radius: 8px; text-align: center;">
                            <div style="font-size: 24px; font-weight: 800; color: #D97706;">${otHours} hrs</div>
                            <div style="font-size: 12px; color: #92400E;">Sobretiempo (Extra)</div>
                        </div>
                    </div>
                </div>
            `;
            return;
        }

        // Caso 4: Ranking de faltas (Top ausentismo)
        if (hasRanking && hasAbsence) {
            const counts = new Map();
            attendanceRecords.forEach(r => {
                if (r.status === 'absent') {
                    counts.set(r.employee_id, (counts.get(r.employee_id) || 0) + 1);
                }
            });
            const ranking = Array.from(counts.entries())
                .map(([empId, count]) => {
                    const emp = employees.find(e => e.id === empId);
                    return {
                        id: empId,
                        code: emp ? emp.employee_code : `EMP-${empId}`,
                        name: emp ? `${emp.first_name} ${emp.last_name}` : `Empleado ${empId}`,
                        count
                    };
                })
                .sort((a, b) => b.count - a.count)
                .slice(0, 5);

            resultsArea.innerHTML = `
                <div style="background: white; border: 1px solid #E5E7EB; border-radius: 12px; padding: 20px;">
                    <div style="background: #FEF2F2; border-left: 4px solid #EF4444; padding: 12px 16px; border-radius: 6px; margin-bottom: 20px;">
                        <strong style="color: #991B1B; font-size: 14px;">💬 Ranking de Ausentismo:</strong>
                        <p style="margin: 4px 0 0; color: #B91C1C; font-size: 13px;">
                            ${ranking.length > 0
                                ? `El colaborador con más faltas registradas es <strong>${escapeHtml(ranking[0].name)}</strong> (${escapeHtml(ranking[0].code)}) con <strong>${ranking[0].count} inasistencias</strong>.`
                                : 'No se registran faltas en el sistema.'
                            }
                        </p>
                    </div>
                    <div style="display: grid; gap: 10px;">
                        ${ranking.map((item, idx) => `
                            <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; background: #F9FAFB; border-radius: 8px; border: 1px solid #E5E7EB;">
                                <div style="display: flex; align-items: center; gap: 12px;">
                                    <span style="font-weight: 800; color: #6B7280; width: 24px;">#${idx + 1}</span>
                                    <div>
                                        <strong style="color: #1F2937;">${escapeHtml(item.name)}</strong>
                                        <span style="color: #6B7280; font-size: 12px; margin-left: 6px;">(${escapeHtml(item.code)})</span>
                                    </div>
                                </div>
                                <span class="badge badge-danger" style="font-size: 13px; font-weight: 700; padding: 6px 12px;">${item.count} faltas</span>
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

        resultsArea.innerHTML = `
            <div style="background: white; border: 1px solid #E5E7EB; border-radius: 12px; padding: 20px;">
                <div style="background: #F0FDF4; border-left: 4px solid #10B981; padding: 12px 16px; border-radius: 6px; margin-bottom: 20px;">
                    <strong style="color: #166534; font-size: 14px;">💬 Panorama General de Asistencia:</strong>
                    <p style="margin: 4px 0 0; color: #14532D; font-size: 13px;">
                        Plantilla de <strong>${employees.length} colaboradores</strong> con una tasa de asistencia acumulada de <strong>${attRate}%</strong>. Se registran <strong>${absCount} ausencias</strong> y <strong>${lateCount} retardos</strong> en total.
                    </p>
                </div>
                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 15px;">
                    <div style="background: #F9FAFB; border: 1px solid #E5E7EB; padding: 15px; border-radius: 8px; text-align: center;">
                        <div style="font-size: 24px; font-weight: 800; color: #2563EB;">${employees.length}</div>
                        <div style="font-size: 12px; color: #4B5563;">Plantilla Total</div>
                    </div>
                    <div style="background: #ECFDF5; border: 1px solid #A7F3D0; padding: 15px; border-radius: 8px; text-align: center;">
                        <div style="font-size: 24px; font-weight: 800; color: #059669;">${attRate}%</div>
                        <div style="font-size: 12px; color: #065F46;">Tasa de Asistencia</div>
                    </div>
                    <div style="background: #FEF2F2; border: 1px solid #FCA5A5; padding: 15px; border-radius: 8px; text-align: center;">
                        <div style="font-size: 24px; font-weight: 800; color: #DC2626;">${absCount}</div>
                        <div style="font-size: 12px; color: #991B1B;">Total Inasistencias</div>
                    </div>
                    <div style="background: #FFFBEB; border: 1px solid #FDE68A; padding: 15px; border-radius: 8px; text-align: center;">
                        <div style="font-size: 24px; font-weight: 800; color: #D97706;">${lateCount}</div>
                        <div style="font-size: 12px; color: #92400E;">Total Retardos</div>
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

        const modalHTML = `
            <div class="modal active" onclick="if(event.target === this) closeModal()">
                <div class="modal-content" style="max-width: 900px;">
                    <div class="modal-header">
                        <h3>📊 Reporte Diario de Asistencia</h3>
                        <button class="close-btn" onclick="closeModal()">&times;</button>
                    </div>
                    <div class="modal-body">
                        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; border-radius: 12px; color: white; margin-bottom: 25px;">
                            <h4 style="margin: 0 0 10px; font-size: 20px;">
                                ${new Date(report.date).toLocaleDateString('es-ES', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
                            </h4>
                            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; margin-top: 15px;">
                                <div style="background: rgba(255,255,255,0.2); padding: 12px; border-radius: 8px; text-align: center;">
                                    <div style="font-size: 28px; font-weight: 700;">${report.stats.present}</div>
                                    <div style="font-size: 12px; opacity: 0.9;">Presentes</div>
                                </div>
                                <div style="background: rgba(255,255,255,0.2); padding: 12px; border-radius: 8px; text-align: center;">
                                    <div style="font-size: 28px; font-weight: 700;">${report.stats.late}</div>
                                    <div style="font-size: 12px; opacity: 0.9;">Tarde</div>
                                </div>
                                <div style="background: rgba(255,255,255,0.2); padding: 12px; border-radius: 8px; text-align: center;">
                                    <div style="font-size: 28px; font-weight: 700;">${report.stats.absent}</div>
                                    <div style="font-size: 12px; opacity: 0.9;">Ausentes</div>
                                </div>
                                <div style="background: rgba(255,255,255,0.2); padding: 12px; border-radius: 8px; text-align: center;">
                                    <div style="font-size: 28px; font-weight: 700;">${report.stats.verified}</div>
                                    <div style="font-size: 12px; opacity: 0.9;">Verificados</div>
                                </div>
                            </div>
                        </div>

                        <div style="margin-bottom: 20px;">
                            <h4 style="margin-bottom: 15px;">Estadísticas Generales</h4>
                            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                                <div style="padding: 15px; background: #F9FAFB; border-radius: 8px;">
                                    <div style="color: #6B7280; font-size: 13px;">Total Empleados Activos</div>
                                    <div style="font-size: 24px; font-weight: 600; color: #1F2937;">${report.totalEmployees}</div>
                                </div>
                                <div style="padding: 15px; background: #F9FAFB; border-radius: 8px;">
                                    <div style="color: #6B7280; font-size: 13px;">Promedio Retraso</div>
                                    <div style="font-size: 24px; font-weight: 600; color: #1F2937;">${report.stats.avgLateMinutes} min</div>
                                </div>
                            </div>
                        </div>

                        ${report.records.length > 0 ? `
                            <div>
                                <h4 style="margin-bottom: 15px;">Detalle de Asistencias (${report.records.length})</h4>
                                <div style="max-height: 400px; overflow-y: auto;">
                                    <table style="width: 100%; font-size: 13px;">
                                        <thead style="position: sticky; top: 0; background: white;">
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
                                                    <td>${rec.employee_name}</td>
                                                    <td>${rec.department_name || '-'}</td>
                                                    <td>${rec.check_in_time || '-'}</td>
                                                    <td>${rec.check_out_time || '-'}</td>
                                                    <td><span class="badge badge-${getStatusBadgeClass(rec.status)}">${getStatusLabel(rec.status)}</span></td>
                                                    <td style="text-align: center;">${rec.fingerprint_verified ? '✓' : '-'}</td>
                                                </tr>
                                            `).join('')}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        ` : '<p style="text-align:center; padding: 2rem; color: #666;">No hay registros para este día</p>'}
                    </div>
                    <div class="modal-footer">
                        <button class="btn" onclick="closeModal()" style="background: #6B7280; color: white;">Cerrar</button>
                        <button class="btn btn-primary" onclick="printReport()">🖨️ Imprimir</button>
                    </div>
                </div>
            </div>
        `;
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

        const modalHTML = `
            <div class="modal active" onclick="if(event.target === this) closeModal()">
                <div class="modal-content" style="max-width: 900px;">
                    <div class="modal-header">
                        <h3>📅 Reporte Semanal de Asistencia</h3>
                        <button class="close-btn" onclick="closeModal()">&times;</button>
                    </div>
                    <div class="modal-body">
                        <div style="background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); padding: 20px; border-radius: 12px; color: white; margin-bottom: 25px;">
                            <h4 style="margin: 0 0 5px; font-size: 18px;">Período</h4>
                            <div style="font-size: 16px; opacity: 0.95;">
                                ${new Date(report.startDate).toLocaleDateString('es-ES')} - ${new Date(report.endDate).toLocaleDateString('es-ES')}
                            </div>
                            <div style="margin-top: 15px; padding-top: 15px; border-top: 1px solid rgba(255,255,255,0.3);">
                                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                                    <div>
                                        <div style="font-size: 12px; opacity: 0.9;">Total Registros</div>
                                        <div style="font-size: 28px; font-weight: 700;">${report.totalRecords}</div>
                                    </div>
                                    <div>
                                        <div style="font-size: 12px; opacity: 0.9;">Promedio Diario</div>
                                        <div style="font-size: 28px; font-weight: 700;">${Math.round(report.avgDailyAttendance)}</div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        ${report.dailyStats.length > 0 ? `
                            <div style="margin-bottom: 25px;">
                                <h4 style="margin-bottom: 15px;">Resumen Diario</h4>
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
                                                <td>${new Date(day.date).toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' })}</td>
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
                            <h4 style="margin-bottom: 15px;">Todos los Registros (${report.records.length})</h4>
                            <div style="max-height: 300px; overflow-y: auto;">
                                <table style="width: 100%; font-size: 13px;">
                                    <thead style="position: sticky; top: 0; background: white;">
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
                                                <td>${new Date(rec.date).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' })}</td>
                                                <td>${rec.employee_name}</td>
                                                <td>${rec.check_in_time || '-'}</td>
                                                <td><span class="badge badge-${getStatusBadgeClass(rec.status)}">${getStatusLabel(rec.status)}</span></td>
                                            </tr>
                                        `).join('')}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button class="btn" onclick="closeModal()" style="background: #6B7280; color: white;">Cerrar</button>
                        <button class="btn btn-primary" onclick="printReport()">🖨️ Imprimir</button>
                    </div>
                </div>
            </div>
        `;
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

        const modalHTML = `
            <div class="modal active" onclick="if(event.target === this) closeModal()">
                <div class="modal-content" style="max-width: 1000px;">
                    <div class="modal-header">
                        <h3>📈 Reporte Mensual de Asistencia</h3>
                        <button class="close-btn" onclick="closeModal()">&times;</button>
                    </div>
                    <div class="modal-body">
                        <div style="background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%); padding: 20px; border-radius: 12px; color: white; margin-bottom: 25px;">
                            <h4 style="margin: 0 0 15px; font-size: 20px;">${report.monthName}</h4>
                            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px;">
                                <div style="background: rgba(255,255,255,0.2); padding: 12px; border-radius: 8px; text-align: center;">
                                    <div style="font-size: 24px; font-weight: 700;">${report.totalStats.totalRecords}</div>
                                    <div style="font-size: 11px; opacity: 0.9;">Total Registros</div>
                                </div>
                                <div style="background: rgba(255,255,255,0.2); padding: 12px; border-radius: 8px; text-align: center;">
                                    <div style="font-size: 24px; font-weight: 700;">${report.totalStats.present}</div>
                                    <div style="font-size: 11px; opacity: 0.9;">Presentes</div>
                                </div>
                                <div style="background: rgba(255,255,255,0.2); padding: 12px; border-radius: 8px; text-align: center;">
                                    <div style="font-size: 24px; font-weight: 700;">${report.totalStats.late}</div>
                                    <div style="font-size: 11px; opacity: 0.9;">Tarde</div>
                                </div>
                                <div style="background: rgba(255,255,255,0.2); padding: 12px; border-radius: 8px; text-align: center;">
                                    <div style="font-size: 24px; font-weight: 700;">${report.totalStats.absent}</div>
                                    <div style="font-size: 11px; opacity: 0.9;">Ausentes</div>
                                </div>
                                <div style="background: rgba(255,255,255,0.2); padding: 12px; border-radius: 8px; text-align: center;">
                                    <div style="font-size: 24px; font-weight: 700;">${report.totalStats.verified}</div>
                                    <div style="font-size: 11px; opacity: 0.9;">Verificados</div>
                                </div>
                            </div>
                        </div>

                        ${report.employeeStats.length > 0 ? `
                            <div>
                                <h4 style="margin-bottom: 15px;">Estadísticas por Empleado (${report.employeeStats.length})</h4>
                                <div style="max-height: 500px; overflow-y: auto;">
                                    <table style="width: 100%; font-size: 13px;">
                                        <thead style="position: sticky; top: 0; background: white;">
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
                                                const rateColor = attendanceRate >= 95 ? '#10B981' : attendanceRate >= 80 ? '#F59E0B' : '#EF4444';
                                                return `
                                                <tr>
                                                    <td>${emp.employeeCode}</td>
                                                    <td>${emp.employeeName}</td>
                                                    <td><strong>${emp.totalDays}</strong></td>
                                                    <td><span class="badge badge-success">${emp.presentDays}</span></td>
                                                    <td><span class="badge badge-warning">${emp.lateDays}</span></td>
                                                    <td><span class="badge badge-danger">${emp.absentDays}</span></td>
                                                    <td>${emp.totalLateMinutes}</td>
                                                    <td><span style="color: ${rateColor}; font-weight: 600;">${emp.attendanceRate}%</span></td>
                                                </tr>
                                                `;
                                            }).join('')}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        ` : '<p style="text-align:center; padding: 2rem; color: #666;">No hay datos para este mes</p>'}
                    </div>
                    <div class="modal-footer">
                        <button class="btn" onclick="closeModal()" style="background: #6B7280; color: white;">Cerrar</button>
                        <button class="btn btn-primary" onclick="printReport()">🖨️ Imprimir</button>
                    </div>
                </div>
            </div>
        `;
        document.body.insertAdjacentHTML('beforeend', modalHTML);
    } catch (error) {
        logger.error('Error generando reporte mensual:', error);
        showNotification('Error al generar el reporte mensual', 'error');
    }
}

async function generateEmployeeReport() {
    // Mostrar selector de empleado y período
    const modalHTML = `
        <div class="modal active" onclick="if(event.target === this) closeModal()">
            <div class="modal-content" style="max-width: 600px;">
                <div class="modal-header">
                    <h3>👤 Seleccionar Empleado y Período</h3>
                    <button class="close-btn" onclick="closeModal()">&times;</button>
                </div>
                <div class="modal-body">
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
                            <label>Fecha Desde (Opcional):</label>
                            <input type="date" id="report-emp-start" class="form-control">
                        </div>
                        <div class="form-group">
                            <label>Fecha Hasta (Opcional):</label>
                            <input type="date" id="report-emp-end" class="form-control">
                        </div>
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn" onclick="closeModal()" style="background: #6B7280; color: white;">Cancelar</button>
                    <button class="btn btn-primary" onclick="showEmployeeReportDetails()">Generar Reporte</button>
                </div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHTML);
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

        const modalHTML = `
            <div class="modal active" onclick="if(event.target === this) closeModal()">
                <div class="modal-content" style="max-width: 900px;">
                    <div class="modal-header">
                        <h3>👤 Reporte Individual de Empleado</h3>
                        <button class="close-btn" onclick="closeModal()">&times;</button>
                    </div>
                    <div class="modal-body">
                        <div style="background: linear-gradient(135deg, #fa709a 0%, #fee140 100%); padding: 20px; border-radius: 12px; color: white; margin-bottom: 25px;">
                            <div style="display: flex; align-items: center; gap: 20px; margin-bottom: 15px;">
                                <div style="width: 80px; height: 80px; border-radius: 50%; background: rgba(255,255,255,0.3); display: flex; align-items: center; justify-content: center; font-size: 32px; font-weight: 700;">
                                    ${getInitials(report.employee.first_name, report.employee.last_name)}
                                </div>
                                <div>
                                    <h3 style="margin: 0; font-size: 24px;">${report.employee.first_name} ${report.employee.last_name}</h3>
                                    <div style="opacity: 0.95; font-size: 14px; margin-top: 5px;">
                                        ${report.employee.employee_code} • ${report.employee.department_name}
                                    </div>
                                </div>
                            </div>
                            <div style="border-top: 1px solid rgba(255,255,255,0.3); padding-top: 15px; font-size: 14px; opacity: 0.95;">
                                Período: ${new Date(report.period.startDate).toLocaleDateString('es-ES')} - ${new Date(report.period.endDate).toLocaleDateString('es-ES')}
                            </div>
                        </div>

                        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 25px;">
                            <div style="padding: 15px; background: #F0FDF4; border-radius: 8px; border-left: 4px solid #10B981;">
                                <div style="color: #065F46; font-size: 12px; margin-bottom: 5px;">Días Trabajados</div>
                                <div style="font-size: 28px; font-weight: 700; color: #10B981;">${report.stats.totalDays}</div>
                            </div>
                            <div style="padding: 15px; background: #FFFBEB; border-radius: 8px; border-left: 4px solid #F59E0B;">
                                <div style="color: #92400E; font-size: 12px; margin-bottom: 5px;">Días Tarde</div>
                                <div style="font-size: 28px; font-weight: 700; color: #F59E0B;">${report.stats.lateDays}</div>
                            </div>
                            <div style="padding: 15px; background: #FEF2F2; border-radius: 8px; border-left: 4px solid #EF4444;">
                                <div style="color: #991B1B; font-size: 12px; margin-bottom: 5px;">Días Ausente</div>
                                <div style="font-size: 28px; font-weight: 700; color: #EF4444;">${report.stats.absentDays}</div>
                            </div>
                            <div style="padding: 15px; background: #EFF6FF; border-radius: 8px; border-left: 4px solid #3B82F6;">
                                <div style="color: #1E40AF; font-size: 12px; margin-bottom: 5px;">% Asistencia</div>
                                <div style="font-size: 28px; font-weight: 700; color: #3B82F6;">${report.stats.attendanceRate}%</div>
                            </div>
                        </div>

                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 25px;">
                            <div style="padding: 15px; background: #F9FAFB; border-radius: 8px;">
                                <div style="color: #6B7280; font-size: 13px; margin-bottom: 8px;">Retraso Promedio</div>
                                <div style="font-size: 20px; font-weight: 600; color: #1F2937;">${report.stats.avgLateMinutes} minutos</div>
                                <div style="color: #9CA3AF; font-size: 12px; margin-top: 5px;">Total: ${report.stats.totalLateMinutes} min</div>
                            </div>
                            <div style="padding: 15px; background: #F9FAFB; border-radius: 8px;">
                                <div style="color: #6B7280; font-size: 13px; margin-bottom: 8px;">Tiempo Extra Promedio</div>
                                <div style="font-size: 20px; font-weight: 600; color: #1F2937;">${report.stats.avgOvertimeMinutes} minutos</div>
                                <div style="color: #9CA3AF; font-size: 12px; margin-top: 5px;">Total: ${report.stats.totalOvertimeMinutes} min</div>
                            </div>
                            <div style="padding: 15px; background: #F9FAFB; border-radius: 8px;">
                                <div style="color: #6B7280; font-size: 13px; margin-bottom: 8px;">Verificaciones Biométricas</div>
                                <div style="font-size: 20px; font-weight: 600; color: #1F2937;">${report.stats.verifiedDays}/${report.stats.totalDays}</div>
                            </div>
                            <div style="padding: 15px; background: #F9FAFB; border-radius: 8px;">
                                <div style="color: #6B7280; font-size: 13px; margin-bottom: 8px;">Huellas Registradas</div>
                                <div style="font-size: 20px; font-weight: 600; color: #1F2937;">${report.fingerprints}/10</div>
                            </div>
                        </div>

                        ${report.records.length > 0 ? `
                            <div>
                                <h4 style="margin-bottom: 15px;">Historial de Asistencia (${report.records.length} registros)</h4>
                                <div style="max-height: 350px; overflow-y: auto;">
                                    <table style="width: 100%; font-size: 13px;">
                                        <thead style="position: sticky; top: 0; background: white;">
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
                                                    <td>${new Date(rec.date).toLocaleDateString('es-ES')}</td>
                                                    <td>${rec.check_in_time || '-'}</td>
                                                    <td>${rec.check_out_time || '-'}</td>
                                                    <td><span class="badge badge-${getStatusBadgeClass(rec.status)}">${getStatusLabel(rec.status)}</span></td>
                                                    <td>${rec.minutes_late ? rec.minutes_late + ' min' : '-'}</td>
                                                    <td style="text-align: center;">${rec.fingerprint_verified ? '✓' : '-'}</td>
                                                </tr>
                                            `).join('')}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        ` : '<p style="text-align:center; padding: 2rem; color: #666;">No hay registros en el período seleccionado</p>'}
                    </div>
                    <div class="modal-footer">
                        <button class="btn" onclick="closeModal()" style="background: #6B7280; color: white;">Cerrar</button>
                        <button class="btn btn-primary" onclick="printReport()">🖨️ Imprimir</button>
                    </div>
                </div>
            </div>
        `;
        document.body.insertAdjacentHTML('beforeend', modalHTML);
    } catch (error) {
        logger.error('Error generando reporte de empleado:', error);
        showNotification('Error al generar el reporte del empleado', 'error');
    }
}

function printReport() {
    window.print();
}

// ==================== SETTINGS SECTION ====================
async function loadSettingsSection() {
    const container = document.querySelector('#settings-section .card-body');
    if (!container) return;

    // Cargar configuración guardada
    const settings = loadSavedSettings();

    container.innerHTML = `
        <div style="max-width: 700px;">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; border-radius: 12px; color: white; margin-bottom: 25px;">
                <h3 style="margin: 0 0 10px;">⚙️ Configuración del Sistema</h3>
                <p style="margin: 0; opacity: 0.9; font-size: 14px;">Configure las preferencias del sistema de asistencia</p>
            </div>

            <div class="card" style="margin-bottom: 20px;">
                <div class="card-header">
                    <h4 style="margin: 0;">Configuración de Asistencia</h4>
                </div>
                <div class="card-body">
                    <div class="form-group">
                        <label><strong>Hora para marcar ausencias automáticas</strong></label>
                        <input type="time" id="setting-absent-time" class="form-control" value="${settings.absentTime}">
                        <small style="color: #6B7280;">Los empleados sin registro de entrada serán marcados como ausentes después de esta hora</small>
                    </div>

                    <div class="form-group">
                        <label style="display: flex; align-items: center; gap: 10px; cursor: pointer;">
                            <input type="checkbox" id="setting-require-checkout" ${settings.requireCheckout ? 'checked' : ''}>
                            <span><strong>Requiere marcar salida</strong></span>
                        </label>
                        <small style="color: #6B7280; margin-left: 30px; display: block;">Los empleados deben registrar su salida al finalizar el día</small>
                    </div>

                    <div class="form-group">
                        <label style="display: flex; align-items: center; gap: 10px; cursor: pointer;">
                            <input type="checkbox" id="setting-allow-manual" ${settings.allowManual ? 'checked' : ''}>
                            <span><strong>Permitir entrada manual de asistencia</strong></span>
                        </label>
                        <small style="color: #6B7280; margin-left: 30px; display: block;">Permitir registro de asistencia sin verificación biométrica</small>
                    </div>

                    <div class="form-group">
                        <label style="display: flex; align-items: center; gap: 10px; cursor: pointer;">
                            <input type="checkbox" id="setting-require-biometric" ${settings.requireBiometric ? 'checked' : ''}>
                            <span><strong>Verificación biométrica obligatoria</strong></span>
                        </label>
                        <small style="color: #6B7280; margin-left: 30px; display: block;">Requiere verificación de huella para marcar asistencia</small>
                    </div>
                </div>
            </div>

            <div class="card" style="margin-bottom: 20px;">
                <div class="card-header">
                    <h4 style="margin: 0;">Lector de Huellas - Modo Automático</h4>
                </div>
                <div class="card-body">
                    <div class="form-group">
                        <label style="display: flex; align-items: center; gap: 10px; cursor: pointer;">
                            <input type="checkbox" id="setting-auto-start-listening" ${settings.autoStartListening ? 'checked' : ''}>
                            <span><strong>Iniciar modo de escucha continua automáticamente</strong></span>
                        </label>
                        <small style="color: #6B7280; margin-left: 30px; display: block;">
                            El lector estará activo y registrará asistencias automáticamente al detectar huellas
                        </small>
                    </div>

                    <div class="form-group" style="margin-top: 15px;">
                        <label><strong>Tiempo de espera por captura (inactividad)</strong></label>
                        <div style="display: flex; align-items: center; gap: 10px; margin-top: 5px;">
                            <input type="number" id="setting-capture-timeout" class="form-control" style="width: 100px;" min="10" max="60" value="${settings.captureTimeoutSeconds || 20}">
                            <span style="color: #4B5563;">segundos (predeterminado: 20s)</span>
                        </div>
                        <small style="color: #6B7280; display: block; margin-top: 4px;">
                            Tiempo máximo que el lector esperará a que el empleado coloque el dedo antes de cancelar por inactividad.
                        </small>
                    </div>

                    <div style="padding: 15px; background: #EFF6FF; border-radius: 8px; border-left: 4px solid #3B82F6; margin-top: 15px;">
                        <div style="font-size: 13px; color: #1E40AF;">
                            <strong>ℹ️ Información:</strong> El modo automático permite que los empleados marquen su asistencia
                            simplemente colocando su dedo en el lector, sin necesidad de buscar su nombre en el sistema.
                        </div>
                    </div>
                </div>
            </div>

            <div class="card" style="margin-bottom: 20px;">
                <div class="card-header">
                    <h4 style="margin: 0;">Notificaciones y Alertas</h4>
                </div>
                <div class="card-body">
                    <div class="form-group">
                        <label style="display: flex; align-items: center; gap: 10px; cursor: pointer;">
                            <input type="checkbox" id="setting-notifications" ${settings.enableNotifications ? 'checked' : ''}>
                            <span><strong>Activar notificaciones del sistema</strong></span>
                        </label>
                    </div>

                    <div class="form-group">
                        <label style="display: flex; align-items: center; gap: 10px; cursor: pointer;">
                            <input type="checkbox" id="setting-late-alerts" ${settings.lateAlerts ? 'checked' : ''}>
                            <span><strong>Alertar cuando un empleado llega tarde</strong></span>
                        </label>
                    </div>

                    <div class="form-group">
                        <label style="display: flex; align-items: center; gap: 10px; cursor: pointer;">
                            <input type="checkbox" id="setting-biometric-fail-alerts" ${settings.biometricFailAlerts ? 'checked' : ''}>
                            <span><strong>Alertar cuando falla la verificación biométrica</strong></span>
                        </label>
                    </div>
                </div>
            </div>

            <div class="card" style="margin-bottom: 20px;">
                <div class="card-header">
                    <h4 style="margin: 0;">Información del Sistema</h4>
                </div>
                <div class="card-body">
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                        <div style="padding: 12px; background: #F9FAFB; border-radius: 8px;">
                            <div style="color: #6B7280; font-size: 12px;">Versión del Sistema</div>
                            <div style="font-size: 16px; font-weight: 600; color: #1F2937;">1.0.0</div>
                        </div>
                        <div style="padding: 12px; background: #F9FAFB; border-radius: 8px;">
                            <div style="color: #6B7280; font-size: 12px;">Total Empleados Activos</div>
                            <div style="font-size: 16px; font-weight: 600; color: #1F2937;">${employees.length}</div>
                        </div>
                        <div style="padding: 12px; background: #F9FAFB; border-radius: 8px;">
                            <div style="color: #6B7280; font-size: 12px;">Total Departamentos</div>
                            <div style="font-size: 16px; font-weight: 600; color: #1F2937;">${departments.length}</div>
                        </div>
                        <div style="padding: 12px; background: #F9FAFB; border-radius: 8px;">
                            <div style="color: #6B7280; font-size: 12px;">Total Turnos</div>
                            <div style="font-size: 16px; font-weight: 600; color: #1F2937;">${shifts.length}</div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="card" style="margin-bottom: 20px; border: 2px solid #FEE2E2;">
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
                            Elimina todos los datos del sistema incluyendo empleados, departamentos, turnos,
                            registros de asistencia y huellas dactilares. Esta acción es irreversible.
                        </p>
                        <button class="btn" onclick="resetDatabase()"
                                style="background: #DC2626; color: white; font-weight: 600;">
                            🗑️ Resetear Toda la Base de Datos
                        </button>
                    </div>
                </div>
            </div>

            <div style="display: flex; gap: 10px; justify-content: flex-end;">
                <button class="btn" onclick="resetSettings()" style="background: #EF4444; color: white;">
                    Restaurar Valores Predeterminados
                </button>
                <button class="btn btn-primary" onclick="saveSettings()">
                    💾 Guardar Configuración
                </button>
            </div>
        </div>
    `;
}

function loadSavedSettings() {
    const defaultSettings = {
        absentTime: '09:00',
        requireCheckout: true,
        allowManual: true,
        requireBiometric: false,
        captureTimeoutSeconds: 20,
        enableNotifications: true,
        lateAlerts: true,
        biometricFailAlerts: false,
        autoStartListening: true  // Modo automático habilitado por defecto
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
        const newSettings = {
            absentTime: document.getElementById('setting-absent-time')?.value || '09:00',
            requireCheckout: safeParseBoolean(document.getElementById('setting-require-checkout')?.checked, true),
            allowManual: safeParseBoolean(document.getElementById('setting-allow-manual')?.checked, true),
            requireBiometric: safeParseBoolean(document.getElementById('setting-require-biometric')?.checked, false),
            captureTimeoutSeconds: safeParseInt(document.getElementById('setting-capture-timeout')?.value, 20),
            enableNotifications: safeParseBoolean(document.getElementById('setting-notifications')?.checked, true),
            lateAlerts: safeParseBoolean(document.getElementById('setting-late-alerts')?.checked, true),
            biometricFailAlerts: safeParseBoolean(document.getElementById('setting-biometric-fail-alerts')?.checked, false),
            autoStartListening: safeParseBoolean(document.getElementById('setting-auto-start-listening')?.checked, true)
        };

        localStorage.setItem('attendance_settings', JSON.stringify(newSettings));

        // Si cambió la configuración de auto-start, aplicar cambio inmediatamente
        if (oldSettings.autoStartListening !== newSettings.autoStartListening && window.touchMode) {
            const state = await window.touchMode.getLocalState();

            if (newSettings.autoStartListening && !state.isActive) {
                // Iniciar modo automático
                const result = await window.touchMode.start();
                if (result.success) {
                    showNotification('Configuración guardada y modo automático iniciado', 'success');
                } else {
                    showNotification(`Configuración guardada. ${result.message}`, 'warning');
                }
            } else if (!newSettings.autoStartListening && state.isActive) {
                // Detener modo automático
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

        logger.info('Configuración guardada:', newSettings);
    } catch (error) {
        logger.error('Error guardando configuración:', error);
        showNotification('Error al guardar la configuración', 'error');
    }
}

function resetSettings() {
    if (confirm('¿Está seguro de que desea restaurar los valores predeterminados? Esta acción no se puede deshacer.')) {
        localStorage.removeItem('attendance_settings');
        showNotification('Configuración restaurada a valores predeterminados', 'success');
        loadSettingsSection();
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

// ==================== AUTO ATTENDANCE (MODO AUTOMÁTICO) ====================

// ==================== TOUCH MODE (MODO AUTOMÁTICO) ====================

let touchModeState = {
    isActive: false,
    lastEventTime: null,
    totalTouches: 0,
    totalFingerprints: 0
};

let touchModePollingInterval = null;

/**
 * Inicializar modo touch
 */
async function initializeTouchMode() {
    try {
        logger.info('🚀 Inicializando Touch Mode...');

        // Configurar listener para errores críticos
        if (window.touchMode.onCriticalError) {
            window.touchMode.onCriticalError((data) => {
                logger.error('❌❌❌ ERROR CRÍTICO EN MODO AUTOMÁTICO ❌❌❌');
                logger.error('Mensaje:', data.message);

                // Mostrar notificación de error crítico
                showNotification(
                    '🔴 Error Crítico: ' + data.message + '. El modo automático ha sido desactivado.',
                    'error'
                );

                // Actualizar estado local
                touchModeState.isActive = false;
                updateTouchModeUI();

                // Detener polling
                stopTouchModePolling();
            });
            logger.info('[UI] Listener de errores críticos configurado');
        }

        // Configurar listener para asistencias registradas
        if (window.touchMode.onAttendanceRegistered) {
            window.touchMode.onAttendanceRegistered((eventData) => {
                logger.info('✅ [UI] Asistencia registrada recibida:', eventData);

                const { type, data } = eventData;

                // Mostrar notificación al registrar asistencia
                if (type === 'CHECK_IN_REGISTERED') {
                    showNotification(
                        `✅ Huella capturada e identificada - Entrada registrada a las ${data.record.check_in_time}`,
                        data.record.status === 'late' ? 'warning' : 'success'
                    );
                } else if (type === 'CHECK_OUT_REGISTERED') {
                    showNotification(
                        `✅ Huella capturada e identificada - Salida registrada a las ${data.record.check_out_time}`,
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
            logger.info('[UI] Listener de asistencias registradas configurado');
        }

        // Obtener estado inicial
        const state = await window.touchMode.getLocalState();
        touchModeState = state;
        updateTouchModeUI();

        // Auto-iniciar el modo automático si no está activo
        if (!state.isActive) {
            logger.info('🔄 Auto-iniciando Modo Automático de Asistencia...');
            const result = await window.touchMode.start();

            if (result.success) {
                logger.info('✅ Modo automático auto-iniciado exitosamente');
                showNotification('Modo Automático de Asistencia activado', 'success');

                // Actualizar estado y UI
                const newState = await window.touchMode.getLocalState();
                touchModeState = newState;
                updateTouchModeUI();

                // Iniciar polling
                startTouchModePolling();
            } else {
                // Si el servidor no está disponible, solo registrar en consola (no mostrar error al usuario)
                if (result.message && result.message.includes('Servidor biométrico no disponible')) {
                    logger.warn('⚠️ Servidor biométrico no disponible - Touch Mode no iniciado');
                    logger.info('ℹ️ Inicie el servidor edge-uru-ui para habilitar el modo automático');
                } else {
                    logger.error('❌ Error al auto-iniciar modo automático:', result.message);
                    showNotification('Error al activar modo automático: ' + result.message, 'error');
                }
            }
        } else {
            logger.info('ℹ️ Modo automático ya estaba activo');
            startTouchModePolling();
        }

        logger.info('✅ Touch Mode inicializado');
    } catch (error) {
        logger.error('❌ Error inicializando Touch Mode:', error);
        showNotification('Error al inicializar modo automático: ' + error.message, 'error');
        // Asegurar que la UI refleje el estado de error
        updateTouchModeUI();
    }
}

/**
 * Alternar modo touch (automático)
 */
async function toggleAutoAttendance() {
    try {
        if (touchModeState.isActive) {
            logger.info('🛑 [UI] Deteniendo modo automático...');
            // Detener
            const result = await window.touchMode.stop();
            if (result.success) {
                logger.info('✅ [UI] Modo automático detenido exitosamente');
                showNotification('Modo automático detenido', 'info');
                stopTouchModePolling();
            } else {
                logger.error('❌ [UI] Error al detener:', result.message);
                showNotification(result.message || 'Error al detener modo automático', 'error');
            }
        } else {
            logger.info('🚀 [UI] Iniciando modo automático...');
            // Iniciar
            const result = await window.touchMode.start();
            if (result.success) {
                logger.info('✅ [UI] Modo automático iniciado exitosamente');
                logger.info('👂 [UI] Lector escuchando eventos de huellas...');
                showNotification(result.message || 'Modo automático iniciado - El lector está escuchando', 'success');
                startTouchModePolling();
            } else {
                logger.error('❌ [UI] Error al iniciar:', result.message);
                showNotification(result.message || 'Error al iniciar modo automático', 'error');
            }
        }

        // Actualizar estado local
        const state = await window.touchMode.getLocalState();
        touchModeState = state;
        logger.info('[UI] Estado touch mode:', touchModeState);
        updateTouchModeUI();

    } catch (error) {
        logger.error('❌ [UI] Error alternando modo automático:', error);
        showNotification('Error al controlar el modo automático: ' + error.message, 'error');
    }
}

/**
 * Iniciar polling de estado del touch mode
 */
function startTouchModePolling() {
    if (touchModePollingInterval) {
        clearInterval(touchModePollingInterval);
    }

    logger.info('📊 [UI] Iniciando polling de estado (cada 1 segundo)');

    touchModePollingInterval = setInterval(async () => {
        try {
            const state = await window.touchMode.getLocalState();
            const previousState = { ...touchModeState };
            touchModeState = state;

            // Detectar cambios en fingerprints capturadas
            if (state.totalFingerprints > previousState.totalFingerprints) {
                logger.info(`✅ [UI] Nueva huella procesada (total: ${state.totalFingerprints})`);
                // Nota: No mostramos notificación aquí porque el listener de eventos
                // ya maneja esto correctamente (solo muestra mensaje cuando score = 0)

                // Recargar datos si estamos en dashboard
                if (currentSection === 'dashboard') {
                    logger.info('[UI] Recargando dashboard...');
                    setTimeout(() => loadDashboard(), 1000);
                }
            }

            // Detectar toques
            if (state.totalTouches > previousState.totalTouches) {
                logger.info(`👆 [UI] Dedo detectado en el lector (total: ${state.totalTouches})`);
            }

            updateTouchModeUI();
        } catch (error) {
            logger.error('❌ [UI] Error polling touch mode state:', error);
        }
    }, 1000); // Polling cada segundo
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
 * Actualizar UI del modo touch
 */
function updateTouchModeUI() {
    const statusIndicator = document.getElementById('auto-attendance-status');
    const toggleBtn = document.getElementById('toggle-auto-attendance-btn');

    if (!statusIndicator || !toggleBtn) return;

    if (touchModeState.isActive) {
        // Modo activo
        statusIndicator.innerHTML = `
            <div style="display: flex; align-items: center; gap: 10px; padding: 15px; background: #ECFDF5; border-radius: 10px; border: 2px solid #10B981;">
                <div style="width: 12px; height: 12px; background: #10B981; border-radius: 50%; animation: pulse 2s infinite;"></div>
                <div>
                    <div style="font-weight: 600; color: #065F46;">🟢 Lector Activo</div>
                    <div style="font-size: 13px; color: #047857; margin-top: 3px;">
                        Toques: ${touchModeState.totalTouches} | Huellas: ${touchModeState.totalFingerprints}
                    </div>
                </div>
            </div>
        `;

        toggleBtn.innerHTML = '🔴 Detener Modo Automático';
        toggleBtn.className = 'btn';
        toggleBtn.style.background = '#EF4444';
        toggleBtn.style.color = 'white';
    } else {
        // Modo inactivo
        statusIndicator.innerHTML = `
            <div style="display: flex; align-items: center; gap: 10px; padding: 15px; background: #F3F4F6; border-radius: 10px; border: 2px solid #9CA3AF;">
                <div style="width: 12px; height: 12px; background: #6B7280; border-radius: 50%;"></div>
                <div>
                    <div style="font-weight: 600; color: #374151;">⚫ Lector Inactivo</div>
                    <div style="font-size: 13px; color: #6B7280; margin-top: 3px;">
                        El modo automático está detenido
                    </div>
                </div>
            </div>
        `;

        toggleBtn.innerHTML = '🟢 Iniciar Modo Automático';
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
    try {
        const audio = new Audio();
        // Frecuencia y duración según el tipo
        const context = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = context.createOscillator();
        const gainNode = context.createGain();

        oscillator.connect(gainNode);
        gainNode.connect(context.destination);

        if (type === 'check-in' || type === 'check-out') {
            // Sonido de éxito
            oscillator.frequency.value = 800;
            gainNode.gain.setValueAtTime(0.3, context.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.01, context.currentTime + 0.2);
            oscillator.start(context.currentTime);
            oscillator.stop(context.currentTime + 0.2);
        } else if (type === 'error' || type === 'not-identified') {
            // Sonido de error
            oscillator.frequency.value = 200;
            gainNode.gain.setValueAtTime(0.3, context.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.01, context.currentTime + 0.3);
            oscillator.start(context.currentTime);
            oscillator.stop(context.currentTime + 0.3);
        }
    } catch (error) {
        // Ignorar errores de audio
    }
}

/**
 * Validar antes de iniciar enrollment
 */
async function validateBeforeEnrollment(employeeId) {
    try {
        if (!window.touchMode) return true;
        const state = await window.touchMode.getLocalState();

        if (state && state.isActive) {
            // Mostrar modal de confirmación
            const confirmPause = confirm(
                '⚠️ El lector está en modo automático continuo.\n\n' +
                '¿Desea pausarlo temporalmente para registrar la huella?'
            );

            if (confirmPause) {
                const result = await window.touchMode.stop();
                if (result.success) {
                    touchModeState.isActive = false;
                    updateTouchModeUI();
                    showNotification('Modo automático pausado temporalmente', 'info');
                    return true;
                } else {
                    showNotification('No se pudo pausar el modo automático: ' + (result.message || ''), 'error');
                    return false;
                }
            }
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

    setTimeout(() => {
        notification.style.animation = 'slideIn 0.3s ease-out reverse';
        setTimeout(() => notification.remove(), 300);
    }, 3000);
}

// ==================== UTILIDADES ====================
function formatTime(timeString) {
    if (!timeString) return '-';
    return timeString.substring(0, 5); // HH:MM
}

function formatDate(dateString) {
    if (!dateString) return '-';
    const date = new Date(dateString);
    return date.toLocaleDateString('es-ES');
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
});
