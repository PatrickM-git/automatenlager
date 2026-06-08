'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Worker-Dienst — Issue #160 (Stufe 6, Slice 0). Ersetzt n8n als SCHEDULER.
// SPEC: docs/specs/multi-tenant-n8n-abloesung-stufe-6-v1.md §"Solution" / §"Rollout"
//
// Eigener docker-compose-Service (gleiches App-Image, anderer Entry-Point;
// `restart: always`, self-healing), GETRENNT vom Web-Prozess. Beispiel-Service-
// Snippet: dashboard/deploy/worker.compose.example.yml. Auf Render wird derselbe
// Entry-Point ein Background Worker / Cron Job (cloud-agnostisch).
//
// Architektur:
//   * createWorker(...)  — REINE, testbare Maschinerie: nimmt Schedules + einen
//                          Telemetrie-Recorder + eine cron-Implementierung (DI).
//                          Lädt node-cron NUR lazy in start() (Tests injizieren ein
//                          Fake-cron ⇒ laufen offline; require('./worker.js') hat
//                          KEINE Seiteneffekte, baut KEINE Pools, verbindet NICHT).
//   * buildWorker(...)   — Produktions-Verkabelung: Infra-/App-Pools (wie server.js),
//                          Mandanten-Tür + Registry + Infra-Runner + Recorder.
//   * main()             — startet buildWorker() (nur bei direktem `node worker.js`).
//
// Slice 0 schaltet KEINEN n8n-Prozess ab (n8n bleibt autoritativ). Einziger
// geplanter Lauf ist ein Heartbeat, der die Pipeline (cron feuert → Lauf landet in
// audit.workflow_runs) beweist. Echte Job-Ports kommen in Slice 1–3.
// ─────────────────────────────────────────────────────────────────────────────

const HEARTBEAT_JOB = 'worker-heartbeat';

/**
 * Reine Worker-Maschinerie (DI, testbar).
 * @param {object} opts
 * @param {{name:string, cronExpr:string, run:()=>Promise<any>}[]} opts.schedules
 * @param {{recordRun:Function}} opts.recorder    Telemetrie (audit.workflow_runs).
 * @param {{schedule:Function, validate?:Function}} [opts.cron]  Default: lazy node-cron.
 * @param {(...a:any[])=>void} [opts.logger]
 */
function createWorker({ schedules = [], recorder, cron, logger } = {}) {
  if (!recorder || typeof recorder.recordRun !== 'function') {
    throw new TypeError('worker: recorder mit recordRun() erforderlich');
  }
  const log = typeof logger === 'function' ? logger : (...a) => console.log('[worker]', ...a);
  const byName = new Map(schedules.map((s) => [s.name, s]));
  let tasks = [];
  let started = false;

  // Ein Tick: den Job durch die Telemetrie laufen lassen. recordRun wirft den
  // Job-Fehler weiter (Status bereits als error protokolliert) — am Tick-Rand
  // abfangen, damit ein Fehlschlag den Scheduler nicht abreißen lässt (self-heal
  // ergänzt `restart: always`).
  async function runOnce(name) {
    const s = byName.get(name);
    if (!s) throw new Error(`worker: unbekannter Job "${name}"`);
    return recorder.recordRun(s.name, s.run);
  }

  function start() {
    if (started) return handle;
    const cronImpl = cron || require('node-cron');
    for (const s of schedules) {
      if (typeof cronImpl.validate === 'function' && !cronImpl.validate(s.cronExpr)) {
        throw new Error(`worker: ungültiger Cron-Ausdruck für "${s.name}": ${s.cronExpr}`);
      }
      // Tick gibt das Promise ZURÜCK (node-cron ignoriert den Rückgabewert; Tests
      // können den gefeuerten Lauf awaiten). Fehler am Tick-Rand abfangen, damit ein
      // Fehlschlag den Scheduler nicht abreißt (self-heal ergänzt `restart: always`).
      const task = cronImpl.schedule(s.cronExpr, () =>
        runOnce(s.name).catch((err) => log(`Job "${s.name}" fehlgeschlagen:`, err && err.message)));
      tasks.push(task);
      log(`geplant: ${s.name} (${s.cronExpr})`);
    }
    started = true;
    return handle;
  }

  function stop() {
    for (const t of tasks) { try { if (t && typeof t.stop === 'function') t.stop(); } catch { /* idempotent */ } }
    tasks = [];
    started = false;
  }

  const handle = {
    start,
    stop,
    runJobNow: runOnce,
    listSchedules: () => schedules.map((s) => ({ name: s.name, cronExpr: s.cronExpr })),
    isStarted: () => started,
  };
  return handle;
}

