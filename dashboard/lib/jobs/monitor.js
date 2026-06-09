'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Job: Worker-Job-Health-Monitor — Issue #161 (Stufe 6, Slice 1).
//
// ABGRENZUNG zu WF-Monitor (n8n `EdgUfv1lMcE25Z3K`, bleibt vorerst AKTIV): Der
// Kern von WF-Monitor ist der `execution_entity`-Check der NOCH in n8n laufenden
// produktiven Workflows (WF1/2/3/5/7/9 — Slice 2/3). Dieser Teil kann erst
// abgelöst werden, wenn diese Workflows selbst portiert sind. Sein voller Port
// gehört daher ans ENDE von Stufe 6.
//
// DIESER Job überwacht die NEUE Welt, die WF-Monitor NICHT kennt: die WORKER-Jobs
// über `audit.workflow_runs` (der n8n-`execution_entity`-Ersatz). Er meldet, wenn
// ein erwarteter Job zu lange keinen Erfolg hatte ODER zuletzt fehlschlug — genau
// die SCHEDULE_GAP-/WORKFLOW_ERROR-Idee von WF-Monitor, aber quellgetrennt
// (audit.workflow_runs statt n8n-DB) ⇒ kein Doppel-Monitoring.
//
// `audit.workflow_runs` ist SYSTEM-Telemetrie OHNE tenant_id ⇒ INFRA-Verbindung
// (injizierter `exec`, wie workflow-runs.js), NICHT die Mandanten-Tür. KEIN rohes
// pg (#107-rein). Alert über den provider-agnostischen Mailer.
// ─────────────────────────────────────────────────────────────────────────────

const WORKFLOW_KEY = 'wf-worker-monitor';

const SUCCESS_STATES = new Set(['success', 'succeeded', 'ok']);

// Erwartete Worker-Jobs + Max-Alter ihres letzten Erfolgs (Minuten). Default-Set
// deckt die in Slice 0/1 portierten Jobs ab. Über opts.expectedJobs überschreibbar.
const DEFAULT_EXPECTED_JOBS = Object.freeze([
  { key: 'worker-heartbeat', maxAgeMin: 20 },        // alle 5 min
  { key: 'wf-guv-aggregate', maxAgeMin: 60 },        // alle 15 min
  { key: 'wf-guv-backfill', maxAgeMin: 60 * 14 },    // alle 6 h (Lücken-Fallback; toleriert 1 Aussetzer + Restart)
  { key: 'wf-matview-refresh', maxAgeMin: 60 * 26 }, // täglich 04:45
  { key: 'wf-db-validation', maxAgeMin: 60 * 26 },   // täglich 04:15
  { key: 'wf-nayax-devices-sync', maxAgeMin: 60 * 26 }, // täglich 04:20
]);

function isSuccess(status) {
  return SUCCESS_STATES.has(String(status || '').trim().toLowerCase());
}

/**
 * REINE Auswertung: aus den letzten Läufen je Job + den Erwartungen die Alerts
 * ableiten. `rows`: [{workflow_key, last_success_at, last_status, last_run_at}].
 */
function evaluateJobHealth(rows = [], expectedJobs = DEFAULT_EXPECTED_JOBS, now = new Date()) {
  const byKey = new Map((rows || []).map((r) => [String(r.workflow_key), r]));
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const alerts = [];
  const ok = [];
  for (const job of expectedJobs) {
    const row = byKey.get(job.key);
    if (!row || !row.last_success_at) {
      alerts.push({ type: 'NO_SUCCESS', key: job.key, severity: 'critical', message: `Kein erfolgreicher Lauf von ${job.key} in der Telemetrie` });
      continue;
    }
    const ageMin = (nowMs - new Date(row.last_success_at).getTime()) / 60000;
    let alerted = false;
    if (Number.isFinite(ageMin) && ageMin > job.maxAgeMin) {
      alerts.push({ type: 'SCHEDULE_GAP', key: job.key, severity: 'warning', ageMin: Math.round(ageMin), limitMin: job.maxAgeMin, message: `${job.key}: letzter Erfolg vor ${Math.round(ageMin)} min (Limit ${job.maxAgeMin} min)` });
      alerted = true;
    }
    if (row.last_status != null && !isSuccess(row.last_status)) {
      alerts.push({ type: 'LAST_RUN_FAILED', key: job.key, severity: 'warning', lastStatus: row.last_status, message: `${job.key}: letzter Lauf-Status "${row.last_status}"` });
      alerted = true;
    }
    if (!alerted) ok.push(job.key);
  }
  return { alerts, ok };
}

