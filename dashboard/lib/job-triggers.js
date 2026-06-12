'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Geschützte Job-Trigger-Endpunkte — Issue #217 (Cloud-Slice 3).
//
// Auf der Render-Gratis-Stufe gibt es keinen Dauer-Worker: Supabase pg_cron ruft
// per pg_net `POST /internal/jobs/<key>` auf (Entscheidung + Schutzmechanismus:
// docs/cloud-migration/slice-0-cron-quelle-entscheidung.md). Die Job-LOGIK bleibt
// identisch — der Endpunkt ruft `worker.runJobNow(key)` (gleiche Verkabelung wie
// ein Worker-Tick, inkl. Telemetrie in audit.workflow_runs via recordRun).
//
// Schutz (Pflicht):
//  - Ohne konfiguriertes WORKER_TRIGGER_SECRET ist der Pfad TOT (404) — der
//    Endpunkt darf nie ein offener „führe einen Schreibjob aus"-Hebel sein.
//  - Secret-Vergleich timing-safe (crypto.timingSafeEqual über SHA-256-Digests —
//    konstante Länge, kein Längen-Orakel, wirft nie).
//  - Nur POST (405 sonst); unbekannter Job ⇒ 404; kein CORS-Allow (eigener
//    /internal/-Präfix, vom Frontend nie erreichbar).
//  - Antwort 202 SOFORT, Lauf asynchron — pg_net-Aufrufe haben enge Timeouts;
//    das Ergebnis steht in audit.workflow_runs (Status ok/error), nicht im
//    HTTP-Body. Doppel-Ticks sind unschädlich (Jobs idempotent).
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('node:crypto');

function timingSafeSecretEqual(given, expected) {
  try {
    const a = crypto.createHash('sha256').update(String(given || ''), 'utf8').digest();
    const b = crypto.createHash('sha256').update(String(expected || ''), 'utf8').digest();
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/**
 * Reine Handler-Fabrik (DB-frei testbar).
 * @param {object} deps
 * @param {string} deps.secret              WORKER_TRIGGER_SECRET ('' ⇒ Pfad tot).
 * @param {(key:string)=>Promise<any>} deps.runJobNow  Worker-Verkabelung (recordRun inklusive).
 * @param {()=>string[]} deps.listJobs      bekannte Job-Keys.
 * @param {Function} [deps.logger]
 * @returns {(req,res,jobKey:string)=>Promise<void>}
 */
function createJobTriggerHandler({ secret, runJobNow, listJobs, logger } = {}) {
  if (typeof runJobNow !== 'function' || typeof listJobs !== 'function') {
    throw new TypeError('job-triggers: runJobNow und listJobs erforderlich');
  }
  const log = typeof logger === 'function' ? logger : (...a) => console.log('[job-trigger]', ...a);
  const configured = String(secret || '').trim();

  return async function handleJobTrigger(req, res, jobKey) {
    // Ohne Secret-Konfiguration existiert der Pfad nach außen nicht (404,
    // ununterscheidbar von einer unbekannten Route — kein Erkundungs-Orakel).
    if (!configured) { sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND' } }); return; }

    const given = (req.headers && req.headers['x-worker-trigger-secret']) || '';
    if (!timingSafeSecretEqual(given, configured)) {
      sendJson(res, 401, { ok: false, error: { code: 'TRIGGER_SECRET_INVALID' } });
      return;
    }
    if (String(req.method || '').toUpperCase() !== 'POST') {
      sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Nur POST.' } });
      return;
    }
    const key = String(jobKey || '').trim();
    if (!listJobs().includes(key)) {
      sendJson(res, 404, { ok: false, error: { code: 'JOB_UNKNOWN', message: `Unbekannter Job: ${key}` } });
      return;
    }

    // 202 sofort; der Lauf läuft asynchron weiter (Telemetrie via recordRun —
    // ein Fehler steht als status=error in audit.workflow_runs, wie beim Worker).
    sendJson(res, 202, { ok: true, job: key, started: true });
    runJobNow(key).catch((err) => log(`Job "${key}" (Trigger) fehlgeschlagen:`, err && err.message));
  };
}

module.exports = { createJobTriggerHandler, timingSafeSecretEqual };
