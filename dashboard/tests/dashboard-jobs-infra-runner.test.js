'use strict';

/**
 * Infra-Runner (Issue #160, Stufe 6 Slice 0).
 * SPEC: docs/specs/multi-tenant-n8n-abloesung-stufe-6-v1.md §"Datenzugriff" + §"#107-Wächter"
 *
 * Mandantenübergreifende Pflege (MatView-REFRESH) ist der EINZIGE legitime Nicht-
 * Tür-Pfad — er läuft über die Infra-/BYPASSRLS-Verbindung (es gibt keinen
 * Mandanten zu setzen). Dieser Runner ist deshalb beim #107-Wächter die
 * dokumentierte Ausnahme (analog db-schema.js). Er kapselt rohes pg an EINER
 * Stelle; Identifier (View-Namen) werden gegen eine Allowlist validiert (kein
 * Injection-Korridor, da Identifier nicht parametrisierbar sind).
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { createInfraJobRunner, REFRESHABLE_MATVIEWS } = require('../lib/jobs/infra-runner.js');

function fakePool() {
  const calls = [];
  return { calls, query: async (sql, params) => { calls.push({ sql: String(sql), params: params || [] }); return { rows: [], rowCount: 0 }; } };
}

test('#160 Infra-Runner: refreshMatViews feuert REFRESH … CONCURRENTLY je bekannter MatView', async () => {
  const pool = fakePool();
  const runner = createInfraJobRunner({ pool });
  await runner.refreshMatViews(['mv_inventory_value_daily', 'mv_db_per_product_monthly']);
  assert.equal(pool.calls.length, 2, 'zwei REFRESH-Aufrufe');
  for (const c of pool.calls) {
    assert.match(c.sql, /REFRESH MATERIALIZED VIEW CONCURRENTLY automatenlager\./i, 'CONCURRENTLY + Schema-qualifiziert');
  }
  assert.match(pool.calls[0].sql, /mv_inventory_value_daily/);
  assert.match(pool.calls[1].sql, /mv_db_per_product_monthly/);
});

test('#160 Infra-Runner: Default refresht alle drei bekannten MatViews (SPEC)', async () => {
  const pool = fakePool();
  const runner = createInfraJobRunner({ pool });
  await runner.refreshMatViews();
  const refreshed = pool.calls.map((c) => c.sql);
  for (const v of ['mv_inventory_value_daily', 'mv_db_per_product_monthly', 'mv_db_per_slot_monthly']) {
    assert.ok(refreshed.some((s) => s.includes(v)), `Default refresht ${v}`);
  }
  assert.deepEqual([...REFRESHABLE_MATVIEWS].sort(),
    ['mv_db_per_product_monthly', 'mv_db_per_slot_monthly', 'mv_inventory_value_daily']);
});

test('#160 Infra-Runner: unbekannter/missbräuchlicher View-Name ⇒ Fehler (kein Identifier-Injection)', async () => {
  const pool = fakePool();
  const runner = createInfraJobRunner({ pool });
  await assert.rejects(() => runner.refreshMatViews(['mv_inventory_value_daily; DROP TABLE x']), /unbekannte|ungültig|allowlist/i);
  await assert.rejects(() => runner.refreshMatViews(['nicht_existent']), /unbekannte|ungültig|allowlist/i);
  assert.equal(pool.calls.length, 0, 'bei ungültigem Namen wird NICHTS ausgeführt (fail-closed)');
});

test('#160 Infra-Runner: nonConcurrent-Option lässt CONCURRENTLY weg (z. B. Erstbefüllung)', async () => {
  const pool = fakePool();
  const runner = createInfraJobRunner({ pool });
  await runner.refreshMatViews(['mv_inventory_value_daily'], { concurrently: false });
  assert.match(pool.calls[0].sql, /REFRESH MATERIALIZED VIEW automatenlager\.mv_inventory_value_daily/i);
  assert.doesNotMatch(pool.calls[0].sql, /CONCURRENTLY/i);
});

test('#160 Infra-Runner: exec reicht beliebiges Infra-SQL an die BYPASSRLS-Verbindung durch', async () => {
  const pool = fakePool();
  const runner = createInfraJobRunner({ pool });
  await runner.exec('SELECT 1', []);
  assert.equal(pool.calls[0].sql, 'SELECT 1');
});

test('#160 Infra-Runner: ohne Pool ⇒ Konstruktion wirft (kein stiller No-Op)', () => {
  assert.throws(() => createInfraJobRunner({}), /pool/i);
});
