'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Statusseite — Issue #219 (Cloud-Slice 5, Cutover-Abschluss).
//
// Aggregiert /health (Backend + DB) und die letzten Job-Läufe (audit.workflow_runs)
// zu einem Gesamtbild für eine schlanke Statusseite. Reine Auswertung (kein IO);
// der Server liefert die Daten (health-Flags + letzter Lauf je workflow_key) und
// rendert das Ergebnis als JSON (/api/v2/status) bzw. die Seite (status.html).
//
// Ein Job ist:
//   ok      — letzter Lauf success UND jünger als Intervall + Toleranz
//   stale   — letzter Lauf success, aber überfällig (Scheduler/Cron klemmt)
//   error   — letzter Lauf fehlgeschlagen
//   unknown — noch nie gelaufen (frischer Start; kippt den Status NICHT hart)
//
// Nur ÜBERWACHTE Jobs (JOB_EXPECTATIONS) zählen für den Gesamtstatus — einmalige/
// gelegentliche Jobs (Backfill) sind bewusst nicht statusrelevant.
// ─────────────────────────────────────────────────────────────────────────────

// Erwartetes Maximal-Alter je Job in Minuten (Intervall + Toleranz). Spiegelt
// die Schedule-Matrix (worker.js / pgcron-setup.sql); großzügig, um Flattern zu
// vermeiden (ein verpasster Tick allein soll nicht alarmieren).
const JOB_EXPECTATIONS = Object.freeze({
  'wf3-nayax-fifo': { label: 'Nayax-Verkäufe', maxAgeMin: 20 },        // alle 5 Min
  'nayax-filllevel-sync': { label: 'Füllstand-Sync', maxAgeMin: 20 }, // alle 5 Min
  'wf-guv-aggregate': { label: 'GuV-Aggregat', maxAgeMin: 45 },        // alle 15 Min
  'wf1-invoice-intake': { label: 'Rechnungseingang', maxAgeMin: 40 }, // alle 10 Min
  'wf9-pickliste': { label: 'Pickliste', maxAgeMin: 20 },             // alle 5 Min
  'anomaly-monitor': { label: 'Sicherheits-Monitor', maxAgeMin: 90 }, // alle 30 Min
  'wf-matview-refresh': { label: 'Kennzahlen-Refresh', maxAgeMin: 60 * 28 }, // täglich
  'wf5-monitor': { label: 'MHD/Low-Stock', maxAgeMin: 60 * 28 },      // täglich
  'backup-supabase': { label: 'Off-Site-Backup', maxAgeMin: 60 * 28 }, // täglich
});

function isSuccess(status) {
  return ['success', 'ok'].includes(String(status || '').toLowerCase());
}

function jobStatus(expectation, lastRun, nowMs) {
  if (!lastRun) return { status: 'unknown', lastRun: null, ageMin: null };
  const finishedMs = new Date(lastRun.finished_at || lastRun.started_at).getTime();
  const ageMin = Number.isFinite(finishedMs) ? Math.round((nowMs - finishedMs) / 60000) : null;
  if (!isSuccess(lastRun.status)) return { status: 'error', lastRun: lastRun.finished_at, ageMin };
  if (ageMin != null && ageMin > expectation.maxAgeMin) return { status: 'stale', lastRun: lastRun.finished_at, ageMin };
  return { status: 'ok', lastRun: lastRun.finished_at, ageMin };
}

// health: { ok, tenantDirectoryReady, pgConfigured }
// jobRuns: [{ workflow_key, status, finished_at }] — letzter Lauf je Job genügt.
function buildStatus({ health = {}, jobRuns = [], now } = {}) {
  const nowMs = (now instanceof Date ? now : new Date(now || Date.now())).getTime();

  // Letzten Lauf je workflow_key bestimmen (jobRuns kann mehrere je Key enthalten).
  const latest = new Map();
  for (const r of jobRuns) {
    const k = r.workflow_key;
    const prev = latest.get(k);
    const t = new Date(r.finished_at || r.started_at).getTime();
    if (!prev || t > new Date(prev.finished_at || prev.started_at).getTime()) latest.set(k, r);
  }

  const backendOk = health.ok !== false && health.tenantDirectoryReady !== false;
  const dbOk = health.pgConfigured !== false;
  const components = {
    backend: { status: backendOk ? 'ok' : 'down', tenantDirectoryReady: !!health.tenantDirectoryReady },
    database: { status: dbOk ? 'ok' : 'down', pgConfigured: !!health.pgConfigured },
    jobs: [],
  };

  let anyJobDegraded = false;
  for (const [key, expectation] of Object.entries(JOB_EXPECTATIONS)) {
    const js = jobStatus(expectation, latest.get(key), nowMs);
    components.jobs.push({ key, label: expectation.label, ...js });
    if (js.status === 'error' || js.status === 'stale') anyJobDegraded = true;
  }

  let overall = 'ok';
  if (!backendOk || !dbOk) overall = 'down';
  else if (anyJobDegraded) overall = 'degraded';

  return { overall, generatedAt: new Date(nowMs).toISOString(), components };
}

module.exports = { buildStatus, jobStatus, JOB_EXPECTATIONS };
