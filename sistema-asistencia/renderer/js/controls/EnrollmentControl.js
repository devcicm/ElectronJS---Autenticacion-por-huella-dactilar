/**
 * EnrollmentControl - Componente ultra simple para enrolamiento
 *
 * Responsabilidades:
 * - UI de enrolamiento con input de usuario
 * - Capturar 4 muestras de huella
 * - Mostrar progreso y estado
 * - Mostrar imagen de huella
 */
class EnrollmentControl extends BaseComponent {
    constructor(containerId, adapter, config = {}) {
        super(containerId, adapter, config);

        // Estado
        this.userId = '';
        this.isEnrolling = false;

        // Progreso de enrolamiento
        this.currentSample = 0;
        this.totalSamples = 4;
        this.progressPercentage = 0;

        // Escuchar directamente al adapter para eventos en tiempo real
        this._setupDirectListener();

        // Escuchar evento de finalización
        this._setupCompletionListener();
    }

    /**
     * Configurar listener directo al adapter para eventos en tiempo real
     * Esto asegura que recibimos TODOS los eventos SSE instantáneamente
     */
    _setupDirectListener() {
        // Escuchar TODOS los eventos del adapter con wildcard
        this.adapter.on('*', (data) => {
            // Solo procesar si estamos en proceso de enrolamiento
            if (!this.isEnrolling) return;

            const eventType = data.eventType || data.evt || '';

            // Eventos de progreso de captura que queremos mostrar en tiempo real
            const realtimeEvents = [
                'SYSTEM_STATUS',
                'SYSTEM_MESSAGE',
                'CAPTURE_PROGRESS',
                'CAPTURE_STARTED',
                'CAPTURE_QUALITY_LOW',
                'IMAGE_CAPTURED',
                'SAMPLE_COLLECTED',  // Evento del backend C#
                'ENROLLMENT_SAMPLE_COLLECTED',
                'ENROLLMENT_SAMPLE_SUCCESS',
                'ENROLLMENT_SAMPLE_STATUS'
            ];

            // Si es un evento de tiempo real, mostrarlo inmediatamente
            if (realtimeEvents.some(evt => eventType.includes(evt))) {
                const message = data.message || data.msg || eventType;
                const severity = (data.severity || 'INFO').toUpperCase();

                console.log(`[${this.componentId}] 📨 Evento directo: ${eventType} - ${message}`);

                // Actualizar status en tiempo real
                let statusType = 'info';
                if (severity === 'SUCCESS') statusType = 'success';
                else if (severity === 'ERROR' || severity === 'WARNING') statusType = 'error';

                this.updateStatus(message, statusType);

                // Actualizar progreso si el evento contiene información de muestras
                // Eventos posibles: SAMPLE_COLLECTED, ENROLLMENT_SAMPLE_COLLECTED
                if ((eventType === 'SAMPLE_COLLECTED' || eventType === 'ENROLLMENT_SAMPLE_COLLECTED') && data.data) {
                    const { sampleNumber, totalSamples, progress } = data.data;
                    if (sampleNumber !== undefined && totalSamples !== undefined) {
                        this._updateProgress(sampleNumber, totalSamples, progress || 0);
                    }
                }

                // Si hay imagen, mostrarla
                const imageBase64 = data.data?.imageBase64 || data.imageBase64;
                if (imageBase64) {
                    this.displayImage(imageBase64);
                }
            }
        });

        console.log(`[${this.componentId}] ✅ Listener directo al adapter configurado`);
    }

    /**
     * Configurar listener para ENROLLMENT_COMPLETED
     */
    _setupCompletionListener() {
        // Sobrescribir handleRouterEvent para detectar ENROLLMENT_COMPLETED
        const originalHandler = this.handleRouterEvent.bind(this);

        this.handleRouterEvent = (eventType, eventData) => {
            // Llamar al handler original primero
            originalHandler(eventType, eventData);

            // Detectar eventos de finalización
            if (eventType === 'ENROLLMENT_COMPLETED') {
                this._onEnrollmentCompleted(eventData);
            } else if (eventType === 'ENROLLMENT_FAILED') {
                this._onEnrollmentFailed(eventData);
            }
        };
    }

