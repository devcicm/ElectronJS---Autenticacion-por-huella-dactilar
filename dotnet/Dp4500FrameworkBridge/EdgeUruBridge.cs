using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using System.Linq;
using DPUruNet;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

namespace Dp4500FrameworkBridge
{
    public class EdgeUruBridge
    {
        private static Reader _reader;
        private static bool _initialized = false;
        private static readonly Dictionary<string, StoredTemplate> _store = new Dictionary<string, StoredTemplate>();

        public class StoredTemplate
        {
            public string Id { get; set; }
            public string FmdXml { get; set; }
            public DateTime Created { get; set; }
        }

        public async Task<object> Invoke(dynamic input)
        {
            try
            {
                var action = (string)input.action;

                switch (action)
                {
                    case "init":
                        return await InitializeReader();
                    case "capture":
                        return await CaptureFingerprint();
                    case "capture3":
                        return await Capture3Attempts();
                    case "enrollSave":
                        return await EnrollAndSave(input);
                    case "verifyWithStore":
                        return await VerifyWithStore(input);
                    case "identify1N":
                        return await Identify1N(input);
                    case "singleCapture":
                        return await SingleCapture();
                    case "storeList":
                        return await StoreList();
                    case "getReaderInfo":
                        return await GetReaderInfo();
                    default:
                        return new { success = false, error = "Acción desconocida: " + action };
                }
            }
            catch (Exception ex)
            {
                return new { success = false, error = "Error en bridge: " + ex.Message };
            }
        }

        private async Task<object> InitializeReader()
        {
            try
            {
                if (_initialized && _reader != null)
                    return new { success = true, message = "Reader ya inicializado" };

                LoadNativeDlls();

                var readers = ReaderCollection.GetReaders();
                if (readers.Count == 0)
                    return new { success = false, error = "No se encontraron lectores conectados" };

                _reader = readers[0];
                var result = _reader.Open(Constants.CapturePriority.DP_PRIORITY_COOPERATIVE);

                if (result != Constants.ResultCode.DP_SUCCESS)
                    return new { success = false, error = "Error abriendo reader" };

                _initialized = true;
                return new {
                    success = true,
                    message = "Reader inicializado: " + _reader.Description.SerialNumber,
                    serialNumber = _reader.Description.SerialNumber,
                    name = _reader.Description.Name
                };
            }
            catch (Exception ex)
            {
                return new { success = false, error = "Error inicializando: " + ex.Message };
            }
        }

