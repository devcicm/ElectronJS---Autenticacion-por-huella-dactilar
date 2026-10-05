// Helper de test: carga un "script clásico" del renderer (IIFE que asigna a window.X).
// Los scripts del renderer NO son ES modules (Electron file:// bloquea imports por CORS),
// así que los tests los evalúan con un window global mock.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function loadClassic(relPath) {
    const src = fs.readFileSync(path.resolve(HERE, relPath), 'utf-8');
    // window === globalThis para que window.X sea accesible como globalThis.X
    if (!globalThis.window) globalThis.window = globalThis;
    (0, eval)(src); // indirect eval → scope global
    return globalThis.window;
}
