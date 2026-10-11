# ElectronJS + Edge-URU-UI - Sistema Biométrico DP4500

Integración limpia de ElectronJS con el engine biométrico Edge-URU-UI para captura, enrolamiento y verificación de huellas dactilares utilizando el lector DP4500.

## Características del Sistema (MVP Producción)

- **Captura e Identificación Continua (Touch Mode)** con FSM de hardware para DigitalPersona DP4500.
- **Precisión en Milisegundos**: Marcas de entrada y salida registradas en formato `HH:MM:SS.mmm` con validación temporal exacta, cálculos de retraso y prevención de doble fichaje (cooldown).
- **Seguridad Robusta de Base de Datos y Kiosco**:
  - Exclusión estricta de archivos `.db`, `.sqlite`, `.bak`, `.dump` en Git.
  - Copias de seguridad automáticas diarias fuera del repositorio (`app.getPath('userData')/backups`) con rotación de 7 días.
  - Protección de operaciones sensibles (exportar respaldo, restaurar BD, reset total) mediante **PIN de Administrador** (hasheado con SHA-256 + pepper).
  - Bloqueo en **Modo Kiosco** que restringe la navegación para terminales desatendidas.
  - Protección de privacidad biométrica: Las plantillas FMD (`template_data`) y los hashes del PIN nunca se transmiten al proceso renderizador.
- **Planificador de Corte Automático de Inasistencias**:
  - Detección en segundo plano según hora configurable y días laborables (`work_days`).
  - Ejecución idempotente con registro de corte diario.
- **Reportería Analítica y Exportación a Excel (.csv)**:
  - Reporte Diario, Semanal, Mensual y por Empleado con exportación directa en formato `.csv` compatible con Excel.
  - Paleta de color neutral y accesible, evitando contrastes saturados y eliminando valores `undefined`.
- **Enrolamiento Multi-Muestra**: Enrolamiento guiado de 4 muestras con validación de calidad.
- **Diagnóstico y Control del Dispositivo**: Modal en vivo con telemetría de firmware, versión de controladores USB y estados de conexión Plug & Play.

## Requisitos Previos

### Hardware
- Lector DigitalPersona U.are.U 4500 (DP4500)
- Puerto USB 2.0 o superior

### Software
- **Node.js**: Versión x86 (32-bit) - v16.x.x o superior
- **.NET Framework**: 4.7.2 o superior
- **Windows**: 7/8/10/11
- **DigitalPersona SDK**: DLLs incluidas en `biometric-engine/bin-deps/`

## Estructura del Proyecto

```
proyecto/
├── biometric-engine/           # Engine biométrico completo (edge-uru-ui)
│   ├── bin-deps/              # DLLs nativas del DP4500
│   ├── bridge-csharp/         # Puente C# .NET
│   ├── node/                  # Servidor Node.js del engine
│   │   ├── public/            # Componentes JavaScript reutilizables
│   │   └── dist/              # Servidor compilado
│   ├── out/net472/            # DLL compilada del bridge
│   └── docs/                  # Documentación del engine
│
├── electron/                   # Aplicación ElectronJS
│   ├── main.ts                # Proceso principal
│   ├── preload.ts             # Preload script
│   └── renderer/              # Proceso renderer
│       └── index.html         # Interfaz principal
│
├── dist/                       # Archivos compilados
├── package.json               # Configuración del proyecto
└── tsconfig.json              # Configuración TypeScript
```

## Instalación

### 1. Instalar Dependencias

```bash
npm install
```

### 2. Compilar el Bridge C#

El bridge C# debe estar compilado para que el sistema funcione. Si aún no está compilado:

```bash
cd biometric-engine/bridge-csharp
msbuild EdgeBridge.csproj /p:Configuration=Release
cd ../..
```

Esto genera:
- `biometric-engine/out/net472/bridge-csharp.dll`
- `biometric-engine/out/net472/DPUruNet.dll`

### 3. Compilar el Servidor del Engine

```bash
cd biometric-engine/node
npm install
npm run build
cd ../..
```

## Uso

### Iniciar la Aplicación

```bash
npm start
```

Esto:
1. Compila el código TypeScript de Electron
2. Inicia la aplicación ElectronJS
3. Inicia automáticamente el servidor biométrico en `http://localhost:8080`
4. Abre la ventana principal con la interfaz

### Modo Desarrollo

```bash
npm run dev
```

Abre la aplicación con DevTools activado.

## Guía de Operación y Uso del Sistema

### 1. Marcaje Continuo de Asistencia (Touch Mode)
El sistema opera en modo continuo sin requerir interacción manual de pantalla:
1. Navega a la vista **"Marcar Asistencia"**.
2. Verifica que el lector figure en estado **"🟢 Activo (Escuchando)"** o **"Listo para marcar"**.
3. El colaborador coloca su dedo sobre el lector DigitalPersona U.are.U 4500.
4. El sistema ejecuta la identificación 1:N contra la memoria RAM en menos de 1 segundo:
   - **Registro de Entrada / Salida**: Registra la marca temporal con precisión de milisegundos (`HH:MM:SS.mmm`).
   - **Prevención de Doble Marcaje**: Cooldown de seguridad de 60 segundos entre marcas para evitar rebotes o toques accidentales.
   - **Retroalimentación**: Sonido de confirmación, foto del empleado y badge de estado (*A tiempo*, *Retardo* o *Salida*).

