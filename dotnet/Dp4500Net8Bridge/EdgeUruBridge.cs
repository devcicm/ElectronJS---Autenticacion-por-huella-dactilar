using System;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;

namespace Dp4500Net8Bridge
{
    /// <summary>
    /// Bridge compatible con electron-edge-js para .NET Framework 4.8
    /// Mantiene compatibilidad total con la interfaz existente pero usa algoritmos avanzados
    /// </summary>
    public sealed class EdgeUruBridge
    {
        private static AdvancedDp4500Service _service;
        private static Func<object, Task> _notify;
        private static readonly object _lock = new object();

        public async Task<object> Invoke(dynamic input)
        {
            var action = (string)input.action;

            try
            {
                _notify = _notify ?? (Func<object, Task>)input.onEvent;
            }
            catch
            {
                // onEvent es opcional
            }

            lock (_lock)
            {
                if (_service == null && action != "dispose")
                {
                    _service = new AdvancedDp4500Service();

                    // Eventos compatibles con la interfaz anterior
                    _service.OnStatus += async (msg) => await NotifySafe(new { type = "status", message = msg });
                    _service.OnSampleCountChanged += async (count) => await NotifySafe(new { type = "sample-count", count });
                    _service.OnAttemptResult += async (sample, success, details) =>
                        await NotifySafe(new { type = "attempt-result", sample, success, details });
                    _service.OnFingerCaptured += async (attempt, bytes, pngB64) =>
                        await NotifySafe(new { type = "finger-captured", attempt, bytes, pngB64 });
                }
            }

            try
            {
                switch (action)
                {
                    case "init":
                        return await HandleInit();
                    case "dispose":
                        return await HandleDispose();
                    case "cancel":
                        return await HandleCancel();
                    case "capture":
                        return await HandleCapture(input);
                    case "verify":
                        return await HandleVerify(input);
                    case "enroll.captureN":
                        return await HandleEnroll(input);
                    case "store.save":
                        return await HandleStoreSave(input);
                    case "store.get":
                        return await HandleStoreGet(input);
                    case "store.delete":
                        return await HandleStoreDelete(input);
                    case "store.clear":
                        return await HandleStoreClear();
                    case "reader.info":
                        return await HandleReaderInfo();

                    // Nuevas funcionalidades avanzadas
                    case "identify.1n":
                        return await HandleIdentify1N(input);
                    case "enroll.advanced":
                        return await HandleAdvancedEnroll(input);
                    case "verify.live":
                        return await HandleVerifyLive(input);
                    case "store.list":
                        return await HandleStoreList();
                    case "capture.single":
                        return await HandleSingleCapture();

                    default:
                        return new { ok = false, error = "unknown_action" };
                }
            }
            catch (OperationCanceledException)
            {
                return new { ok = false, error = "operation_cancelled" };
            }
            catch (Exception ex)
            {
                await NotifySafe(new { type = "error", message = ex.Message });
                return new { ok = false, error = ex.Message };
            }
        }

        private async Task<object> HandleInit()
        {
            if (_service == null) return new { ok = false, error = "Service not initialized" };

            try
            {
                _service.Init();
                await NotifySafe(new { type = "ready", message = "Sistema inicializado" });
                return new { ok = true };
            }
            catch (Exception ex)
            {
                return new { ok = false, error = ex.Message };
            }
        }

        private async Task<object> HandleDispose()
        {
            lock (_lock)
            {
                _service?.Dispose();
                _service = null;
            }
            await NotifySafe(new { type = "disposed" });
            return new { ok = true };
        }

        private async Task<object> HandleCancel()
        {
            _service?.Cancel();
            await NotifySafe(new { type = "cancelled" });
            return new { ok = true };
        }

        private async Task<object> HandleCapture(dynamic input)
        {
            if (_service == null) return new { ok = false, error = "Service not initialized" };

            int attempts = 3;
            try { attempts = (int)input.payload.maxAttempts; } catch { }

            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(60));

