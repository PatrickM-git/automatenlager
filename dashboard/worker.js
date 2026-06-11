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
// geplanter Lauf ist ein Heartbeat, der die Pipeline (Scheduler feuert → Lauf landet
// in audit.workflow_runs) beweist. Echte Job-Ports kommen in Slice 1–3.
//
// SCHEDULER: zwei Pfade je Schedule — `intervalMs` (setInterval, drift-IMMUN, Default
// für periodische Jobs) ODER `cronExpr` (node-cron, für feste Uhrzeiten). Grund für
// den Intervall-Default: node-cron v4 verwirft auf dem WSL2/Docker-Mini jeden Tick als
// "missed execution" (Uhr-Drift + v4-Drift-Schutz). `runOnStart` feuert sofort bei Start.
// ─────────────────────────────────────────────────────────────────────────────

const HEARTBEAT_JOB = 'worker-heartbeat';

// Millisekunden bis zum nächsten Auftreten von "HH:MM" in LOKALER Zeit (Container-TZ).
// Drift-tolerant: wird bei JEDEM Tick neu aus der aktuellen Wanduhr berechnet (kein
// akkumulierender Drift) und nutzt lokale Date-Methoden ⇒ DST-korrekt. Für nächtliche
// Ex-n8n-Jobs (scheduleTrigger), wo node-cron auf dem WSL-Mini unzuverlässig ist.
function msUntilNextDailyAt(hhmm, now = new Date()) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm == null ? '' : hhmm).trim());
  if (!m) throw new Error(`worker: ungültige dailyAt-Zeit "${hhmm}" (erwartet "HH:MM")`);
  const h = Number(m[1]); const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`worker: dailyAt-Zeit außerhalb 00:00–23:59: "${hhmm}"`);
  const target = new Date(now);
  target.setHours(h, min, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return target.getTime() - now.getTime();
}

/**
 * Reine Worker-Maschinerie (DI, testbar).
 * @param {object} opts
 * @param {{name:string, intervalMs?:number, cronExpr?:string, dailyAt?:string, runOnStart?:boolean, run:()=>Promise<any>}[]} opts.schedules
 *        Je Schedule GENAU EINES: intervalMs (setInterval, drift-immun) | dailyAt "HH:MM"
 *        (drift-toleranter Selbst-Reschedule, für nächtliche Jobs) | cronExpr (node-cron).
 * @param {{recordRun:Function}} opts.recorder    Telemetrie (audit.workflow_runs).
 * @param {{schedule:Function, validate?:Function}} [opts.cron]  Default: lazy node-cron (nur für cronExpr).
 * @param {(...a:any[])=>void} [opts.logger]
 */
