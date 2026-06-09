'use strict';

/**
 * Audit-Log-Monitoring + Anomalie-Alarmierung (#168, IR #109 §8 / ROADMAP A3).
 * Reine Auswertung (evaluateAnomalies) + I/O (Audit-JSONL-Tail, error-Run-Zähler,
 * Backup-Warnungen) + Worker-Job mit Mail. Schwellwerte konfigurierbar.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const am = require('../lib/jobs/anomaly-monitor.js');

const NOW = new Date('2026-06-09T12:00:00.000Z');
function ev(min, extra) { return { timestamp: new Date(NOW.getTime() - min * 60000).toISOString(), ...extra }; }

// ── evaluateAnomalies ────────────────────────────────────────────────────────
test('#168 evaluateAnomalies: Häufung abgewiesener Auth im Fenster ⇒ AUTH_FAIL_SPIKE', () => {
  const auditEvents = Array.from({ length: 6 }, () => ev(10, { outcome: 'denied', event: 'capability_denied' }));
  const { alerts } = am.evaluateAnomalies({ auditEvents }, { authFailThreshold: 5, windowMin: 60, now: NOW });
  assert.ok(alerts.find((a) => a.type === 'AUTH_FAIL_SPIKE'), 'Spike erkannt');
});

test('#168 evaluateAnomalies: alte Auth-Fails außerhalb des Fensters zählen nicht', () => {
  const auditEvents = Array.from({ length: 6 }, () => ev(200, { outcome: 'denied' }));
  const { alerts } = am.evaluateAnomalies({ auditEvents }, { authFailThreshold: 5, windowMin: 60, now: NOW });
  assert.equal(alerts.find((a) => a.type === 'AUTH_FAIL_SPIKE'), undefined);
});

test('#168 evaluateAnomalies: jede Break-Glass-Nutzung im Fenster ⇒ BREAK_GLASS_USED', () => {
  const auditEvents = [ev(5, { outcome: 'ok', event: 'break_glass', targetTenant: 't_acme' })];
  const { alerts } = am.evaluateAnomalies({ auditEvents }, { now: NOW, windowMin: 60 });
  const a = alerts.find((x) => x.type === 'BREAK_GLASS_USED');
  assert.ok(a);
  assert.equal(a.severity, 'critical');
});

test('#168 evaluateAnomalies: error-Run-Häufung ⇒ ERROR_RATE_SPIKE; Backup-Warnung ⇒ BACKUP_ALERT', () => {
  const { alerts } = am.evaluateAnomalies({
    auditEvents: [], errorRunCount: 9, backupWarnings: [{ warning_type: 'BACKUP_FAIL', message: 'dump fehlgeschlagen' }],
  }, { errorRunThreshold: 5, now: NOW });
  assert.ok(alerts.find((a) => a.type === 'ERROR_RATE_SPIKE'));
  assert.ok(alerts.find((a) => a.type === 'BACKUP_ALERT'));
});

test('#168 evaluateAnomalies: alles ruhig ⇒ keine Alerts', () => {
  const { alerts } = am.evaluateAnomalies({ auditEvents: [ev(5, { outcome: 'ok' })], errorRunCount: 0, backupWarnings: [] }, { now: NOW });
  assert.equal(alerts.length, 0);
});

// ── readAuditTail ────────────────────────────────────────────────────────────
test('#168 readAuditTail: liest letzte N JSONL-Zeilen, überspringt kaputte', () => {
  const tmp = path.join(os.tmpdir(), `audit-${process.pid}-${Date.now()}.jsonl`);
  fs.writeFileSync(tmp, [JSON.stringify({ a: 1 }), 'NICHT JSON', JSON.stringify({ a: 2 })].join('\n') + '\n');
  try {
    const rows = am.readAuditTail(tmp, 10);
    assert.deepEqual(rows.map((r) => r.a), [1, 2]);
    assert.deepEqual(am.readAuditTail(path.join(os.tmpdir(), 'fehlt-nicht-da.jsonl'), 10), [], 'fehlende Datei ⇒ []');
  } finally { fs.unlinkSync(tmp); }
});

// ── createAnomalyMonitorJob ──────────────────────────────────────────────────
test('#168 createAnomalyMonitorJob: Anomalien ⇒ Mail; ruhig ⇒ keine Mail', async () => {
  const tmp = path.join(os.tmpdir(), `audit-job-${process.pid}-${Date.now()}.jsonl`);
  fs.writeFileSync(tmp, Array.from({ length: 8 }, () => JSON.stringify({ timestamp: new Date().toISOString(), outcome: 'denied' })).join('\n') + '\n');
  const sent = [];
  const mailer = { send: async (m) => { sent.push(m); } };
  const exec = async (sql) => (/stock_movements|workflow_runs/i.test(sql) ? { rows: [{ n: 0 }] } : { rows: [] });
  try {
    const job = am.createAnomalyMonitorJob({ exec, mailer, env: { ALERT_EMAIL_DEFAULT: 'ops@x.z' }, auditPath: tmp, thresholds: { authFailThreshold: 5 } });
    const r = await job.run();
    assert.ok(r.alerts.find((a) => a.type === 'AUTH_FAIL_SPIKE'));
    assert.equal(sent.length, 1, 'Mail bei Anomalie');
  } finally { fs.unlinkSync(tmp); }
});
