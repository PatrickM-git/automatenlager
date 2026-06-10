'use strict';

// Regression-Guard: Die ON-CONFLICT-Ziele des Backend-Schreibpfads (lib/jobs/*,
// faithful zu pgw_write) müssen nach ALLEN Migrationen einen passenden Unique haben;
// sonst bräche der Schreibweg mit 42P10. Seit #111 (Migration 0031, n8n-Ablösung
// Stufe 6) sind die fachlichen Schlüssel mandanten-geschlüsselt: die globalen
// (key)-Uniques sind weg, das Konfliktziel ist `(tenant_id, key)`.
// Ausnahmen ausserhalb des #111-Scope: slot_assignments (product_slot_key) und
// nayax_devices (nayax_machine_id) bleiben global; classification_settings (mandant_id)
// bis #108.
//
// Geprüft per EXPLAIN (löst die ON-CONFLICT-Constraint-Auflösung beim Planen aus,
// ohne den INSERT auszuführen — keine Seiteneffekte, keine NOT-NULL/FK-Prüfung).
// Gegen die ECHTE DB nach Anwendung aller Migrationen, in Rollback-Transaktion.

const assert = require('node:assert/strict');
const test = require('node:test');

const { inSandbox, applyMigrationsFrom } = require('./helpers/migration-sandbox.js');

// [Tabelle, INSERT-Spalten+VALUES, ON-CONFLICT-Ziel] — exakt die im Code/in WF*
// und in pgw_write benutzten Konflikt-Ziele.
const CASES = [
  ['products', "(product_key) VALUES ('x')", '(tenant_id, product_key)'],
  ['product_aliases', "(alias, source) VALUES ('a','s')", '(tenant_id, alias, source)'],
  ['slot_assignments', "(product_slot_key) VALUES ('x')", '(product_slot_key)'],
  ['suppliers', "(supplier_key) VALUES ('x')", '(tenant_id, supplier_key)'],
  ['invoices', "(invoice_key) VALUES ('x')", '(tenant_id, invoice_key)'],
  ['invoice_items', "(invoice_id, line_number) VALUES (1, 1)", '(tenant_id, invoice_id, line_number)'],
  ['stock_batches', "(batch_key) VALUES ('x')", '(tenant_id, batch_key)'],
  ['sales_transactions', "(nayax_transaction_id) VALUES ('x')", '(tenant_id, provider, nayax_transaction_id)'],
  ['stock_movements', "(movement_key) VALUES ('x')", '(tenant_id, movement_key)'],
  ['guv_daily', "(guv_key) VALUES ('x')", '(tenant_id, guv_key)'],
  ['warnings', "(warning_key) VALUES ('x')", '(tenant_id, warning_key)'],
  ['product_change_proposals', "(proposal_key) VALUES ('x')", '(tenant_id, proposal_key)'],
  ['workflow_state', "(workflow_key) VALUES ('x')", '(tenant_id, workflow_key)'],
  ['nayax_devices', "(nayax_machine_id) VALUES ('x')", '(nayax_machine_id)'],
  // Stufe 4 (#132): locations/machines wurden mandantengetrennt — die globale
  // (key)-Unique ist gedroppt, Konfliktziel ist jetzt (tenant_id, key). Der
  // Dashboard-Upsert (location-profiles/machine-create) zieht in #135/#136 nach;
  // n8n/pgw_write schreibt diese beiden Tabellen nicht.
  ['locations', "(location_key) VALUES ('x')", '(tenant_id, location_key)'],
  ['machines', "(machine_key) VALUES ('x')", '(tenant_id, machine_key)'],
  // classification_settings traegt in Stufe 1 weiter mandant_id (Dashboard nutzt
  // ON CONFLICT (mandant_id) via tenantColumn-Bruecke).
  ['classification_settings', "(mandant_id) VALUES ('x')", '(mandant_id)'],
];

test('ON-CONFLICT-Kompat: alle Schreibpfad-Konfliktziele bleiben nach allen Migrationen gültig (kein 42P10)', async (t) => {
  await inSandbox(t, async (client) => {
    await applyMigrationsFrom(client, 7);
    const broken = [];
    for (const [tbl, colsValues, target] of CASES) {
      const sql = `EXPLAIN INSERT INTO automatenlager.${tbl} ${colsValues} ON CONFLICT ${target} DO NOTHING`;
      try {
        await client.query('SAVEPOINT s');
        await client.query(sql);
        await client.query('RELEASE SAVEPOINT s');
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT s');
        if (e.code === '42P10') broken.push(`${tbl} ON CONFLICT ${target}`);
        else throw e; // anderer Fehler -> echtes Problem
      }
    }
    assert.deepEqual(broken, [],
      `ON CONFLICT-Ziele ohne passenden Unique nach der Migration (Schreibpfad bräche mit 42P10):\n  ${broken.join('\n  ')}`);
  });
});

test('ON-CONFLICT-Kompat: echter tenant-geschlüsselter Upsert läuft idempotent durch (#111)', async (t) => {
  await inSandbox(t, async (client) => {
    await applyMigrationsFrom(client, 7);
    const tj = await client.query(`SELECT tenant_id FROM automatenlager.tenants ORDER BY tenant_id LIMIT 1`);
    const tenant = tj.rows[0] && tj.rows[0].tenant_id;
    assert.ok(tenant, 'mindestens ein Mandant existiert');

    // products: ON CONFLICT (tenant_id, product_key) DO NOTHING — wie der Backend-Job. Zweimal → 1 Zeile.
    for (let i = 0; i < 2; i++) {
      await client.query(
        `INSERT INTO automatenlager.products (product_key, name, vat_rate_pct, tenant_id)
         VALUES ('octest', 'OC Test', 19, $1) ON CONFLICT (tenant_id, product_key) DO NOTHING`, [tenant]);
    }
    // workflow_state: ON CONFLICT (tenant_id, workflow_key) DO UPDATE — wie WF3-Watermark.
    await client.query(
      `INSERT INTO automatenlager.workflow_state (workflow_key, last_inventory_review_at, tenant_id)
       VALUES ('octest', now(), $1) ON CONFLICT (tenant_id, workflow_key) DO UPDATE SET updated_at = now()`, [tenant]);

    const n = await client.query(
      `SELECT count(*) c FROM automatenlager.products WHERE product_key='octest' AND tenant_id=$1`, [tenant]);
    assert.equal(Number(n.rows[0].c), 1, 'tenant-Upsert idempotent (genau 1 Zeile)');
  });
});
