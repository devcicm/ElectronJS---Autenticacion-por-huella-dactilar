# 🏢 Demo - Sistema de Control de Asistencia con Huella Dactilar

Demo de sistema de control de empleados con autenticación biométrica usando el lector **DigitalPersona U.are.U 4500**.

## 🎯 Características del Demo

- ✅ **Gestión de Empleados**: CRUD completo de empleados
- ✅ **Enrolamiento Biométrico**: Registro de huellas dactilares (hasta 10 dedos por empleado)
- ✅ **Control de Asistencia**: Registro automático de entrada/salida
- ✅ **Base de Datos SQLite**: Almacenamiento local persistente
- ✅ **Interfaz Moderna**: Aplicación Electron con diseño responsivo
- ✅ **Eventos en Tiempo Real**: Actualización instantánea de estado

## 📋 Requisitos Previos

### Hardware
- **Lector DP4500**: DigitalPersona U.are.U 4500 conectado vía USB
- **Sistema Operativo**: Windows 7/8/10/11

### Software
- **Node.js**: Versión 18+ (32-bit recomendado para edge.js)
- **.NET Framework**: 4.7.2 o superior
- **SDK DigitalPersona**: DLLs nativas del lector

## 🚀 Instalación

### 1. Clonar el Repositorio

```bash
git clone <tu-repositorio>
cd "ElectronJS - Autenticacion por huella dactilar"
```

### 2. Instalar Dependencias

```bash
# Dependencias del proyecto principal
npm install

# Dependencias del engine biométrico
cd biometric-engine/node
npm install
cd ../..
```

### 3. Compilar el Proyecto

```bash
npm run build
```

### 4. Compilar el Bridge C# (si es necesario)

```bash
cd biometric-engine/bridge-csharp
dotnet build --configuration Release
cd ../..
```

### 5. Verificar DLLs Nativas

Asegúrate de que las DLLs estén en `biometric-engine/bin-deps/`:
- `DPUruNet.dll`
- `dpfpdd.dll`
- `dpfj.dll`
- `DPCtlUruNet.dll`

## 🎮 Modo de Uso

### Opción 1: Demo Rápido (Sin Lector Físico)

Si no tienes el lector físico conectado, puedes ejecutar el demo sin funcionalidad biométrica:

```bash
npm start
```

La aplicación se iniciará con:
- ✅ Base de datos SQLite funcional
- ✅ API REST para gestión de empleados
- ✅ Interfaz de usuario completa
- ⚠️ Sin funciones biométricas (requiere lector)

### Opción 2: Demo Completo (Con Lector DP4500)

Para usar todas las funcionalidades incluyendo el lector biométrico:

**Terminal 1** - Servidor Biométrico:
```bash
cd biometric-engine/node
npm start
```

Esto iniciará el servidor biométrico en `http://localhost:8080`

**Terminal 2** - Aplicación Electron:
```bash
npm start
```

Esto iniciará:
- Aplicación Electron
- API REST interna en `http://localhost:3001`
- Base de datos SQLite

### Opción 3: Modo Desarrollo con Datos de Prueba

```bash
npm run dev -- --seed
```

Esto insertará empleados de ejemplo en la base de datos.

## 📊 Estructura de la Aplicación

```
📦 Demo Sistema de Asistencia
├── 📂 src/                      # Código fuente TypeScript
│   ├── main.ts                  # Proceso principal Electron
│   ├── preload.ts               # Bridge IPC seguro
│   ├── database.ts              # Servicio de base de datos SQLite
│   └── types/global.d.ts        # Definiciones TypeScript
│
├── 📂 static/                   # Interfaz web
│   └── index.html               # UI principal
│
├── 📂 biometric-engine/         # Engine biométrico (edge-uru-ui)
│   ├── node/                    # Servidor Node.js + TypeScript
│   │   ├── server.ts            # API biométrica
│   │   └── public/              # Interfaz web del lector
│   ├── bridge-csharp/           # Bridge C# + .NET Framework
│   │   └── src/                 # Código fuente C#
│   └── bin-deps/                # DLLs nativas DigitalPersona
│
├── 📂 dist/                     # Código compilado
└── 📄 attendance.db             # Base de datos SQLite (generada automáticamente)
```

## 🗄️ Base de Datos

La aplicación utiliza **SQLite** con las siguientes tablas:

### `employees`
- id, employee_code, first_name, last_name
- email, position, department
- photo_url, is_active, created_at

### `fingerprints`
- id, employee_id, tag, hand, finger
- template (base64), format, enrolled_at

### `attendance_records`
- id, employee_id, record_type (ENTRY/EXIT)
- recorded_at, finger_used, notes

## 🔌 API REST Interna

La aplicación expone una API REST en `http://localhost:3001`:

### Empleados
- `GET /api/employees` - Listar todos los empleados
- `GET /api/employees/:id` - Obtener empleado por ID
- `POST /api/employees` - Crear nuevo empleado
- `PUT /api/employees/:id` - Actualizar empleado
- `DELETE /api/employees/:id` - Eliminar empleado

