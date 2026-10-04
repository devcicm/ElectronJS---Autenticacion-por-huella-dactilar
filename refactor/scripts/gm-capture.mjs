/**
 * gm-capture.mjs — Captura del golden master (Fase 1, skill refactor-codebase v2.1)
 * Solo lectura del repo: extrae C(P) observable y lo congela en refactor/baseline/.
 * Uso: node refactor/scripts/gm-capture.mjs   (o gm-verify.mjs para comparar)
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const BASELINE = path.join(ROOT, 'baseline');
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const read = (rel) => fs.readFileSync(path.join(ROOT, '..', rel), 'utf-8');

// ---------------------------------------------------------------- GM1: HTTP
function gm1_http() {
  const src = read('biometric-engine/node/server.ts');
  const endpoints = [];
  const rx = /app\.(get|post|delete|put|patch)\(\s*"([^"]+)"/g;
  let m;
  while ((m = rx.exec(src)) !== null) {
    const start = m.index;
    const end = src.indexOf('});', start);
    const body = src.slice(start, end > 0 ? end : start + 1500);
    endpoints.push({
      method: m[1].toUpperCase(),
      path: m[2],
      validates: /return res\.status\(400\)/.test(body),
      errorShape: '500 {ok:false,code:"INTERNAL_ERROR",error:"msg"}',  // B2: BE-19 sanitizado
    });
  }
  endpoints.sort((a, b) => (a.path + a.method).localeCompare(b.path + b.method));
  return { contract: 'HTTP API biometric-engine (puerto 8080, bodyParser.json)', endpoints, normalizer: 'solo endpoints/validaciones; bodies con String(e) dependen del entorno (CANDIDATE, no congelados por valor)' };
}

// ---------------------------------------------------------------- GM2: IPC
function gm2_ipc() {
  const preload = read('electron/preload.ts');
  const main = read('electron/main.ts');
  const namespaces = [...preload.matchAll(/exposeInMainWorld\('([^']+)'/g)].map(m => m[1]).sort();
  const invoked = [...new Set([...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(m => m[1]))].sort();
  const events = [...new Set([...preload.matchAll(/ipcRenderer\.on\('([^']+)'/g)].map(m => m[1]))].sort();
  const handled = [...new Set([...main.matchAll(/ipcMain\.handle\('([^']+)'/g)].map(m => m[1]))].sort();
  const sent = [...new Set([...main.matchAll(/webContents\.send\('([^']+)'/g)].map(m => m[1]))].sort();
  const missingHandlers = invoked.filter(c => !handled.includes(c));
  const orphanHandlers = handled.filter(c => !invoked.includes(c));
  const missingEvents = events.filter(c => !sent.includes(c));
  return {
    contract: 'IPC preload<->main (contextIsolation on)',
    namespaces, invokedChannels: invoked, handledChannels: handled,
    eventChannelsRenderer: events, eventChannelsMain: sent,
    parity: { missingHandlers, orphanHandlers, missingEvents },
  };
}

// ---------------------------------------------------------------- GM3: SQLite
function gm3_sqlite() {
  const schema = read('sistema-asistencia/database/schema.sql');
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  const master = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
  const seeds = {
    departments: db.prepare('SELECT id,name,description FROM departments ORDER BY id').all(),
    shifts: db.prepare('SELECT id,name,start_time,end_time,tolerance_minutes,color FROM shifts ORDER BY id').all(),
    system_config: db.prepare('SELECT key,value,description FROM system_config ORDER BY key').all(),
  };
  const views = {};
  for (const v of master.filter(r => r.type === 'view')) {
    views[v.name] = db.prepare(`SELECT COUNT(*) AS n FROM "${v.name}"`).get().n;
  }
  db.close();
  return { contract: 'Esquema SQLite (schema.sql) + semillas + vistas ejecutables', objects: master, seeds, viewRowCounts: views };
}

// ---------------------------------------------------------------- GM4: DOM
function gm4_dom() {
  const html = read('sistema-asistencia/renderer/index.html');
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
  const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"[^>]*>/g)].map(m => m[1]);
  const styles = [...html.matchAll(/<link[^>]*href="([^"]+\.css)"[^>]*>/g)].map(m => m[1]);
  const views = [...html.matchAll(/class="[^"]*view[^"]*"[^>]*id="([^"]+)"/g)].map(m => m[1]);
  return { contract: 'DOM renderer sistema-asistencia (carga por archivo)', elementIds: ids, scriptLoadOrder: scripts, stylesheets: styles, viewSections: views };
}

// ---------------------------------------------------------------- GM5: package
function gm5_package() {
  const pkg = JSON.parse(read('package.json'));
  const node = JSON.parse(read('biometric-engine/node/package.json'));
  return {
    contract: 'Manifiestos y scripts de build',
    root: { scripts: pkg.scripts, deps: pkg.dependencies, devDeps: pkg.devDeps, type: pkg.type, main: pkg.main },
    biometricNode: { scripts: node.scripts, deps: node.dependencies, devDeps: node.devDependencies },
  };
}

// ---------------------------------------------------------------- main
const sections = {
  'gm1-http-api.json': gm1_http(),
  'gm2-ipc-contract.json': gm2_ipc(),
  'gm3-sqlite-schema.json': gm3_sqlite(),
  'gm4-renderer-dom.json': gm4_dom(),
  'gm5-manifests.json': gm5_package(),
};

const isVerify = process.argv[1].endsWith('gm-verify.mjs');

if (!isVerify) {
  fs.mkdirSync(BASELINE, { recursive: true });
  const index = { capturedAt: new Date().toISOString(), nondeterminismo: ['bodies String(e) de errores de entorno', 'timestamps ISO de respuestas', 'ocupacion del puerto 8080', 'presencia del lector DP4500'], sections: {} };
  for (const [file, data] of Object.entries(sections)) {
    const json = JSON.stringify(data, null, 2);
    fs.writeFileSync(path.join(BASELINE, file), json);
    index.sections[file] = sha256(json);
  }
  fs.writeFileSync(path.join(BASELINE, 'gm-index.json'), JSON.stringify(index, null, 2));
  console.log('[GM] Baseline congelada en', BASELINE);
  for (const [f, h] of Object.entries(index.sections)) console.log(`  ${h.slice(0, 12)}  ${f}`);
} else {
  let fails = 0;
  for (const [file, now] of Object.entries(sections)) {
    const bp = path.join(BASELINE, file);
    if (!fs.existsSync(bp)) { console.log(`[GM-FAIL] falta baseline: ${file}`); fails++; continue; }
    const before = JSON.parse(fs.readFileSync(bp, 'utf-8'));
    const bj = JSON.stringify(before, null, 2), nj = JSON.stringify(now, null, 2);
    if (bj === nj) { console.log(`[GM-OK] ${file}`); continue; }
    fails++;
    console.log(`[GM-DIFF] ${file}`);
    const diffKeys = [];
    const walk = (a, b, p) => {
      if (JSON.stringify(a) === JSON.stringify(b)) return;
      if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) { diffKeys.push(p); return; }
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a?.[k], b?.[k], `${p}.${k}`);
    };
    walk(before, now, '$');
    for (const k of diffKeys.slice(0, 12)) console.log(`    ${k}: ${JSON.stringify(k.split('.').reduce((o, k2) => o?.[k2?.replace(/\]/g, '').replace(/\[/g, '.')], before))} -> ...`);
  }
  console.log(fails === 0 ? '[GM] Paridad C(P) verificada ✅' : `[GM] ${fails} sección(es) con ruptura de paridad ❌`);
  process.exit(fails === 0 ? 0 : 1);
}
