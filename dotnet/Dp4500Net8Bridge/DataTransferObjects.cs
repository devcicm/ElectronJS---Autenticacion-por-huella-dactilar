using System;
using System.Collections.Generic;

namespace Dp4500Net8Bridge
{
    // DTOs para transferir datos entre el servicio y el bridge

    public sealed class CaptureResultDto
    {
        public bool Success { get; set; }
        public int Attempts { get; set; }
        public string? PngBase64 { get; set; }
        public string? FmdXml { get; set; }
        public string? Error { get; set; }
    }

    public sealed class EnrollResultDto
    {
        public bool Success { get; set; }
        public string? TemplateXml { get; set; }
        public string? Method { get; set; }
        public int SamplesUsed { get; set; }
        public string? Error { get; set; }
    }

    public sealed class VerifyResultDto
    {
        public bool Matched { get; set; }
        public int Score { get; set; }
        public int Threshold { get; set; }
        public double Confidence { get; set; }
        public string? Method { get; set; }
        public string? Error { get; set; }
    }

    public sealed class ReaderInfoDto
    {
        public bool Success { get; set; }
        public string? Description { get; set; }
        public string? Guid { get; set; }
        public string? SerialNumber { get; set; }
        public string? ProductName { get; set; }
        public string? Error { get; set; }
    }

    public sealed class SingleCaptureResultDto
    {
        public bool Success { get; set; }
        public string? PngBase64 { get; set; }
        public string? FmdXml { get; set; }
        public Dictionary<string, string>? Formats { get; set; }
        public string? Error { get; set; }
    }

    public sealed class VerifyLiveResultDto
    {
        public bool Success { get; set; }
        public int Score { get; set; }
        public int Threshold { get; set; }
        public string? Method { get; set; }
        public string? Message { get; set; }
    }

    public sealed class Identify1NResultDto
    {
        public bool Match { get; set; }
        public int BestScore { get; set; }
        public string? BestTag { get; set; }
        public string? GalleryFormat { get; set; }
        public List<object>? TopK { get; set; }
        public string? Message { get; set; }
    }

    public sealed class EnrollAdvancedResultDto
    {
        public bool Success { get; set; }
        public string? TemplateXml { get; set; }
        public string? Method { get; set; }
        public int SamplesUsed { get; set; }
        public string? Error { get; set; }
    }
}