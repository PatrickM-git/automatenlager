'use strict';

// Issue #99 — Migration 0012 (fachliche Unique-Constraints mandanten-eindeutig).
// LIVE-Sandbox mit ROLLBACK.

const assert = require('node:assert/strict');
const test = require('node:test');

const { inSandbox, applyMigration, expectReject } = require('./helpers/migration-sandbox.js');

async function setup(client) {
  for (const n of [7, 8, 9, 10, 11, 12]) await applyMigration(client, n);
}
async function constraintDef(client, name) {
  const r = await client.query(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname=$1`, [name]);
  return r.rows[0] ? r.rows[0].d : null;
}

test('#99 LIVE-Sandbox: alle erweiterten fachlichen Uniques enthalten tenant_id vorangestellt', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    const checks = [
      'products_tenant_uk', 'stock_batches_tenant_uk', 'suppliers_tenant_uk',
      'warnings_tenant_uk', 'product_change_proposals_tenant_uk', 'product_aliases_tenant_uk',
      'invoices_tenant_uk', 'invoice_items_tenant_uk', 'sales_transactions_tenant_uk',
      'guv_daily_tenant_uk', 'stock_movements_tenant_uk',
    ];
    for (const name of checks) {
      const def = await constraintDef(client, name);
      assert.ok(def, `${name} existiert`);
      assert.match(def, /UNIQUE\s*\(tenant_id/i, `${name} stellt tenant_id voran`);
    }
    // slot_assignments: partieller aktiver Unique-Index tenant-fuehrend.
    const idx = await client.query(
      `SELECT indexdef FROM pg_indexes WHERE schemaname='automatenlager' AND indexname='idx_slot_active_tenant'`);
    assert.equal(idx.rowCount, 1, 'idx_slot_active_tenant existiert');
    assert.match(idx.rows[0].indexdef, /tenant_id, machine_id, mdb_code/);
    assert.match(idx.rows[0].indexdef, /WHERE \(active/i, 'bleibt partiell auf active');
  });
});

test('#99 LIVE-Sandbox: workflow_state-PK ist (tenant_id, workflow_key)', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    const def = await constraintDef(client, 'workflow_state_pkey');
    assert.match(def, /PRIMARY KEY \(tenant_id, workflow_key\)/);
  });
});

test('#99 LIVE-Sandbox: gleicher product_key bei zwei Mandanten = zwei Zeilen; im selben Mandanten abgelehnt', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    const pk = (await client.query(
      `SELECT product_key FROM automatenlager.products WHERE tenant_id='t_faltrix' LIMIT 1`)).rows[0].product_key;

    await client.query(`SELECT automatenlager.fn_create_tenant('t_b', 'B GmbH', NULL)`);
    // Gleicher product_key, ANDERER Mandant -> erlaubt (zwei saubere Zeilen).
    await client.query(
      `INSERT INTO automatenlager.products (product_key, name, vat_rate_pct, tenant_id)
       VALUES ($1, 'Dup', 19, 't_b')`, [pk]);
    const n = await client.query(`SELECT count(*) c FROM automatenlager.products WHERE product_key=$1`, [pk]);
    assert.equal(Number(n.rows[0].c), 2, 'derselbe product_key existiert fuer zwei Mandanten');

    // Gleicher product_key, GLEICHER Mandant -> abgelehnt.
    await expectReject(client,
      `INSERT INTO automatenlager.products (product_key, name, vat_rate_pct, tenant_id)
       VALUES ('${pk.replace(/'/g, "''")}', 'Dup2', 19, 't_b')`,
      /products_tenant_uk|duplicate key/i,
      'gleicher product_key im selben Mandanten wird abgelehnt');
  });
});

test('#99 LIVE-Sandbox: gleicher supplier_key bei zwei Mandanten konfliktfrei', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    await client.query(`SELECT automatenlager.fn_create_tenant('t_b', 'B GmbH', NULL)`);
    await client.query(`INSERT INTO automatenlager.suppliers (supplier_key, name, tenant_id) VALUES ('sk1','S','t_faltrix')`);
    await client.query(`INSERT INTO automatenlager.suppliers (supplier_key, name, tenant_id) VALUES ('sk1','S','t_b')`);
    const n = await client.query(`SELECT count(*) c FROM automatenlager.suppliers WHERE supplier_key='sk1'`);
    assert.equal(Number(n.rows[0].c), 2);
  });
});

test('#99 LIVE-Sandbox: Migration idempotent', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    await applyMigration(client, 12);
    const def = await constraintDef(client, 'products_tenant_uk');
    assert.match(def, /UNIQUE \(tenant_id, product_key\)/);
  });
});
