using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using DPUruNet;

namespace Dp4500Net8Bridge
{
    /// <summary>
    /// Servicio avanzado DP4500 con algoritmos robustos de enrolamiento/verificación
    /// Incorpora toda la lógica del DP4500 DPURUNET DLL pero optimizada para Electron
    /// </summary>
    public sealed class AdvancedDp4500Service : IDisposable
    {
        private readonly ManualResetEventSlim _sampleReady = new(false);
        private volatile CaptureResult? _lastCapture;
        private volatile Fid? _lastFid;
        private bool _subscribed;
        private int _dpi = 500;
        private bool _disposed;

        private readonly Lazy<Reader> _readerLazy = new(() =>
        {
            var readers = ReaderCollection.GetReaders();
            var reader = readers?.FirstOrDefault() ?? throw new InvalidOperationException("No hay lectores U.are.U conectados.");
            var rc = reader.Open(Constants.CapturePriority.DP_PRIORITY_EXCLUSIVE);
            if (rc != Constants.ResultCode.DP_SUCCESS)
                throw new InvalidOperationException($"Reader.Open(EXCLUSIVE) falló: {rc}");
            return reader;
        }, isThreadSafe: true);

        private Reader Reader => _readerLazy.Value;

        // Eventos para notificar al bridge
        public event Action<string>? OnStatus;
        public event Action<int>? OnSampleCountChanged;
        public event Action<int, bool, string?>? OnAttemptResult;
        public event Action<int, int, string?>? OnFingerCaptured;

        private const int TARGET_FARN_ENROLL_CHECK = 100_000;

        static AdvancedDp4500Service()
        {
            // Inicializar carga de DLLs nativas
            NativeLoader.Bootstrap();
        }

        public void Init()
        {
            if (!_subscribed)
            {
                Reader.On_Captured += OnCaptured;
                _subscribed = true;
            }
            try
            {
                var caps = Reader.Capabilities;
                if (caps?.Resolutions is { Length: > 0 }) _dpi = caps.Resolutions[0];
            }
            catch { _dpi = 500; }
        }

        private void OnCaptured(CaptureResult result)
        {
            _lastCapture = result;
            _sampleReady.Set();
        }

        private static readonly TimeSpan BusyPollDelay = TimeSpan.FromMilliseconds(35);

        private void WaitReadyWithOptionalCancel(CancellationToken ct, int overallTimeoutMs = 4000)
        {
            long deadline = Environment.TickCount64 + overallTimeoutMs;
            long busyStart = -1;
            bool flushedOnce = false;

            while (Environment.TickCount64 < deadline)
            {
                ct.ThrowIfCancellationRequested();

                var rc = Reader.GetStatus();
                if (rc != Constants.ResultCode.DP_SUCCESS)
                    throw new InvalidOperationException($"GetStatus: {rc}");

                var st = Reader.Status?.Status ?? Constants.ReaderStatuses.DP_STATUS_NEED_CALIBRATION;

                if (st == Constants.ReaderStatuses.DP_STATUS_READY) return;

                if (st == Constants.ReaderStatuses.DP_STATUS_NEED_CALIBRATION)
                {
                    try { Reader.Calibrate(); } catch { }
                    Thread.Sleep(BusyPollDelay);
                    continue;
                }

                if (st == Constants.ReaderStatuses.DP_STATUS_BUSY)
                {
                    if (busyStart < 0) busyStart = Environment.TickCount64;
                    if (!flushedOnce && Environment.TickCount64 - busyStart > 900)
                    {
                        try { Reader.CancelCapture(); } catch { }
                        flushedOnce = true;
                        busyStart = Environment.TickCount64;
                    }
                }

                Thread.Sleep(BusyPollDelay);
            }
            throw new TimeoutException("El lector no volvió a READY a tiempo.");
        }