/** Mail aus den Alerts (oder null, wenn keine). Faithful-nah am WF-Monitor-Stil. */
function buildMonitorMail(alerts, nowIso) {
  if (!alerts || !alerts.length) return null;
  const ts = nowIso || new Date().toISOString();
  const crit = alerts.filter((a) => a.severity === 'critical').length;
  const lead = alerts[0].message;
  const items = alerts.map((a) => `<li>[${a.severity}] ${a.message}</li>`).join('');
  return {
    subject: `[Worker-Monitor] ${alerts.length} Alert${alerts.length !== 1 ? 's' : ''}${crit ? ' (kritisch)' : ''} - ${lead}`,
    html: `<h2 style="color:#c0392b">Worker-Monitor: ${alerts.length} Alert${alerts.length !== 1 ? 's' : ''}</h2><ul>${items}</ul><hr><p style="color:#888;font-size:12px">Worker-Monitor: ${ts}</p>`,
  };
}

/** Liest die letzten Läufe je Job aus audit.workflow_runs (Infra-exec). */
async function readJobRuns(exec, keys) {
  const res = await exec(
    `SELECT workflow_key,
            MAX(started_at) FILTER (WHERE lower(status) IN ('success','succeeded','ok')) AS last_success_at,
            (ARRAY_AGG(status ORDER BY started_at DESC))[1] AS last_status,
            MAX(started_at) AS last_run_at
       FROM audit.workflow_runs
      WHERE workflow_key = ANY($1) AND started_at > NOW() - INTERVAL '7 days'
      GROUP BY workflow_key`,
    [keys],
  );
  return (res && res.rows) || [];
}

/**
 * @param {object} deps
 * @param {(sql:string,params:any[])=>Promise<{rows:any[]}>} deps.exec  INFRA-Executor.
 * @param {{send:Function}} [deps.mailer]
 * @param {object} [deps.env]
 * @param {object[]} [deps.expectedJobs]
 * @param {()=>Date} [deps.now]
 * @returns {{key:string, run:()=>Promise<any>}}
 */
function createWorkerHealthMonitorJob({ exec, mailer, env = process.env, expectedJobs = DEFAULT_EXPECTED_JOBS, now } = {}) {
  if (typeof exec !== 'function') throw new TypeError('monitor: exec (INFRA-Executor) erforderlich');
  const clock = typeof now === 'function' ? now : () => new Date();
  return {
    key: WORKFLOW_KEY,
    run: async () => {
      const rows = await readJobRuns(exec, expectedJobs.map((j) => j.key));
      const { alerts, ok } = evaluateJobHealth(rows, expectedJobs, clock());
      let mailed = false;
      if (alerts.length && mailer) {
        const to = (env.ALERT_EMAIL_DEFAULT && String(env.ALERT_EMAIL_DEFAULT).trim()) || null;
        const mail = buildMonitorMail(alerts, clock().toISOString());
        if (to && mail) { await mailer.send({ to, subject: mail.subject, html: mail.html }); mailed = true; }
      }
      return { checked: expectedJobs.length, okJobs: ok, alerts, mailed };
    },
  };
}

module.exports = {
  createWorkerHealthMonitorJob,
  evaluateJobHealth,
  buildMonitorMail,
  readJobRuns,
  isSuccess,
  DEFAULT_EXPECTED_JOBS,
  WORKFLOW_KEY,
};
