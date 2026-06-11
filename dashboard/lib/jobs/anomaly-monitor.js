'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Audit-Log-Monitoring + Anomalie-Alarmierung — Issue #168 (IR #109 §8 / ROADMAP A3).
//
// Baut die AUTOMATIK zu den im IR-Runbook (docs/security/incident-response-runbook.md
// §2/§8) manuell beschriebenen Indikatoren. Überwacht:
//   - Häufung abgewiesener Auth (outcome='denied' im Audit-Trail) → AUTH_FAIL_SPIKE
//   - Break-Glass-Nutzung (X-Support-Tenant ⇒ targetTenant gesetzt) → BREAK_GLASS_USED (immer)
//   - Häufung fehlgeschlagener Läufe (audit.workflow_runs status=error) → ERROR_RATE_SPIKE
//   - Backup-Fehler (warnings BACKUP_FAIL/BACKUP_STALE, unresolved) → BACKUP_ALERT
//
// Lauf-/Backup-Telemetrie ist SYSTEM-weit (kein tenant_id für den Ops-Blick) ⇒ INFRA-
// Executor (injizierter `exec`, wie monitor.js/workflow-runs.js), NICHT die Mandanten-
// Tür. KEIN rohes pg (#107-rein).
//
// #213 (flüchtiges Cloud-FS): Die Audit-Quelle ist die DB-Tabelle audit.access_log
// (Migration 0035, maßgeblich — überlebt Container-Restarts); der JSONL-Tail
// (guest-access.jsonl) ist nur noch FALLBACK bei DB-Lesefehler (z. B. Migration
// noch nicht angewendet / lokale Dev ohne Tabelle). Verhalten/Schwellen unverändert.
// Alert über den provider-agnostischen Mailer. Schwellwerte konfigurierbar.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('node:fs');
const path = require('node:path');

const { readAuditEventsDb } = require('../audit-log.js');

const ANOMALY_MONITOR_KEY = 'anomaly-monitor';
const DEFAULTS = Object.freeze({ windowMin: 60, authFailThreshold: 10, errorRunThreshold: 5, tailLines: 2000 });

function toMs(t) { const d = new Date(t); const ms = d.getTime(); return Number.isFinite(ms) ? ms : null; }

function isBreakGlass(e) {
  if (!e) return false;
  if (e.targetTenant != null && String(e.targetTenant).trim() !== '') return true;
  return /break.?glass|support.?tenant|support.?session/i.test(String(e.event || ''));
}

/**
 * REINE Auswertung der Anomalie-Signale.
 * @param {object} sources { auditEvents[], errorRunCount, backupWarnings[] }
 * @param {object} opts    { now, windowMin, authFailThreshold, errorRunThreshold }
 * @returns {{alerts:object[]}}
 */
function evaluateAnomalies(sources = {}, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date(opts.now || Date.now());
  const windowMin = Number(opts.windowMin) || DEFAULTS.windowMin;
  const authFailThreshold = Number(opts.authFailThreshold) || DEFAULTS.authFailThreshold;
  const errorRunThreshold = Number(opts.errorRunThreshold) || DEFAULTS.errorRunThreshold;
  const cutoff = now.getTime() - windowMin * 60000;
  const inWindow = (e) => { const ms = toMs(e && e.timestamp); return ms != null && ms >= cutoff; };

  const events = (sources.auditEvents || []).filter(inWindow);
  const alerts = [];

  const authFails = events.filter((e) => String(e.outcome || '').toLowerCase() === 'denied').length;
  if (authFails >= authFailThreshold) {
    alerts.push({ type: 'AUTH_FAIL_SPIKE', severity: 'warning', count: authFails, windowMin, message: `${authFails} abgewiesene Aktionen in ${windowMin} min (Limit ${authFailThreshold})` });
  }

  const breakGlass = events.filter(isBreakGlass);
  if (breakGlass.length) {
    const tenants = [...new Set(breakGlass.map((e) => e.targetTenant).filter(Boolean))];
    alerts.push({ type: 'BREAK_GLASS_USED', severity: 'critical', count: breakGlass.length, tenants, message: `Break-Glass ${breakGlass.length}× genutzt/angefragt${tenants.length ? ` (Ziel: ${tenants.join(', ')})` : ''}` });
  }

  const errorRuns = Number(sources.errorRunCount) || 0;
  if (errorRuns >= errorRunThreshold) {
    alerts.push({ type: 'ERROR_RATE_SPIKE', severity: 'warning', count: errorRuns, windowMin, message: `${errorRuns} fehlgeschlagene Job-Läufe in ${windowMin} min (Limit ${errorRunThreshold})` });
  }

  for (const w of sources.backupWarnings || []) {
    alerts.push({ type: 'BACKUP_ALERT', severity: 'critical', warningType: w.warning_type, message: `Backup-Warnung ${w.warning_type}: ${w.message || ''}`.trim() });
  }

  return { alerts };
}

