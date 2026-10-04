# Bugs detectados (no arreglados en el refactor)

Principio rector: mezclar fixes con refactor rompe la trazabilidad del barco de Teseo. Estos hallazgos cambian C(P) y se registran para un changeset separado.

| # | Ubicación | Descripción | Relacionado con | Urgencia | Por qué no se arregló aquí |
|---|---|---|---|---|---|
| 1 | biometric-engine/node/server.ts (×14 handlers) | Errores internos se filtran al cliente: `500 {ok:false, error:String(e)}` expone mensajes de edge-js/DLL/rutas. endurecer = cambiar body observable | BE-19 | alta | Cambia C(P) congelado en gm1-http-api.json; requiere decisión de contrato de error |
| 2 | app.js:192,484 + controles engine con datos de usuario | Interpolación de nombres/emails/tags de empleado en `innerHTML` sin escape → XSS si un nombre contiene HTML (los empleados se crean por formulario sin sanitizar) | FE-15 | alta | Escapar cambia la salida observable ante input hostil: es FIX, no refactor puro |
| 3 | biometric-engine/node/server.ts:460 | `app.listen(8080)` bind en todas las interfaces (0.0.0.0): API biométrica sin autenticación accesible desde la LAN (enroll/identify/delete store) | BE-18-adjacente | alta | Añadir auth/bind-local cambia contrato de red observable; decisión de arquitectura, no refactor |
| 4 | electron/main.ts:99 | `spawn('node', ...)` asume `node` en PATH del usuario final; en app empaquetada fallaría. Relacionado: espera activa de 15s (30×500ms) | BE-15-adjacente / FE-20-adjacente | media | Cambiaría comportamiento de arranque observable; requiere decisión de empaquetado |
