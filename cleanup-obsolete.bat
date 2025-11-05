@echo off
echo ============================================
echo LIMPIEZA DE PROYECTOS OBSOLETOS
echo ============================================
echo.
echo Este script eliminará:
echo - Proyecto .NET Framework obsoleto
echo - Proyecto DP4500 DPURUNET DLL de consola
echo - Archivos temporales y de build
echo - Carpetas de Visual Studio (.vs)
echo.
echo MANTIENE:
echo - Proyecto .NET 8 (dotnet/Dp4500Net8Bridge)
echo - Código fuente Electron (src/)
echo - Archivos de configuración principales
echo.

set /p confirm="¿Continuar con la limpieza? (S/N): "
if /i not "%confirm%"=="S" (
    echo Limpieza cancelada.
    pause
    exit /b 0
)

cd /d "%~dp0"

echo.
echo ==========================================
echo 1. ELIMINANDO PROYECTO .NET FRAMEWORK OBSOLETO
echo ==========================================
if exist "dotnet\Dp4500FrameworkBridge" (
    echo Eliminando dotnet\Dp4500FrameworkBridge...
    rmdir /s /q "dotnet\Dp4500FrameworkBridge" 2>nul
    if exist "dotnet\Dp4500FrameworkBridge" (
        echo ❌ Error eliminando proyecto .NET Framework
    ) else (
        echo ✅ Proyecto .NET Framework eliminado
    )
) else (
    echo ℹ️  Proyecto .NET Framework ya no existe
)

echo.
echo ==========================================
echo 2. ARCHIVANDO PROYECTO CONSOLA DPURUNET
echo ==========================================
if exist "DP4500 DPURUNET DLL" (
    echo Creando archivo de referencia...
    mkdir "archive" 2>nul

    echo Moviendo a carpeta archive...
    move "DP4500 DPURUNET DLL" "archive\DP4500-DPURUNET-DLL-REFERENCE" >nul 2>&1
    if exist "archive\DP4500-DPURUNET-DLL-REFERENCE" (
        echo ✅ Proyecto consola archivado en archive\DP4500-DPURUNET-DLL-REFERENCE
        echo ℹ️  Se mantiene como referencia de algoritmos
    ) else (
        echo ❌ Error archivando proyecto consola
    )
) else (
    echo ℹ️  Proyecto consola ya fue movido
)

echo.
echo ==========================================
echo 3. LIMPIANDO ARCHIVOS TEMPORALES
echo ==========================================

echo Limpiando carpetas bin y obj...
for /d /r . %%d in (bin obj) do (
    if exist "%%d" (
        echo Eliminando %%d
        rmdir /s /q "%%d" 2>nul
    )
)

echo Limpiando carpetas .vs...
for /d /r . %%d in (.vs) do (
    if exist "%%d" (
        echo Eliminando %%d
        rmdir /s /q "%%d" 2>nul
    )
)

echo Limpiando archivos de cache de Node.js antiguos...
if exist "node_modules\.cache" (
    rmdir /s /q "node_modules\.cache" 2>nul
)

echo ✅ Archivos temporales limpiados

echo.
echo ==========================================
echo 4. LIMPIANDO ARCHIVOS ESPECÍFICOS OBSOLETOS
echo ==========================================

rem Eliminar archivos de muestra que no se usan
if exist "MuestrasDactilares.png" (
    del "MuestrasDactilares.png" 2>nul
    echo ✅ MuestrasDactilares.png eliminado
)

if exist "PertinentOccasionalAgouti.gif" (
    del "PertinentOccasionalAgouti.gif" 2>nul
    echo ✅ PertinentOccasionalAgouti.gif eliminado
)

rem Limpiar carpetas que no se usan
if exist "MuestrasDactilares" (
    rmdir /s /q "MuestrasDactilares" 2>nul
    echo ✅ Carpeta MuestrasDactilares eliminada
)

if exist "Interface CP Tickets" (
    rmdir /s /q "Interface CP Tickets" 2>nul
    echo ✅ Carpeta Interface CP Tickets eliminada
)

if exist "Nueva carpeta" (
    rmdir /s /q "Nueva carpeta" 2>nul
    echo ✅ Nueva carpeta eliminada
)

if exist "VBSample" (
    rmdir /s /q "VBSample" 2>nul
    echo ✅ VBSample eliminado
)

if exist "Wondershare_DrFone_IOSUnlock" (
    rmdir /s /q "Wondershare_DrFone_IOSUnlock" 2>nul
    echo ✅ Wondershare_DrFone_IOSUnlock eliminado
)

echo.
echo ==========================================
echo 5. VERIFICANDO ESTRUCTURA FINAL
echo ==========================================
echo.
echo ESTRUCTURA ACTIVA MANTENIDA:
echo.
tree /f /a | findstr /v /c:"│   │" | findstr /v /c:"    │"
echo.

echo ==========================================
echo ✅ LIMPIEZA COMPLETADA
echo ==========================================
echo.
echo PROYECTOS ACTIVOS:
echo ✅ dotnet\Dp4500Net8Bridge - Wrapper .NET 8 activo
echo ✅ src\ - Código fuente Electron
echo ✅ static\ - Archivos estáticos web
echo ✅ dist\ - Código compilado TypeScript
echo.
echo ARCHIVADO:
echo 📁 archive\DP4500-DPURUNET-DLL-REFERENCE - Referencia algoritmos
echo.
echo ELIMINADO:
echo ❌ dotnet\Dp4500FrameworkBridge - .NET Framework obsoleto
echo ❌ Archivos temporales y carpetas no utilizadas
echo.
echo Para construir: build-dotnet8.bat
echo Para ejecutar: npm start
echo.
pause