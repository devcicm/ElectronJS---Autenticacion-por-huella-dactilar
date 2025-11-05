# 🔐 ElectronJS - Autenticación por Huella Dactilar

Sistema de autenticación biométrica usando **Electron** + **.NET 8** + **DigitalPersona U.are.U 4500**

## 🏗️ **Arquitectura del Proyecto**

```
📦 ElectronJS - Autenticacion por huella dactilar/
├── 📂 src/                          # 💻 Código fuente Electron/TypeScript
│   ├── main.ts                     # Proceso principal de Electron
│   ├── preload.ts                  # Bridge IPC seguro
│   ├── renderer.ts                 # Lógica del renderizador
│   └── types/global.d.ts           # Definiciones de tipos
├── 📂 static/                       # 🌐 Interfaz web moderna
│   └── index.html                  # UI principal con diseño moderno
├── 📂 dotnet/Dp4500Net8Bridge/     # 🔧 Wrapper .NET 8 (ACTIVO)
│   ├── EdgeUruBridge.cs            # Bridge para electron-edge-js
│   ├── AdvancedDp4500Service.cs    # Algoritmos avanzados
│   ├── AdvancedFingerprintStore.cs # Store thread-safe
│   └── libs/                       # DLLs nativas DigitalPersona
├── 📂 dist/                         # 📦 Código compilado
├── 📂 archive/                      # 📚 Archivos de referencia
│   └── DP4500-DPURUNET-DLL-REFERENCE/  # Código fuente original
└── 📄 build-dotnet8.bat            # 🛠️ Script de construcción
```

## 🚀 **Instalación y Uso**

### **Prerequisitos**
- **Node.js** 18+
- **.NET 8 SDK**
- **Sensor DigitalPersona U.are.U 4500** conectado

### **1. Instalar Dependencias**
```bash
npm install
```

### **2. Construir el Proyecto**
```bash
# Usar script automático (recomendado)
build-dotnet8.bat

# O manualmente:
cd dotnet/Dp4500Net8Bridge
dotnet build --configuration Debug
cd ../..
npm run build
```

### **3. Ejecutar la Aplicación**
```bash
npm start
```

## 💡 **Funcionalidades**

### **🎯 Funciones Principales**
- **Inicialización** del sensor con calibración automática
- **Captura** de huellas con hasta 3 intentos
- **Enrolamiento** multi-estrategia (5 algoritmos de fallback)
- **Verificación** 1:1 robusta con comparación de fallback
- **Identificación** 1:N con ranking y TOP-K matches

### **🧠 Algoritmos Avanzados**
- **Fix para score=Int32.MaxValue** (problema conocido de DigitalPersona)
- **Enrolamiento con validación cruzada** entre muestras
- **Comparación VER→ANSI fallback** automática
- **Selección de mejor tríada** para enrolamiento óptimo
- **Calibración automática** del sensor

### **📊 Store Avanzado**
- **Thread-safe** para acceso concurrente
- **Metadatos SHA1** para verificación de integridad
- **TTL configurable** con expiración automática
- **Múltiples formatos** (PRE/VER/ANSI/REG)

## 🔌 **API del Frontend**

### **Funciones Básicas (Compatibles)**
```typescript
// Inicializar sensor
await window.fp.init()

// Capturar huella (3 intentos)
const capture = await window.fp.capture3()

// Enrolar y guardar template
const template = await window.fp.enrollSave(id, samples)

// Verificar contra template almacenado
const result = await window.fp.verifyWithStore(id, liveFmdXml, farDenominator)

// Información del sensor
const info = await window.fp.getReaderInfo()
```

### **Funciones Avanzadas (Nuevas)**
```typescript
// Identificación 1:N en galería
const result = await window.fp.identify1N(targetFarn, topK)

// Enrolamiento multi-estrategia
const result = await window.fp.enrollAdvanced(samples, targetFarn, maxRetries)

// Verificación en vivo optimizada
const result = await window.fp.verifyLive(templateXml, targetFarn)

// Captura con todos los formatos
const result = await window.fp.singleCapture()

// Listar templates almacenados
const result = await window.fp.storeList()
```

## 🎨 **Interfaz de Usuario**

La aplicación incluye una **interfaz web moderna** con:
- **Diseño responsivo** con CSS Grid
- **Estados visuales** (desconectado/conectado/trabajando)
- **Visualización de huellas** capturadas
- **Log en tiempo real** de todas las operaciones
- **Controles intuitivos** para cada función

## 📈 **Ventajas vs Versión Anterior**

| Característica | .NET Framework | .NET 8 |
|---------------|---------------|---------|
| **Runtime** | .NET FX 4.x | .NET 8 |
| **Algoritmos** | Básicos | Multi-estrategia |
| **Enrolamiento** | 1 estrategia | 5 estrategias |
| **Comparación** | Con bugs conocidos | Robusta con fallback |
| **Identificación** | Solo 1:1 | 1:1 + 1:N |
| **Store** | TTL simple | Thread-safe + SHA1 |
| **Rendimiento** | Estándar | Optimizado |

## 🛠️ **Scripts Disponibles**

```bash
# Construcción completa
build-dotnet8.bat

# Solo TypeScript
npm run build

# Ejecutar aplicación
npm start

# Limpiar archivos obsoletos
cleanup-obsolete.bat
```

## 📚 **Archivos de Referencia**

El código fuente original del **DP4500 DPURUNET DLL** se mantiene en:
- `archive/DP4500-DPURUNET-DLL-REFERENCE/`

Este contiene la implementación completa de 787 líneas con todos los algoritmos avanzados que han sido integrados en la nueva solución .NET 8.

## 🔒 **Seguridad**

- **Aislamiento de contexto** habilitado
- **Comunicación IPC segura** entre procesos
- **Sin integración directa** de Node.js en el renderizador
- **Validación de entrada** en todas las operaciones
- **Manejo robusto de errores** y timeouts

## 🐛 **Solución de Problemas**

### **Error: Bridge no inicializado**
- Verificar que .NET 8 Runtime esté instalado
- Ejecutar `build-dotnet8.bat` para reconstruir

### **Error: Sensor no encontrado**
- Verificar conexión del sensor DigitalPersona U.are.U 4500
- Instalar drivers oficiales de DigitalPersona

### **Error de compilación**
- Ejecutar `npm install` para reinstalar dependencias
- Verificar que .NET 8 SDK esté instalado

## 📄 **Licencia**

MIT License - Ver archivo LICENSE para más detalles.

---

**Desarrollado con ❤️ usando Electron + .NET 8 + DigitalPersona SDK**