    /**
     * Manejar finalización exitosa
     */
    _onEnrollmentCompleted(eventData) {
        console.log(`[${this.componentId}] ✅ Enrolamiento completado, finalizando operación`);

        // Marcar progreso al 100% al completar
        this._updateProgress(4, 4, 100);

        this.isEnrolling = false;
        this._updateUI();

        // Emitir evento 'enrolled' para que listeners externos puedan reaccionar
        this.emit('enrolled', {
            userId: this.userId,
            eventData: eventData
        });

        // Auto-limpiar después de 5 segundos (dar tiempo a ver el progreso completo)
        setTimeout(() => this.clear(), 5000);
    }

    /**
     * Manejar fallos
     */
    _onEnrollmentFailed(eventData) {
        console.log(`[${this.componentId}] ❌ Enrolamiento fallido, finalizando operación`);

        this.isEnrolling = false;
        this._updateUI();

        // Dar tiempo para que el usuario vea el error antes de limpiar
        setTimeout(() => this.clear(), 3000);
    }

    /**
     * Crear estructura HTML
     */
    _createStructure() {
        this.container.innerHTML = `
            <div class="enrollment-control">
                <!-- Header -->
                <div class="component-header">
                    <h3>📝 Enrolamiento</h3>
                    <p class="component-subtitle">Captura 4 muestras de huella dactilar</p>
                </div>

                <!-- Input Usuario -->
                <div class="component-input-group">
                    <label for="userId-${this.containerId}">ID del Usuario:</label>
                    <input type="text"
                           id="userId-${this.containerId}"
                           class="component-input"
                           placeholder="Ej: Usuario001">
                </div>

                <!-- Progreso de Enrolamiento -->
                <div class="enrollment-progress" id="enrollmentProgress-${this.containerId}" style="display: none;">
                    <div class="progress-header">
                        <span class="progress-label">Progreso de Captura</span>
                        <span class="progress-counter" id="progressCounter-${this.containerId}">0/4</span>
                    </div>
                    <div class="progress-bar-container">
                        <div class="progress-bar" id="progressBar-${this.containerId}" style="width: 0%;">
                            <span class="progress-percentage" id="progressPercentage-${this.containerId}">0%</span>
                        </div>
                    </div>
                    <div class="progress-samples" id="progressSamples-${this.containerId}">
                        <span class="sample-indicator" data-sample="1">1</span>
                        <span class="sample-indicator" data-sample="2">2</span>
                        <span class="sample-indicator" data-sample="3">3</span>
                        <span class="sample-indicator" data-sample="4">4</span>
                    </div>
                </div>

                <!-- Imagen de huella -->
                <div class="fingerprint-image">
                    <div class="image-placeholder">👤</div>
                </div>

                <!-- Estado con timestamp -->
                <div class="component-status status-info">
                    <span class="status-timestamp">[--:--:--]</span>
                    <span class="status-icon">ℹ️</span>
                    <span class="status-message">Ingresa el ID del usuario</span>
                </div>

                <!-- Botones -->
                <div class="component-buttons">
                    <button class="btn-primary" id="btnEnroll-${this.containerId}">
                        Iniciar Enrolamiento
                    </button>
                    <button class="btn-secondary" id="btnClear-${this.containerId}">
                        Limpiar
                    </button>
                </div>

                <!-- Instrucciones -->
                <div class="component-instructions">
                    <div class="instruction-item">
                        <span class="instruction-number">1</span>
                        <span class="instruction-text">Ingresa un ID único</span>
                    </div>
                    <div class="instruction-item">
                        <span class="instruction-number">2</span>
                        <span class="instruction-text">Presiona "Iniciar Enrolamiento"</span>
                    </div>
                    <div class="instruction-item">
                        <span class="instruction-number">3</span>
                        <span class="instruction-text">Coloca el dedo 4 veces cuando se solicite</span>
                    </div>
                </div>

                <style>
                    .enrollment-progress {
                        background: #f8f9fa;
                        border: 2px solid #e9ecef;
                        border-radius: 10px;
                        padding: 15px;
                        margin-bottom: 15px;
                    }

                    .progress-header {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        margin-bottom: 10px;
                    }

                    .progress-label {
                        font-weight: 600;
                        color: #495057;
                        font-size: 0.9rem;
                    }

                    .progress-counter {
                        font-weight: 700;
                        color: #667eea;
                        font-size: 1.1rem;
                    }

                    .progress-bar-container {
                        width: 100%;
                        height: 30px;
                        background: #e9ecef;
                        border-radius: 15px;
                        overflow: hidden;
                        position: relative;
                        margin-bottom: 12px;
                        box-shadow: inset 0 2px 4px rgba(0,0,0,0.1);
                    }

                    .progress-bar {
                        height: 100%;
                        background: linear-gradient(90deg, #667eea 0%, #764ba2 100%);
                        border-radius: 15px;
                        transition: width 0.5s ease;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        position: relative;
                    }

                    .progress-percentage {
                        color: white;
                        font-weight: 700;
                        font-size: 0.85rem;
                        text-shadow: 0 1px 2px rgba(0,0,0,0.2);
                    }

                    .progress-samples {
                        display: flex;
                        gap: 10px;
                        justify-content: center;
                    }

                    .sample-indicator {
                        width: 40px;
                        height: 40px;
                        border-radius: 50%;
                        background: #e9ecef;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        font-weight: 700;
                        font-size: 1rem;
                        color: #adb5bd;
                        border: 2px solid #dee2e6;
                        transition: all 0.3s ease;
                    }

                    .sample-indicator.captured {
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        color: white;
                        border-color: #667eea;
                        box-shadow: 0 4px 12px rgba(102, 126, 234, 0.3);
                        transform: scale(1.1);
                    }

                    .sample-indicator.active {
                        background: #fff3cd;
                        color: #856404;
                        border-color: #ffc107;
                        animation: pulse 1.5s infinite;
                    }

                    @keyframes pulse {
                        0%, 100% { transform: scale(1); }
                        50% { transform: scale(1.05); }
                    }
                </style>
            </div>
        `;

        // Referencias a elementos
        this.userIdInput = this.container.querySelector(`#userId-${this.containerId}`);
        this.btnEnroll = this.container.querySelector(`#btnEnroll-${this.containerId}`);
        this.btnClear = this.container.querySelector(`#btnClear-${this.containerId}`);

        // Referencias a elementos de progreso
        this.progressContainer = this.container.querySelector(`#enrollmentProgress-${this.containerId}`);
        this.progressCounter = this.container.querySelector(`#progressCounter-${this.containerId}`);
        this.progressBar = this.container.querySelector(`#progressBar-${this.containerId}`);
        this.progressPercentageEl = this.container.querySelector(`#progressPercentage-${this.containerId}`);
        this.progressSamples = this.container.querySelector(`#progressSamples-${this.containerId}`);

        // Eventos
        this.btnEnroll.onclick = () => this.startEnrollment();
        this.btnClear.onclick = () => this.clear();
        this.userIdInput.oninput = () => this._validateInput();

        this._validateInput();
    }