            try
            {
                var result = await _service.CaptureWithAttemptsAsync(attempts, cts.Token);
                return new
                {
                    ok = result.Success,
                    attempts = result.Attempts,
                    pngB64 = result.PngBase64,
                    fmdXml = result.FmdXml,
                    error = result.Error
                };
            }
            catch (Exception ex)
            {
                return new { ok = false, error = ex.Message };
            }
        }

        private async Task<object> HandleVerify(dynamic input)
        {
            if (_service == null) return new { ok = false, error = "Service not initialized" };

            try
            {
                var enrolledXml = (string)input.payload.enrolledXml;
                string? liveXml = null;
                int farDenominator = 100000;

                try { liveXml = (string)input.payload.liveXml; } catch { }
                try { farDenominator = (int)input.payload.farDenominator; } catch { }

                var result = await _service.VerifyAsync(enrolledXml, liveXml, farDenominator);
                return new
                {
                    ok = true,
                    matched = result.Matched,
                    score = result.Score,
                    threshold = result.Threshold,
                    confidence = result.Confidence,
                    method = result.Method
                };
            }
            catch (Exception ex)
            {
                return new { ok = false, error = ex.Message };
            }
        }

        private async Task<object> HandleEnroll(dynamic input)
        {
            if (_service == null) return new { ok = false, error = "Service not initialized" };

            int samples = 4;
            try { samples = (int)input.payload.samples; } catch { }

            using var cts = new CancellationTokenSource(TimeSpan.FromMinutes(2));

            try
            {
                var result = await _service.EnrollAsync(samples, cts.Token);
                if (result.Success)
                {
                    return new { ok = true, templateXml = result.TemplateXml, method = result.Method };
                }
                else
                {
                    return new { ok = false, error = result.Error };
                }
            }
            catch (Exception ex)
            {
                return new { ok = false, error = ex.Message };
            }
        }

        private async Task<object> HandleStoreSave(dynamic input)
        {
            try
            {
                var id = (string)input.payload.id;
                var templateXml = (string)input.payload.templateXml;
                int ttlSeconds = 0;
                try { ttlSeconds = (int)input.payload.ttlSeconds; } catch { }

                var ttl = ttlSeconds > 0 ? TimeSpan.FromSeconds(ttlSeconds) : (TimeSpan?)null;
                AdvancedFingerprintStore.SaveTemplate(id, templateXml, ttl);

                return new { ok = true };
            }
            catch (Exception ex)
            {
                return new { ok = false, error = ex.Message };
            }
        }

        private async Task<object> HandleStoreGet(dynamic input)
        {
            try
            {
                var id = (string)input.payload.id;
                var template = AdvancedFingerprintStore.GetTemplate(id);

                if (template == null)
                {
                    return new { ok = false, error = "not_found" };
                }

                return new { ok = true, templateXml = template.TemplateXml, format = template.Format };
            }
            catch (Exception ex)
            {
                return new { ok = false, error = ex.Message };
            }
        }

        private async Task<object> HandleStoreDelete(dynamic input)
        {
            try
            {
                var id = (string)input.payload.id;
                var removed = AdvancedFingerprintStore.RemoveTemplate(id);
                return new { ok = removed };
            }
            catch (Exception ex)
            {
                return new { ok = false, error = ex.Message };
            }
        }

        private async Task<object> HandleStoreClear()
        {
            AdvancedFingerprintStore.Clear();
            return new { ok = true };
        }

        private async Task<object> HandleReaderInfo()
        {
            if (_service == null) return new { ok = false, error = "Service not initialized" };

            try
            {
                var info = _service.GetReaderInfo();
                return new
                {
                    ok = info.Success,
                    description = info.Description,
                    guid = info.Guid,
                    serialNumber = info.SerialNumber,
                    productName = info.ProductName,
                    error = info.Error
                };
            }
            catch (Exception ex)
            {
                return new { ok = false, error = ex.Message };
            }
        }

