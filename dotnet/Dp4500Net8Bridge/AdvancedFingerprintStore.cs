using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using DPUruNet;

namespace Dp4500Net8Bridge
{
    /// <summary>
    /// Store avanzado thread-safe para plantillas biométricas con metadatos completos
    /// </summary>
    public sealed class StoredTemplate
    {
        public required string Id { get; init; }
        public required string Format { get; init; }
        public required string TemplateXml { get; init; }
        public required int Bytes { get; init; }
        public required int XmlLength { get; init; }
        public required string Sha1 { get; init; }
        public required DateTime CreatedUtc { get; init; }
        public required DateTime? ExpiresAt { get; init; }
    }

    public static class AdvancedFingerprintStore
    {
        private static readonly ConcurrentDictionary<string, StoredTemplate> _store = new();

        public static void SaveTemplate(string id, string templateXml, TimeSpan? ttl = null)
        {
            var fmd = Fmd.DeserializeXml(templateXml);
            var bytes = fmd.Bytes?.Length ?? 0;

            using var sha1 = SHA1.Create();
            var hash = sha1.ComputeHash(Encoding.UTF8.GetBytes(templateXml));
            var sha1String = Convert.ToHexString(hash);

            var template = new StoredTemplate
            {
                Id = id,
                Format = DetectFormat(templateXml),
                TemplateXml = templateXml,
                Bytes = bytes,
                XmlLength = templateXml.Length,
                Sha1 = sha1String,
                CreatedUtc = DateTime.UtcNow,
                ExpiresAt = ttl.HasValue ? DateTime.UtcNow.Add(ttl.Value) : null
            };

            _store[id] = template;
        }

        public static StoredTemplate? GetTemplate(string id)
        {
            if (!_store.TryGetValue(id, out var template))
                return null;

            // Verificar expiración
            if (template.ExpiresAt.HasValue && template.ExpiresAt.Value < DateTime.UtcNow)
            {
                _store.TryRemove(id, out _);
                return null;
            }

            return template;
        }

        public static bool RemoveTemplate(string id)
        {
            return _store.TryRemove(id, out _);
        }

        public static void Clear()
        {
            _store.Clear();
        }

        public static List<StoredTemplate> GetAllTemplates()
        {
            var now = DateTime.UtcNow;
            var validTemplates = new List<StoredTemplate>();
            var expiredKeys = new List<string>();

            foreach (var kvp in _store)
            {
                if (kvp.Value.ExpiresAt.HasValue && kvp.Value.ExpiresAt.Value < now)
                {
                    expiredKeys.Add(kvp.Key);
                }
                else
                {
                    validTemplates.Add(kvp.Value);
                }
            }

            // Limpiar expirados
            foreach (var key in expiredKeys)
            {
                _store.TryRemove(key, out _);
            }

            return validTemplates;
        }

        public static int Count => _store.Count;

        private static string DetectFormat(string templateXml)
        {
            // Detectar formato basado en el XML
            if (templateXml.Contains("DP_REGISTRATION"))
                return "DP_REGISTRATION";
            if (templateXml.Contains("DP_VERIFICATION"))
                return "DP_VERIFICATION";
            if (templateXml.Contains("DP_PRE_REGISTRATION"))
                return "DP_PRE_REGISTRATION";
            if (templateXml.Contains("ANSI"))
                return "ANSI";
            return "UNKNOWN";
        }

        public static void SaveMultipleFormats(string baseId, Dictionary<string, string> formatXmls, TimeSpan? ttl = null)
        {
            foreach (var kvp in formatXmls)
            {
                var format = kvp.Key;
                var xml = kvp.Value;
                var id = $"{baseId}-{format}";
                SaveTemplate(id, xml, ttl);
            }
        }

        public static List<StoredTemplate> GetTemplatesByFormat(string format)
        {
            return GetAllTemplates().Where(t => t.Format.Equals(format, StringComparison.OrdinalIgnoreCase)).ToList();
        }
    }
}