### 2. Gestión de Empleados y Enrolamiento Biométrico
1. Ingresa a la sección **"Empleados"**.
2. Para dar de alta un nuevo empleado, presiona **"Nuevo Empleado"** y completa los datos (Nombre, Apellido, Código, Departamento, Turno y Foto opcional).
3. En la tabla de empleados, presiona el botón biométrico 🖐️ para registrar sus huellas.
4. Selecciona el dedo a enrolar (ej. Índice Derecho) y sigue el asistente interactivo:
   - Coloca y levanta el dedo 4 veces consecutivas para completar las 4 muestras.
   - La plantilla se genera en formato compatible FMD, se valida su calidad y se almacena cifrada en la base de datos SQLite.

### 3. Reportes de Asistencia y Exportación a Excel
1. Accede a **"Reportes"**.
2. Selecciona la pestaña deseada:
   - **Reporte Diario**: Muestra las entradas, salidas y estatus de la jornada actual.
   - **Reporte Semanal / Mensual**: Estadísticas consolidadas de puntualidad, faltas y tiempo laborado.
   - **Por Empleado**: Historial individual detallado.
3. Presiona **"Exportar a Excel"** para descargar de inmediato un archivo `.csv` compatible con Excel con codificación UTF-8 BOM para caracteres en español.

### 4. Seguridad, Respaldos y Modo Kiosco
1. Ingresa a **"Configuración"**.
2. **PIN de Administrador**: Si está configurado, las operaciones críticas (Exportar copia, Restaurar BD, Restablecer Sistema) solicitarán el PIN de 4 a 8 dígitos protegido por SHA-256.
3. **Modo Kiosco**: Al activarse, bloquea la navegación y el teclado en terminales desatendidas para que los usuarios solo puedan marcar asistencia.
4. **Respaldos de Base de Datos**: Las copias de seguridad automáticas se guardan de forma aislada en el directorio local de la aplicación fuera del repositorio Git.


## Arquitectura Técnica

### Flujo de Datos

```
Electron Main Process
    ↓
Biometric Server (Node.js) :8080
    ↓
Edge.js Bridge
    ↓
C# .NET Bridge
    ↓
DPUruNet SDK
    ↓
DP4500 Hardware
```

### Eventos en Tiempo Real

El sistema usa Server-Sent Events (SSE) para comunicación en tiempo real:

- `READER_READY`: Lector inicializado
- `SAMPLE_COLLECTED`: Muestra capturada (1/4, 2/4, etc.)
- `ENROLLMENT_COMPLETED`: Enrolamiento exitoso
- `VERIFICATION_SUCCESS`: Verificación exitosa
- `IDENTIFICATION_MATCH`: Identificación exitosa

## Componentes del Engine

La interfaz integra los siguientes controles del engine Edge-URU-UI:

- **ReaderControl**: Control de encendido/apagado del lector
- **SimpleCaptureControl**: Captura simple de huellas
- **EnrollmentControl**: Proceso de enrolamiento con 4 muestras
- **VerificationControl**: Verificación 1:1 e Identificación 1:N
- **TemplateManagerControl**: Gestión de plantillas almacenadas
- **LogDeviceControl**: Logs del sistema en tiempo real

Todos los componentes se cargan dinámicamente desde `http://localhost:8080` y son completamente funcionales.

## Solución de Problemas

### Error: "Bridge C# no encontrado"

```bash
cd biometric-engine/bridge-csharp
msbuild EdgeBridge.csproj /p:Configuration=Release
```

### Error: "Servidor biométrico no respondió"

1. Verifica que Node.js x86 (32-bit) esté instalado
2. Compila el servidor del engine:
   ```bash
   cd biometric-engine/node
   npm run build
   ```

### Error: "Lector no detectado"

1. Conecta el lector DP4500 vía USB
2. Verifica que las DLLs estén en `biometric-engine/bin-deps/`
3. Reinicia la aplicación

### Botones deshabilitados

1. Asegúrate de inicializar el lector primero
2. Recarga la aplicación (Ctrl+R en DevTools)

## Scripts Disponibles

- `npm start`: Compilar y ejecutar
- `npm run dev`: Ejecutar en modo desarrollo
- `npm run build`: Solo compilar TypeScript

## Créditos

- **Engine Biométrico**: Edge-URU-UI (devcicm/edge-uru-ui)
- **SDK**: DigitalPersona U.are.U SDK
- **Framework**: ElectronJS

## Licencia

MIT

## Arquitectura y Persistencia

- **Base de Datos SQLite**: Integrada mediante `better-sqlite3` con persistencia permanente en disco de empleados, huellas dactilares, asistencias, departamentos y turnos.
- **Modo Continuo (Touch Mode)**: Escucha continua de huellas para marcaje automático instantáneo 1:N sin selección previa en pantalla.
- **Captura Fotográfica**: Soporte para captura de fotografía facial desde cámara web vinculada al registro del empleado.
- **Analítica de Ausencias y Consultas de Dominio**: Motor de análisis de faltas por períodos/semanas y procesador de preguntas en lenguaje natural sobre asistencia.
- **Reportes y Exportación**: Generación de reportes e impresión directa, así como exportación a formatos CSV (Excel) y PDF.
- **Garantía de Calidad y Seguridad**: Suite de 99 pruebas unitarias y de integración automáticas con WAF perimetral, deserialización segura y verificación continua de contratos Golden Master.

Para documentación completa del engine biométrico, consulta: `biometric-engine/README.md`