### Huellas Dactilares
- `GET /api/employees/:id/fingerprints` - Huellas de un empleado
- `POST /api/fingerprints` - Guardar huella

### Asistencia
- `GET /api/attendance/today` - Registros de hoy
- `GET /api/attendance/employee/:id` - Historial de un empleado
- `POST /api/attendance/clock` - Registrar entrada/salida

### Estadísticas
- `GET /api/stats` - Estadísticas generales

## 🖥️ API IPC (Electron)

La interfaz web puede usar directamente las APIs IPC:

```javascript
// Obtener todos los empleados
const employees = await window.employees.getAll();

// Crear nuevo empleado
const id = await window.employees.create({
  employeeCode: 'EMP001',
  firstName: 'Juan',
  lastName: 'Pérez',
  email: 'juan@empresa.com',
  position: 'Desarrollador',
  isActive: true
});

// Obtener estadísticas
const stats = await window.stats.get();
console.log(stats); // { totalEmployees, todayAttendance, totalFingerprints }

// Configuración
const config = await window.config.get();
console.log(config); // { expressPort: 3001, biometricPort: 8080 }
```

## 🔐 Flujo de Uso del Lector Biométrico

### 1. Enrolar Empleado

```javascript
// Desde el biometric-engine en http://localhost:8080
// Usar la interfaz web o la API:

// 1. Inicializar lector
await fetch('http://localhost:8080/api/init', { method: 'POST' });

// 2. Enrolar huella
const response = await fetch('http://localhost:8080/api/enroll', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    tag: 'EMP001_LEFT_THUMB',
    maxSamples: 4
  })
});

const result = await response.json();

// 3. Guardar en base de datos del demo
await window.fingerprints.create({
  employeeId: 1,
  tag: 'EMP001_LEFT_THUMB',
  hand: 'LEFT',
  finger: 'THUMB',
  template: result.template,
  format: 'DP_REGISTRATION'
});
```

### 2. Identificar Empleado

```javascript
// Identificar huella en el lector
const response = await fetch('http://localhost:8080/api/identify', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    targetFarn: 21474,
    maxAttempts: 3
  })
});

const result = await response.json();

if (result.ok && result.matched) {
  // Extraer código de empleado del tag
  const tag = result.user.tag; // Ej: "EMP001_LEFT_THUMB"
  const employeeCode = tag.split('_')[0];

  // Registrar asistencia
  const attendance = await fetch('http://localhost:3001/api/attendance/clock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      employeeCode,
      fingerUsed: tag
    })
  });

  const attendanceResult = await attendance.json();
  console.log(attendanceResult);
  // { ok: true, record: {...}, employee: {...} }
}
```

## 🧪 Testing sin Lector Físico

Para probar la aplicación sin el lector:

1. Iniciar solo la aplicación Electron:
   ```bash
   npm start
   ```

2. Usar la consola del desarrollador (F12):
   ```javascript
   // Crear empleado de prueba
   const id = await window.employees.create({
     employeeCode: 'TEST001',
     firstName: 'Test',
     lastName: 'Usuario',
     isActive: true
   });

   // Simular registro de asistencia directamente
   const response = await fetch('http://localhost:3001/api/attendance/clock', {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({
       employeeCode: 'TEST001',
       fingerUsed: 'TEST001_LEFT_THUMB',
       notes: 'Registro manual de prueba'
     })
   });

   console.log(await response.json());
   ```

## 📝 Scripts Disponibles

```bash
# Compilar TypeScript
npm run build

# Iniciar aplicación
npm start

# Modo desarrollo (abre DevTools)
npm run dev

# Modo desarrollo con datos de prueba
npm run dev -- --seed
```

## 🐛 Solución de Problemas

### Error: "Cannot find module 'better-sqlite3'"
```bash
npm install
```

### Error: "Lector no encontrado"
- Verifica que el DP4500 esté conectado
- Instala los drivers de DigitalPersona
- Ejecuta el servidor biométrico: `cd biometric-engine/node && npm start`

### Error: "Port 3001 already in use"
- Cierra otras instancias de la aplicación
- Cambia el puerto en `src/main.ts` (constante `EXPRESS_PORT`)

### Base de datos bloqueada
```bash
# Eliminar la base de datos y comenzar de nuevo
rm attendance.db
npm start
```

## 📸 Capturas de Pantalla

_(Aquí puedes agregar capturas de tu interfaz cuando esté lista)_

## 🎯 Siguientes Pasos para Producción

1. **Interfaz Web Mejorada**: Crear UI personalizada para tu caso de uso
2. **Reportes**: Implementar generación de reportes PDF/Excel
3. **Horarios**: Sistema de horarios de trabajo
4. **Notificaciones**: Alertas de tardanzas
5. **Seguridad**: Autenticación de administradores
6. **Exportación**: Backup y restauración de datos

## 📄 Licencia

MIT License

## 🤝 Soporte

Para más información sobre el engine biométrico, consulta:
- [edge-uru-ui README](./biometric-engine/README.md)
- [Documentación DigitalPersona SDK](./biometric-engine/docs/)

---

**Desarrollado como demo para mostrar capacidades de integración biométrica**
