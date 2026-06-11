'use strict';

/**
 * Audit-Log-Monitoring + Anomalie-Alarmierung (#168, IR #109 §8 / ROADMAP A3).
 * Reine Auswertung (evaluateAnomalies) + I/O (Audit-Quelle: DB audit.access_log
 * maßgeblich [#213], JSONL-Tail nur Fallback; error-Run-Zähler, Backup-Warnungen)
 * + Worker-Job mit Mail. Schwellwerte konfigurierbar.
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
// #213: Die Audit-Quelle ist die DB-Tabelle audit.access_log (maßgeblich, überlebt
// Container-Restarts); die JSONL-Datei ist nur noch Fallback bei DB-Lesefehler.
test('#213 createAnomalyMonitorJob: liest Auth-Fails aus der DB (audit.access_log) ⇒ Mail', async () => {
  const sent = [];
  const mailer = { send: async (m) => { sent.push(m); } };
  const deniedRows = Array.from({ length: 8 }, (_, i) => ({
    ts: new Date(), event: 'capability_denied', outcome: 'denied',
    login: 'gast@example.test', role: 'guest', request_id: `r-${i}`, details: null,
  }));
  const exec = async (sql) => {
    if (/audit\.access_log/i.test(sql)) return { rows: deniedRows };
    if (/workflow_runs/i.test(sql)) return { rows: [{ n: 0 }] };
    return { rows: [] };
  };
  const job = am.createAnomalyMonitorJob({ exec, mailer, env: { ALERT_EMAIL_DEFAULT: 'ops@x.z' }, thresholds: { authFailThreshold: 5 } });
  const r = await job.run();
  assert.equal(r.auditSource, 'db', 'DB ist die maßgebliche Audit-Quelle');
  assert.ok(r.alerts.find((a) => a.type === 'AUTH_FAIL_SPIKE'));
  assert.equal(sent.length, 1, 'Mail bei Anomalie');
});

test('#213 createAnomalyMonitorJob: DB ruhig ⇒ keine Mail (Datei wird NICHT mehr primär gelesen)', async (t) => {
  const tmp = path.join(os.tmpdir(), `audit-job-${process.pid}-${Date.now()}-ruhig.jsonl`);
  // Datei voller denied-Events — aber die DB (maßgeblich) ist leer ⇒ keine Anomalie.
  fs.writeFileSync(tmp, Array.from({ length: 8 }, () => JSON.stringify({ timestamp: new Date().toISOString(), outcome: 'denied' })).join('\n') + '\n');
  t.after(() => fs.rmSync(tmp, { force: true }));
  const sent = [];
  const mailer = { send: async (m) => { sent.push(m); } };
  const exec = async (sql) => (/workflow_runs/i.test(sql) ? { rows: [{ n: 0 }] } : { rows: [] });
  const job = am.createAnomalyMonitorJob({ exec, mailer, env: { ALERT_EMAIL_DEFAULT: 'ops@x.z' }, auditPath: tmp, thresholds: { authFailThreshold: 5 } });
  const r = await job.run();
  assert.equal(r.auditSource, 'db');
  assert.equal(r.alerts.length, 0, 'leere DB ⇒ ruhig, Datei zählt nicht mehr primär');
  assert.equal(sent.length, 0);
});

test('#213 createAnomalyMonitorJob: DB-Lesefehler ⇒ Datei-Fallback (Verhalten/Schwellen unverändert)', async (t) => {
  const tmp = path.join(os.tmpdir(), `audit-job-${process.pid}-${Date.now()}-fb.jsonl`);
  fs.writeFileSync(tmp, Array.from({ length: 8 }, () => JSON.stringify({ timestamp: new Date().toISOString(), outcome: 'denied' })).join('\n') + '\n');
  t.after(() => fs.rmSync(tmp, { force: true }));
  const sent = [];
  const mailer = { send: async (m) => { sent.push(m); } };
  const exec = async (sql) => {
    if (/audit\.access_log/i.test(sql)) throw new Error('relation "audit.access_log" does not exist');
    if (/workflow_runs/i.test(sql)) return { rows: [{ n: 0 }] };
    return { rows: [] };
  };
  const job = am.createAnomalyMonitorJob({ exec, mailer, env: { ALERT_EMAIL_DEFAULT: 'ops@x.z' }, auditPath: tmp, thresholds: { authFailThreshold: 5 } });
  const r = await job.run();
  assert.equal(r.auditSource, 'file', 'Fallback auf die JSONL-Datei bei DB-Lesefehler');
  assert.ok(r.alerts.find((a) => a.type === 'AUTH_FAIL_SPIKE'));
  assert.equal(sent.length, 1, 'Mail bei Anomalie (Schwellen unverändert)');
});
