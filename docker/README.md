# 🐳 Configuración Docker - Sistema de Asistencia

## ⚠️ Advertencias Importantes

### Limitaciones con Hardware USB
Este proyecto requiere acceso a un lector de huellas dactilares USB (DigitalPersona U.are.U 4500). Docker tiene limitaciones significativas con dispositivos USB:

1. **Windows**: Docker Desktop en Windows no soporta USB passthrough nativamente
2. **Linux**: Posible con `--device` flag pero requiere permisos especiales
3. **macOS**: Soporte limitado para dispositivos USB

### Limitaciones con Electron
Electron requiere un servidor X11 (display) para mostrar la interfaz gráfica, lo cual complica el uso de Docker.

## 📋 Casos de Uso Recomendados

### ✅ Desarrollo/Testing sin Hardware
```bash
docker-compose up
```
Útil para:
- Desarrollo de la interfaz
- Testing de lógica de negocio
- Pruebas de base de datos
- CI/CD pipelines

### ❌ NO Recomendado para
- Producción con lector de huellas real
- Despliegue final de la aplicación
- Registro real de asistencias

## 🚀 Uso Básico

### Construir y ejecutar
```bash
# Construir imagen
docker-compose build

# Iniciar servicios
docker-compose up

# Iniciar en background
docker-compose up -d

# Ver logs
docker-compose logs -f

# Detener servicios
docker-compose down
```

### Ejecutar solo la aplicación principal
```bash
docker-compose up electron-app
```

### Ejecutar con rebuild
```bash
docker-compose up --build
```

## 🔧 Configuración para Acceso USB (Linux)

Si estás en Linux y quieres intentar usar el hardware real:

1. Descomenta las líneas en `docker-compose.yml`:
```yaml
devices:
  - /dev/bus/usb:/dev/bus/usb
privileged: true
```

2. Dar permisos al dispositivo USB:
```bash
# Encontrar el dispositivo
lsusb

# Cambiar permisos (ejemplo)
sudo chmod 666 /dev/bus/usb/001/002
```

3. Instalar udev rules:
```bash
# Crear regla para DigitalPersona
echo 'SUBSYSTEM=="usb", ATTR{idVendor}=="05ba", ATTR{idProduct}=="000a", MODE="0666"' | \
  sudo tee /etc/udev/rules.d/99-digitalpersona.rules

# Recargar reglas
sudo udevadm control --reload-rules
sudo udevadm trigger
```

## 📁 Estructura de Volúmenes

Los siguientes directorios persisten fuera del contenedor:

- `./sistema-asistencia/database`: Base de datos SQLite
- `.:/app`: Código fuente (para desarrollo con hot reload)

## 🌐 Puertos Expuestos

- `3000`: Aplicación Electron (desarrollo)
- `5173`: Vite dev server (si aplica)
- `3001`: Servidor biométrico edge-uru-ui

## 🛠️ Variables de Entorno

Puedes crear un archivo `.env` en la raíz:

```env
NODE_ENV=development
DISPLAY=:99
DATABASE_PATH=/app/sistema-asistencia/database/attendance.db
```

## 🐛 Troubleshooting

### Error: "Cannot open display"
La aplicación Electron necesita un servidor X11. En Linux:
```bash
xhost +local:docker
```

### Error: "USB device not found"
- Verifica permisos del dispositivo USB
- Asegúrate de que Docker tiene acceso a `/dev/bus/usb`
- En Windows, considera usar WSL2 con USB passthrough

### Error: "Database locked"
```bash
# Detener todos los contenedores
docker-compose down

# Eliminar volúmenes
docker-compose down -v

# Reiniciar
docker-compose up
```

## 📦 Alternativas Recomendadas

Para producción con hardware real, se recomienda:

1. **Instalación nativa**: Ejecutar directamente en Windows con Node.js
2. **VM con USB passthrough**: Usar VirtualBox/VMware con soporte USB
3. **Desarrollo híbrido**: Docker para backend, nativo para frontend

## 🔄 Actualizar Contenedores

```bash
# Reconstruir después de cambios en package.json
docker-compose build --no-cache

# Actualizar solo un servicio
docker-compose up -d --build electron-app
```

## 🗑️ Limpieza

```bash
# Eliminar contenedores, redes y volúmenes
docker-compose down -v

# Eliminar imágenes
docker-compose down --rmi all

# Limpieza completa de Docker
docker system prune -a --volumes
```

## 📝 Notas Adicionales

- El backend C# (.NET Framework) **NO** está incluido en Docker ya que es Windows-only
- Para desarrollo completo con biometría, usar instalación nativa en Windows
- Docker es útil principalmente para testing de la lógica de aplicación sin hardware
