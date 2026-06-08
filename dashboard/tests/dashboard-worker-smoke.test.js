'use strict';

/**
 * Worker-Smoke (Issue #160, Stufe 6 Slice 0).
 * SPEC: docs/specs/multi-tenant-n8n-abloesung-stufe-6-v1.md §"Testing Decisions"
 *
 * Beweist die Pipeline OHNE echtes pg/echtes node-cron (beide injiziert):
 *   node-cron feuert ⇒ Job läuft ⇒ Lauf landet in audit.workflow_runs.
 * Die LIVE-Variante (echter DB-Schreibvertrag + Migration 0027) steht in
 * dashboard-jobs-migration-0027.test.js.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { createWorker, HEARTBEAT_JOB } = require('../worker.js');
const { createWorkflowRunRecorder } = require('../lib/workflow-runs.js');

// In-Memory-Attrappe von audit.workflow_runs (INSERT…RETURNING run_id / UPDATE).
function memAudit() {
  const rows = [];
  let id = 0;
  const exec = async (sql, params) => {
    if (/INSERT INTO audit\.workflow_runs/i.test(sql) && /RETURNING run_id/i.test(sql)) {
      const run = { run_id: ++id, workflow_key: params[0], status: params[1], started_at: params[2], source: params[3], finished_at: null, error: null };
      rows.push(run); return { rows: [{ run_id: run.run_id }], rowCount: 1 };
    }
    if (/INSERT INTO audit\.workflow_runs/i.test(sql)) {
      rows.push({ run_id: ++id, workflow_key: params[0], status: params[1], started_at: params[2], finished_at: params[3], error: params[4], source: params[5] });
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE audit\.workflow_runs/i.test(sql)) {
      const run = rows.find((r) => r.run_id === params[0]);
      if (run) { run.status = params[1]; run.finished_at = params[2]; run.error = params[3]; }
      return { rows: [], rowCount: run ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  };
  return { rows, exec };
}

// Fake-cron: erfasst geplante Jobs; `fn()` simuliert das Feuern.
function fakeCron() {
  const jobs = [];
  return {
    jobs,
    validate: (expr) => typeof expr === 'string' && expr.trim().split(/\s+/).length >= 5,
    schedule: (expr, fn) => { const j = { expr, fn, stopped: false, stop() { this.stopped = true; } }; jobs.push(j); return j; },
  };
}

const FIXED = () => new Date('2026-06-08T08:00:00.000Z');

test('#160 Worker-Smoke: node-cron feuert ⇒ Heartbeat-Lauf in audit.workflow_runs (success, Ende gesetzt)', async () => {
  const audit = memAudit();
  const recorder = createWorkflowRunRecorder({ exec: audit.exec, now: FIXED });
  const cron = fakeCron();
  const worker = createWorker({
    schedules: [{ name: HEARTBEAT_JOB, cronExpr: '*/5 * * * *', run: async () => ({ ok: true }) }],
    recorder, cron,
  });

  worker.start();
  assert.equal(cron.jobs.length, 1, 'genau ein Cron-Job geplant');
  assert.equal(cron.jobs[0].expr, '*/5 * * * *', 'mit dem konfigurierten Ausdruck');

  await cron.jobs[0].fn(); // cron „feuert"

  const run = audit.rows.find((r) => r.workflow_key === HEARTBEAT_JOB);
  assert.ok(run, 'ein Heartbeat-Lauf wurde protokolliert');
  assert.equal(run.status, 'success');
  assert.ok(run.finished_at, 'Ende-Zeit gesetzt (Lauf abgeschlossen)');
});

test('#160 Worker: ein fehlschlagender Tick reißt den Scheduler NICHT ab (self-heal), Lauf = error', async () => {
  const audit = memAudit();
  const recorder = createWorkflowRunRecorder({ exec: audit.exec, now: FIXED });
  const cron = fakeCron();
  const worker = createWorker({
    schedules: [{ name: 'kaputt-job', cronExpr: '* * * * *', run: async () => { throw new Error('Job-Bumm'); } }],
    recorder, cron, logger: () => {},
  });
  worker.start();
  // Der Tick-Handler fängt den Fehler ab (kein unhandled rejection, kein Abriss).
  await assert.doesNotReject(() => cron.jobs[0].fn());
  const run = audit.rows.find((r) => r.workflow_key === 'kaputt-job');
  assert.equal(run.status, 'error', 'der Fehlschlag ist als error protokolliert');
  assert.ok(/Job-Bumm/.test(run.error), 'mit Fehlermeldung');
});

test('#160 Worker: runJobNow führt einen benannten Job manuell durch die Telemetrie', async () => {
  const audit = memAudit();
  const recorder = createWorkflowRunRecorder({ exec: audit.exec, now: FIXED });
  const worker = createWorker({
    schedules: [{ name: HEARTBEAT_JOB, cronExpr: '*/5 * * * *', run: async () => 'manuell' }],
    recorder, cron: fakeCron(),
  });
  const result = await worker.runJobNow(HEARTBEAT_JOB);
  assert.equal(result, 'manuell');
  assert.ok(audit.rows.some((r) => r.workflow_key === HEARTBEAT_JOB && r.status === 'success'));
});

test('#160 Worker: stop() stoppt alle Cron-Tasks (idempotent)', () => {
  const cron = fakeCron();
  const worker = createWorker({
    schedules: [{ name: HEARTBEAT_JOB, cronExpr: '*/5 * * * *', run: async () => 1 }],
    recorder: createWorkflowRunRecorder({ exec: async () => ({ rows: [{ run_id: 1 }], rowCount: 1 }) }),
    cron,
  });
  worker.start();
  worker.stop();
  assert.ok(cron.jobs[0].stopped, 'Task gestoppt');
  assert.doesNotThrow(() => worker.stop(), 'stop ist idempotent');
});

test('#160 Worker: ungültiger Cron-Ausdruck ⇒ start wirft (kein stiller Nicht-Lauf)', () => {
  const cron = fakeCron();
  const worker = createWorker({
    schedules: [{ name: 'x', cronExpr: 'kaputt', run: async () => 1 }],
    recorder: createWorkflowRunRecorder({ exec: async () => ({ rows: [{ run_id: 1 }], rowCount: 1 }) }),
    cron,
  });
  assert.throws(() => worker.start(), /ungültig|Cron/i);
});

test('#160 Worker: ohne recorder ⇒ Konstruktion wirft (Telemetrie ist Pflicht)', () => {
  assert.throws(() => createWorker({ schedules: [], cron: fakeCron() }), /recorder/i);
});

test('#160 buildWorker: require hat KEINE Seiteneffekte — exportiert die Fabrik, baut keine Pools beim Laden', () => {
  // Reines Laden des Moduls darf nicht verbinden/Pools bauen. Wir prüfen nur die API.
  const mod = require('../worker.js');
  assert.equal(typeof mod.createWorker, 'function');
  assert.equal(typeof mod.buildWorker, 'function');
  assert.equal(mod.HEARTBEAT_JOB, 'worker-heartbeat');
});
