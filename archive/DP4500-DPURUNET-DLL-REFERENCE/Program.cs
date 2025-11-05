// Program.cs — DP4500 (DPUruNet) lector + enrolamiento / verificación 1:1 y 1:N (FIX score=2147483647)
// Windows + .NET 6/7. Referencia DPUruNet.dll. dpfpdd.dll/dpfj.dll (x86/x64) junto al exe.

#nullable enable
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Threading;
using System.Drawing;
using System.Drawing.Imaging;
using DPUruNet;

[assembly: DefaultDllImportSearchPaths(
    DllImportSearchPath.AssemblyDirectory |
    DllImportSearchPath.ApplicationDirectory |
    DllImportSearchPath.System32 |
    DllImportSearchPath.SafeDirectories)]

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

    public static void Bootstrap(params string[] extraDirs)
    {
        if (!SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_DEFAULT_DIRS | LOAD_LIBRARY_SEARCH_USER_DIRS))
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "SetDefaultDllDirectories()");
        foreach (var dir in extraDirs)
            if (!string.IsNullOrWhiteSpace(dir) && Directory.Exists(dir))
                AddDllDirectory(dir);
        foreach (var dll in new[] { "dpfpdd.dll", "dpfj.dll" }) LoadLibraryW(dll);
    }
}

/* ===============================
 * Store temporal (thread-safe)
 * ===============================*/
public sealed class StoredFmd
{
    public required string Tag { get; init; }
    public required string Format { get; init; } // DP_PRE_REGISTRATION / DP_VERIFICATION / DP_REGISTRATION / ANSI
    public required DateTime Utc { get; init; }
    public required Fmd Fmd { get; init; }
    public required int Bytes { get; init; }
    public required int XmlLength { get; init; }
    public required string XmlPreview { get; init; }
    public required string Sha1 { get; init; }
}

public static class FingerprintTempStore
{
    private static readonly object _sync = new();
    private static readonly List<StoredFmd> _fmds = new();

    public static StoredFmd Add(string tag, string formatName, Fmd fmd, bool keepXmlPreview = false)
    {
        var xml = keepXmlPreview ? Fmd.SerializeXml(fmd) : string.Empty;
        using var sha1 = SHA1.Create();
        var bytes = fmd.Bytes ?? Array.Empty<byte>();
        var sha = BitConverter.ToString(sha1.ComputeHash(bytes)).Replace("-", "");

        var rec = new StoredFmd
        {
            Tag = tag,
            Format = formatName,
            Utc = DateTime.UtcNow,
            Fmd = fmd,
            Bytes = bytes.Length,
            XmlLength = keepXmlPreview ? xml.Length : 0,
            XmlPreview = keepXmlPreview ? (xml.Length > 160 ? xml[..160] + "…" : xml) : "(omitido)",
            Sha1 = sha
        };
        lock (_sync) _fmds.Add(rec);
        return rec;
    }

    public static IReadOnlyList<StoredFmd> All() { lock (_sync) return _fmds.ToList(); }
    public static void Clear() { lock (_sync) _fmds.Clear(); }
}

/* ===============================
 * Servicio DP4500 (EXCLUSIVE)
 * ===============================*/
public sealed class Dp4500Service : IDisposable
{
    private readonly ManualResetEventSlim _sampleReady = new(false);
    private volatile CaptureResult? _lastCapture;
    private volatile Fid? _lastFid;
    private bool _subscribed;
    private int _dpi = 500;

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

    public event Action<string>? OnStatus;
    public event Action<int>? OnSampleCountChanged;
    public event Action<int, bool, string?>? OnAttemptResult;

    private const int TARGET_FARN_ENROLL_CHECK = 100_000; // filtro intra-enrolamiento

