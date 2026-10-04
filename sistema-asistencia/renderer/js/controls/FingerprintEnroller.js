/**
 * FingerprintEnroller - Manejo de progreso en tiempo real para enrollment
 * Basado en EnrollmentControl.js del biometric-engine
 */
export class FingerprintEnroller {
    constructor() {
        this.eventSource = null;
        this.isEnrolling = false;
        this.currentSample = 0;
        this.totalSamples = 4;
        this.capturedImages = []; // Almacenar imágenes capturadas
        this.statusDiv = null;
        this.progressContainer = null;
    }

    /**
     * Conectar a eventos SSE del biometric-engine
     */
    async connectToSSE() {
        if (this.eventSource) {
            console.log('[FingerprintEnroller] Ya conectado al SSE');
            return;
        }

        // Puerto único vía contrato IPC existente (window.config, preload.ts)
        const cfg = await window.config.get();
        this.eventSource = new EventSource(`http://localhost:${cfg.biometricPort}/events`);

        this.eventSource.onopen = () => {
            console.log('[FingerprintEnroller] ✅ Conectado a eventos SSE');
        };

        this.eventSource.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                this.handleEvent(data);
            } catch (e) {
                console.error('[FingerprintEnroller] Error parsing SSE event:', e);
            }
        };

        this.eventSource.onerror = () => {
            console.error('[FingerprintEnroller] Error en conexión SSE');
        };
    }

    /**
     * Manejar eventos del backend
     */
    handleEvent(data) {
        if (!this.isEnrolling) return;

        const eventType = data.eventType || data.evt || '';
        console.log(`[FingerprintEnroller] 📨 Evento: ${eventType}`, data);

        // Eventos que queremos mostrar
        const realtimeEvents = [
            'CAPTURE_STARTED',
            'IMAGE_CAPTURED',
            'SAMPLE_COLLECTED',
            'ENROLLMENT_COMPLETED'
        ];

        if (realtimeEvents.includes(eventType)) {
            const message = data.message || eventType;

            // Actualizar mensaje de estado
            this.updateStatusMessage(message);

            // Actualizar progreso
            if (eventType === 'SAMPLE_COLLECTED' && data.data) {
                const { sampleNumber, totalSamples, progress } = data.data;
                this.updateProgress(sampleNumber, totalSamples, progress || 0);
            }

            // Guardar imagen capturada
            if (eventType === 'IMAGE_CAPTURED' && data.data?.imageBase64) {
                this.capturedImages.push(data.data.imageBase64);
                this.displayLatestImage(data.data.imageBase64);
            }

            // Enrollment completado
            if (eventType === 'ENROLLMENT_COMPLETED') {
                this.updateProgress(4, 4, 100);
            }
        }
    }

    /**
     * Iniciar enrollment con progreso visual
     */
    startEnrollment(statusDiv) {
        this.statusDiv = statusDiv;
        this.isEnrolling = true;
        this.currentSample = 0;
        this.capturedImages = [];

        // Conectar a SSE si no está conectado
        if (!this.eventSource) {
            this.connectToSSE();
        }

        // Crear UI de progreso
        this.createProgressUI();
    }

    /**
     * Crear UI de progreso
     */
    createProgressUI() {
        this.statusDiv.innerHTML = `
            <div class="enrollment-progress-container">
                <!-- Barra de progreso -->
                <div class="progress-header">
                    <span class="progress-label">Progreso de Captura</span>
                    <span class="progress-counter" id="progress-counter">0/4</span>
                </div>
                <div class="progress-bar-container">
                    <div class="progress-bar" id="progress-bar" style="width: 0%;">
                        <span class="progress-percentage" id="progress-percentage">0%</span>
                    </div>
                </div>
                <div class="progress-samples" id="progress-samples">
                    <span class="sample-indicator" data-sample="1">1</span>
                    <span class="sample-indicator" data-sample="2">2</span>
                    <span class="sample-indicator" data-sample="3">3</span>
                    <span class="sample-indicator" data-sample="4">4</span>
                </div>

                <!-- Imagen de huella -->
                <div class="fingerprint-image-preview" id="fingerprint-image">
                    <div class="image-placeholder">👆</div>
                </div>

                <!-- Mensaje de estado -->
                <div class="status-message" id="status-message">
                    <p style="color: #3B82F6; font-weight: 600;">Iniciando captura...</p>
                    <p style="color: #6B7280; font-size: 13px;">Coloque el dedo en el lector</p>
                </div>
            </div>

            <style>
                .enrollment-progress-container {
                    padding: 20px;
                    text-align: center;
                }

                .progress-header {
                    display: flex;
                    justify-content: space-between;
                    margin-bottom: 10px;
                }

                .progress-label {
                    font-weight: 600;
                    color: #495057;
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
                    margin-bottom: 15px;
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
                }

                .progress-percentage {
                    color: white;
                    font-weight: 700;
                    font-size: 0.85rem;
                }

                .progress-samples {
                    display: flex;
                    gap: 10px;
                    justify-content: center;
                    margin-bottom: 20px;
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

                .fingerprint-image-preview {
                    width: 200px;
                    height: 220px;
                    margin: 20px auto;
                    border: 2px dashed #ccc;
                    border-radius: 10px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    background: #f8f9fa;
                }

                .fingerprint-image-preview img {
                    max-width: 100%;
                    max-height: 100%;
                    object-fit: contain;
                }

                .image-placeholder {
                    font-size: 48px;
                    opacity: 0.3;
                }

                .status-message {
                    margin-top: 15px;
                }
            </style>
        `;
    }

    /**
     * Actualizar progreso
     */
    updateProgress(current, total, percentage) {
        console.log(`[FingerprintEnroller] 📊 Progreso: ${current}/${total} (${percentage}%)`);

        this.currentSample = current;
        this.totalSamples = total;

        // Actualizar contador
        const counter = document.getElementById('progress-counter');
        if (counter) {
            counter.textContent = `${current}/${total}`;
        }

        // Actualizar barra
        const bar = document.getElementById('progress-bar');
        if (bar) {
            bar.style.width = `${percentage}%`;
        }

        // Actualizar porcentaje
        const percentageEl = document.getElementById('progress-percentage');
        if (percentageEl) {
            percentageEl.textContent = `${Math.round(percentage)}%`;
        }

        // Actualizar indicadores de muestras
        const samples = document.querySelectorAll('.sample-indicator');
        samples.forEach((indicator, index) => {
            const sampleNum = index + 1;
            indicator.classList.remove('captured', 'active');

            if (sampleNum <= current) {
                indicator.classList.add('captured');
            } else if (sampleNum === current + 1 && current < total) {
                indicator.classList.add('active');
            }
        });
    }

    /**
     * Actualizar mensaje de estado
     */
    updateStatusMessage(message) {
        const statusMsg = document.getElementById('status-message');
        if (statusMsg) {
            statusMsg.innerHTML = `
                <p style="color: #3B82F6; font-weight: 600;">${message}</p>
                <p style="color: #6B7280; font-size: 13px;">Muestra ${this.currentSample + 1} de ${this.totalSamples}</p>
            `;
        }
    }

    /**
     * Mostrar última imagen capturada
     */
    displayLatestImage(imageBase64) {
        const imageContainer = document.getElementById('fingerprint-image');
        if (imageContainer && imageBase64) {
            imageContainer.innerHTML = `<img src="data:image/png;base64,${imageBase64}" alt="Huella capturada">`;
        }
    }

    /**
     * Finalizar enrollment
     */
    finishEnrollment(success, message) {
        this.isEnrolling = false;

        if (success) {
            this.statusDiv.innerHTML = `
                <div style="text-align: center; padding: 20px;">
                    <div style="font-size: 48px; color: #10B981; margin-bottom: 10px;">✓</div>
                    <p style="color: #10B981; font-weight: 600;">${message || '¡Huella registrada exitosamente!'}</p>
                </div>
            `;
        } else {
            this.statusDiv.innerHTML = `
                <div style="text-align: center; padding: 20px;">
                    <div style="font-size: 48px; color: #EF4444; margin-bottom: 10px;">✗</div>
                    <p style="color: #EF4444; font-weight: 600;">${message || 'Error al registrar huella'}</p>
                </div>
            `;
        }
    }

    /**
     * Desconectar SSE
     */
    disconnect() {
        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
            console.log('[FingerprintEnroller] Desconectado del SSE');
        }
    }
}
