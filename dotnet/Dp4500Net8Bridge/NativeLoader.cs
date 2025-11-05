using System;
using System.IO;
using System.Runtime.InteropServices;

namespace Dp4500Net8Bridge
{
    /// <summary>
    /// Cargador nativo de DLLs del DigitalPersona SDK
    /// </summary>
    internal static class NativeLoader
    {
        private const uint LOAD_LIBRARY_SEARCH_DEFAULT_DIRS = 0x00001000;
        private const uint LOAD_LIBRARY_SEARCH_USER_DIRS = 0x00000400;

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetDefaultDllDirectories(uint flags);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr AddDllDirectory(string path);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr LoadLibraryW(string fileName);

        private static volatile bool _bootstrapped = false;
        private static readonly object _lock = new object();

        public static void Bootstrap(params string[] extraDirs)
        {
            if (_bootstrapped) return;

            lock (_lock)
            {
                if (_bootstrapped) return;

                try
                {
                    if (!SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_DEFAULT_DIRS | LOAD_LIBRARY_SEARCH_USER_DIRS))
                        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "SetDefaultDllDirectories()");

                    // Agregar directorios adicionales
                    foreach (var dir in extraDirs)
                    {
                        if (!string.IsNullOrWhiteSpace(dir) && Directory.Exists(dir))
                            AddDllDirectory(dir);
                    }

                    // Agregar directorio base y libs
                    var baseDir = AppContext.BaseDirectory;
                    AddDllDirectory(baseDir);

                    var libsDir = Path.Combine(baseDir, "libs");
                    if (Directory.Exists(libsDir))
                        AddDllDirectory(libsDir);

                    // Cargar DLLs nativas críticas
                    foreach (var dll in new[] { "dpfpdd.dll", "dpfj.dll", "DPCtlUruNet.dll" })
                    {
                        try
                        {
                            LoadLibraryW(dll);
                        }
                        catch
                        {
                            // Intentar desde el directorio libs
                            var libPath = Path.Combine(libsDir, dll);
                            if (File.Exists(libPath))
                                LoadLibraryW(libPath);
                        }
                    }

                    _bootstrapped = true;
                }
                catch (Exception ex)
                {
                    throw new InvalidOperationException($"Error inicializando cargador nativo: {ex.Message}", ex);
                }
            }
        }
    }
}