    /**
     * Actualizar progreso de enrolamiento
     * @param {number} current - Muestra actual (1-4)
     * @param {number} total - Total de muestras (4)
     * @param {number} percentage - Porcentaje de progreso (0-100)
     */
    _updateProgress(current, total, percentage) {
        console.log(`[${this.componentId}] 📊 Actualizando progreso: ${current}/${total} (${percentage}%)`);

        // Guardar estado
        this.currentSample = current;
        this.totalSamples = total;
        this.progressPercentage = percentage;

        // Mostrar contenedor de progreso
        if (this.progressContainer) {
            this.progressContainer.style.display = 'block';
        }

        // Actualizar contador (ej: "2/4")
        if (this.progressCounter) {
            this.progressCounter.textContent = `${current}/${total}`;
        }

        // Actualizar barra de progreso
        if (this.progressBar) {
            this.progressBar.style.width = `${percentage}%`;
        }

        // Actualizar texto de porcentaje
        if (this.progressPercentageEl) {
            this.progressPercentageEl.textContent = `${Math.round(percentage)}%`;
        }

        // Actualizar indicadores de muestras
        if (this.progressSamples) {
            const indicators = this.progressSamples.querySelectorAll('.sample-indicator');
            indicators.forEach((indicator, index) => {
                const sampleNum = index + 1;

                // Limpiar clases anteriores
                indicator.classList.remove('captured', 'active');

                // Marcar como capturada si ya se completó
                if (sampleNum <= current) {
                    indicator.classList.add('captured');
                }
                // Marcar como activa la siguiente muestra que se va a capturar
                else if (sampleNum === current + 1 && current < total) {
                    indicator.classList.add('active');
                }
            });
        }
    }