    public void Init()
    {
        if (!_subscribed) { Reader.On_Captured += OnCaptured; _subscribed = true; }
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

    // ---- FID -> FMDs ----
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

    private static void PrintFidMeta(Fid fid, CaptureResult cap)
    {
        var v = fid.Views[0];
        Console.WriteLine($"[FID] {v.Width}x{v.Height} px  raw={v.RawImage?.Length ?? 0} bytes  quality={cap.Quality}");
    }

    // === FIX: comparación robusta con fallback y descarte de score=Int32.MaxValue ===
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

    // ==== Persistencia de FID ====
    public static string SaveFidAsPng(Fid fid, string filePath)
    {
        var v = fid.Views[0];
        using var bmp = new Bitmap(v.Width, v.Height, PixelFormat.Format8bppIndexed);
        var pal = bmp.Palette; for (int i = 0; i < 256; i++) pal.Entries[i] = Color.FromArgb(i, i, i);
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
        bmp.Save(filePath, ImageFormat.Png);
        return filePath;
    }

    public static string FidToXmlBase64(Fid fid)
    {
        var v = fid.Views[0];
        var b64 = Convert.ToBase64String(v.RawImage ?? Array.Empty<byte>());
        return $"<FidImage width=\"{v.Width}\" height=\"{v.Height}\"><Raw8bpp>{b64}</Raw8bpp></FidImage>";
    }

    // ==== Captura simple (S) ====
    public void SingleCapture(CancellationToken ct)
    {
        Init();
        OnStatus?.Invoke("Captura simple… coloca el dedo.");
        RequestCaptureGentle(ct);

        if (!_sampleReady.Wait(TimeSpan.FromSeconds(10), ct))
            throw new TimeoutException("Timeout en captura simple.");

        var cap = _lastCapture;
        if (!IsGoodCapture(cap, out var why))
            throw new InvalidOperationException($"Mala captura: {why}");

        PrintFidMeta(cap!.Data!, cap);
        _lastFid = cap.Data;

        var preFmt = "";
        var fmdPre = FidToPreFmd(cap.Data!, out preFmt);
        var fmdVer = FidToVerFmd(cap.Data!);
        var fmdAnsi = FidToAnsiFmd(cap.Data!);

        var t = $"{DateTime.UtcNow:yyyyMMdd-HHmmss}";
        var recPre = FingerprintTempStore.Add($"PRE-{t}", preFmt, fmdPre, keepXmlPreview: false);
        var recVer = FingerprintTempStore.Add($"VER-{t}", "DP_VERIFICATION", fmdVer, keepXmlPreview: true);
        var recAnsi = FingerprintTempStore.Add($"ANSI-{t}", "ANSI", fmdAnsi, keepXmlPreview: false);

        PrintFmdSummary(recPre, "[PRE] ");
        PrintFmdFull(recVer, "[VER] ");
        PrintFmdSummary(recAnsi, "[ANS] ");
    }

    // ==== Selección de la mejor tríada (VER→ANSI) ====
    private (bool ok, int i, int j, int k) FindBestTriad(List<Fmd> verList, List<Fmd> ansiList, int targetFarn)
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

    private (bool ok, Fmd? fmdReg, string msg) TryEnrollmentWithStrategies(List<Fmd> preList, List<Fmd> ansiList, List<Fmd> verList)
    {
        var enr = Enrollment.CreateEnrollmentFmd(Constants.Formats.Fmd.DP_REGISTRATION, preList.ToArray());
        if (enr.ResultCode == Constants.ResultCode.DP_SUCCESS && enr.Data != null)
            return (true, enr.Data, "REG desde PRE[]");

        var tri = FindBestTriad(verList, ansiList, TARGET_FARN_ENROLL_CHECK);
        if (tri.ok)
        {
            var sel = new[] { preList[tri.i], preList[tri.j], preList[tri.k] };
            var enrSel = Enrollment.CreateEnrollmentFmd(Constants.Formats.Fmd.DP_REGISTRATION, sel);
            if (enrSel.ResultCode == Constants.ResultCode.DP_SUCCESS && enrSel.Data != null)
                return (true, enrSel.Data, "REG desde mejor tríada PRE");
        }

        var enrA = Enrollment.CreateEnrollmentFmd(Constants.Formats.Fmd.DP_REGISTRATION, ansiList.ToArray());
        if (enrA.ResultCode == Constants.ResultCode.DP_SUCCESS && enrA.Data != null)
            return (true, enrA.Data, "REG desde ANSI[]");

        if (tri.ok)
        {
            var selA = new[] { ansiList[tri.i], ansiList[tri.j], ansiList[tri.k] };
            var enrSelA = Enrollment.CreateEnrollmentFmd(Constants.Formats.Fmd.DP_REGISTRATION, selA);
            if (enrSelA.ResultCode == Constants.ResultCode.DP_SUCCESS && enrSelA.Data != null)
                return (true, enrSelA.Data, "REG desde mejor tríada ANSI");
        }

        return (false, null, "NOT_READY");
    }

    // ===== Verificación en vivo contra un REG dado =====
    public (bool ok, int score, string used, string msg) VerifyLiveAgainstReg(
        Fmd reg, CancellationToken ct, int targetFarn = 21474)
    {
        OnStatus?.Invoke("Verificación en vivo… coloca el dedo.");
        RequestCaptureGentle(ct);
        if (!_sampleReady.Wait(TimeSpan.FromSeconds(10), ct))
            return (false, int.MaxValue, "TIMEOUT", "Timeout en captura de verificación.");

        var cap = _lastCapture;
        if (!IsGoodCapture(cap, out var why))
            return (false, int.MaxValue, "BAD", $"Mala captura: {why}");

        _lastFid = cap!.Data;

        var fxVer = FeatureExtraction.CreateFmdFromFid(cap.Data!, Constants.Formats.Fmd.DP_VERIFICATION);
        if (fxVer.ResultCode != Constants.ResultCode.DP_SUCCESS || fxVer.Data == null)
            return (false, int.MaxValue, "VER", $"CreateFmdFromFid VER falló: {fxVer.ResultCode}");
        var probeVer = fxVer.Data;

        var fxAnsi = FeatureExtraction.CreateFmdFromFid(cap.Data!, Constants.Formats.Fmd.ANSI);
        var probeAnsi = (fxAnsi.ResultCode == Constants.ResultCode.DP_SUCCESS) ? fxAnsi.Data : null;

        var cmp = Comparison.Compare(probeVer, 0, reg, 0);
        if (cmp.ResultCode == Constants.ResultCode.DP_SUCCESS && cmp.Score != int.MaxValue)
            return (cmp.Score < targetFarn, cmp.Score, "VER", (cmp.Score < targetFarn) ? "MATCH" : "NO MATCH");

        if (probeAnsi != null)
        {
            var cmp2 = Comparison.Compare(probeAnsi, 0, reg, 0);
            if (cmp2.ResultCode == Constants.ResultCode.DP_SUCCESS && cmp2.Score != int.MaxValue)
                return (cmp2.Score < targetFarn, cmp2.Score, "ANSI", (cmp2.Score < targetFarn) ? "MATCH" : "NO MATCH");
        }

        return (false, int.MaxValue, "FAIL", $"Compare falló (rc={cmp.ResultCode}, score={(cmp.Score == int.MaxValue ? "MAX" : cmp.Score)})");
    }

    // ===== 1:N en vivo contra galería (REG→VER→ANSI) =====
    public (bool match, int bestScore, string bestTag, string galleryFormat, List<(string tag, int score)> topK, string msg)
        IdentifyLive1N(CancellationToken ct, int targetFarn = 21474, int top = 5)
    {
        var all = FingerprintTempStore.All();
        if (all.Count == 0) return (false, int.MaxValue, "", "", new(), "Galería vacía.");

        string galleryFmt;
        var gallery = all.Where(r => r.Format == "DP_REGISTRATION").ToList();
        if (gallery.Count > 0) galleryFmt = "DP_REGISTRATION";
        else
        {
            gallery = all.Where(r => r.Format == "DP_VERIFICATION").ToList();
            if (gallery.Count > 0) galleryFmt = "DP_VERIFICATION";
            else
            {
                gallery = all.Where(r => r.Format == "ANSI").ToList();
                if (gallery.Count == 0) return (false, int.MaxValue, "", "", new(), "No hay REG/VER/ANSI en galería.");
                galleryFmt = "ANSI";
            }
        }

        OnStatus?.Invoke($"Identificación 1:N… coloca el dedo. (galería: {galleryFmt})");
        RequestCaptureGentle(ct);
        if (!_sampleReady.Wait(TimeSpan.FromSeconds(12), ct))
            return (false, int.MaxValue, "", galleryFmt, new(), "Timeout en captura de identificación.");

        var cap = _lastCapture;
        if (!IsGoodCapture(cap, out var why))
            return (false, int.MaxValue, "", galleryFmt, new(), $"Mala captura: {why}");

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
        if (probe == null) return (false, int.MaxValue, "", galleryFmt, new(), "No se pudo generar el probe.");

        var ranking = new List<(string tag, int score)>(gallery.Count);
        int best = int.MaxValue; string bestTag = "";
        foreach (var cand in gallery)
        {
            var c = Comparison.Compare(probe, 0, cand.Fmd, 0);
            if (c.ResultCode != Constants.ResultCode.DP_SUCCESS || c.Score == int.MaxValue) continue; // IGNORA inválidos
            ranking.Add((cand.Tag, c.Score));
            if (c.Score < best) { best = c.Score; bestTag = cand.Tag; }
        }

        if (ranking.Count == 0) return (false, int.MaxValue, "", galleryFmt, new(), "Compare inválido para toda la galería.");

        ranking.Sort((a, b) => a.score.CompareTo(b.score));
        var topK = ranking.Take(Math.Max(1, top)).ToList();

        bool match = best < targetFarn;
        var msg = match
            ? $"MATCH (score={best}, probe={usedProbe}, galería={galleryFmt}) → {bestTag}"
            : $"NO MATCH (mejor score={best} ≥ {targetFarn}, probe={usedProbe}, galería={galleryFmt})";

        return (match, best, bestTag, galleryFmt, topK, msg);
    }

    // ===== Enrolamiento progresivo (4 tomas) con gate robusto =====
    public (bool ok, Fmd? fmdReg, string msg) Enroll3(
        CancellationToken ct,
        int targetFarn = 21474,
        int maxRetriesPerSample = 3,
        int maxSamples = 4)
    {
        Init();

        var preList = new List<Fmd>(maxSamples);
        var ansiList = new List<Fmd>(maxSamples);
        var verList = new List<Fmd>(maxSamples);

        Fmd? verFirst = null, ansiFirst = null;

        for (int sampleIndex = 0; sampleIndex < maxSamples; sampleIndex++)
        {
            int attempt = 0;
            while (true)
            {
                ct.ThrowIfCancellationRequested();

                OnStatus?.Invoke($"Coloca el dedo (muestra {sampleIndex + 1}/{maxSamples})… levanta y recoloca cada vez.");
                RequestCaptureGentle(ct);

                if (!_sampleReady.Wait(TimeSpan.FromSeconds(10), ct))
                { OnAttemptResult?.Invoke(sampleIndex + 1, false, "timeout"); return (false, null, $"Timeout en muestra {sampleIndex + 1}"); }

                var cap = _lastCapture;
                if (!IsGoodCapture(cap, out var why))
                {
                    attempt++; OnAttemptResult?.Invoke(sampleIndex + 1, false, $"mala captura: {why}");
                    if (attempt >= maxRetriesPerSample) return (false, null, $"Muestra {sampleIndex + 1}: calidad insuficiente ({why}).");
                    Thread.Sleep(140); continue;
                }

                PrintFidMeta(cap!.Data!, cap);
                _lastFid = cap.Data;

                var preFmt = "";
                var fmdPre = FidToPreFmd(cap.Data!, out preFmt);
                var fmdVer = FidToVerFmd(cap.Data!);
                var fmdAnsi = FidToAnsiFmd(cap.Data!);

                var t = $"{DateTime.UtcNow:yyyyMMdd-HHmmss}";
                var recPre = FingerprintTempStore.Add($"PRE-{sampleIndex + 1}-{t}", preFmt, fmdPre, keepXmlPreview: false);
                var recVer = FingerprintTempStore.Add($"VER-{sampleIndex + 1}-{t}", "DP_VERIFICATION", fmdVer, keepXmlPreview: true);
                var recAnsi = FingerprintTempStore.Add($"ANSI-{sampleIndex + 1}-{t}", "ANSI", fmdAnsi, keepXmlPreview: false);

                PrintFmdSummary(recPre, "[PRE] ");
                PrintFmdFull(recVer, "[VER] ");
                PrintFmdSummary(recAnsi, "[ANS] ");

                if (verFirst == null) { verFirst = fmdVer; ansiFirst = fmdAnsi; }
                else
                {
                    var (rcOk, score, used) = CompareSafe(fmdVer, verFirst!, fmdAnsi, ansiFirst!, TARGET_FARN_ENROLL_CHECK);
                    if (!rcOk)
                    {
                        attempt++; OnAttemptResult?.Invoke(sampleIndex + 1, false, $"compare inválido ({used})");
                        if (attempt >= maxRetriesPerSample) return (false, null, $"Muestra {sampleIndex + 1}: compare inválido ({used}).");
                        Thread.Sleep(160); continue;
                    }
                    if (score >= TARGET_FARN_ENROLL_CHECK)
                    {
                        attempt++; OnAttemptResult?.Invoke(sampleIndex + 1, false, $"no coincide (score={(score == int.MaxValue ? "MAX" : score)})");
                        if (attempt >= maxRetriesPerSample) return (false, null, $"Muestra {sampleIndex + 1} no coincide. Score={(score == int.MaxValue ? "MAX" : score)}");
                        Thread.Sleep(160); continue;
                    }
                }

                preList.Add(fmdPre);
                verList.Add(fmdVer);
                ansiList.Add(fmdAnsi);

                OnSampleCountChanged?.Invoke(preList.Count);
                OnAttemptResult?.Invoke(sampleIndex + 1, true, "ok");

                Thread.Sleep(220);
                break;
            }

            if (preList.Count >= 3)
            {
                var (ok, reg, regMsg) = TryEnrollmentWithStrategies(preList, ansiList, verList);
                if (ok && reg != null)
                {
                    var recReg = FingerprintTempStore.Add($"REG-{DateTime.UtcNow:yyyyMMdd-HHmmss}", "DP_REGISTRATION", reg, keepXmlPreview: true);
                    PrintFmdFull(recReg, "[REG] ");
                    return (true, reg, $"Enrolamiento exitoso ({regMsg}).");
                }
            }
        }

        try
        {
            if (_lastFid != null)
            {
                var regFx = FeatureExtraction.CreateFmdFromFid(_lastFid, Constants.Formats.Fmd.DP_REGISTRATION);
                if (regFx.ResultCode == Constants.ResultCode.DP_SUCCESS && regFx.Data != null)
                {
                    var recReg = FingerprintTempStore.Add($"REG-{DateTime.UtcNow:yyyyMMdd-HHmmss}", "DP_REGISTRATION", regFx.Data, keepXmlPreview: true);
                    PrintFmdFull(recReg, "[REG*] ");
                    return (true, regFx.Data, "Enrolamiento (REG directo desde FID).");
                }
            }
        }
        catch { }

        return (false, null, "Enrollment falló: DP_ENROLLMENT_NOT_READY.");
    }

    // ===== helpers de impresión =====
    public static void PrintFmdSummary(StoredFmd rec, string prefix = "")
    {
        Console.WriteLine($"{prefix}Tag={rec.Tag}  Format={rec.Format}  Bytes={rec.Bytes}  XmlLen={rec.XmlLength}  SHA1={rec.Sha1}  Utc={rec.Utc:O}");
    }
    public static void PrintFmdFull(StoredFmd rec, string prefix = "")
    {
        Console.WriteLine($"{prefix}Tag={rec.Tag}  Format={rec.Format}  Bytes={rec.Bytes}  XmlLen={rec.XmlLength}  SHA1={rec.Sha1}  Utc={rec.Utc:O}");
        Console.WriteLine($"{prefix}XML: {rec.XmlPreview}");
    }

    public void Dispose()
    {
        try
        {
            if (_subscribed) { Reader.On_Captured -= OnCaptured; _subscribed = false; }
            try { Reader.CancelCapture(); } catch { }
        }
        catch { }
        if (_readerLazy.IsValueCreated) { try { Reader.Dispose(); } catch { } }
        _sampleReady.Dispose();
    }
}

/* ===============================
 * App consola (E, V, R, N, L, C, S, W, Q)
 * ===============================*/
internal static class Program
{
    private const int TargetFarn = 21474;
    private const int TopK = 5;