// ── Produktions-Verkabelung ───────────────────────────────────────────────────
// Spiegelt die Pool-Komposition aus server.js: INFRA-Pool (BYPASSRLS) trägt
// Registry + MatView-Refresh + Telemetrie; APP-Pool (automatenlager_app, RLS) trägt
// die Mandanten-Tür. KEIN neuer BYPASS.
function buildWorker(env = process.env) {
  const { resolvePgUrl } = require('./lib/pg-url.js');
  const { createTenantDirectory } = require('./lib/tenant-directory.js');
  const { createTenantDb } = require('./lib/tenant-db.js');
  const { createInfraJobRunner } = require('./lib/jobs/infra-runner.js');
  const { createTenantJobRunner } = require('./lib/jobs/tenant-runner.js');
  const { createWorkflowRunRecorder } = require('./lib/workflow-runs.js');

  function loadLocalEnv() {
    // Minimaler .env.local-Leser (Projekt- + dashboard-Ebene), wie server.js.
    const fs = require('node:fs'); const path = require('node:path');
    const files = [path.join(__dirname, '..', '.env.local'), path.join(__dirname, '.env.local')];
    const merged = {};
    for (const fp of files) {
      let text; try { text = fs.readFileSync(fp, 'utf8'); } catch { continue; }
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim(); if (!t || t.startsWith('#')) continue;
        const i = t.indexOf('='); if (i === -1) continue;
        merged[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
      }
    }
    return merged;
  }
  const local = loadLocalEnv();
  const infraUrl = resolvePgUrl(env, local);
  const appUrl = (Object.prototype.hasOwnProperty.call(env, 'DASHBOARD_V2_APP_PG_URL')
    ? (String(env.DASHBOARD_V2_APP_PG_URL || '').trim() || infraUrl)
    : (String((local && local.DASHBOARD_V2_APP_PG_URL) || '').trim() || infraUrl));

  if (!infraUrl) {
    console.error('[worker] Kein PG konfiguriert (DASHBOARD_V2_PG_URL) — Worker startet ohne DB; Läufe nur best-effort protokolliert.');
  }
  const { Pool } = require('pg');
  const infraPool = infraUrl ? new Pool({ connectionString: infraUrl, max: 4, connectionTimeoutMillis: 3000 }) : null;
  const appPool = appUrl ? new Pool({ connectionString: appUrl, max: 4, connectionTimeoutMillis: 3000 }) : null;
  if (infraPool) infraPool.on('error', (e) => console.error('[worker][infra-pool]', e && e.message));
  if (appPool) appPool.on('error', (e) => console.error('[worker][app-pool]', e && e.message));

  const directory = infraPool
    ? createTenantDirectory({ query: (sql, params) => infraPool.query(sql, params), logger: (...a) => console.error('[tenant-directory]', ...a) })
    : null;
  const tenantDb = appPool
    ? createTenantDb({ query: (sql, params) => appPool.query(sql, params), pool: appPool, log: (...a) => console.error('[tenant-db]', ...a) })
    : null;
  const infraRunner = infraPool ? createInfraJobRunner({ pool: infraPool, logger: (...a) => console.log('[infra-runner]', ...a) }) : null;
  const recorder = createWorkflowRunRecorder({
    exec: infraRunner ? infraRunner.exec : async () => ({ rows: [], rowCount: 0 }),
    logger: (...a) => console.error('[workflow-runs]', ...a),
    source: 'worker',
  });
  const tenantRunner = (tenantDb && directory) ? createTenantJobRunner({ db: tenantDb, directory, logger: (...a) => console.error('[tenant-runner]', ...a) }) : null;

  // Slice 0: nur der Heartbeat (beweist cron→audit.workflow_runs). Reale Jobs:
  // Slice 1 (WF8/MatView/Val/Monitor/Devices), Slice 2 (WF7/9/5), Slice 3 (WF3/1/2).
  const schedules = [
    { name: HEARTBEAT_JOB, cronExpr: env.WORKER_HEARTBEAT_CRON || '*/5 * * * *', kind: 'infra',
      run: async () => ({ ok: true }) },
  ];

  const worker = createWorker({ schedules, recorder, logger: (...a) => console.log('[worker]', ...a) });
  return { worker, deps: { infraPool, appPool, directory, tenantDb, infraRunner, tenantRunner, recorder } };
}

async function main() {
  const { worker, deps } = buildWorker();
  if (deps.directory) { try { await deps.directory.init(); deps.directory.startAutoRefresh(); } catch (e) { console.error('[worker] Verzeichnis-Init:', e && e.message); } }
  worker.start();
  console.log('[worker] gestartet.');
  const shutdown = async (sig) => {
    console.log(`[worker] ${sig} — fahre herunter.`);
    worker.stop();
    try { if (deps.directory) deps.directory.stop(); } catch { /* */ }
    try { if (deps.infraPool) await deps.infraPool.end(); } catch { /* */ }
    try { if (deps.appPool) await deps.appPool.end(); } catch { /* */ }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  main().catch((err) => { console.error('[worker] Fatal:', err && err.stack || err); process.exit(1); });
}

module.exports = { createWorker, buildWorker, HEARTBEAT_JOB };