        // ===== NUEVAS FUNCIONALIDADES AVANZADAS =====

        private async Task<object> HandleIdentify1N(dynamic input)
        {
            if (_service == null) return new { ok = false, error = "Service not initialized" };

            try
            {
                int targetFarn = 21474;
                int topK = 5;
                try { targetFarn = (int)input.payload.targetFarn; } catch { }
                try { topK = (int)input.payload.topK; } catch { }

                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
                var result = await _service.IdentifyLive1NAsync(cts.Token, targetFarn, topK);

                return new
                {
                    ok = true,
                    match = result.Match,
                    bestScore = result.BestScore,
                    bestTag = result.BestTag,
                    galleryFormat = result.GalleryFormat,
                    topK = result.TopK,
                    message = result.Message
                };
            }
            catch (Exception ex)
            {
                return new { ok = false, error = ex.Message };
            }
        }

        private async Task<object> HandleAdvancedEnroll(dynamic input)
        {
            if (_service == null) return new { ok = false, error = "Service not initialized" };

            try
            {
                int samples = 4;
                int targetFarn = 21474;
                int maxRetriesPerSample = 3;

                try { samples = (int)input.payload.samples; } catch { }
                try { targetFarn = (int)input.payload.targetFarn; } catch { }
                try { maxRetriesPerSample = (int)input.payload.maxRetriesPerSample; } catch { }

                using var cts = new CancellationTokenSource(TimeSpan.FromMinutes(3));
                var result = await _service.EnrollAdvancedAsync(samples, targetFarn, maxRetriesPerSample, cts.Token);

                return new
                {
                    ok = result.Success,
                    templateXml = result.TemplateXml,
                    method = result.Method,
                    samplesUsed = result.SamplesUsed,
                    error = result.Error
                };
            }
            catch (Exception ex)
            {
                return new { ok = false, error = ex.Message };
            }
        }

        private async Task<object> HandleVerifyLive(dynamic input)
        {
            if (_service == null) return new { ok = false, error = "Service not initialized" };

            try
            {
                var templateXml = (string)input.payload.templateXml;
                int targetFarn = 21474;
                try { targetFarn = (int)input.payload.targetFarn; } catch { }

                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(25));
                var result = await _service.VerifyLiveAsync(templateXml, cts.Token, targetFarn);

                return new
                {
                    ok = true,
                    matched = result.Success,
                    score = result.Score,
                    threshold = result.Threshold,
                    method = result.Method,
                    message = result.Message
                };
            }
            catch (Exception ex)
            {
                return new { ok = false, error = ex.Message };
            }
        }

        private async Task<object> HandleStoreList()
        {
            try
            {
                var templates = AdvancedFingerprintStore.GetAllTemplates();
                var result = templates.Select(t => new
                {
                    id = t.Id,
                    format = t.Format,
                    bytes = t.Bytes,
                    xmlLength = t.XmlLength,
                    sha1 = t.Sha1,
                    createdUtc = t.CreatedUtc,
                    expiresAt = t.ExpiresAt
                }).ToList();

                return new { ok = true, templates = result };
            }
            catch (Exception ex)
            {
                return new { ok = false, error = ex.Message };
            }
        }

        private async Task<object> HandleSingleCapture()
        {
            if (_service == null) return new { ok = false, error = "Service not initialized" };

            try
            {
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));
                var result = await _service.SingleCaptureAsync(cts.Token);

                return new
                {
                    ok = result.Success,
                    pngB64 = result.PngBase64,
                    fmdXml = result.FmdXml,
                    formats = result.Formats,
                    error = result.Error
                };
            }
            catch (Exception ex)
            {
                return new { ok = false, error = ex.Message };
            }
        }

        private async Task NotifySafe(object evt)
        {
            try
            {
                var callback = _notify;
                if (callback != null)
                {
                    await callback(evt);
                }
            }
            catch
            {
                // Ignorar errores de notificación para evitar crasheos
            }
        }
    }
}