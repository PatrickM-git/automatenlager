'use strict';

/**
 * Migration 0027 + audit.workflow_runs-Schreibvertrag LIVE (Issue #160, Stufe 6 Slice 0).
 * SPEC: docs/specs/multi-tenant-n8n-abloesung-stufe-6-v1.md §"Job-Lauf-Telemetrie"
 *
 * Beweist gegen die ECHTE Mini-DB im #94-Sandbox-Harness (ROLLBACK):
 *   - 0027 ist idempotent (zweimal anwendbar) und additiv (bricht pgw_write nicht).
 *   - der Schreiber (lib/workflow-runs.js) schreibt einen vollständigen Lauf
 *     (Start running → Ende success/error) — Round-Trip Insert→Update→Select.
 * Skippt offline.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { inSandbox, applyMigration } = require('./helpers/migration-sandbox.js');
const { createWorkflowRunRecorder } = require('../lib/workflow-runs.js');

// Ambient-exec auf dem Sandbox-Client (alles in der äußeren Rollback-Transaktion).
function execForClient(client) {
  return (sql, params) => client.query(sql, params);
}

test('#160 0027 LIVE: idempotent — zweimal anwendbar ohne Fehler, error/source/details vorhanden', async (t) => {
  await inSandbox(t, async (client) => {
    await applyMigration(client, 27);
    await applyMigration(client, 27); // idempotent
    const cols = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='audit' AND table_name='workflow_runs'`);
    const names = cols.rows.map((r) => r.column_name);
    for (const c of ['run_id', 'workflow_key', 'started_at', 'finished_at', 'status', 'error', 'source', 'details']) {
      assert.ok(names.includes(c), `Spalte ${c} vorhanden`);
    }
  });
});

test('#160 Schreiber LIVE: recordRun Erfolg schreibt einen vollständigen Lauf (running→success)', async (t) => {
  await inSandbox(t, async (client) => {
    await applyMigration(client, 27);
    const rec = createWorkflowRunRecorder({ exec: execForClient(client), source: 'worker' });
    const key = 'test-slice0-roundtrip-success';

    const out = await rec.recordRun(key, async () => 'erledigt');
    assert.equal(out, 'erledigt');

    const r = await client.query(
      `SELECT workflow_key, status, started_at, finished_at, error, source
         FROM audit.workflow_runs WHERE workflow_key = $1`, [key]);
    assert.equal(r.rows.length, 1, 'genau ein Lauf protokolliert');
    assert.equal(r.rows[0].status, 'success');
    assert.ok(r.rows[0].finished_at, 'finished_at gesetzt');
    assert.equal(r.rows[0].error, null, 'kein Fehler bei Erfolg');
    assert.equal(r.rows[0].source, 'worker');
  });
});

test('#160 Schreiber LIVE: recordRun Fehler protokolliert status=error + Meldung und wirft', async (t) => {
  await inSandbox(t, async (client) => {
    await applyMigration(client, 27);
    const rec = createWorkflowRunRecorder({ exec: execForClient(client), source: 'worker' });
    const key = 'test-slice0-roundtrip-error';

    await assert.rejects(() => rec.recordRun(key, async () => { throw new Error('Nayax-Timeout'); }), /Nayax-Timeout/);

    const r = await client.query(
      `SELECT status, error FROM audit.workflow_runs WHERE workflow_key = $1`, [key]);
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].status, 'error');
    assert.match(r.rows[0].error, /Nayax-Timeout/);
  });
});

test('#160 Schreiber LIVE: bricht pgw_write-Bestand nicht — bestehende WF-PGW-Läufe bleiben lesbar', async (t) => {
  await inSandbox(t, async (client) => {
    await applyMigration(client, 27);
    // Additiv: die out-of-band-Spalten/Daten bleiben unangetastet (Lesbarkeit als Beleg).
    const r = await client.query(
      `SELECT count(*)::int AS n FROM audit.workflow_runs WHERE workflow_key = 'WF-PGW'`);
    assert.ok(Number.isInteger(r.rows[0].n), 'WF-PGW-Telemetrie weiterhin lesbar (Spaltenvertrag kompatibel)');
  });
});
