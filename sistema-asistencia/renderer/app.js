/**
 * Sistema de Asistencia - Renderer Application
 * Conecta la interfaz con el backend a través de la API expuesta por preload
 */
import { FingerprintEnroller } from './js/controls/FingerprintEnroller.js';
import { logger } from './logger.js';
import { escapeHtml } from './js/escape-html.js';

// Instancia única (antes: singleton global creado por su propio script tag)
window.FingerprintEnroller = new FingerprintEnroller();
// B4: liberar EventSource al cerrar la ventana (recurso del engine)
window.addEventListener('beforeunload', () => window.FingerprintEnroller.disconnect());

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
document.addEventListener('DOMContentLoaded', async () => {
    logger.info('🚀 Sistema de Asistencia - Iniciando...');

    // Configurar navegación
    setupNavigation();

    // Configurar reloj
    updateClock();
    setInterval(updateClock, 1000);

    // Cargar datos iniciales
    await loadInitialData();

    // Inicializar modo touch
    await initializeTouchMode();

    // Mostrar dashboard por defecto
    showSection('dashboard');

    logger.info('✅ Sistema listo');
});

// ==================== NAVEGACIÓN ====================
function setupNavigation() {
    const navItems = document.querySelectorAll('.nav-item');

    navItems.forEach(item => {
        item.addEventListener('click', () => {
            const section = item.dataset.section;
            navItems.forEach(nav => nav.classList.remove('active'));
            item.classList.add('active');
            showSection(section);
        });
    });
}

function showSection(sectionName) {
    currentSection = sectionName;

    // Ocultar todas las secciones
    document.querySelectorAll('.content-section').forEach(section => {
        section.classList.remove('active');
    });

    // Mostrar sección seleccionada
    const targetSection = document.getElementById(`${sectionName}-section`);
    if (targetSection) {
        targetSection.classList.add('active');
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
    document.getElementById('page-title').textContent = titles[sectionName] || 'Sistema';

    // Cargar datos según la sección
    switch (sectionName) {
        case 'dashboard':
            loadDashboard();
            break;
        case 'check-in':
            loadCheckInSection();
            break;
        case 'employees':
            loadEmployeesSection();
            break;
        case 'attendance':
            loadAttendanceSection();
            break;
        case 'departments':
            loadDepartmentsSection();
            break;
        case 'shifts':
            loadShiftsSection();
            break;
        case 'reports':
            loadReportsSection();
            break;
        case 'settings':
            loadSettingsSection();
            break;
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
            loadDashboard();
        } else {
            showNotification(result.message, 'error');
        }
    } catch (error) {
        logger.error('Error en check-in:', error);
        showNotification('Error al registrar entrada', 'error');
    }
}

async function performCheckOut() {
    if (!selectedEmployeeId) return;

    try {
        const result = await window.attendance.checkOut(selectedEmployeeId);

        if (result.success) {
            showNotification(result.message, 'success');
            closeModal();
            loadDashboard();
        } else {
            showNotification(result.message, 'error');
        }
    } catch (error) {
        logger.error('Error en check-out:', error);
        showNotification('Error al registrar salida', 'error');
    }
}

