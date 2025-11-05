const $ = (q: string) => document.querySelector(q)! as HTMLElement;
const img = () => document.getElementById('fpimg') as HTMLImageElement;
const fmd = () => document.getElementById('fmd') as HTMLTextAreaElement;
const tplId = () => document.getElementById('tplId') as HTMLInputElement;
const statusIndicator = () => document.getElementById('statusIndicator') as HTMLElement;
const statusText = () => document.getElementById('statusText') as HTMLElement;
const placeholder = () => document.getElementById('placeholder') as HTMLElement;

const log = (m: string) => {
  const el = $('#log');
  const timestamp = new Date().toLocaleTimeString();
  el.textContent += `[${timestamp}] ${m}\n`;
  el.scrollTop = el.scrollHeight;
};

const setStatus = (status: 'disconnected' | 'connected' | 'working', text: string) => {
  const indicator = statusIndicator();
  const textEl = statusText();

  indicator.className = `status-indicator status-${status}`;
  textEl.textContent = text;
};

const setButtonsEnabled = (init: boolean, capture: boolean, enroll: boolean, verify: boolean, cancel: boolean, dispose: boolean) => {
  ($('#bInit') as HTMLButtonElement).disabled = !init;
  ($('#bCapture') as HTMLButtonElement).disabled = !capture;
  ($('#bEnroll') as HTMLButtonElement).disabled = !enroll;
  ($('#bVerify') as HTMLButtonElement).disabled = !verify;
  ($('#bCancel') as HTMLButtonElement).disabled = !cancel;
  ($('#bDispose') as HTMLButtonElement).disabled = !dispose;
};

const showFingerprintImage = (base64: string) => {
  const imgEl = img();
  const placeholderEl = placeholder();

  imgEl.src = `data:image/png;base64,${base64}`;
  imgEl.style.display = 'block';
  placeholderEl.style.display = 'none';
};

const hideFingerprintImage = () => {
  const imgEl = img();
  const placeholderEl = placeholder();

  imgEl.style.display = 'none';
  placeholderEl.style.display = 'block';
};

let lastBytes = 0;
let isInitialized = false;

