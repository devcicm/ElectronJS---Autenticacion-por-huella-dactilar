export {};

declare global {
  interface Window {
    fp: {
      // Funcionalidades existentes (compatibilidad)
      init(): Promise<void>;
      capture3(): Promise<{ ok: boolean; attempts: number; pngB64?: string; fmdXml?: string; error?: string }>;
      enrollSave(id: string, samples?: number): Promise<string>;
      verifyWithStore(id: string, liveFmdXml: string, farDenominator?: number): Promise<{ ok: boolean; matched: boolean; score: number; threshold: number }>;
      getReaderInfo(): Promise<{ ok: boolean; description?: string; guid?: string; serialNumber?: string; productName?: string; error?: string }>;
      cancel(): Promise<void>;
      dispose(): Promise<void>;
      onEvent(cb: (evt: any) => void): void;

      // ===== NUEVAS FUNCIONALIDADES AVANZADAS =====

      // Identificación 1:N en vivo
      identify1N(targetFarn?: number, topK?: number): Promise<{
        ok: boolean;
        match?: boolean;
        bestScore?: number;
        bestTag?: string;
        galleryFormat?: string;
        topK?: Array<{ tag: string; score: number }>;
        message?: string;
        error?: string;
      }>;

      // Enrolamiento avanzado con múltiples estrategias
      enrollAdvanced(samples?: number, targetFarn?: number, maxRetriesPerSample?: number): Promise<{
        ok: boolean;
        templateXml?: string;
        method?: string;
        samplesUsed?: number;
        error?: string;
      }>;

      // Verificación en vivo optimizada
      verifyLive(templateXml: string, targetFarn?: number): Promise<{
        ok: boolean;
        matched?: boolean;
        score?: number;
        threshold?: number;
        method?: string;
        message?: string;
        error?: string;
      }>;

      // Captura simple para testing
      singleCapture(): Promise<{
        ok: boolean;
        pngB64?: string;
        fmdXml?: string;
        formats?: { [format: string]: string };
        error?: string;
      }>;

      // Listar plantillas almacenadas
      storeList(): Promise<{
        ok: boolean;
        templates?: Array<{
          id: string;
          format: string;
          bytes: number;
          xmlLength: number;
          sha1: string;
          createdUtc: string;
          expiresAt?: string;
        }>;
        error?: string;
      }>;
    };
  }
}