function closeModal() {
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
                    ${employees.map(emp => {
                        const enrollmentMode = emp.enrollment_mode || 'N/A';
                        const enrollmentText = enrollmentMode === 'simple' ? 'Simple (1)' :
                                             enrollmentMode === 'advanced' ? 'Avanzado (10)' :
                                             'Sin definir';
                        const enrollmentColor = enrollmentMode === 'simple' ? '#3B82F6' :
                                              enrollmentMode === 'advanced' ? '#8B5CF6' :
                                              '#9CA3AF';

                        return `
                        <tr>
                            <td>${escapeHtml(emp.employee_code)}</td>
                            <td>${escapeHtml(emp.first_name)} ${escapeHtml(emp.last_name)}</td>
                            <td>${escapeHtml(emp.email)}</td>
                            <td>${escapeHtml(emp.department_name)}</td>
                            <td>${escapeHtml(emp.shift_name)}</td>
                            <td style="text-align: center;">${emp.fingerprints_count || 0}/10</td>
                            <td style="text-align: center;">
                                <span style="background: ${enrollmentColor}; color: white; padding: 4px 10px; border-radius: 12px; font-size: 11px; font-weight: 600;">
                                    ${enrollmentText}
                                </span>
                            </td>
                            <td><span class="badge badge-${emp.status === 'active' ? 'success' : 'danger'}">${escapeHtml(emp.status)}</span></td>
                            <td>
                                <button class="btn" onclick="showEmployeeDetails(${emp.id})" style="padding: 5px 10px; font-size: 12px; margin-right: 3px; background: #3B82F6; color: white;" title="Ver detalles">👁️</button>
                                <button class="btn" onclick="showEditEmployeeModal(${emp.id})" style="padding: 5px 10px; font-size: 12px; margin-right: 3px; background: #10B981; color: white;" title="Editar">✏️</button>
                                <button class="btn" onclick="showEnrollFingerprintModal(${emp.id})" style="padding: 5px 10px; font-size: 12px; margin-right: 3px; background: #8B5CF6; color: white;" title="Registrar huella">👆</button>
                                <button class="btn" onclick="deleteEmployee(${emp.id})" style="padding: 5px 10px; font-size: 12px; background: #EF4444; color: white;" title="Eliminar">🗑️</button>
                            </td>
                        </tr>
                        `;
                    }).join('')}
                </tbody>
            </table>
        </div>
    `;
}

function filterEmployees(searchText) {
    const tbody = document.getElementById('employees-table-body');
    if (!tbody) return;

    const filtered = employees.filter(emp => {
        const searchLower = searchText.toLowerCase();
        return emp.first_name.toLowerCase().includes(searchLower) ||
               emp.last_name.toLowerCase().includes(searchLower) ||
               emp.employee_code.toLowerCase().includes(searchLower) ||
               emp.email.toLowerCase().includes(searchLower);
    });

    tbody.innerHTML = filtered.map(emp => {
        const enrollmentMode = emp.enrollment_mode || 'N/A';
        const enrollmentText = enrollmentMode === 'simple' ? 'Simple (1)' :
                             enrollmentMode === 'advanced' ? 'Avanzado (10)' :
                             'Sin definir';
        const enrollmentColor = enrollmentMode === 'simple' ? '#3B82F6' :
                              enrollmentMode === 'advanced' ? '#8B5CF6' :
                              '#9CA3AF';

        return `
        <tr>
            <td>${escapeHtml(emp.employee_code)}</td>
            <td>${escapeHtml(emp.first_name)} ${escapeHtml(emp.last_name)}</td>
            <td>${escapeHtml(emp.email)}</td>
            <td>${escapeHtml(emp.department_name)}</td>
            <td>${escapeHtml(emp.shift_name)}</td>
            <td style="text-align: center;">${emp.fingerprints_count || 0}/10</td>
            <td style="text-align: center;">
                <span style="background: ${enrollmentColor}; color: white; padding: 4px 10px; border-radius: 12px; font-size: 11px; font-weight: 600;">
                    ${enrollmentText}
                </span>
            </td>
            <td><span class="badge badge-${emp.status === 'active' ? 'success' : 'danger'}">${escapeHtml(emp.status)}</span></td>
            <td>
                <button class="btn" onclick="showEmployeeDetails(${emp.id})" style="padding: 5px 10px; font-size: 12px; margin-right: 3px; background: #3B82F6; color: white;" title="Ver detalles">👁️</button>
                <button class="btn" onclick="showEditEmployeeModal(${emp.id})" style="padding: 5px 10px; font-size: 12px; margin-right: 3px; background: #10B981; color: white;" title="Editar">✏️</button>
                <button class="btn" onclick="showEnrollFingerprintModal(${emp.id})" style="padding: 5px 10px; font-size: 12px; margin-right: 3px; background: #8B5CF6; color: white;" title="Registrar huella">👆</button>
                <button class="btn" onclick="deleteEmployee(${emp.id})" style="padding: 5px 10px; font-size: 12px; background: #EF4444; color: white;" title="Eliminar">🗑️</button>
            </td>
        </tr>
        `;
    }).join('');
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
                                    ${departments.map(dept => `<option value="${dept.id}">${dept.name}</option>`).join('')}
                                </select>
                            </div>
                            <div class="form-group">
                                <label>Turno *</label>
                                <select id="emp-shift" class="form-control" required>
                                    <option value="">Seleccione...</option>
                                    ${shifts.map(shift => `<option value="${shift.id}">${shift.name}</option>`).join('')}
                                </select>
                            </div>
                            <div class="form-group" style="grid-column: 1 / -1;">
                                <label>Puesto *</label>
                                <input type="text" id="emp-position" class="form-control" required>
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

    const data = {
        employee_code: document.getElementById('emp-code').value.trim(),
        first_name: document.getElementById('emp-firstname').value.trim(),
        last_name: document.getElementById('emp-lastname').value.trim(),
        email: email.trim().toLowerCase(),
        phone: document.getElementById('emp-phone').value.trim() || null,
        department_id: parseInt(document.getElementById('emp-department').value),
        shift_id: parseInt(document.getElementById('emp-shift').value),
        position: document.getElementById('emp-position').value.trim(),
        hire_date: document.getElementById('emp-hire-date').value,
        status: 'active'
    };

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
                            <div class="form-group">
                                <label>Código de Empleado *</label>
                                <input type="text" id="edit-emp-code" class="form-control" value="${escapeHtml(employee.employee_code)}" required>
                            </div>
                            <div class="form-group">
                                <label>Fecha de Contratación *</label>
                                <input type="date" id="edit-emp-hire-date" class="form-control" value="${employee.hire_date}" required>
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
                                <input type="tel" id="edit-emp-phone" class="form-control" value="${employee.phone || ''}">
                            </div>
                            <div class="form-group">
                                <label>Departamento *</label>
                                <select id="edit-emp-department" class="form-control" required>
                                    ${departments.map(dept => `<option value="${dept.id}" ${dept.id === employee.department_id ? 'selected' : ''}>${dept.name}</option>`).join('')}
                                </select>
                            </div>
                            <div class="form-group">
                                <label>Turno *</label>
                                <select id="edit-emp-shift" class="form-control" required>
                                    ${shifts.map(shift => `<option value="${shift.id}" ${shift.id === employee.shift_id ? 'selected' : ''}>${shift.name}</option>`).join('')}
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

    const data = {
        id: employeeId,
        employee_code: document.getElementById('edit-emp-code').value.trim(),
        first_name: document.getElementById('edit-emp-firstname').value.trim(),
        last_name: document.getElementById('edit-emp-lastname').value.trim(),
        email: email.trim().toLowerCase(),
        phone: document.getElementById('edit-emp-phone').value.trim() || null,
        department_id: parseInt(document.getElementById('edit-emp-department').value),
        shift_id: parseInt(document.getElementById('edit-emp-shift').value),
        position: document.getElementById('edit-emp-position').value.trim(),
        hire_date: document.getElementById('edit-emp-hire-date').value,
        status: document.getElementById('edit-emp-status').value
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
        }
    } catch (error) {
        logger.error('Error actualizando empleado:', error);
        showNotification(error.message || 'Error al actualizar empleado', 'error');
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
                        <div style="width: 100px; height: 100px; border-radius: 50%; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); display: flex; align-items: center; justify-content: center; color: white; font-size: 40px; font-weight: 600; margin: 0 auto 15px;">
                            ${getInitials(employee.first_name, employee.last_name)}
                        </div>
                        <h3 style="margin: 0;">${escapeHtml(employee.first_name)} ${escapeHtml(employee.last_name)}</h3>
                        <p style="color: #6B7280;">${escapeHtml(employee.employee_code)}</p>
                    </div>

                    <div style="display: grid; gap: 15px;">
                        <div style="display: grid; grid-template-columns: 120px 1fr; gap: 10px; padding: 12px; background: #F9FAFB; border-radius: 8px;">
                            <strong>Email:</strong> <span>${escapeHtml(employee.email)}</span>
                        </div>
                        <div style="display: grid; grid-template-columns: 120px 1fr; gap: 10px; padding: 12px; background: #F9FAFB; border-radius: 8px;">
                            <strong>Teléfono:</strong> <span>${employee.phone || 'N/A'}</span>
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
                    <button class="btn" onclick="closeModal()" style="background: #6B7280; color: white;">Cancelar</button>
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
                closeModal();
                loadEmployeesSection();
            }, 2000);
        } else {
            enroller.finishEnrollment(false, result.message || 'Error al registrar huella');
            startBtn.disabled = false;
            startBtn.textContent = 'Reintentar';
        }
    } catch (error) {
        logger.error('[Renderer] Error enrolling fingerprint:', error);
        logger.error('[Renderer] Error stack:', error.stack);
        enroller.finishEnrollment(false, 'Error de conexión con el lector');
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
        const finger = fingers[i];
        const progressId = `progress-${finger.hand}-${finger.position}`;
        const progressDiv = document.getElementById(progressId);

        // Actualizar estado a "en progreso"
        progressDiv.style.color = '#F59E0B';
        progressDiv.style.fontWeight = '600';
        progressDiv.innerHTML = `⏳ ${finger.label}`;

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

            if (result.success) {
                progressDiv.style.color = '#10B981';
                progressDiv.innerHTML = `✅ ${finger.label}`;
                completedCount++;
                enroller.finishEnrollment(true, `${finger.label} registrado exitosamente`);

                // Pausa para mostrar el éxito
                await new Promise(resolve => setTimeout(resolve, 1500));
            } else {
                progressDiv.style.color = '#EF4444';
                progressDiv.innerHTML = `❌ ${finger.label}`;
                enroller.finishEnrollment(false, result.message || 'Error al registrar');
                showNotification(`Error capturando ${finger.label}: ${result.message}`, 'warning', 3000);

                // Pausa antes de continuar
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        } catch (error) {
            logger.error(`Error enrolling ${finger.label}:`, error);
            progressDiv.style.color = '#EF4444';
            progressDiv.innerHTML = `❌ ${finger.label}`;
            enroller.finishEnrollment(false, 'Error de conexión');
            showNotification(`Error de conexión capturando ${finger.label}`, 'warning', 3000);

            // Pausa antes de continuar
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }

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
        closeModal();
        loadEmployeesSection();
    }, 3000);
}

// ==================== ATTENDANCE SECTION ====================
async function loadAttendanceSection() {
    try {
        const records = await window.attendance.getAttendanceRecords();

        const container = document.getElementById('attendance-records-container');
        if (!container) return;

        container.innerHTML = `
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
                        ${records.map(rec => `
                            <tr>
                                <td>${rec.date}</td>
                                <td>${rec.employee_name}</td>
                                <td>${rec.department_name}</td>
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
        `;
    } catch (error) {
        logger.error('Error cargando registros:', error);
    }
}

// ==================== DEPARTMENTS SECTION ====================
function loadDepartmentsSection() {
    const container = document.getElementById('departments-container');
    if (!container) return;

    container.innerHTML = `
        <div style="margin-bottom: 20px;">
            <button class="btn btn-primary" onclick="showAddDepartmentModal()">
                + Agregar Departamento
            </button>
        </div>

        <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 20px;">
            ${departments.map(dept => `
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
                            <h4 style="margin: 0; color: #1F2937;">${dept.name}</h4>
                            <p style="margin: 5px 0 0; color: #6B7280; font-size: 13px;">
                                ${employees.filter(e => e.department_id === dept.id).length} empleados
                            </p>
                        </div>
                    </div>
                    <p style="color: #6B7280; font-size: 14px; margin: 10px 0 0;">
                        ${dept.description || 'Sin descripción'}
                    </p>
                </div>
            `).join('')}
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
    const name = document.getElementById('dept-name').value.trim();
    const description = document.getElementById('dept-description').value.trim();

    if (!name) {
        showNotification('El nombre del departamento es requerido', 'warning');
        return;
    }

    try {
        const result = await window.attendance.createDepartment({ name, description });

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
                            <input type="text" id="edit-dept-name" class="form-control" value="${dept.name}" required>
                        </div>
                        <div class="form-group">
                            <label>Descripción</label>
                            <textarea id="edit-dept-description" class="form-control" rows="3">${dept.description || ''}</textarea>
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
    const name = document.getElementById('edit-dept-name').value.trim();
    const description = document.getElementById('edit-dept-description').value.trim();

    if (!name) {
        showNotification('El nombre del departamento es requerido', 'warning');
        return;
    }

    try {
        const result = await window.attendance.updateDepartment({
            id: deptId,
            name,
            description
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
            `No se puede eliminar el departamento "${dept.name}" porque tiene ${employeesInDept.length} empleado(s) asignado(s). ` +
            `Por favor, reasigne los empleados a otro departamento primero.`,
            'warning'
        );
        return;
    }

    const confirmDelete = confirm(
        `¿Está seguro de que desea eliminar el departamento?\n\n` +
        `${dept.name}\n\n` +
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

    container.innerHTML = `
        <div style="margin-bottom: 20px;">
            <button class="btn btn-primary" onclick="showAddShiftModal()">
                + Agregar Turno
            </button>
        </div>

        <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 20px;">
            ${shifts.map(shift => `
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
                            <h4 style="margin: 0; color: #1F2937;">${shift.name}</h4>
                            <p style="margin: 5px 0 0; color: #6B7280; font-size: 13px;">
                                ${employees.filter(e => e.shift_id === shift.id).length} empleados
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
            `).join('')}
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
    const name = document.getElementById('shift-name').value.trim();
    const startTime = document.getElementById('shift-start-time').value;
    const endTime = document.getElementById('shift-end-time').value;
    const tolerance = parseInt(document.getElementById('shift-tolerance').value);
    const color = document.getElementById('shift-color').value;

    if (!name || !startTime || !endTime) {
        showNotification('Todos los campos son requeridos', 'warning');
        return;
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
        }
    } catch (error) {
        logger.error('Error creando turno:', error);
        showNotification(error.message || 'Error al crear turno', 'error');
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
                            <input type="text" id="edit-shift-name" class="form-control" value="${shift.name}" required>
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
    const name = document.getElementById('edit-shift-name').value.trim();
    const startTime = document.getElementById('edit-shift-start-time').value;
    const endTime = document.getElementById('edit-shift-end-time').value;
    const tolerance = parseInt(document.getElementById('edit-shift-tolerance').value);
    const color = document.getElementById('edit-shift-color').value;

    if (!name || !startTime || !endTime) {
        showNotification('Todos los campos son requeridos', 'warning');
        return;
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
        }
    } catch (error) {
        logger.error('Error actualizando turno:', error);
        showNotification(error.message || 'Error al actualizar turno', 'error');
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
            `No se puede eliminar el turno "${shift.name}" porque tiene ${employeesInShift.length} empleado(s) asignado(s). ` +
            `Por favor, reasigne los empleados a otro turno primero.`,
            'warning'
        );
        return;
    }

    const confirmDelete = confirm(
        `¿Está seguro de que desea eliminar el turno?\n\n` +
        `${shift.name} (${shift.start_time} - ${shift.end_time})\n\n` +
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

// ==================== REPORTS SECTION ====================
async function loadReportsSection() {
    const container = document.querySelector('#reports-section .card-body');
    if (!container) return;

    container.innerHTML = `
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px;">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 12px; padding: 30px; color: white; cursor: pointer;" onclick="generateDailyReport()">
                <div style="font-size: 48px; margin-bottom: 15px;">📊</div>
                <h3 style="margin: 0 0 10px;">Reporte Diario</h3>
                <p style="opacity: 0.9; margin: 0;">Resumen de asistencia del día</p>
            </div>

            <div style="background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); border-radius: 12px; padding: 30px; color: white; cursor: pointer;" onclick="generateWeeklyReport()">
                <div style="font-size: 48px; margin-bottom: 15px;">📅</div>
                <h3 style="margin: 0 0 10px;">Reporte Semanal</h3>
                <p style="opacity: 0.9; margin: 0;">Asistencia de la última semana</p>
            </div>

            <div style="background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%); border-radius: 12px; padding: 30px; color: white; cursor: pointer;" onclick="generateMonthlyReport()">
                <div style="font-size: 48px; margin-bottom: 15px;">📈</div>
                <h3 style="margin: 0 0 10px;">Reporte Mensual</h3>
                <p style="opacity: 0.9; margin: 0;">Estadísticas del mes actual</p>
            </div>

            <div style="background: linear-gradient(135deg, #fa709a 0%, #fee140 100%); border-radius: 12px; padding: 30px; color: white; cursor: pointer;" onclick="generateEmployeeReport()">
                <div style="font-size: 48px; margin-bottom: 15px;">👤</div>
                <h3 style="margin: 0 0 10px;">Por Empleado</h3>
                <p style="opacity: 0.9; margin: 0;">Historial de un empleado</p>
            </div>
        </div>
    `;
}

async function generateDailyReport() {
    try {
        showNotification('Generando reporte diario...', 'info');
        const report = await window.reports.generateDaily();

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

async function generateWeeklyReport() {
    try {
        showNotification('Generando reporte semanal...', 'info');
        const report = await window.reports.generateWeekly();

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

async function generateMonthlyReport() {
    try {
        showNotification('Generando reporte mensual...', 'info');
        const report = await window.reports.generateMonthly();

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
                                                const attendanceRate = parseFloat(emp.attendanceRate);
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
    // Mostrar selector de empleado
    const modalHTML = `
        <div class="modal active" onclick="if(event.target === this) closeModal()">
            <div class="modal-content" style="max-width: 600px;">
                <div class="modal-header">
                    <h3>👤 Seleccionar Empleado</h3>
                    <button class="close-btn" onclick="closeModal()">&times;</button>
                </div>
                <div class="modal-body">
                    <div class="form-group">
                        <label>Seleccione el empleado:</label>
                        <select id="report-employee-select" class="form-control">
                            <option value="">Seleccione...</option>
                            ${employees.map(emp => `
                                <option value="${emp.id}">${escapeHtml(emp.first_name)} ${escapeHtml(emp.last_name)} (${escapeHtml(emp.employee_code)})</option>
                            `).join('')}
                        </select>
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
    const employeeId = document.getElementById('report-employee-select').value;
    if (!employeeId) {
        showNotification('Por favor seleccione un empleado', 'warning');
        return;
    }

    try {
        closeModal();
        showNotification('Generando reporte del empleado...', 'info');
        const report = await window.reports.generateEmployee(parseInt(employeeId));

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
        enableNotifications: true,
        lateAlerts: true,
        biometricFailAlerts: false,
        autoStartListening: true  // Modo automático habilitado por defecto
    };

    try {
        const saved = localStorage.getItem('attendance_settings');
        return saved ? { ...defaultSettings, ...JSON.parse(saved) } : defaultSettings;
    } catch {
        return defaultSettings;
    }
}

async function saveSettings() {
    try {
        const oldSettings = loadSavedSettings();
        const newSettings = {
            absentTime: document.getElementById('setting-absent-time').value,
            requireCheckout: document.getElementById('setting-require-checkout').checked,
            allowManual: document.getElementById('setting-allow-manual').checked,
            requireBiometric: document.getElementById('setting-require-biometric').checked,
            enableNotifications: document.getElementById('setting-notifications').checked,
            lateAlerts: document.getElementById('setting-late-alerts').checked,
            biometricFailAlerts: document.getElementById('setting-biometric-fail-alerts').checked,
            autoStartListening: document.getElementById('setting-auto-start-listening').checked
        };

        localStorage.setItem('attendance_settings', JSON.stringify(newSettings));

        // Si cambió la configuración de auto-start, aplicar cambio inmediatamente
        if (oldSettings.autoStartListening !== newSettings.autoStartListening) {
            const state = await window.autoAttendance.getState();

            if (newSettings.autoStartListening && !state.isListening) {
                // Iniciar modo automático
                const result = await window.autoAttendance.start();
                if (result.success) {
                    showNotification('Configuración guardada y modo automático iniciado', 'success');
                } else {
                    showNotification(`Configuración guardada. ${result.message}`, 'warning');
                }
            } else if (!newSettings.autoStartListening && state.isListening) {
                // Detener modo automático
                const result = await window.autoAttendance.stop();
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

                // Mostrar notificación solo si el score es exactamente 0 (coincidencia perfecta)
                if (data.score === 0) {
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
                } else {
                    logger.info(`ℹ️ [UI] Asistencia registrada pero score no es perfecto (score: ${data.score})`);
                }

                // Recargar la vista actual si estamos en dashboard o records
                logger.info('[UI] Recargando datos de asistencia...');
                setTimeout(async () => {
                    await loadInitialData();

                    if (currentSection === 'dashboard') {
                        loadDashboard();
                    } else if (currentSection === 'records') {
                        loadRecordsSection();
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

    // Recargar registros del día si estamos en dashboard o records
    if (currentSection === 'dashboard' || currentSection === 'records') {
        setTimeout(async () => {
            await loadInitialData();
            if (currentSection === 'dashboard') {
                loadDashboard();
            } else if (currentSection === 'records') {
                loadRecordsSection();
            }
        }, 1000);
    }
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
        const canEnroll = await window.autoAttendance.canStartEnrollment();

        if (!canEnroll.can) {
            // Mostrar modal de confirmación
            const confirmPause = confirm(
                `⚠️ El lector está en modo automático\n\n` +
                `${canEnroll.reason}\n\n` +
                `¿Desea pausarlo temporalmente para registrar la huella?`
            );

            if (confirmPause) {
                const result = await window.autoAttendance.pauseForEnrollment();
                if (result.success) {
                    showNotification('Modo automático pausado temporalmente', 'info');
                    return true;
                } else {
                    showNotification('No se pudo pausar el modo automático', 'error');
                    return false;
                }
            }
            return false;
        }

        return true;
    } catch (error) {
        logger.error('Error validando enrollment:', error);
        return true; // Permitir continuar si hay error
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
});