window.addEventListener('DOMContentLoaded', () => {
  log('Aplicación iniciada');
  setStatus('disconnected', 'Desconectado');
  setButtonsEnabled(true, false, false, false, false, false);

  // Verificar si window.fp está disponible
  if (typeof window.fp === 'undefined') {
    log('ERROR: window.fp no está definido. Verifica el preload script.');
    return;
  }

  $('#bInit').addEventListener('click', async () => {
    if (isInitialized) return;

    try {
      setStatus('working', 'Inicializando...');
      setButtonsEnabled(false, false, false, false, false, false);

      await window.fp.init();
      log('✅ Inicialización exitosa');
      isInitialized = true;

      // Mostrar información del lector incluyendo GUID
      try {
        const info = await window.fp.getReaderInfo();
        if (info.ok) {
          log(`📱 Lector: ${info.description || 'Unknown'}`);
          log(`🆔 GUID: ${info.guid || 'Unknown'}`);
          log(`📊 Serie: ${info.serialNumber || 'Unknown'}`);
          setStatus('connected', 'Conectado');
        } else {
          log(`❌ Error obteniendo info: ${info.error}`);
        }
      } catch (e: any) {
        log('⚠️ Error mostrando info del lector: ' + e.message);
      }

      setButtonsEnabled(false, true, true, true, true, true);
    } catch (e: any) {
      log('❌ Error de inicialización: ' + e.message);
      setStatus('disconnected', 'Error de conexión');
      setButtonsEnabled(true, false, false, false, false, false);
    }
  });

  $('#bCapture').addEventListener('click', async () => {
    if (!isInitialized) return;

    try {
      setStatus('working', 'Capturando huella...');
      setButtonsEnabled(false, false, false, false, true, false);
      log('📸 Iniciando captura (3 intentos)...');

      const res = await window.fp.capture3();
      if (!res.ok) {
        log('❌ Error en captura: ' + (res.error || 'captura fallida'));
        setStatus('connected', 'Conectado');
        setButtonsEnabled(false, true, true, true, true, true);
        return;
      }

      if (res.pngB64) {
        showFingerprintImage(res.pngB64);
      }
      if (res.fmdXml) {
        fmd().value = res.fmdXml;
      }

      $('#q').textContent = lastBytes.toString();
      log(`✅ Captura exitosa (${res.attempts} intentos)`);
      setStatus('connected', 'Conectado');
      setButtonsEnabled(false, true, true, true, true, true);
    } catch (e: any) {
      log('❌ Error: ' + e.message);
      setStatus('connected', 'Conectado');
      setButtonsEnabled(false, true, true, true, true, true);
    }
  });

  $('#bEnroll').addEventListener('click', async () => {
    if (!isInitialized) return;

    try {
      const id = tplId().value.trim();
      if (!id) {
        log('⚠️ Introduce un ID antes de enrolar');
        return;
      }

      setStatus('working', 'Enrolando...');
      setButtonsEnabled(false, false, false, false, true, false);
      log(`📝 Iniciando enrolamiento para ID: ${id}...`);

      const xml = await window.fp.enrollSave(id, 4);
      log(`✅ Enrolado y guardado: ${id} (${xml.length} chars)`);
      setStatus('connected', 'Conectado');
      setButtonsEnabled(false, true, true, true, true, true);
    } catch (e: any) {
      log('❌ Error en enrolamiento: ' + e.message);
      setStatus('connected', 'Conectado');
      setButtonsEnabled(false, true, true, true, true, true);
    }
  });

  $('#bVerify').addEventListener('click', async () => {
    if (!isInitialized) return;

    try {
      const id = tplId().value.trim();
      const live = fmd().value.trim();
      if (!id || !live) {
        log('⚠️ Necesitas ID y datos FMD para verificar');
        return;
      }

      setStatus('working', 'Verificando...');
      setButtonsEnabled(false, false, false, false, true, false);
      log(`🔍 Verificando ID: ${id}...`);

      const v = await window.fp.verifyWithStore(id, live, 100000);
      const result = v.matched ? '✅ COINCIDE' : '❌ NO COINCIDE';
      log(`${result} - Score: ${v.score}, Umbral: ${v.threshold}`);
      setStatus('connected', 'Conectado');
      setButtonsEnabled(false, true, true, true, true, true);
    } catch (e: any) {
      log('❌ Error en verificación: ' + e.message);
      setStatus('connected', 'Conectado');
      setButtonsEnabled(false, true, true, true, true, true);
    }
  });

  $('#bCancel').addEventListener('click', async () => {
    try {
      await window.fp.cancel();
      log('🚫 Operación cancelada');
      setStatus('connected', 'Conectado');
      setButtonsEnabled(false, true, true, true, true, true);
    } catch (e: any) {
      log('⚠️ Error al cancelar: ' + e.message);
    }
  });

  $('#bDispose').addEventListener('click', async () => {
    try {
      await window.fp.dispose();
      log('🔌 Dispositivo desconectado');
      setStatus('disconnected', 'Desconectado');
      setButtonsEnabled(true, false, false, false, false, false);
      isInitialized = false;
      hideFingerprintImage();
      fmd().value = '';
      $('#q').textContent = 'Sin datos';
    } catch (e: any) {
      log('⚠️ Error al desconectar: ' + e.message);
    }
  });

  window.fp.onEvent((evt: any) => {
    if (evt.type === 'finger-captured') {
      lastBytes = evt.bytes ?? 0;
      if (evt.pngB64) {
        showFingerprintImage(evt.pngB64);
      }
      $('#q').textContent = String(lastBytes);
      log(`🔄 Intento ${evt.attempt}: ${lastBytes} bytes`);
    } else if (evt.type === 'ready') {
      log('🚀 Sistema listo');
    } else if (evt.type === 'error') {
      log(`❌ Error del dispositivo: ${evt.msg}`);
    } else if (evt.type === 'verify-done') {
      const result = evt.matched ? '✅ VERIFICADO' : '❌ RECHAZADO';
      log(`${result} (Score: ${evt.score}, Umbral: ${evt.threshold})`);
    } else {
      log(`📡 Evento: ${JSON.stringify(evt)}`);
    }
  });

  // Limpiar log inicial después de un momento
  setTimeout(() => {
    if (!isInitialized) {
      log('💡 Presiona "Inicializar" para conectar el dispositivo');
    }
  }, 1000);
});