    /**
     * Validar input del usuario
     */
    _validateInput() {
        const isValid = this.userIdInput.value.trim().length > 0;
        this.btnEnroll.disabled = !isValid || this.isEnrolling;
    }

    /**
     * Iniciar enrolamiento
     */
    async startEnrollment() {
        // Verificar que el lector esté encendido
        if (window.checkReaderOrWarn && !window.checkReaderOrWarn('enrolar')) {
            this.showError('⚠️ Enciende el lector primero desde ReaderControl');
            return;
        }

        this.userId = this.userIdInput.value.trim();

        if (!this.userId) {
            this.showError('Ingresa un ID de usuario válido');
            return;
        }

        try {
            this.isEnrolling = true;
            this._updateUI();

            // Resetear progreso al inicio
            this._updateProgress(0, 4, 0);

            this.showLoading('Iniciando enrolamiento...');

            // Llamar al backend
            const result = await this.adapter.enrollFingerprint(this.userId);

            // IMPORTANTE: Si la API retorna y los eventos SSE no manejaron la finalización,
            // manejarla aquí como respaldo
            if (this.isEnrolling) {
                console.log(`[${this.componentId}] ⚠️ Enrolamiento finalizado por API response (respaldo)`);

                if (result.ok) {
                    this._updateProgress(4, 4, 100);
                    this.showSuccess('✅ Enrolamiento completado exitosamente');
                } else {
                    this.showError(result.error || 'Error en enrolamiento');
                }

                // Finalizar operación
                this.isEnrolling = false;
                this._updateUI();

                // Auto-limpiar después de 3 segundos
                setTimeout(() => this.clear(), 3000);
            }

        } catch (error) {
            this.showError(`Error: ${error.message}`);

            // Solo en caso de error de conexión finalizamos
            this.isEnrolling = false;
            this._updateUI();
        }
    }

    /**
     * Limpiar componente
     */
    clear() {
        super.clear();

        this.userId = '';
        this.isEnrolling = false;
        this.userIdInput.value = '';

        // Resetear progreso
        this.currentSample = 0;
        this.totalSamples = 4;
        this.progressPercentage = 0;

        // Ocultar contenedor de progreso
        if (this.progressContainer) {
            this.progressContainer.style.display = 'none';
        }

        // Resetear elementos de progreso
        if (this.progressCounter) {
            this.progressCounter.textContent = '0/4';
        }
        if (this.progressBar) {
            this.progressBar.style.width = '0%';
        }
        if (this.progressPercentageEl) {
            this.progressPercentageEl.textContent = '0%';
        }

        // Limpiar indicadores de muestras
        if (this.progressSamples) {
            const indicators = this.progressSamples.querySelectorAll('.sample-indicator');
            indicators.forEach(indicator => {
                indicator.classList.remove('captured', 'active');
            });
        }

        this._updateUI();
        this.showInfo('Ingresa el ID del usuario');
    }

    /**
     * Actualizar UI según estado
     */
    _updateUI() {
        this.userIdInput.disabled = this.isEnrolling;
        this.btnEnroll.disabled = this.isEnrolling || !this.userIdInput.value.trim();
        this.btnClear.disabled = this.isEnrolling;

        if (this.isEnrolling) {
            this.btnEnroll.textContent = 'Enrolando...';
        } else {
            this.btnEnroll.textContent = 'Iniciar Enrolamiento';
        }
    }
}

// Registrar globalmente
window.EnrollmentControl = EnrollmentControl;
