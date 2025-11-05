@echo off
echo ====================================
echo CONSTRUYENDO PROYECTO ELECTRON + .NET 8
echo ====================================

cd /d "%~dp0"

echo.
echo 📋 Verificando prerequisitos...
if not exist "dotnet\Dp4500Net8Bridge" (
    echo ❌ ERROR: Directorio dotnet\Dp4500Net8Bridge no encontrado
    echo    Ejecute primero la migración
    pause
    exit /b 1
)

if not exist "archive\DP4500-DPURUNET-DLL-REFERENCE\DPURUNET" (
    echo ❌ ERROR: Librerías nativas no encontradas en archive
    echo    Verifique que las librerías DigitalPersona estén disponibles
    pause
    exit /b 1
)

echo ✅ Prerequisitos verificados

echo.
echo 1️⃣ COPIANDO LIBRERÍAS NATIVAS...
xcopy /Y "archive\DP4500-DPURUNET-DLL-REFERENCE\DPURUNET\*.dll" "dotnet\Dp4500Net8Bridge\libs\" >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ Error copiando librerías nativas
    pause
    exit /b 1
)
echo ✅ Librerías nativas copiadas desde archivo

echo.
echo 2️⃣ CONSTRUYENDO WRAPPER .NET 8...
cd "dotnet\Dp4500Net8Bridge"
dotnet clean >nul 2>&1
dotnet build --configuration Debug --verbosity quiet
if %errorlevel% neq 0 (
    echo ❌ Error construyendo proyecto .NET 8
    echo    Verifique que .NET 8 SDK esté instalado
    pause
    exit /b 1
)
echo ✅ Wrapper .NET 8 construido exitosamente

echo.
echo 3️⃣ COPIANDO DEPENDENCIAS NATIVAS...
xcopy /Y "libs\*.dll" "bin\Debug\net8.0\" >nul 2>&1
if %errorlevel% neq 0 (
    echo ⚠️  Advertencia: Error copiando librerías al directorio de salida
)
echo ✅ Dependencias nativas copiadas

cd /d "%~dp0"

echo.
echo 4️⃣ CONSTRUYENDO CÓDIGO TYPESCRIPT...
call npm run build
if %errorlevel% neq 0 (
    echo ❌ Error construyendo proyecto TypeScript
    echo    Ejecute: npm install
    pause
    exit /b 1
)
echo ✅ Código TypeScript construido exitosamente

echo.
echo ====================================
echo ✅ ¡CONSTRUCCIÓN COMPLETADA!
echo ====================================
echo.
echo 🎯 SOLUCIÓN ACTIVA:
echo   📁 dotnet\Dp4500Net8Bridge - Wrapper .NET 8 con algoritmos avanzados
echo   📁 src\ - Código fuente Electron/TypeScript
echo   📁 static\ - Interfaz web moderna
echo   📁 dist\ - Código compilado listo para ejecución
echo.
echo 🚀 FUNCIONALIDADES DISPONIBLES:
echo   ✅ Enrolamiento multi-estrategia (5 algoritmos)
echo   ✅ Identificación 1:N con ranking
echo   ✅ Comparación robusta con fallback
echo   ✅ Store thread-safe con metadatos SHA1
echo   ✅ Calibración automática del sensor
echo.
echo 📚 ARCHIVOS DE REFERENCIA:
echo   📁 archive\ - Código fuente de referencia archivado
echo.
echo ▶️  Para ejecutar: npm start
echo 🧹 Para limpiar: cleanup-obsolete.bat
echo.
pause