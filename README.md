# ElectronJS + Edge-URU-UI - Sistema Biométrico DP4500

Integración limpia de ElectronJS con el engine biométrico Edge-URU-UI para captura, enrolamiento y verificación de huellas dactilares utilizando el lector DP4500.

## Características

- Integración completa del engine biométrico Edge-URU-UI
- Interfaz de usuario moderna con controles reutilizables
- Inicio automático del servidor biométrico
- Captura simple de huellas
- Enrolamiento con 4 muestras
- Verificación 1:1 e Identificación 1:N
- Gestión de plantillas biométricas
- Logs en tiempo real

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

## Guía de Uso de la Interfaz

### 1. Inicializar el Lector

**IMPORTANTE**: Antes de cualquier operación biométrica, debes inicializar el lector:

1. En la sección "Control del Lector"
2. Presiona "Encender Lector"
3. Espera el mensaje: "✅ Lector DP4500 listo"

### 2. Captura Simple

Para capturar una huella sin enrolarla:

1. Sección "Captura Simple"
2. Presiona "Capturar"
3. Coloca el dedo en el lector
4. La imagen de la huella aparecerá en pantalla

### 3. Enrolamiento

Para registrar un nuevo usuario:

1. Sección "Enrolamiento"
2. Ingresa un ID de usuario (ej: "Juan_Perez")
3. Presiona "Iniciar Enrolamiento"
4. Coloca el mismo dedo 4 veces cuando se solicite
5. El sistema mostrará el progreso: 1/4 → 2/4 → 3/4 → 4/4
6. Mensaje final: "✅ Enrolamiento completado"

### 4. Verificación 1:1

Para verificar si una huella pertenece a un usuario específico:

1. Sección "Verificación"
2. Selecciona un usuario de la lista
3. Presiona "Verificar Usuario Seleccionado"
4. Coloca el dedo en el lector
5. Resultado: ✅ VERIFICADO o ❌ NO COINCIDE

### 5. Identificación 1:N

Para identificar a qué usuario pertenece una huella:

1. Sección "Verificación" → Tab "Identificación 1:N"
2. Presiona "Identificar 1:N"
3. Coloca el dedo en el lector
4. El sistema busca en toda la galería
5. Resultado: Usuario identificado con score de coincidencia

### 6. Gestión de Plantillas

Para ver todas las huellas almacenadas:

1. Sección "Plantillas"
2. Presiona "Refrescar"
3. Se muestran todas las plantillas con:
   - Tag (ID del usuario)
   - Formato
   - Tamaño
   - Fecha de creación

**Limpiar todas las plantillas**:
- Presiona "Limpiar Todo"
- Confirma la acción
- Todas las huellas serán eliminadas

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

## Notas Importantes

- El sistema NO incluye base de datos - las plantillas se almacenan en RAM
- Al cerrar la aplicación, se pierden todas las plantillas enroladas
- Para almacenamiento permanente, implementa integración con base de datos externa
- El sistema está listo para agregar funcionalidad de control de asistencia en el futuro

## Próximos Pasos

Una vez que el sistema de captura esté funcionando correctamente, se puede:

1. Agregar base de datos SQLite para almacenamiento permanente
2. Implementar sistema de control de asistencia
3. Agregar gestión de empleados
4. Crear reportes de asistencia
5. Integrar con sistemas externos

Para documentación completa del engine, consulta: `biometric-engine/README.md`