function buildAnomalyMail(alerts, nowIso) {
  if (!alerts || !alerts.length) return null;
  const ts = nowIso || new Date().toISOString();
  const crit = alerts.filter((a) => a.severity === 'critical').length;
  const items = alerts.map((a) => `<li>[${a.severity}] ${a.message}</li>`).join('');
  const text = alerts.map((a) => `[${a.severity}] ${a.message}`).join('\n');
  return {
    subject: `[Sicherheits-Monitor] ${alerts.length} Anomalie${alerts.length !== 1 ? 'n' : ''}${crit ? ' (kritisch)' : ''}`,
    text: `${text}\n\nAnomalie-Monitor: ${ts}`,
    html: `<h2 style="color:#c0392b">Sicherheits-Monitor: ${alerts.length} Anomalie${alerts.length !== 1 ? 'n' : ''}</h2><ul>${items}</ul><hr><p style="color:#888;font-size:12px">${ts}</p>`,
  };
}

/** Letzte N Zeilen eines JSONL-Audit-Logs lesen + parsen (kaputte Zeilen übersprungen). */
function readAuditTail(filePath, maxLines = DEFAULTS.tailLines) {
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch { return []; }
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const tail = lines.slice(-Math.max(1, maxLines));
  const out = [];
  for (const l of tail) { try { out.push(JSON.parse(l)); } catch { /* kaputte Zeile überspringen */ } }
  return out;
}

async function readErrorRunCount(exec, windowMin) {
  const res = await exec(
    `SELECT count(*)::int AS n FROM audit.workflow_runs
      WHERE lower(status) IN ('error','failed') AND started_at > NOW() - ($1 || ' minutes')::interval`,
    [String(windowMin)],
  );
  return (res && res.rows && res.rows[0] && Number(res.rows[0].n)) || 0;
}

// Ops-Scan über die Infra-Verbindung (BYPASSRLS): Backup-Warnungen sind SYSTEM-Health,
// kein Mandanten-Datenpfad. Wie der audit.workflow_runs-Pfad bewusst nicht durch die Tür.
async function readBackupWarnings(exec) {
  const res = await exec(
    `SELECT warning_type, message FROM automatenlager.warnings
      WHERE warning_type IN ('BACKUP_FAIL','BACKUP_STALE') AND resolved = FALSE
      ORDER BY created_at DESC LIMIT 20`,
    [],
  );
  return (res && res.rows) || [];
}

/**
 * @param {object} deps
 * @param {(sql:string,params:any[])=>Promise<{rows:any[]}>} deps.exec  INFRA-Executor.
 * @param {{send:Function}} [deps.mailer]
 * @param {object} [deps.env]
 * @param {string} [deps.auditPath]  FALLBACK-JSONL (#213: DB ist primär).
 *                                   Default: DASHBOARD_AUDIT_LOG oder logs/guest-access.jsonl.
 * @param {object} [deps.thresholds]
 * @param {()=>Date} [deps.now]
 * @returns {{key:string, run:()=>Promise<any>}}
 */
function createAnomalyMonitorJob({ exec, mailer, env = process.env, auditPath, thresholds = {}, now } = {}) {
  if (typeof exec !== 'function') throw new TypeError('anomaly-monitor: exec (INFRA-Executor) erforderlich');
  const clock = typeof now === 'function' ? now : () => new Date();
  const file = auditPath || env.DASHBOARD_AUDIT_LOG || path.join(__dirname, '..', '..', 'logs', 'guest-access.jsonl');
  const opts = {
    windowMin: Number(env.ANOMALY_WINDOW_MIN) || thresholds.windowMin || DEFAULTS.windowMin,
    authFailThreshold: Number(env.ANOMALY_AUTHFAIL_MAX) || thresholds.authFailThreshold || DEFAULTS.authFailThreshold,
    errorRunThreshold: Number(env.ANOMALY_ERRORRUN_MAX) || thresholds.errorRunThreshold || DEFAULTS.errorRunThreshold,
  };
  return {
    key: ANOMALY_MONITOR_KEY,
    run: async () => {
      // #213: DB primär (audit.access_log überlebt Restarts); JSONL-Tail nur als
      // Fallback bei DB-Lesefehler. evaluateAnomalies filtert das Fenster ohnehin
      // selbst ⇒ identische Auswertung/Schwellen für beide Quellen.
      let auditEvents;
      let auditSource = 'db';
      try {
        auditEvents = await readAuditEventsDb(exec, { windowMin: opts.windowMin, limit: DEFAULTS.tailLines });
      } catch {
        auditSource = 'file';
        auditEvents = readAuditTail(file, DEFAULTS.tailLines);
      }
      const errorRunCount = await readErrorRunCount(exec, opts.windowMin);
      const backupWarnings = await readBackupWarnings(exec);
      const { alerts } = evaluateAnomalies({ auditEvents, errorRunCount, backupWarnings }, { ...opts, now: clock() });
      let mailed = false;
      const to = (env.ALERT_EMAIL_DEFAULT && String(env.ALERT_EMAIL_DEFAULT).trim()) || null;
      if (alerts.length && mailer && to) {
        const mail = buildAnomalyMail(alerts, clock().toISOString());
        if (mail) { await mailer.send({ to, subject: mail.subject, text: mail.text, html: mail.html }); mailed = true; }
      }
      return { auditEventsScanned: auditEvents.length, auditSource, errorRunCount, backupWarnings: backupWarnings.length, alerts, mailed };
    },
  };
}

module.exports = {
  ANOMALY_MONITOR_KEY,
  DEFAULTS,
  evaluateAnomalies,
  buildAnomalyMail,
  readAuditTail,
  readErrorRunCount,
  readBackupWarnings,
  createAnomalyMonitorJob,
};
