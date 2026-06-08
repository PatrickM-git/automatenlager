'use strict';

/**
 * Job: MatView-Refresh (Issue #161, Stufe 6 Slice 1) — ersetzt WF-MatView-Refresh.
 * SPEC: docs/specs/multi-tenant-n8n-abloesung-stufe-6-v1.md §"Pro-Workflow-Disposition"
 *
 * Dünnes Infra-Job-Modul: delegiert an den (in #160 getesteten) Infra-Runner
 * (REFRESH MATERIALIZED VIEW CONCURRENTLY über die BYPASSRLS-Verbindung). Hier wird
 * nur die Delegation + die Schnittstelle verhaltensgetrieben geprüft (Fake-Runner).
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { createMatViewRefreshJob } = require('../lib/jobs/matview-refresh.js');

test('#161 matview-refresh: run() delegiert an infraRunner.refreshMatViews() (alle MatViews)', async () => {
  let called = 0;
  const infraRunner = { refreshMatViews: async () => { called++; return [{}, {}, {}]; } };
  const job = createMatViewRefreshJob({ infraRunner });
  assert.equal(job.key, 'wf-matview-refresh');
  const r = await job.run();
  assert.equal(called, 1, 'refreshMatViews genau einmal aufgerufen');
  assert.equal(r.refreshed, 3, 'Anzahl refreshter Views zurückgegeben');
});

test('#161 matview-refresh: Fehler aus dem Infra-Runner propagiert (nie still geschluckt)', async () => {
  const infraRunner = { refreshMatViews: async () => { throw new Error('refresh kaputt'); } };
  const job = createMatViewRefreshJob({ infraRunner });
  await assert.rejects(() => job.run(), /refresh kaputt/);
});

test('#161 matview-refresh: ohne infraRunner ⇒ wirft (fail-closed)', () => {
  assert.throws(() => createMatViewRefreshJob({}), /infraRunner/);
  assert.throws(() => createMatViewRefreshJob({ infraRunner: {} }), /infraRunner/);
});
