'use strict';

// Regression-Guard für den Deploy-Befund: Die Stufe-1-Migrationen dürfen die
// ON-CONFLICT-Ziele des laufenden Schreibpfads (DB-Funktion pgw_write + n8n-WF*)
// NICHT zerstören (Story 23). `ON CONFLICT (key)` braucht einen Unique mit EXAKT
// diesen Spalten; ein Umbau auf (tenant_id, key) bräche das mit 42P10.
//
// Geprüft per EXPLAIN (löst die ON-CONFLICT-Constraint-Auflösung beim Planen aus,
// ohne den INSERT auszuführen — keine Seiteneffekte, keine NOT-NULL/FK-Prüfung).
// Gegen die ECHTE DB nach Anwendung von 0007-0017, in Rollback-Transaktion.

const assert = require('node:assert/strict');
const test = require('node:test');

const { inSandbox, applyMigrationsFrom } = require('./helpers/migration-sandbox.js');

// [Tabelle, INSERT-Spalten+VALUES, ON-CONFLICT-Ziel] — exakt die im Code/in WF*
// und in pgw_write benutzten Konflikt-Ziele.
const CASES = [
  ['products', "(product_key) VALUES ('x')", '(product_key)'],
  ['product_aliases', "(alias, source) VALUES ('a','s')", '(alias, source)'],
  ['slot_assignments', "(product_slot_key) VALUES ('x')", '(product_slot_key)'],
  ['suppliers', "(supplier_key) VALUES ('x')", '(supplier_key)'],
  ['invoices', "(invoice_key) VALUES ('x')", '(invoice_key)'],
  ['invoice_items', "(invoice_id, line_number) VALUES (1, 1)", '(invoice_id, line_number)'],
  ['stock_batches', "(batch_key) VALUES ('x')", '(batch_key)'],
  ['sales_transactions', "(nayax_transaction_id) VALUES ('x')", '(nayax_transaction_id)'],
  ['stock_movements', "(movement_key) VALUES ('x')", '(movement_key)'],
  ['guv_daily', "(guv_key) VALUES ('x')", '(guv_key)'],
  ['warnings', "(warning_key) VALUES ('x')", '(warning_key)'],
  ['product_change_proposals', "(proposal_key) VALUES ('x')", '(proposal_key)'],
  ['workflow_state', "(workflow_key) VALUES ('x')", '(workflow_key)'],
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

test('ON-CONFLICT-Kompat: alle Schreibpfad-Konfliktziele bleiben nach 0007-0017 gültig (kein 42P10)', async (t) => {
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

test('ON-CONFLICT-Kompat: echter Upsert (products/warnings) läuft nach der Migration durch', async (t) => {
  await inSandbox(t, async (client) => {
    await applyMigrationsFrom(client, 7);
    // products: ON CONFLICT (product_key) DO NOTHING — wie pgw_write.
    await client.query(
      `INSERT INTO automatenlager.products (product_key, name, vat_rate_pct)
       VALUES ('octest', 'OC Test', 19) ON CONFLICT (product_key) DO NOTHING`);
    // warnings: ON CONFLICT (warning_key) DO NOTHING — wie WF5/pgw_write.
    await client.query(
      `INSERT INTO automatenlager.warnings (warning_key, warning_type, message, source_workflow)
       VALUES ('octest', 'BACKUP_OK', 'x', 'm') ON CONFLICT (warning_key) DO NOTHING`);
    // workflow_state: ON CONFLICT (workflow_key) DO UPDATE — wie WF3.
    await client.query(
      `INSERT INTO automatenlager.workflow_state (workflow_key, last_inventory_review_at)
       VALUES ('octest', now()) ON CONFLICT (workflow_key) DO UPDATE SET updated_at = now()`);
    const n = await client.query(`SELECT count(*) c FROM automatenlager.products WHERE product_key='octest'`);
    assert.equal(Number(n.rows[0].c), 1, 'products-Upsert lief durch');
  });
});