function createWorker({ schedules = [], recorder, cron, logger } = {}) {
  if (!recorder || typeof recorder.recordRun !== 'function') {
    throw new TypeError('worker: recorder mit recordRun() erforderlich');
  }
  const log = typeof logger === 'function' ? logger : (...a) => console.log('[worker]', ...a);
  const byName = new Map(schedules.map((s) => [s.name, s]));
  let stoppers = []; // einheitliche Stop-Funktionen (clearInterval ODER node-cron task.stop)
  let started = false;

  // Ein Tick: den Job durch die Telemetrie laufen lassen. recordRun wirft den
  // Job-Fehler weiter (Status bereits als error protokolliert) — am Tick-Rand
  // abfangen, damit ein Fehlschlag den Scheduler nicht abreißen lässt (self-heal
  // ergänzt `restart: unless-stopped`).
  async function runOnce(name) {
    const s = byName.get(name);
    if (!s) throw new Error(`worker: unbekannter Job "${name}"`);
    return recorder.recordRun(s.name, s.run);
  }
  function tick(name) {
    return runOnce(name).catch((err) => log(`Job "${name}" fehlgeschlagen:`, err && err.message));
  }

  function start() {
    if (started) return handle;
    let cronImpl = cron; // node-cron NUR lazy laden, falls ein cronExpr-Schedule existiert
    for (const s of schedules) {
      // runOnStart: sofortiger erster Lauf (Heartbeat sofort sichtbar + resilient
      // gegen verpasste erste Intervalle nach (Re)Start).
      if (s.runOnStart) tick(s.name);

      if (Number.isFinite(s.intervalMs) && s.intervalMs > 0) {
        // INTERVALL-Scheduler (setInterval) — drift-IMMUN (libuv-Monotonic-Timer statt
        // Wanduhr-Cron-Matching). Bewusst gewählt: node-cron v4 verwirft auf dem
        // WSL2/Docker-Mini JEDEN Tick als "missed execution" (WSL2-Uhr-Drift trifft auf
        // v4-Drift-Schutz, den v3 nicht hatte). NICHT unref(): das Intervall hält den
        // Worker-Prozess am Leben (sein Daseinszweck).
        const h = setInterval(() => tick(s.name), s.intervalMs);
        stoppers.push(() => clearInterval(h));
        log(`geplant: ${s.name} (alle ${Math.round(s.intervalMs / 1000)}s, Intervall)`);
      } else if (s.cronExpr) {
        // CRON-Ausdruck (feste Uhrzeiten) über node-cron. ⚠️ Auf dem WSL2-Mini
        // drift-anfällig (s. o.) — für feste Uhrzeiten ggf. drift-toleranten Ansatz
        // wählen. Nur optionale/künftige Jobs nutzen diesen Pfad; der Heartbeat nicht.
        if (!cronImpl) cronImpl = require('node-cron');
        if (typeof cronImpl.validate === 'function' && !cronImpl.validate(s.cronExpr)) {
          throw new Error(`worker: ungültiger Cron-Ausdruck für "${s.name}": ${s.cronExpr}`);
        }
        const task = cronImpl.schedule(s.cronExpr, () => tick(s.name));
        stoppers.push(() => { try { if (task && typeof task.stop === 'function') task.stop(); } catch { /* idempotent */ } });
        log(`geplant: ${s.name} (${s.cronExpr}, cron)`);
      } else if (s.dailyAt) {
        // TÄGLICH zu fester Uhrzeit (HH:MM lokal) — drift-toleranter Selbst-Reschedule:
        // setTimeout bis zum nächsten Auftreten, nach dem Lauf neu aus der Wanduhr
        // berechnen. Ersetzt n8n-scheduleTrigger ZUVERLÄSSIG (node-cron-Drift auf dem
        // WSL-Mini umgangen). NICHT unref(): hält den Prozess am Leben.
        let timer = null;
        let cancelled = false;
        const arm = () => {
          if (cancelled) return;
          timer = setTimeout(() => { arm(); tick(s.name); }, msUntilNextDailyAt(s.dailyAt, new Date()));
        };
        arm();
        stoppers.push(() => { cancelled = true; if (timer) clearTimeout(timer); });
        log(`geplant: ${s.name} (täglich ${s.dailyAt})`);
      } else {
        throw new Error(`worker: Schedule "${s.name}" braucht intervalMs, cronExpr ODER dailyAt`);
      }
    }
    started = true;
    return handle;
  }

  function stop() {
    for (const st of stoppers) { try { st(); } catch { /* idempotent */ } }
    stoppers = [];
    started = false;
  }

  const handle = {
    start,
    stop,
    runJobNow: runOnce,
    listSchedules: () => schedules.map((s) => ({ name: s.name, intervalMs: s.intervalMs, cronExpr: s.cronExpr, dailyAt: s.dailyAt, runOnStart: !!s.runOnStart })),
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
  const { createMatViewRefreshJob } = require('./lib/jobs/matview-refresh.js');
  const { createGuvAggregateJob } = require('./lib/jobs/guv-aggregate.js');
  const { createGuvBackfillJob } = require('./lib/jobs/guv-backfill.js');
  const { createDbValidationJob } = require('./lib/jobs/db-validation.js');
  const { createNayaxDevicesSyncJob } = require('./lib/jobs/nayax-devices-sync.js');
  const { createWorkerHealthMonitorJob } = require('./lib/jobs/monitor.js');
  const { createAnomalyMonitorJob } = require('./lib/jobs/anomaly-monitor.js');
  const { createClaudeProposalsJob } = require('./lib/jobs/claude-proposals.js');
  const { createWf5MonitorJob } = require('./lib/jobs/wf5-monitor.js');
  const { createPicklistPollJob } = require('./lib/jobs/picklist.js');
  const { createNayaxSalesJob } = require('./lib/jobs/nayax-sales.js');
  const { createInvoiceIntakeJob } = require('./lib/jobs/invoice-intake.js');
  const { createCutoverMonitorJob } = require('./lib/jobs/cutover-monitor.js');
  const { buildGithubIssuesFromEnv } = require('./lib/jobs/github-issues.js');
  const { buildMailerFromEnv } = require('./lib/jobs/mailer.js');
  const { buildAnthropicFromEnv } = require('./lib/anthropic-client.js');
  const { buildDriveFromEnv, buildInvoiceDriveFromEnv } = require('./lib/google-drive-client.js');

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

  // Laufzeit-Env = .env.local (Secrets: RESEND_API_KEY, ALERT_EMAIL_*, NAYAX_*)
  // gemerged mit process.env (process.env gewinnt, wenn gesetzt).
  const runtimeEnv = { ...local, ...env };
  // Provider-agnostischer Mailer (Resend, wenn RESEND_API_KEY gesetzt; sonst „disabled":
  // Jobs laufen, mailen aber nicht — kein fehlender Key bricht etwas).
  const { mailer, kind: mailerKind } = buildMailerFromEnv(runtimeEnv);
  console.log(`[worker] Mailer: ${mailerKind}`);
  // Anthropic-Client (#162): Key aus .env.local (ANTHROPIC_API_KEY). „disabled" ohne Key
  // ⇒ Claude-Jobs laufen, rufen die API aber nicht (kein fehlender Key bricht den Worker).
  const { createMessage: anthropicCreateMessage, kind: anthropicKind } = buildAnthropicFromEnv(runtimeEnv);
  console.log(`[worker] Anthropic: ${anthropicKind}`);
  const anthropic = anthropicCreateMessage ? { createMessage: anthropicCreateMessage } : null;

  // Infra-Jobs (mandantenübergreifend, über die BYPASSRLS-Verbindung).
  const matViewRefreshJob = infraRunner ? createMatViewRefreshJob({ infraRunner }) : null;
  // Worker-Job-Health-Monitor (liest audit.workflow_runs über die Infra-Verbindung).
  const workerMonitorJob = infraRunner ? createWorkerHealthMonitorJob({ exec: infraRunner.exec, mailer, env: runtimeEnv }) : null;
  // Sicherheits-/Anomalie-Monitor (#168): Auth-Fail-Häufung, Break-Glass, error-Run-Spike, Backup-Fehler.
  const anomalyMonitorJob = infraRunner ? createAnomalyMonitorJob({ exec: infraRunner.exec, mailer, env: runtimeEnv }) : null;
  // Per-Mandant-Jobs (durch die Tür, GUC je Mandant). WF8 GuV + DB-Validierung (Slice 1).
  const guvAggregateJob = tenantRunner ? createGuvAggregateJob({ tenantRunner }) : null;
  // GuV-Backfill (Issue #172): füllt GuV-Lücken aus dem freigegebenen Nayax-Roh-Export
  // automatisch, wenn Nayax keine/unvollständige Zahlen lieferte. Quelle (Sheet-ID) via
  // GUV_BACKFILL_SHEET_ID; Default-Fetcher in der Factory. Warnungen über den Logger.
  const guvBackfillJob = tenantRunner ? createGuvBackfillJob({ tenantRunner, env: runtimeEnv, logger: (...a) => console.warn('[guv-backfill]', ...a) }) : null;
  const dbValidationJob = tenantRunner ? createDbValidationJob({ tenantRunner, mailer, env: runtimeEnv }) : null;
  // Nayax-Devices-Sync: ein Token = ein Mandant (NAYAX_TENANT_ID oder einziger Registry-Mandant).
  const nayaxDevicesSyncJob = (tenantDb && directory) ? createNayaxDevicesSyncJob({ db: tenantDb, directory, env: runtimeEnv }) : null;
  // WF3 Nayax-Verkäufe (#163, Slice 3): datenkritisch → DEFAULT Schattenbetrieb (rechnet +
  // vergleicht, schreibt NICHT); Cutover erst per WF3_CUTOVER=1, nachdem die Diffs leer sind.
  const nayaxSalesJob = (tenantDb && directory) ? createNayaxSalesJob({ db: tenantDb, directory, env: runtimeEnv }) : null;
  // WF-Claude-Proposals (#162, Slice 2): alte pending Proposals von Claude vorentscheiden.
  const claudeProposalsJob = tenantRunner ? createClaudeProposalsJob({ tenantRunner, anthropic, mailer, env: runtimeEnv }) : null;
  // WF5 (#162, Slice 2): MHD/Low-Stock-Warnungen synchronisieren + Digest-Mail (Resend).
  const wf5MonitorJob = tenantRunner ? createWf5MonitorJob({ tenantRunner, mailer, env: runtimeEnv }) : null;
  // WF9 Pickliste (#162, Slice 2): Drive→OCR→Slot-Verteilung. Drive-Client aus .env.local
  // (GOOGLE_DRIVE_*). „disabled" ohne Credentials/Ordner. Braucht zusätzlich Anthropic (OCR).
  const { drive: driveClient, kind: driveKind } = buildDriveFromEnv(runtimeEnv);
  console.log(`[worker] Drive: ${driveKind}`);
  const picklistJob = (tenantDb && driveClient && anthropic)
    ? createPicklistPollJob({ db: tenantDb, drive: driveClient, anthropic, env: runtimeEnv })
    : createPicklistPollJob({ drive: driveClient, anthropic });
  // WF1 Rechnungseingang (#163, Slice 3): Drive→Claude→invoice+items. Datenkritisch →
  // DEFAULT Schattenbetrieb (kein Schreiben); Cutover via WF1_CUTOVER=1. Ohne Drive disabled.
  // Seit n8n-Ablösung (2026-06-11): EIGENES Ordnerpaar GOOGLE_DRIVE_INVOICE_* — vorher
  // pollte der Job fälschlich den Picklisten-Ordner des geteilten Clients.
  const { drive: invoiceDrive, kind: invoiceDriveKind } = buildInvoiceDriveFromEnv(runtimeEnv);
  console.log(`[worker] Invoice-Drive: ${invoiceDriveKind}`);
  const invoiceIntakeJob = createInvoiceIntakeJob({ db: tenantDb, drive: invoiceDrive, anthropic, env: runtimeEnv });
  // Cutover-Readiness-Wächter (#198): ruft die Schatten-Jobs read-only, zählt deckungsgleiche
  // aktive Läufe in workflow_state und mailt, sobald das Cutover-Kriterium erfüllt ist.
  const cutoverTenant = (runtimeEnv.NAYAX_TENANT_ID || runtimeEnv.WF1_TENANT_ID || runtimeEnv.WF9_TENANT_ID || '').trim();
  const cutoverIssues = buildGithubIssuesFromEnv(runtimeEnv); // null ohne GITHUB_TOKEN/REPO
  console.log(`[worker] Cutover-Issues: ${cutoverIssues ? 'live' : 'disabled (kein GITHUB_TOKEN/REPO)'}`);
  const cutoverMonitorJob = (tenantDb && cutoverTenant) ? createCutoverMonitorJob({
    db: tenantDb, env: runtimeEnv, mailer, issues: cutoverIssues,
    checks: [
      { streakKey: 'CUTOVER_STREAK_WF3', label: 'WF3 Nayax-Verkäufe', tenant: cutoverTenant, job: nayaxSalesJob },
      { streakKey: 'CUTOVER_STREAK_WF1', label: 'WF1 Rechnungseingang', tenant: cutoverTenant, job: invoiceIntakeJob },
    ].filter((c) => c.job),
  }) : null;

  // Heartbeat (Slice 0) + portierte idempotente Jobs (Slice 1). Nächtliche Jobs nutzen
  // dailyAt (drift-tolerant), nicht node-cron (auf dem WSL-Mini unzuverlässig).
  // Weiter: Slice 1 GuV/Val/Monitor/Nayax-Devices, Slice 2 (WF7/9/5), Slice 3 (WF3/1/2).
  const schedules = [
    { name: HEARTBEAT_JOB, intervalMs: Number(env.WORKER_HEARTBEAT_MS) || 5 * 60 * 1000, runOnStart: true, kind: 'infra',
      run: async () => ({ ok: true }) },
  ];
  // WF-MatView-Refresh (n8n: nächtlich 04:45) → Infra-Job, dailyAt.
  if (matViewRefreshJob) {
    schedules.push({ name: matViewRefreshJob.key, dailyAt: env.WORKER_MATVIEW_AT || '04:45', kind: 'infra',
      run: () => matViewRefreshJob.run() });
  }
  // WF8 GuV-Aggregator (n8n: Knoten heißt "Täglich 02:00", echte Regel = alle 15 min,
  // minutesInterval:15) → per-Mandant-Job durch die Tür, intervalMs (drift-immun).
  // Idempotent (ON CONFLICT guv_key) ⇒ häufige Läufe sind unschädlich.
  // runOnStart: sofortiger erster Lauf — damit bei häufigen Container-Neustarts (Deploy-Loop)
  // der Job bereits gelaufen ist, bevor der nächste SIGTERM kommt (sonst Lücken von >15 min).
  if (guvAggregateJob) {
    schedules.push({ name: guvAggregateJob.key, intervalMs: Number(env.WORKER_GUV_MS) || 15 * 60 * 1000, runOnStart: true, kind: 'tenant',
      run: () => guvAggregateJob.run() });
  }
  // GuV-Backfill (Issue #172): Lücken-Fallback aus dem Roh-Export → per Mandant durch
  // die Tür, intervalMs (drift-immun; node-cron auf dem WSL-Mini unzuverlässig).
  // Idempotent (Dedup + ON CONFLICT guv_key) ⇒ häufige Läufe unschädlich. Default alle
  // 6 h — selten genug, das externe Sheet nicht zu hämmern, oft genug für zeitnahe Lücken.
  if (guvBackfillJob) {
    schedules.push({ name: guvBackfillJob.key, intervalMs: Number(env.WORKER_GUV_BACKFILL_MS) || 6 * 60 * 60 * 1000, kind: 'tenant',
      run: () => guvBackfillJob.run() });
  }
  // WF-Val DB-Konsistenz-Checks (n8n: cron 0 15 4 ⇒ täglich 04:15) → per Mandant, dailyAt.
  if (dbValidationJob) {
    schedules.push({ name: dbValidationJob.key, dailyAt: env.WORKER_DBVAL_AT || '04:15', kind: 'tenant',
      run: () => dbValidationJob.run() });
  }
  // WF-Nayax-Devices-Sync (n8n: täglich 04:20) → ein Token/Mandant, dailyAt.
  if (nayaxDevicesSyncJob) {
    schedules.push({ name: nayaxDevicesSyncJob.key, dailyAt: env.WORKER_NAYAX_AT || '04:20', kind: 'infra',
      run: () => nayaxDevicesSyncJob.run() });
  }
  // WF3 Nayax-Verkäufe: in n8n lief der Schedule-Trigger ALLE 5 MINUTEN
  // (WF3-Export: `minutesInterval: 5`) — das ist der „Live"-Motor, der
  // `sales_transactions` tagsüber füllt (#38 Live-Umsätze ~2 Min Polling,
  // idempotent via processedTxIds-Dedup). Der Stufe-6-Port hatte daraus
  // versehentlich `dailyAt 01:00` gemacht ⇒ Live-Kachel + GuV blieben tagsüber
  // leer (Regression). Zurück auf intervalMs (drift-immun), per WORKER_WF3_MS
  // überschreibbar. FIFO-Schreiben erst nach Cutover via WF3_CUTOVER=1.
  if (nayaxSalesJob) {
    schedules.push({ name: nayaxSalesJob.key, intervalMs: Number(env.WORKER_WF3_MS) || 5 * 60 * 1000, kind: 'tenant',
      run: () => nayaxSalesJob.run() });
  }
  // WF-Claude-Proposals (n8n: cron 0 30 4 ⇒ täglich 04:30) → per Mandant, dailyAt.
  if (claudeProposalsJob) {
    schedules.push({ name: claudeProposalsJob.key, dailyAt: env.WORKER_PROPOSALS_AT || '04:30', kind: 'tenant',
      run: () => claudeProposalsJob.run() });
  }
  // WF5 MHD/Low-Stock (n8n: scheduleTrigger 0 7 * * * ⇒ täglich 07:00) → per Mandant, dailyAt.
  if (wf5MonitorJob) {
    schedules.push({ name: wf5MonitorJob.key, dailyAt: env.WORKER_WF5_AT || '07:00', kind: 'tenant',
      run: () => wf5MonitorJob.run() });
  }
  // WF9 Pickliste → Drive-Polling (intervalMs). Nur registrieren, wenn ein Drive-Client
  // vorhanden ist (sonst disabled — kein Schedule, kein Fehler).
  if (picklistJob && !picklistJob.disabled) {
    schedules.push({ name: picklistJob.key, intervalMs: Number(env.WORKER_WF9_MS) || 5 * 60 * 1000, kind: 'tenant',
      run: () => picklistJob.run() });
  }
  // WF1 Rechnungseingang (n8n: Drive-Trigger) → Drive-Polling. Default Schatten
  // (kein Schreiben); Cutover via WF1_CUTOVER=1. Ohne Drive-Client „disabled".
  if (invoiceIntakeJob && !invoiceIntakeJob.disabled) {
    schedules.push({ name: invoiceIntakeJob.key, intervalMs: Number(env.WORKER_WF1_MS) || 10 * 60 * 1000, kind: 'tenant',
      run: () => invoiceIntakeJob.run() });
  }
  // Cutover-Readiness-Wächter (#198) → täglich, nach den nächtlichen Schattenläufen.
  if (cutoverMonitorJob) {
    schedules.push({ name: cutoverMonitorJob.key, dailyAt: env.WORKER_CUTOVER_AT || '02:00', kind: 'tenant',
      run: () => cutoverMonitorJob.run() });
  }
  // Worker-Job-Health-Monitor (audit.workflow_runs) → intervalMs. KEIN runOnStart
  // (erst nach den ersten Job-Läufen prüfen, sonst NO_SUCCESS-Fehlalarm).
  if (anomalyMonitorJob) {
    schedules.push({ name: anomalyMonitorJob.key, intervalMs: Number(env.WORKER_ANOMALY_MS) || 30 * 60 * 1000, kind: 'infra',
      run: () => anomalyMonitorJob.run() });
  }
  if (workerMonitorJob) {
    schedules.push({ name: workerMonitorJob.key, intervalMs: Number(env.WORKER_MONITOR_MS) || 10 * 60 * 1000, kind: 'infra',
      run: () => workerMonitorJob.run() });
  }

  const worker = createWorker({ schedules, recorder, logger: (...a) => console.log('[worker]', ...a) });
  return { worker, deps: { infraPool, appPool, directory, tenantDb, infraRunner, tenantRunner, recorder } };
}

async function main() {
  const args = process.argv.slice(2);
  const { worker, deps } = buildWorker();
  const cleanup = async () => {
    try { if (deps.directory) deps.directory.stop(); } catch { /* */ }
    try { if (deps.infraPool) await deps.infraPool.end(); } catch { /* */ }
    try { if (deps.appPool) await deps.appPool.end(); } catch { /* */ }
  };

  // Einmallauf (CLI / Render-Cron / Live-Smoke, US4): node worker.js --run <jobname>
  const runIdx = args.indexOf('--run');
  if (runIdx !== -1) {
    const jobName = args[runIdx + 1];
    if (deps.directory) { try { await deps.directory.init(); } catch (e) { console.error('[worker] Verzeichnis-Init:', e && e.message); } }
    try {
      const res = await worker.runJobNow(jobName);
      console.log(`[worker] Einmallauf "${jobName}" ok:`, JSON.stringify(res));
      await cleanup();
      process.exit(0);
    } catch (e) {
      console.error(`[worker] Einmallauf "${jobName}" FEHLER:`, e && e.message);
      await cleanup();
      process.exit(1);
    }
    return;
  }

  // Dauerbetrieb (Scheduler).
  if (deps.directory) { try { await deps.directory.init(); deps.directory.startAutoRefresh(); } catch (e) { console.error('[worker] Verzeichnis-Init:', e && e.message); } }
  worker.start();
  console.log('[worker] gestartet.');
  const shutdown = async (sig) => {
    console.log(`[worker] ${sig} — fahre herunter.`);
    worker.stop();
    await cleanup();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  main().catch((err) => { console.error('[worker] Fatal:', err && err.stack || err); process.exit(1); });
}

module.exports = { createWorker, buildWorker, HEARTBEAT_JOB, msUntilNextDailyAt };
