'use strict';

/**
 * Worker-Job-Health-Monitor (Issue #161, Stufe 6 Slice 1).
 * Reine Auswertung (NO_SUCCESS / SCHEDULE_GAP / LAST_RUN_FAILED) + Mailbau +
 * Live-Read gegen das echte audit.workflow_runs (Infra, kein tenant).
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const mon = require('../lib/jobs/monitor.js');
const { connectOrSkip } = require('./helpers/migration-sandbox.js');

const NOW = new Date('2026-06-08T12:00:00Z');
const iso = (minAgo) => new Date(NOW.getTime() - minAgo * 60000).toISOString();

test('#161 evaluateJobHealth: kein Erfolg ⇒ NO_SUCCESS (critical)', () => {
  const { alerts, ok } = mon.evaluateJobHealth([], [{ key: 'wf-guv-aggregate', maxAgeMin: 60 }], NOW);
  assert.equal(ok.length, 0);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, 'NO_SUCCESS');
  assert.equal(alerts[0].severity, 'critical');
});

test('#161 evaluateJobHealth: veraltet ⇒ SCHEDULE_GAP; aktuell ⇒ ok', () => {
  const expected = [{ key: 'a', maxAgeMin: 60 }, { key: 'b', maxAgeMin: 60 }];
  const rows = [
    { workflow_key: 'a', last_success_at: iso(120), last_status: 'success' }, // 120 > 60 ⇒ gap
    { workflow_key: 'b', last_success_at: iso(10), last_status: 'success' },   // frisch ⇒ ok
  ];
  const { alerts, ok } = mon.evaluateJobHealth(rows, expected, NOW);
  assert.deepEqual(ok, ['b']);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, 'SCHEDULE_GAP');
  assert.equal(alerts[0].key, 'a');
});

test('#161 evaluateJobHealth: letzter Lauf fehlgeschlagen ⇒ LAST_RUN_FAILED (auch bei frischem Erfolg)', () => {
  const rows = [{ workflow_key: 'a', last_success_at: iso(5), last_status: 'error' }];
  const { alerts } = mon.evaluateJobHealth(rows, [{ key: 'a', maxAgeMin: 60 }], NOW);
  assert.ok(alerts.some((x) => x.type === 'LAST_RUN_FAILED'));
});

test('#161 buildMonitorMail: keine Alerts ⇒ null; sonst Betreff+HTML', () => {
  assert.equal(mon.buildMonitorMail([]), null);
  const m = mon.buildMonitorMail([{ severity: 'critical', message: 'X down' }], '2026-06-08T00:00:00Z');
  assert.match(m.subject, /\[Worker-Monitor\] 1 Alert \(kritisch\) - X down/);
  assert.match(m.html, /<li>\[critical\] X down<\/li>/);
});

test('#161 createWorkerHealthMonitorJob: ohne exec ⇒ TypeError; mit Fakes ⇒ Alerts + Mail', async () => {
  assert.throws(() => mon.createWorkerHealthMonitorJob({}), /exec/);
  const fakeExec = async () => ({ rows: [] }); // keine Läufe ⇒ alle erwartet NO_SUCCESS
  const sent = [];
  const job = mon.createWorkerHealthMonitorJob({
    exec: fakeExec,
    mailer: { send: async (m) => { sent.push(m); return { id: '1' }; } },
    env: { ALERT_EMAIL_DEFAULT: 'ops@x' },
    expectedJobs: [{ key: 'wf-guv-aggregate', maxAgeMin: 60 }],
    now: () => NOW,
  });
  const res = await job.run();
  assert.equal(res.alerts.length, 1);
  assert.equal(res.mailed, true);
  assert.equal(sent[0].to, 'ops@x');
});

test('#161 readJobRuns LIVE: Query gegen echtes audit.workflow_runs (Infra)', async (t) => {
  const client = await connectOrSkip(t);
  if (!client) return;
  try {
    const exec = (sql, params) => client.query(sql, params);
    const rows = await mon.readJobRuns(exec, ['worker-heartbeat', 'wf-guv-aggregate']);
    assert.ok(Array.isArray(rows), 'Query liefert Zeilen-Array');
    // nicht-vakuös, falls Telemetrie vorhanden: jede Zeile trägt die erwarteten Felder
    for (const r of rows) {
      assert.ok('workflow_key' in r && 'last_success_at' in r && 'last_status' in r, 'Schema-Felder vorhanden');
    }
  } finally {
    await client.end();
  }
});