    private static void Help()
    {
        Console.WriteLine(@"
DP4500 (DPUruNet) – EXCLUSIVE
=============================
Teclas:
  E : Enrolar (4 capturas). Guarda PRE/VER/ANSI y REG
  V : Verificación EN VIVO contra la mejor referencia del store (REG→VER→ANSI)
  R : Verificación EN VIVO contra el último REG (1:1)
  N : Identificación EN VIVO 1:N (ranking y TOP-K)
  L : Listar plantillas del store (tag/format/bytes/xmlLen/SHA1)
  C : Limpiar store temporal
  S : Captura simple (genera PRE/VER/ANSI de una toma)
  W : Guardar PNG del último FID bueno en la carpeta del exe
  Q : Salir
");
    }

    private static void Main(string[] args)
    {
        var baseDir = AppContext.BaseDirectory;
        NativeLoader.Bootstrap(Path.Combine(baseDir, "x86"), Path.Combine(baseDir, "x64"));

        Help();

        using var svc = new Dp4500Service();
        svc.OnStatus += m => Console.WriteLine("[STATUS] " + m);
        svc.OnSampleCountChanged += c => Console.WriteLine($"[ENROLL] muestras OK = {c}/4");
        svc.OnAttemptResult += (n, ok, d) => Console.WriteLine(ok ? $"[TRY] muestra {n}: OK" : $"[TRY] muestra {n}: FAIL ({d})");

        Console.WriteLine("Listo. (E=Enroll, V=Live, R=LiveReg, N=1:N, L=Listar, C=Clear, S=Single, W=PNG, Q=Salir)");

        while (true)
        {
            var key = Console.ReadKey(intercept: true).Key;
            if (key == ConsoleKey.Q) break;

            try
            {
                switch (key)
                {
                    case ConsoleKey.E:
                        {
                            using var cts = new CancellationTokenSource(TimeSpan.FromMinutes(1));
                            var (ok, _, msg) = svc.Enroll3(cts.Token, maxSamples: 4);
                            Console.WriteLine(ok ? $"✅ {msg}" : $"❌ {msg}");
                            break;
                        }
                    case ConsoleKey.V:
                        {
                            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(25));
                            var r = svc.IdentifyLive1N(cts.Token, TargetFarn, top: 1);
                            if (!string.IsNullOrEmpty(r.bestTag)) Console.WriteLine($"[REF] {r.bestTag}");
                            Console.WriteLine(r.match
                                ? $"VERIFICACIÓN EN VIVO: MATCH ✅  score={r.bestScore} (galería={r.galleryFormat})"
                                : $"VERIFICACIÓN EN VIVO: ❌  {r.msg}  (score={(r.bestScore == int.MaxValue ? "N/A" : r.bestScore)})");
                            break;
                        }
                    case ConsoleKey.R:
                        {
                            var reg = FingerprintTempStore.All().LastOrDefault(r => r.Format == "DP_REGISTRATION");
                            if (reg == null) { Console.WriteLine("No hay REG en store. Primero enrola (E)."); break; }

                            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(25));
                            var (ok, score, used, msg) = svc.VerifyLiveAgainstReg(reg.Fmd, cts.Token, TargetFarn);
                            Console.WriteLine(ok
                                ? $"VERIFICACIÓN EN VIVO contra REG: MATCH ✅  score={score}  (usando {used})"
                                : $"VERIFICACIÓN EN VIVO contra REG: ❌  {msg}  (usando {used}, score={(score == int.MaxValue ? "N/A" : score)})");
                            break;
                        }
                    case ConsoleKey.N:
                        {
                            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
                            var r = svc.IdentifyLive1N(cts.Token, TargetFarn, TopK);
                            Console.WriteLine(r.match
                                ? $"IDENT 1:N: MATCH ✅  mejor={r.bestTag} score={r.bestScore}  galería={r.galleryFormat}"
                                : $"IDENT 1:N: ❌  {r.msg}");
                            if (r.topK.Count > 0)
                            {
                                Console.WriteLine("TOP:");
                                int rank = 1;
                                foreach (var c in r.topK)
                                    Console.WriteLine($"  {rank++}. {c.tag}  score={c.score}");
                            }
                            break;
                        }
                    case ConsoleKey.L:
                        {
                            var all = FingerprintTempStore.All();
                            if (all.Count == 0) { Console.WriteLine("(store vacío)"); break; }
                            foreach (var r in all)
                            {
                                if (r.Format == "DP_VERIFICATION") Dp4500Service.PrintFmdFull(r, "- ");
                                else Dp4500Service.PrintFmdSummary(r, "- ");
                            }
                            break;
                        }
                    case ConsoleKey.C:
                        FingerprintTempStore.Clear(); Console.WriteLine("Store temporal limpiado."); break;

                    case ConsoleKey.S:
                        {
                            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));
                            svc.SingleCapture(cts.Token);
                            break;
                        }

                    case ConsoleKey.W:
                        {
                            try
                            {
                                var fidField = typeof(Dp4500Service).GetField("_lastFid", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);
                                var fidVal = fidField?.GetValue(svc) as Fid;
                                if (fidVal == null) { Console.WriteLine("No hay FID en memoria. Captura nuevamente."); break; }

                                var path = Path.Combine(AppContext.BaseDirectory, $"FID-{DateTime.Now:yyyyMMdd-HHmmss}.png");
                                var saved = Dp4500Service.SaveFidAsPng(fidVal, path);
                                Console.WriteLine($"[FID] PNG guardado: {saved}");
                            }
                            catch (Exception ex) { Console.WriteLine($"[FID] dump fallo: {ex.Message}"); }
                            break;
                        }

                    default: Help(); break;
                }
            }
            catch (OperationCanceledException) { Console.WriteLine("Cancelado / timeout."); }
            catch (Exception ex) { Console.WriteLine("Error: " + ex.Message); }
        }
    }
}
