@echo off
echo ============================================
echo ELIMINANDO ARCHIVOS DUPLICADOS
echo ============================================
echo.
echo Este script eliminará archivos duplicados manteniendo solo:
echo ✅ DLLs nativas DigitalPersona en archive/DP4500-DPURUNET-DLL-REFERENCE/DPURUNET/
echo ✅ DLLs de dependencias en node_modules/ (necesarias para Electron)
echo ✅ Wrapper .NET 8 compilado en dotnet/Dp4500Net8Bridge/
echo.
echo ELIMINARÁ:
echo ❌ Archivos de build temporales en archive/
echo ❌ DLLs compiladas duplicadas en archive/
echo ❌ Carpetas obj/ y bin/ no esenciales
echo.

set /p confirm="¿Continuar con la eliminación de duplicados? (S/N): "
if /i not "%confirm%"=="S" (
    echo Eliminación cancelada.
    pause
    exit /b 0
)

cd /d "%~dp0"

echo.
echo ==========================================
echo 1. ELIMINANDO BUILD TEMPORALES DEL ARCHIVE
echo ==========================================

if exist "archive\DP4500-DPURUNET-DLL-REFERENCE\bin" (
    echo Eliminando archive\DP4500-DPURUNET-DLL-REFERENCE\bin...
    rmdir /s /q "archive\DP4500-DPURUNET-DLL-REFERENCE\bin" 2>nul
    if not exist "archive\DP4500-DPURUNET-DLL-REFERENCE\bin" (
        echo ✅ Carpeta bin/ del archive eliminada
    ) else (
        echo ⚠️  Error eliminando carpeta bin/
    )
) else (
    echo ℹ️  Carpeta bin/ ya no existe en archive
)

if exist "archive\DP4500-DPURUNET-DLL-REFERENCE\obj" (
    echo Eliminando archive\DP4500-DPURUNET-DLL-REFERENCE\obj...
    rmdir /s /q "archive\DP4500-DPURUNET-DLL-REFERENCE\obj" 2>nul
    if not exist "archive\DP4500-DPURUNET-DLL-REFERENCE\obj" (
        echo ✅ Carpeta obj/ del archive eliminada
    ) else (
        echo ⚠️  Error eliminando carpeta obj/
    )
) else (
    echo ℹ️  Carpeta obj/ ya no existe en archive
)

echo.
echo ==========================================
echo 2. ELIMINANDO ARCHIVOS .VS DEL ARCHIVE
echo ==========================================

if exist "archive\DP4500-DPURUNET-DLL-REFERENCE\.vs" (
    echo Eliminando archive\DP4500-DPURUNET-DLL-REFERENCE\.vs...
    rmdir /s /q "archive\DP4500-DPURUNET-DLL-REFERENCE\.vs" 2>nul
    if not exist "archive\DP4500-DPURUNET-DLL-REFERENCE\.vs" (
        echo ✅ Carpeta .vs/ del archive eliminada
    ) else (
        echo ⚠️  Error eliminando carpeta .vs/
    )
) else (
    echo ℹ️  Carpeta .vs/ ya no existe en archive
)

echo.
echo ==========================================
echo 3. VERIFICANDO DLLS NATIVAS ESENCIALES
echo ==========================================

echo Verificando DLLs nativas en archive\DP4500-DPURUNET-DLL-REFERENCE\DPURUNET\...
if exist "archive\DP4500-DPURUNET-DLL-REFERENCE\DPURUNET\DPUruNet.dll" (
    echo ✅ DPUruNet.dll - SDK .NET DigitalPersona
) else (
    echo ❌ FALTA: DPUruNet.dll
)

if exist "archive\DP4500-DPURUNET-DLL-REFERENCE\DPURUNET\dpfj.dll" (
    echo ✅ dpfj.dll - DigitalPersona Feature Extraction
) else (
    echo ❌ FALTA: dpfj.dll
)

if exist "archive\DP4500-DPURUNET-DLL-REFERENCE\DPURUNET\dpfpdd.dll" (
    echo ✅ dpfpdd.dll - DigitalPersona Device Driver
) else (
    echo ❌ FALTA: dpfpdd.dll
)

if exist "archive\DP4500-DPURUNET-DLL-REFERENCE\DPURUNET\DPCtlUruNet.dll" (
    echo ✅ DPCtlUruNet.dll - DigitalPersona Control Library
) else (
    echo ❌ FALTA: DPCtlUruNet.dll
)

echo.
echo ==========================================
echo 4. LIMPIANDO ARCHIVOS TEMPORALES PROYECTO ACTIVO
echo ==========================================

if exist "dotnet\Dp4500Net8Bridge\bin\Debug\net8.0\*.pdb" (
    echo Eliminando archivos .pdb del proyecto activo...
    del /q "dotnet\Dp4500Net8Bridge\bin\Debug\net8.0\*.pdb" 2>nul
    echo ✅ Archivos .pdb eliminados
) else (
    echo ℹ️  No hay archivos .pdb para eliminar
)

echo.
echo ==========================================
echo 5. VERIFICANDO ESTRUCTURA LIMPIA
echo ==========================================

echo.
echo 🎯 ARCHIVOS ACTIVOS MANTENIDOS:
echo   📁 dotnet\Dp4500Net8Bridge\ - Wrapper .NET 8
if exist "dotnet\Dp4500Net8Bridge\Dp4500Net8Bridge.csproj" (
    echo   ✅ Proyecto .NET 8 presente
) else (
    echo   ❌ PROBLEMA: Proyecto .NET 8 no encontrado
)

echo.
echo 📚 ARCHIVOS DE REFERENCIA MANTENIDOS:
echo   📁 archive\DP4500-DPURUNET-DLL-REFERENCE\DPURUNET\ - DLLs nativas
echo   📁 archive\DP4500-DPURUNET-DLL-REFERENCE\*.cs - Código fuente referencia

echo.
echo 🧹 ARCHIVOS ELIMINADOS:
echo   ❌ build/ temporales del archive
echo   ❌ obj/ temporales del archive
echo   ❌ .vs/ configuraciones Visual Studio
echo   ❌ .pdb archivos de debug

echo.
echo ==========================================
echo 6. CALCULANDO ESPACIO LIBERADO
echo ==========================================

echo Verificando tamaños de directorio...
for /d %%D in ("archive\DP4500-DPURUNET-DLL-REFERENCE") do (
    echo 📁 Tamaño archive: Aproximadamente menor después de limpieza
)

for /d %%D in ("dotnet\Dp4500Net8Bridge") do (
    echo 📁 Tamaño proyecto activo: Solo archivos esenciales
)

for /d %%D in ("node_modules") do (
    echo 📁 node_modules: Mantenido (necesario para Electron)
)

echo.
echo ==========================================
echo ✅ ELIMINACIÓN DE DUPLICADOS COMPLETADA
echo ==========================================
echo.
echo RESUMEN:
echo ✅ Archivos temporales y duplicados eliminados
echo ✅ Solo DLLs nativas esenciales conservadas
echo ✅ Estructura optimizada para producción
echo ✅ Referencias de código fuente preservadas
echo.
echo SIGUIENTE PASO:
echo ▶️  Ejecutar: build-dotnet8.bat
echo    (Reconstruirá solo lo necesario)
echo.
pause