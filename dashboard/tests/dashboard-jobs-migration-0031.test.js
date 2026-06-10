'use strict';

/**
 * Migration 0031 — globale (key)-Uniques droppen → nur noch (tenant_id, key)
 * (Issue #111, Teil der n8n-Ablösung Stufe 6 / Abschluss-Slice #164).
 * SPEC: docs/specs/multi-tenant-n8n-abloesung-stufe-6-v1.md §"Migrationen 0027+".
 *
 * Beweist gegen die ECHTE Mini-DB im #94-Sandbox-Harness (ROLLBACK):
 *   - Nach 0031 existiert KEIN Single-/Global-(key)-Unique mehr auf den fachlichen
 *     Schlüsseln; nur noch der mandantengeschlüsselte (tenant_id, key)-Unique (aus 0012).
 *   - sales_transactions: globaler (nayax_transaction_id)-Unique weg; provider-aware
 *     (tenant_id, provider, nayax_transaction_id) (aus 0015) bleibt.
 *   - workflow_state-PK ist jetzt (tenant_id, workflow_key) statt (workflow_key).
 *   - idx_slot_active (global) ist weg; idx_slot_active_tenant bleibt.
 *   - 0031 ist idempotent (zweimal anwendbar, kein Fehler).
 * Reines DDL (sandbox-/rollback-sicher). Skippt offline.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { inSandbox, applyMigrationsFrom, applyMigration } = require('./helpers/migration-sandbox.js');

// Unique-/PK-Constraint-Spaltensätze einer Tabelle (namens-unabhängig).
async function uniqueColSets(client, table) {
  const r = await client.query(
    `SELECT c.contype,
            array_agg(a.attname::text ORDER BY k.ord) AS cols
       FROM pg_constraint c
       JOIN pg_class t      ON t.oid = c.conrelid
       JOIN pg_namespace n  ON n.oid = t.relnamespace
       JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
       JOIN pg_attribute a  ON a.attrelid = t.oid AND a.attnum = k.attnum
      WHERE n.nspname = 'automatenlager' AND t.relname = $1
        AND c.contype IN ('u','p')
      GROUP BY c.oid, c.contype`,
    [table]);
  return r.rows.map((row) => ({ type: row.contype, cols: row.cols }));
}

function hasColSet(sets, cols) {
  const want = JSON.stringify(cols);
  return sets.some((s) => JSON.stringify(s.cols) === want);
}

// [Tabelle, alter globaler (key)-Spaltensatz, neuer (tenant_id, …)-Spaltensatz]
const TABLES = [
  ['products', ['product_key'], ['tenant_id', 'product_key']],
  ['stock_batches', ['batch_key'], ['tenant_id', 'batch_key']],
  ['suppliers', ['supplier_key'], ['tenant_id', 'supplier_key']],
  ['warnings', ['warning_key'], ['tenant_id', 'warning_key']],
  ['invoices', ['invoice_key'], ['tenant_id', 'invoice_key']],
  ['guv_daily', ['guv_key'], ['tenant_id', 'guv_key']],
  ['stock_movements', ['movement_key'], ['tenant_id', 'movement_key']],
  ['product_change_proposals', ['proposal_key'], ['tenant_id', 'proposal_key']],
  ['product_aliases', ['alias', 'source'], ['tenant_id', 'alias', 'source']],
  ['invoice_items', ['invoice_id', 'line_number'], ['tenant_id', 'invoice_id', 'line_number']],
];

test('#111 0031: globale (key)-Uniques weg, nur noch (tenant_id, key)', async (t) => {
  await inSandbox(t, async (client) => {
    await applyMigrationsFrom(client, 7);
    for (const [table, oldCols, newCols] of TABLES) {
      const sets = await uniqueColSets(client, table);
      assert.ok(!hasColSet(sets, oldCols),
        `${table}: globaler Unique (${oldCols.join(', ')}) muss weg sein, ist aber noch da`);
      assert.ok(hasColSet(sets, newCols),
        `${table}: mandanten-Unique (${newCols.join(', ')}) muss vorhanden sein`);
    }
  });
});

test('#111 0031: sales_transactions — globaler (nayax_transaction_id) weg, provider-aware bleibt', async (t) => {
  await inSandbox(t, async (client) => {
    await applyMigrationsFrom(client, 7);
    const sets = await uniqueColSets(client, 'sales_transactions');
    assert.ok(!hasColSet(sets, ['nayax_transaction_id']),
      'globaler (nayax_transaction_id)-Unique muss weg sein');
    assert.ok(hasColSet(sets, ['tenant_id', 'provider', 'nayax_transaction_id']),
      'provider-aware (tenant_id, provider, nayax_transaction_id) muss bleiben');
  });
});

test('#111 0031: workflow_state-PK ist (tenant_id, workflow_key)', async (t) => {
  await inSandbox(t, async (client) => {
    await applyMigrationsFrom(client, 7);
    const sets = await uniqueColSets(client, 'workflow_state');
    const pk = sets.find((s) => s.type === 'p');
    assert.ok(pk, 'workflow_state hat einen Primary Key');
    assert.deepEqual(pk.cols, ['tenant_id', 'workflow_key'],
      'PK ist (tenant_id, workflow_key)');
  });
});

test('#111 0031: idx_slot_active (global) weg, idx_slot_active_tenant bleibt', async (t) => {
  await inSandbox(t, async (client) => {
    await applyMigrationsFrom(client, 7);
    const r = await client.query(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'automatenlager' AND tablename = 'slot_assignments'
          AND indexname IN ('idx_slot_active', 'idx_slot_active_tenant')`);
    const names = r.rows.map((x) => x.indexname);
    assert.ok(!names.includes('idx_slot_active'), 'globaler idx_slot_active muss weg sein');
    assert.ok(names.includes('idx_slot_active_tenant'), 'idx_slot_active_tenant muss bleiben');
  });
});

test('#111 0031: idempotent (zweimal anwendbar, kein Fehler)', async (t) => {
  await inSandbox(t, async (client) => {
    await applyMigrationsFrom(client, 7);
    await applyMigration(client, 31); // zweite Anwendung
    const sets = await uniqueColSets(client, 'products');
    assert.ok(!hasColSet(sets, ['product_key']), 'auch nach 2x: kein globaler Unique');
    assert.ok(hasColSet(sets, ['tenant_id', 'product_key']), 'auch nach 2x: composite bleibt');
  });
});

test('#111 0031: gleicher product_key bei zwei Mandanten = zwei Zeilen (Isolation scharf)', async (t) => {
  await inSandbox(t, async (client) => {
    await applyMigrationsFrom(client, 7);
    const tj = await client.query(
      `SELECT tenant_id FROM automatenlager.tenants ORDER BY tenant_id LIMIT 2`);
    assert.ok(tj.rows.length >= 2, 'mindestens zwei Mandanten für den Isolationsnachweis');
    const [a, b] = tj.rows.map((r) => r.tenant_id);
    const key = 'mt-dup-0031';
    // Vor 0031 hätte der globale (product_key)-Unique die zweite Zeile geblockt.
    await client.query(
      `INSERT INTO automatenlager.products (product_key, name, vat_rate_pct, tenant_id)
       VALUES ($1, 'A', 19, $2) ON CONFLICT (tenant_id, product_key) DO NOTHING`, [key, a]);
    await client.query(
      `INSERT INTO automatenlager.products (product_key, name, vat_rate_pct, tenant_id)
       VALUES ($1, 'B', 19, $2) ON CONFLICT (tenant_id, product_key) DO NOTHING`, [key, b]);
    const n = await client.query(
      `SELECT count(*) c FROM automatenlager.products WHERE product_key = $1`, [key]);
    assert.equal(Number(n.rows[0].c), 2, 'zwei Mandanten → zwei Zeilen mit gleichem product_key');
  });
});