        private void LoadNativeDlls()
        {
            try
            {
                var currentDir = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
                var dlls = new[] { "dpfpdd.dll", "dpfj.dll", "DPUruNet.dll", "DPCtlUruNet.dll" };

                foreach (var dll in dlls)
                {
                    var path = Path.Combine(currentDir, dll);
                    if (File.Exists(path))
                    {
                        LoadLibrary(path);
                    }
                }
            }
            catch { }
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr LoadLibrary(string fileName);

        private async Task<object> CaptureFingerprint()
        {
            if (!_initialized || _reader == null)
                return new { success = false, error = "Reader no inicializado" };

            try
            {
                var captureResult = _reader.Capture(Constants.Formats.Fid.ANSI, Constants.CaptureProcessing.DP_IMG_PROC_DEFAULT, 5000, 500);

                if (captureResult.ResultCode != Constants.ResultCode.DP_SUCCESS)
                    return new { success = false, error = "Error capturando" };

                var imageBase64 = Convert.ToBase64String(captureResult.Data.Views[0].Bytes);

                return new {
                    success = true,
                    fidXml = Fid.SerializeXml(captureResult.Data),
                    imageBase64 = imageBase64,
                    width = captureResult.Data.Views[0].Width,
                    height = captureResult.Data.Views[0].Height
                };
            }
            catch (Exception ex)
            {
                return new { success = false, error = "Error en captura: " + ex.Message };
            }
        }

        private async Task<object> Capture3Attempts()
        {
            var captures = new List<object>();

            for (int i = 0; i < 3; i++)
            {
                var result = await CaptureFingerprint();
                captures.Add(result);

                if (!(bool)((dynamic)result).success)
                    break;
            }

            return new {
                success = captures.Count > 0 && (bool)((dynamic)captures[0]).success,
                captures = captures
            };
        }

        private async Task<object> EnrollAndSave(dynamic input)
        {
            try
            {
                string id = input.id ?? Guid.NewGuid().ToString();
                var samples = (dynamic[])input.samples;

                if (samples.Length < 3)
                    return new { success = false, error = "Se necesitan al menos 3 muestras para enrolamiento" };

                var fids = new List<Fid>();
                foreach (var sample in samples)
                {
                    var fidXml = (string)sample.fidXml;
                    var fid = Fid.DeserializeXml(fidXml);
                    fids.Add(fid);
                }

                var fmds = new List<Fmd>();
                foreach (var fid in fids)
                {
                    var extractResult = FeatureExtraction.CreateFmdFromFid(fid, Constants.Formats.Fmd.DP_VERIFICATION);
                    if (extractResult.ResultCode == Constants.ResultCode.DP_SUCCESS)
                        fmds.Add(extractResult.Data);
                }

                if (fmds.Count < 3)
                    return new { success = false, error = "No se pudieron extraer suficientes características" };

                var enrollResult = Enrollment.CreateEnrollmentFmd(Constants.Formats.Fmd.DP_REGISTRATION, fmds.ToArray());

                if (enrollResult.ResultCode != Constants.ResultCode.DP_SUCCESS)
                    return new { success = false, error = "Error en enrolamiento" };

                var template = new StoredTemplate
                {
                    Id = id,
                    FmdXml = Fmd.SerializeXml(enrollResult.Data),
                    Created = DateTime.Now
                };

                _store[id] = template;

                return new {
                    success = true,
                    templateId = id,
                    templateXml = template.FmdXml,
                    message = "Template enrolado exitosamente: " + id
                };
            }
            catch (Exception ex)
            {
                return new { success = false, error = "Error en enrolamiento: " + ex.Message };
            }
        }

        private async Task<object> VerifyWithStore(dynamic input)
        {
            try
            {
                string id = input.id;
                string liveFmdXml = input.liveFmdXml;
                int threshold = input.farDenominator ?? 100000;

                if (!_store.ContainsKey(id))
                    return new { success = false, error = "Template no encontrado: " + id };

                var storedFmd = Fmd.DeserializeXml(_store[id].FmdXml);
                var liveFmd = Fmd.DeserializeXml(liveFmdXml);

                var compareResult = Comparison.Compare(storedFmd, 0, liveFmd, 0);

                int score = compareResult.Score;
                if (score == int.MaxValue)
                {
                    score = threshold + 1;
                }

                bool match = compareResult.ResultCode == Constants.ResultCode.DP_SUCCESS && score < threshold;

                return new {
                    success = true,
                    match = match,
                    score = score,
                    threshold = threshold,
                    message = match ? "MATCH (score=" + score + ")" : "NO MATCH (score=" + score + ")"
                };
            }
            catch (Exception ex)
            {
                return new { success = false, error = "Error en verificación: " + ex.Message };
            }
        }

        private async Task<object> Identify1N(dynamic input)
        {
            try
            {
                string liveFmdXml = input.liveFmdXml ?? throw new ArgumentNullException("liveFmdXml requerido");
                int threshold = input.threshold ?? 100000;
                int topK = input.topK ?? 5;

                if (_store.Count == 0)
                    return new { success = false, error = "No hay templates en el store" };

                var liveFmd = Fmd.DeserializeXml(liveFmdXml);
                var results = new List<dynamic>();

                foreach (var template in _store.Values)
                {
                    var storedFmd = Fmd.DeserializeXml(template.FmdXml);
                    var compareResult = Comparison.Compare(storedFmd, 0, liveFmd, 0);

                    int score = compareResult.Score;
                    if (score == int.MaxValue) score = threshold + 1;

                    results.Add(new {
                        id = template.Id,
                        score = score,
                        match = score < threshold
                    });
                }

                var sortedResults = results.OrderBy(r => r.score).Take(topK).ToList();
                var bestMatch = sortedResults.FirstOrDefault();
                bool hasMatch = bestMatch != null && bestMatch.match;

                return new {
                    success = true,
                    match = hasMatch,
                    bestId = hasMatch ? bestMatch.id : null,
                    bestScore = hasMatch ? bestMatch.score : -1,
                    topK = sortedResults,
                    total = _store.Count
                };
            }
            catch (Exception ex)
            {
                return new { success = false, error = "Error en identificación 1:N: " + ex.Message };
            }
        }

        private async Task<object> SingleCapture()
        {
            var captureResult = await CaptureFingerprint();
            if (!(bool)((dynamic)captureResult).success)
                return captureResult;

            try
            {
                var fidXml = (string)((dynamic)captureResult).fidXml;
                var fid = Fid.DeserializeXml(fidXml);

                var extractVer = FeatureExtraction.CreateFmdFromFid(fid, Constants.Formats.Fmd.DP_VERIFICATION);
                var extractReg = FeatureExtraction.CreateFmdFromFid(fid, Constants.Formats.Fmd.DP_REGISTRATION);

                var formats = new Dictionary<string, string>();
                if (extractVer.ResultCode == Constants.ResultCode.DP_SUCCESS)
                    formats["VER"] = Fmd.SerializeXml(extractVer.Data);
                if (extractReg.ResultCode == Constants.ResultCode.DP_SUCCESS)
                    formats["REG"] = Fmd.SerializeXml(extractReg.Data);

                return new {
                    success = true,
                    fidXml = fidXml,
                    formats = formats,
                    imageBase64 = ((dynamic)captureResult).imageBase64
                };
            }
            catch (Exception ex)
            {
                return new { success = false, error = "Error procesando captura: " + ex.Message };
            }
        }

        private async Task<object> StoreList()
        {
            var templates = _store.Values.Select(t => new {
                id = t.Id,
                created = t.Created.ToString("yyyy-MM-dd HH:mm:ss")
            }).ToArray();

            return new { success = true, templates = templates, count = templates.Length };
        }

        private async Task<object> GetReaderInfo()
        {
            if (!_initialized || _reader == null)
                return new { success = false, error = "Reader no inicializado" };

            return new {
                success = true,
                name = _reader.Description.Name,
                serialNumber = _reader.Description.SerialNumber
            };
        }
    }
}