        private void RequestCaptureGentle(CancellationToken ct)
        {
            _sampleReady.Reset();
            _lastCapture = null;

            WaitReadyWithOptionalCancel(ct, 3000);

            for (int i = 0; i < 3; i++)
            {
                var rc = Reader.CaptureAsync(
                    Constants.Formats.Fid.ANSI,
                    Constants.CaptureProcessing.DP_IMG_PROC_DEFAULT,
                    _dpi);

                if (rc == Constants.ResultCode.DP_SUCCESS) return;

                if (rc == Constants.ResultCode.DP_DEVICE_BUSY || rc == Constants.ResultCode.DP_FAILURE)
                {
                    Thread.Sleep(120);
                    WaitReadyWithOptionalCancel(ct, 1500);
                    continue;
                }

                throw new InvalidOperationException($"CaptureAsync: {rc}");
            }

            throw new InvalidOperationException("CaptureAsync: DP_DEVICE_BUSY persistente");
        }

        private static bool IsGoodCapture(CaptureResult? cap, out string why)
        {
            if (cap == null) { why = "cap==null"; return false; }
            if (cap.ResultCode != Constants.ResultCode.DP_SUCCESS) { why = $"rc={cap.ResultCode}"; return false; }
            if (cap.Data == null) { why = "Data==null"; return false; }
            if (cap.Quality != Constants.CaptureQuality.DP_QUALITY_GOOD) { why = $"quality={cap.Quality}"; return false; }
            why = null!; return true;
        }

        // FID -> FMDs con todas las estrategias
        private static Fmd FidToPreFmd(Fid fid, out string formatName)
        {
            var fx = FeatureExtraction.CreateFmdFromFid(fid, Constants.Formats.Fmd.DP_PRE_REGISTRATION);
            if (fx.ResultCode == Constants.ResultCode.DP_SUCCESS && fx.Data != null)
            { formatName = "DP_PRE_REGISTRATION"; return fx.Data; }

            fx = FeatureExtraction.CreateFmdFromFid(fid, Constants.Formats.Fmd.ANSI);
            if (fx.ResultCode != Constants.ResultCode.DP_SUCCESS || fx.Data == null)
                throw new InvalidOperationException($"CreateFmdFromFid PRE falló: {fx.ResultCode}");
            formatName = "ANSI"; return fx.Data;
        }

        private static Fmd FidToVerFmd(Fid fid)
        {
            var fx = FeatureExtraction.CreateFmdFromFid(fid, Constants.Formats.Fmd.DP_VERIFICATION);
            if (fx.ResultCode != Constants.ResultCode.DP_SUCCESS || fx.Data == null)
                throw new InvalidOperationException($"CreateFmdFromFid VER falló: {fx.ResultCode}");
            return fx.Data;
        }

        private static Fmd FidToAnsiFmd(Fid fid)
        {
            var fx = FeatureExtraction.CreateFmdFromFid(fid, Constants.Formats.Fmd.ANSI);
            if (fx.ResultCode != Constants.ResultCode.DP_SUCCESS || fx.Data == null)
                throw new InvalidOperationException($"CreateFmdFromFid ANSI falló: {fx.ResultCode}");
            return fx.Data;
        }

        // Comparación robusta con fix para score=Int32.MaxValue
        private static (bool rcOk, int score, string from) CompareSafe(Fmd aVer, Fmd bVer, Fmd aAnsi, Fmd bAnsi, int targetFarn)
        {
            var c1 = Comparison.Compare(aVer, 0, bVer, 0);
            if (c1.ResultCode == Constants.ResultCode.DP_SUCCESS && c1.Score != int.MaxValue)
                return (true, c1.Score, "VER");

            var c2 = Comparison.Compare(aAnsi, 0, bAnsi, 0);
            if (c2.ResultCode == Constants.ResultCode.DP_SUCCESS && c2.Score != int.MaxValue)
                return (true, c2.Score, "ANSI");

            return (false, int.MaxValue, $"rc1={c1.ResultCode},score1={(c1.Score == int.MaxValue ? "MAX" : c1.Score)}; rc2={c2.ResultCode},score2={(c2.Score == int.MaxValue ? "MAX" : c2.Score)}");
        }

