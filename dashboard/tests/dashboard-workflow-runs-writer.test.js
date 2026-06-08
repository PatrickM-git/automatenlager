'use strict';

/**
 * audit.workflow_runs-Schreiber (Issue #160, Stufe 6 Slice 0) — Lauf-Telemetrie.
 * SPEC: docs/specs/multi-tenant-n8n-abloesung-stufe-6-v1.md §"Job-Lauf-Telemetrie"
 *
 * Ersetzt n8ns `execution_entity`: der Worker protokolliert je Lauf Start/Ende/
 * Status/Fehler (`workflow_key` = Job-Name). `audit.workflow_runs` ist System-
 * Telemetrie OHNE tenant_id (geteilte Pipeline) ⇒ läuft über die INFRA-Verbindung
 * (injizierter `exec`), NICHT durch die Mandanten-Tür. Verhaltensgetrieben mit
 * einem Fake-`exec` (kein echtes pg nötig).
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { createWorkflowRunRecorder } = require('../lib/workflow-runs.js');

// Fake-exec: erfasst alle SQL-Aufrufe; liefert für INSERT…RETURNING eine run_id.
function makeFakeExec({ failOnUpdate = false } = {}) {
  const calls = [];
  let nextId = 41;
  const exec = async (sql, params) => {
    calls.push({ sql: String(sql), params: params || [] });
    if (/INSERT\s+INTO\s+audit\.workflow_runs/i.test(sql)) {
      return { rows: [{ run_id: ++nextId }], rowCount: 1 };
    }
    if (/UPDATE\s+audit\.workflow_runs/i.test(sql)) {
      if (failOnUpdate) throw new Error('update kaputt');
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  return { exec, calls };
}

const FIXED = new Date('2026-06-08T08:00:00.000Z');

test('#160 recordRun Erfolg: schreibt Start (running) + Ende (success), gibt fn-Ergebnis zurück', async () => {
  const { exec, calls } = makeFakeExec();
  const rec = createWorkflowRunRecorder({ exec, now: () => FIXED });
  const result = await rec.recordRun('wf8-guv-daily', async () => 'fertig');

  assert.equal(result, 'fertig', 'Ergebnis der Job-Funktion wird durchgereicht');
  const insert = calls.find((c) => /INSERT INTO audit\.workflow_runs/i.test(c.sql));
  const update = calls.find((c) => /UPDATE audit\.workflow_runs/i.test(c.sql));
  assert.ok(insert, 'Start-Zeile geschrieben');
  assert.ok(update, 'Ende-Zeile geschrieben');
  assert.ok(insert.params.includes('wf8-guv-daily'), 'workflow_key = Job-Name in der Start-Zeile');
  // Status-Übergang running → success, finished_at gesetzt.
  assert.ok(update.params.some((p) => String(p).toLowerCase() === 'success'), 'Endstatus success');
});

test('#160 recordRun: Start+Ende über dieselbe run_id verknüpft (parametrisiert, kein String-SQL)', async () => {
  const { exec, calls } = makeFakeExec();
  const rec = createWorkflowRunRecorder({ exec, now: () => FIXED });
  await rec.recordRun('wf-matview-refresh', async () => null);
  const update = calls.find((c) => /UPDATE audit\.workflow_runs/i.test(c.sql));
  assert.ok(update.params.includes(42), 'die von INSERT gelieferte run_id (42) steuert das UPDATE');
  // Kein interpolierter Wert: die SQL-Texte tragen Platzhalter, Werte stehen in params.
  for (const c of calls) assert.match(c.sql, /\$\d/, 'parametrisierte SQL (Platzhalter vorhanden)');
});

test('#160 recordRun Fehler: protokolliert status=error + Fehlermeldung und wirft weiter', async () => {
  const { exec, calls } = makeFakeExec();
  const rec = createWorkflowRunRecorder({ exec, now: () => FIXED });
  await assert.rejects(
    () => rec.recordRun('wf3-nayax', async () => { throw new Error('Nayax 500'); }),
    /Nayax 500/,
    'der ursprüngliche Fehler propagiert (nie verschluckt)',
  );
  const update = calls.find((c) => /UPDATE audit\.workflow_runs/i.test(c.sql));
  assert.ok(update, 'auch im Fehlerfall wird das Ende geschrieben');
  assert.ok(update.params.some((p) => String(p).toLowerCase() === 'error'), 'Endstatus error');
  assert.ok(update.params.some((p) => /Nayax 500/.test(String(p))), 'Fehlermeldung protokolliert');
});

test('#160 recordRun: workflow_key ist Pflicht (fail-closed)', async () => {
  const { exec } = makeFakeExec();
  const rec = createWorkflowRunRecorder({ exec, now: () => FIXED });
  await assert.rejects(() => rec.recordRun('', async () => 1), /workflow_key/i);
  await assert.rejects(() => rec.recordRun(null, async () => 1), /workflow_key/i);
});

test('#160 writeRun: fertige Lauf-Zeile direkt schreiben (ein Insert mit Status+Zeiten)', async () => {
  const { exec, calls } = makeFakeExec();
  const rec = createWorkflowRunRecorder({ exec, now: () => FIXED });
  await rec.writeRun({ workflowKey: 'wf-monitor', status: 'success', startedAt: FIXED, finishedAt: FIXED });
  assert.equal(calls.length, 1, 'genau ein Insert');
  assert.match(calls[0].sql, /INSERT INTO audit\.workflow_runs/i);
  assert.ok(calls[0].params.includes('wf-monitor'));
  assert.ok(calls[0].params.includes('success'));
});

test('#160 recordRun: Telemetrie-Schreibfehler beim START darf den Job nicht verhindern (best-effort)', async () => {
  // Telemetrie ist Nebensache: kann die Start-Zeile nicht geschrieben werden, läuft
  // der Job trotzdem (Lieferung > Protokoll). Der Fehler wird geloggt, nicht geworfen.
  const logs = [];
  const exec = async (sql) => { if (/INSERT/i.test(sql)) throw new Error('audit down'); return { rows: [], rowCount: 1 }; };
  const rec = createWorkflowRunRecorder({ exec, now: () => FIXED, logger: (...a) => logs.push(a.join(' ')) });
  const result = await rec.recordRun('wf8-guv-daily', async () => 'lief trotzdem');
  assert.equal(result, 'lief trotzdem', 'der Job läuft trotz Telemetrie-Ausfall');
  assert.ok(logs.some((l) => /audit|telemetrie/i.test(l)), 'Telemetrie-Ausfall wird geloggt');
});
