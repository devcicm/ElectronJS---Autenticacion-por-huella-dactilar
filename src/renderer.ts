// Renderer process
// Este archivo se cargará en la ventana de Electron y tendrá acceso a las APIs expuestas por preload.ts

console.log('🚀 Renderer process iniciado');

// Verificar que las APIs están disponibles
if (window.employees) {
  console.log('✅ API de empleados disponible');
}

if (window.stats) {
  console.log('✅ API de estadísticas disponible');
}

if (window.config) {
  console.log('✅ API de configuración disponible');
}

// La lógica de la interfaz se implementará en static/index.html
// Este archivo es solo un placeholder para el proceso renderer