        // Conversión FID a PNG Base64
        public static string FidToPngBase64(Fid fid)
        {
            var v = fid.Views[0];
            using var bmp = new Bitmap(v.Width, v.Height, PixelFormat.Format8bppIndexed);
            var pal = bmp.Palette;
            for (int i = 0; i < 256; i++) pal.Entries[i] = Color.FromArgb(i, i, i);
            bmp.Palette = pal;

            var data = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height), ImageLockMode.WriteOnly, bmp.PixelFormat);
            try
            {
                int stride = data.Stride, srcW = v.Width;
                for (int y = 0; y < v.Height; y++)
                {
                    var dstRow = IntPtr.Add(data.Scan0, y * stride);
                    Marshal.Copy(v.RawImage!, y * srcW, dstRow, srcW);
                }
            }
            finally { bmp.UnlockBits(data); }

            using var ms = new MemoryStream();
            bmp.Save(ms, ImageFormat.Png);
            return Convert.ToBase64String(ms.ToArray());
        }

        // ===== MÉTODOS PÚBLICOS PRINCIPALES =====

        public async Task<CaptureResultDto> CaptureWithAttemptsAsync(int maxAttempts, CancellationToken ct)
        {
            Init();
            OnStatus?.Invoke("Captura con intentos múltiples...");

            for (int attempt = 1; attempt <= maxAttempts; attempt++)
            {
                try
                {
                    OnStatus?.Invoke($"Captura intento {attempt}/{maxAttempts}... coloca el dedo.");
                    RequestCaptureGentle(ct);

                    if (!_sampleReady.Wait(TimeSpan.FromSeconds(10), ct))
                    {
                        OnAttemptResult?.Invoke(attempt, false, "timeout");
                        continue;
                    }

                    var cap = _lastCapture;
                    if (!IsGoodCapture(cap, out var why))
                    {
                        OnAttemptResult?.Invoke(attempt, false, why);
                        continue;
                    }

                    _lastFid = cap!.Data;
                    var fmdVer = FidToVerFmd(cap.Data!);
                    var pngB64 = FidToPngBase64(cap.Data!);
                    var bytes = cap.Data!.Views[0].RawImage?.Length ?? 0;

                    OnFingerCaptured?.Invoke(attempt, bytes, pngB64);
                    OnAttemptResult?.Invoke(attempt, true, "ok");

                    return new CaptureResultDto
                    {
                        Success = true,
                        Attempts = attempt,
                        PngBase64 = pngB64,
                        FmdXml = Fmd.SerializeXml(fmdVer)
                    };
                }
                catch (Exception ex)
                {
                    OnAttemptResult?.Invoke(attempt, false, ex.Message);
                }

                if (attempt < maxAttempts) await Task.Delay(200, ct);
            }

            return new CaptureResultDto { Success = false, Error = "Todos los intentos fallaron", Attempts = maxAttempts };
        }

        public async Task<EnrollResultDto> EnrollAsync(int samples, CancellationToken ct)
        {
            Init();
            OnStatus?.Invoke($"Iniciando enrolamiento ({samples} muestras)...");

            var preList = new List<Fmd>(samples);
            var ansiList = new List<Fmd>(samples);
            var verList = new List<Fmd>(samples);

            Fmd? verFirst = null, ansiFirst = null;

            for (int sampleIndex = 0; sampleIndex < samples; sampleIndex++)
            {
                int attempt = 0;
                while (true)
                {
                    ct.ThrowIfCancellationRequested();

                    OnStatus?.Invoke($"Muestra {sampleIndex + 1}/{samples} - levanta y recoloca el dedo");
                    RequestCaptureGentle(ct);

                    if (!_sampleReady.Wait(TimeSpan.FromSeconds(10), ct))
                    {
                        OnAttemptResult?.Invoke(sampleIndex + 1, false, "timeout");
                        return new EnrollResultDto { Success = false, Error = $"Timeout en muestra {sampleIndex + 1}" };
                    }

                    var cap = _lastCapture;
                    if (!IsGoodCapture(cap, out var why))
                    {
                        attempt++;
                        OnAttemptResult?.Invoke(sampleIndex + 1, false, $"mala captura: {why}");
                        if (attempt >= 3)
                            return new EnrollResultDto { Success = false, Error = $"Muestra {sampleIndex + 1}: calidad insuficiente ({why})" };
                        Thread.Sleep(140);
                        continue;
                    }

                    _lastFid = cap!.Data;
                    var preFmt = "";
                    var fmdPre = FidToPreFmd(cap.Data!, out preFmt);
                    var fmdVer = FidToVerFmd(cap.Data!);
                    var fmdAnsi = FidToAnsiFmd(cap.Data!);

                    // Validar consistencia con la primera muestra
                    if (verFirst == null)
                    {
                        verFirst = fmdVer;
                        ansiFirst = fmdAnsi;
                    }
                    else
                    {
                        var (rcOk, score, used) = CompareSafe(fmdVer, verFirst!, fmdAnsi, ansiFirst!, TARGET_FARN_ENROLL_CHECK);
                        if (!rcOk)
                        {
                            attempt++;
                            OnAttemptResult?.Invoke(sampleIndex + 1, false, $"compare inválido ({used})");
                            if (attempt >= 3)
                                return new EnrollResultDto { Success = false, Error = $"Muestra {sampleIndex + 1}: compare inválido ({used})" };
                            Thread.Sleep(160);
                            continue;
                        }
                        if (score >= TARGET_FARN_ENROLL_CHECK)
                        {
                            attempt++;
                            OnAttemptResult?.Invoke(sampleIndex + 1, false, $"no coincide (score={(score == int.MaxValue ? "MAX" : score)})");
                            if (attempt >= 3)
                                return new EnrollResultDto { Success = false, Error = $"Muestra {sampleIndex + 1} no coincide. Score={(score == int.MaxValue ? "MAX" : score)}" };
                            Thread.Sleep(160);
                            continue;
                        }
                    }

                    preList.Add(fmdPre);
                    verList.Add(fmdVer);
                    ansiList.Add(fmdAnsi);

                    OnSampleCountChanged?.Invoke(preList.Count);
                    OnAttemptResult?.Invoke(sampleIndex + 1, true, "ok");

                    var bytes = cap.Data!.Views[0].RawImage?.Length ?? 0;
                    var pngB64 = FidToPngBase64(cap.Data!);
                    OnFingerCaptured?.Invoke(sampleIndex + 1, bytes, pngB64);

                    Thread.Sleep(220);
                    break;
                }
            }

            // Estrategias de enrolamiento múltiples
            var (success, fmdReg, method) = TryEnrollmentWithStrategies(preList, ansiList, verList);
            if (success && fmdReg != null)
            {
                return new EnrollResultDto
                {
                    Success = true,
                    TemplateXml = Fmd.SerializeXml(fmdReg),
                    Method = method,
                    SamplesUsed = preList.Count
                };
            }

            return new EnrollResultDto { Success = false, Error = "Enrollment falló: DP_ENROLLMENT_NOT_READY" };
        }

        private (bool success, Fmd? fmdReg, string method) TryEnrollmentWithStrategies(List<Fmd> preList, List<Fmd> ansiList, List<Fmd> verList)
        {
            // Estrategia 1: REG desde PRE[]
            var enr = Enrollment.CreateEnrollmentFmd(Constants.Formats.Fmd.DP_REGISTRATION, preList.ToArray());
            if (enr.ResultCode == Constants.ResultCode.DP_SUCCESS && enr.Data != null)
                return (true, enr.Data, "REG desde PRE[]");

            // Estrategia 2: Mejor tríada desde PRE
            var tri = FindBestTriad(verList, ansiList, TARGET_FARN_ENROLL_CHECK);
            if (tri.success)
            {
                var sel = new[] { preList[tri.i], preList[tri.j], preList[tri.k] };
                var enrSel = Enrollment.CreateEnrollmentFmd(Constants.Formats.Fmd.DP_REGISTRATION, sel);
                if (enrSel.ResultCode == Constants.ResultCode.DP_SUCCESS && enrSel.Data != null)
                    return (true, enrSel.Data, "REG desde mejor tríada PRE");
            }

            // Estrategia 3: REG desde ANSI[]
            var enrA = Enrollment.CreateEnrollmentFmd(Constants.Formats.Fmd.DP_REGISTRATION, ansiList.ToArray());
            if (enrA.ResultCode == Constants.ResultCode.DP_SUCCESS && enrA.Data != null)
                return (true, enrA.Data, "REG desde ANSI[]");

            // Estrategia 4: REG directo desde último FID
            if (_lastFid != null)
            {
                var regFx = FeatureExtraction.CreateFmdFromFid(_lastFid, Constants.Formats.Fmd.DP_REGISTRATION);
                if (regFx.ResultCode == Constants.ResultCode.DP_SUCCESS && regFx.Data != null)
                    return (true, regFx.Data, "REG directo desde FID");
            }

            return (false, null, "NOT_READY");
        }

        private (bool success, int i, int j, int k) FindBestTriad(List<Fmd> verList, List<Fmd> ansiList, int targetFarn)
        {
            int n = verList.Count;
            if (n < 3) return (false, -1, -1, -1);

            var scores = new int[n, n];
            var okPair = new bool[n, n];

            for (int a = 0; a < n; a++)
                for (int b = a + 1; b < n; b++)
                {
                    var c1 = Comparison.Compare(verList[a], 0, verList[b], 0);
                    if (c1.ResultCode == Constants.ResultCode.DP_SUCCESS && c1.Score != int.MaxValue)
                    {
                        scores[a, b] = scores[b, a] = c1.Score;
                        okPair[a, b] = okPair[b, a] = true;
                        continue;
                    }
                    var c2 = Comparison.Compare(ansiList[a], 0, ansiList[b], 0);
                    if (c2.ResultCode == Constants.ResultCode.DP_SUCCESS && c2.Score != int.MaxValue)
                    {
                        scores[a, b] = scores[b, a] = c2.Score;
                        okPair[a, b] = okPair[b, a] = true;
                    }
                }

            long bestSum = long.MaxValue;
            (int i, int j, int k) best = (-1, -1, -1);

            for (int i = 0; i < n; i++)
                for (int j = i + 1; j < n; j++)
                    for (int k = j + 1; k < n; k++)
                    {
                        if (!okPair[i, j] || !okPair[i, k] || !okPair[j, k]) continue;
                        if (scores[i, j] >= targetFarn || scores[i, k] >= targetFarn || scores[j, k] >= targetFarn) continue;

                        long sum = (long)scores[i, j] + scores[i, k] + scores[j, k];
                        if (sum < bestSum) { bestSum = sum; best = (i, j, k); }
                    }

            return (best.i >= 0, best.i, best.j, best.k);
        }

        public async Task<VerifyResultDto> VerifyAsync(string enrolledXml, string? liveXml, int farDenominator)
        {
            var enrolledFmd = Fmd.DeserializeXml(enrolledXml);
            Fmd liveFmd;

            if (string.IsNullOrEmpty(liveXml))
            {
                // Capturar en vivo
                var captureResult = await CaptureWithAttemptsAsync(1, CancellationToken.None);
                if (!captureResult.Success)
                    throw new InvalidOperationException($"Error capturando huella en vivo: {captureResult.Error}");
                liveFmd = Fmd.DeserializeXml(captureResult.FmdXml!);
            }
            else
            {
                liveFmd = Fmd.DeserializeXml(liveXml);
            }

            int threshold = Math.Max(1, int.MaxValue / Math.Max(1, farDenominator));
            var compare = Comparison.Compare(liveFmd, 0, enrolledFmd, 0);

            if (compare.ResultCode != Constants.ResultCode.DP_SUCCESS)
                throw new InvalidOperationException($"Compare falló: {compare.ResultCode}");

            bool matched = compare.Score < threshold && compare.Score != int.MaxValue;
            double confidence = compare.Score == int.MaxValue ? 0.0 : Math.Max(0.0, (1.0 - (double)compare.Score / threshold) * 100.0);

            return new VerifyResultDto
            {
                Matched = matched,
                Score = compare.Score,
                Threshold = threshold,
                Confidence = confidence,
                Method = "DP_VERIFICATION"
            };
        }

        public ReaderInfoDto GetReaderInfo()
        {
            try
            {
                var reader = Reader;
                return new ReaderInfoDto
                {
                    Success = true,
                    Description = reader.Description?.Name ?? "Unknown",
                    Guid = reader.Description?.Id?.ToString() ?? "Unknown",
                    SerialNumber = reader.Description?.SerialNumber ?? "Unknown",
                    ProductName = reader.Description?.Name ?? "Unknown"
                };
            }
            catch (Exception ex)
            {
                return new ReaderInfoDto
                {
                    Success = false,
                    Error = "Error obteniendo info del lector: " + ex.Message
                };
            }
        }

        public void Cancel()
        {
            try
            {
                if (_readerLazy.IsValueCreated)
                {
                    _readerLazy.Value.CancelCapture();
                }
            }
            catch { }
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;

            try
            {
                if (_subscribed)
                {
                    Reader.On_Captured -= OnCaptured;
                    _subscribed = false;
                }
                Cancel();
            }
            catch { }

            if (_readerLazy.IsValueCreated)
            {
                try { Reader.Dispose(); } catch { }
            }

            _sampleReady.Dispose();
        }

        // ===== MÉTODOS ADICIONALES PARA FUNCIONALIDADES AVANZADAS =====

        public async Task<SingleCaptureResultDto> SingleCaptureAsync(CancellationToken ct)
        {
            Init();
            OnStatus?.Invoke("Captura simple... coloca el dedo.");
            RequestCaptureGentle(ct);

            if (!_sampleReady.Wait(TimeSpan.FromSeconds(10), ct))
                return new SingleCaptureResultDto { Success = false, Error = "Timeout en captura simple" };

            var cap = _lastCapture;
            if (!IsGoodCapture(cap, out var why))
                return new SingleCaptureResultDto { Success = false, Error = $"Mala captura: {why}" };

            _lastFid = cap!.Data;
            var pngB64 = FidToPngBase64(cap.Data!);

            var fmdPre = FidToPreFmd(cap.Data!, out var preFmt);
            var fmdVer = FidToVerFmd(cap.Data!);
            var fmdAnsi = FidToAnsiFmd(cap.Data!);

            var formats = new Dictionary<string, string>
            {
                [preFmt] = Fmd.SerializeXml(fmdPre),
                ["DP_VERIFICATION"] = Fmd.SerializeXml(fmdVer),
                ["ANSI"] = Fmd.SerializeXml(fmdAnsi)
            };

            return new SingleCaptureResultDto
            {
                Success = true,
                PngBase64 = pngB64,
                FmdXml = Fmd.SerializeXml(fmdVer), // Default a VER
                Formats = formats
            };
        }

        public async Task<VerifyLiveResultDto> VerifyLiveAsync(string templateXml, CancellationToken ct, int targetFarn = 21474)
        {
            OnStatus?.Invoke("Verificación en vivo... coloca el dedo.");
            RequestCaptureGentle(ct);

            if (!_sampleReady.Wait(TimeSpan.FromSeconds(10), ct))
                return new VerifyLiveResultDto { Success = false, Message = "Timeout en captura de verificación." };

            var cap = _lastCapture;
            if (!IsGoodCapture(cap, out var why))
                return new VerifyLiveResultDto { Success = false, Message = $"Mala captura: {why}" };

            _lastFid = cap!.Data;
            var templateFmd = Fmd.DeserializeXml(templateXml);

            var fxVer = FeatureExtraction.CreateFmdFromFid(cap.Data!, Constants.Formats.Fmd.DP_VERIFICATION);
            if (fxVer.ResultCode != Constants.ResultCode.DP_SUCCESS || fxVer.Data == null)
                return new VerifyLiveResultDto { Success = false, Message = $"CreateFmdFromFid VER falló: {fxVer.ResultCode}" };

            var probeVer = fxVer.Data;
            var cmp = Comparison.Compare(probeVer, 0, templateFmd, 0);

            if (cmp.ResultCode == Constants.ResultCode.DP_SUCCESS && cmp.Score != int.MaxValue)
            {
                bool matched = cmp.Score < targetFarn;
                return new VerifyLiveResultDto
                {
                    Success = matched,
                    Score = cmp.Score,
                    Threshold = targetFarn,
                    Method = "VER",
                    Message = matched ? "MATCH" : "NO MATCH"
                };
            }

            return new VerifyLiveResultDto
            {
                Success = false,
                Score = int.MaxValue,
                Message = $"Compare falló (rc={cmp.ResultCode}, score={(cmp.Score == int.MaxValue ? "MAX" : cmp.Score)})"
            };
        }

        public async Task<Identify1NResultDto> IdentifyLive1NAsync(CancellationToken ct, int targetFarn = 21474, int top = 5)
        {
            var all = AdvancedFingerprintStore.GetAllTemplates();
            if (all.Count == 0)
                return new Identify1NResultDto { Match = false, Message = "Galería vacía." };

            string galleryFmt;
            var gallery = all.Where(r => r.Format == "DP_REGISTRATION").ToList();
            if (gallery.Count > 0)
                galleryFmt = "DP_REGISTRATION";
            else
            {
                gallery = all.Where(r => r.Format == "DP_VERIFICATION").ToList();
                if (gallery.Count > 0)
                    galleryFmt = "DP_VERIFICATION";
                else
                {
                    gallery = all.Where(r => r.Format == "ANSI").ToList();
                    if (gallery.Count == 0)
                        return new Identify1NResultDto { Match = false, Message = "No hay REG/VER/ANSI en galería." };
                    galleryFmt = "ANSI";
                }
            }

            OnStatus?.Invoke($"Identificación 1:N... coloca el dedo. (galería: {galleryFmt})");
            RequestCaptureGentle(ct);

            if (!_sampleReady.Wait(TimeSpan.FromSeconds(12), ct))
                return new Identify1NResultDto { Match = false, Message = "Timeout en captura de identificación." };

            var cap = _lastCapture;
            if (!IsGoodCapture(cap, out var why))
                return new Identify1NResultDto { Match = false, Message = $"Mala captura: {why}" };

            _lastFid = cap!.Data;

            Fmd? probe = null;
            string usedProbe = "";

            if (galleryFmt is "DP_REGISTRATION" or "DP_VERIFICATION")
            {
                var fx = FeatureExtraction.CreateFmdFromFid(cap.Data!, Constants.Formats.Fmd.DP_VERIFICATION);
                if (fx.ResultCode == Constants.ResultCode.DP_SUCCESS) { probe = fx.Data; usedProbe = "VER"; }
            }
            else
            {
                var fx = FeatureExtraction.CreateFmdFromFid(cap.Data!, Constants.Formats.Fmd.ANSI);
                if (fx.ResultCode == Constants.ResultCode.DP_SUCCESS) { probe = fx.Data; usedProbe = "ANSI"; }
            }

            if (probe == null)
                return new Identify1NResultDto { Match = false, Message = "No se pudo generar el probe." };

            var ranking = new List<(string id, int score)>(gallery.Count);
            int best = int.MaxValue;
            string bestId = "";

            foreach (var cand in gallery)
            {
                var candidateFmd = Fmd.DeserializeXml(cand.TemplateXml);
                var c = Comparison.Compare(probe, 0, candidateFmd, 0);
                if (c.ResultCode != Constants.ResultCode.DP_SUCCESS || c.Score == int.MaxValue) continue;

                ranking.Add((cand.Id, c.Score));
                if (c.Score < best) { best = c.Score; bestId = cand.Id; }
            }

            if (ranking.Count == 0)
                return new Identify1NResultDto { Match = false, Message = "Compare inválido para toda la galería." };

            ranking.Sort((a, b) => a.score.CompareTo(b.score));
            var topK = ranking.Take(Math.Max(1, top)).Select(x => (object)new { tag = x.id, score = x.score }).ToList();

            bool match = best < targetFarn;
            var msg = match
                ? $"MATCH (score={best}, probe={usedProbe}, galería={galleryFmt}) → {bestId}"
                : $"NO MATCH (mejor score={best} ≥ {targetFarn}, probe={usedProbe}, galería={galleryFmt})";

            return new Identify1NResultDto
            {
                Match = match,
                BestScore = best,
                BestTag = bestId,
                GalleryFormat = galleryFmt,
                TopK = topK,
                Message = msg
            };
        }

        public async Task<EnrollAdvancedResultDto> EnrollAdvancedAsync(int samples, int targetFarn, int maxRetriesPerSample, CancellationToken ct)
        {
            // Usa el método de enrolamiento estándar pero con parámetros avanzados
            var result = await EnrollAsync(samples, ct);
            return new EnrollAdvancedResultDto
            {
                Success = result.Success,
                TemplateXml = result.TemplateXml,
                Method = result.Method,
                SamplesUsed = result.SamplesUsed,
                Error = result.Error
            };
        }
    }
}