'use strict';

// Issue #100 — Migration 0013 (mandanten-treue composite FKs + tenant_id->tenants).
// LIVE-Sandbox mit ROLLBACK.

const assert = require('node:assert/strict');
const test = require('node:test');

const { inSandbox, applyMigration, expectReject } = require('./helpers/migration-sandbox.js');

async function setup(client) {
  for (const n of [7, 8, 9, 10, 11, 12, 13]) await applyMigration(client, n);
}
async function faltrixCtx(client) {
  const r = await client.query(`
    SELECT (SELECT machine_id FROM automatenlager.machines WHERE tenant_id='t_faltrix' LIMIT 1) mid,
           (SELECT product_id FROM automatenlager.products WHERE tenant_id='t_faltrix' LIMIT 1) pid,
           (SELECT warehouse_id FROM automatenlager.warehouses WHERE tenant_id='t_faltrix' AND is_default LIMIT 1) wid`);
  return r.rows[0];
}

test('#100 LIVE-Sandbox: Eltern-Anker + tenant_id->tenants-FKs existieren', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    for (const name of ['machines_tenant_uk', 'products_tenant_pk_uk', 'warehouses_tenant_uk',
      'slot_assignments_tenant_uk', 'locations_tenant_uk', 'invoices_tenant_pk_uk']) {
      const r = await client.query(`SELECT 1 FROM pg_constraint WHERE conname=$1`, [name]);
      assert.equal(r.rowCount, 1, `Eltern-Anker ${name} existiert`);
    }
    // Stichprobe tenant_id->tenants-FK (classification_settings hat keinen tenants-FK — __default__ Sentinel)
    for (const tab of ['machines', 'sales_transactions', 'stock_batches', 'settings_thresholds']) {
      const r = await client.query(
        `SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname=$1`, [tab + '_tenant_fk']);
      assert.ok(r.rowCount === 1 && /REFERENCES automatenlager\.tenants/.test(r.rows[0].d),
        `${tab}_tenant_fk verweist auf tenants`);
    }
  });
});

test('#100 LIVE-Sandbox: composite Kind-FKs existieren und sind tenant-fuehrend', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    for (const name of ['slot_assignments_machine_tenant_fk', 'slot_assignments_product_tenant_fk',
      'stock_batches_product_tenant_fk', 'stock_batches_machine_tenant_fk', 'stock_batches_warehouse_tenant_fk',
      'prices_slot_tenant_fk', 'sales_transactions_machine_tenant_fk', 'sales_transactions_slot_tenant_fk',
      'invoice_items_invoice_tenant_fk', 'warehouses_location_tenant_fk']) {
      const r = await client.query(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname=$1`, [name]);
      assert.equal(r.rowCount, 1, `${name} existiert`);
      assert.match(r.rows[0].d, /FOREIGN KEY \(tenant_id,/, `${name} ist composite (tenant_id, ...)`);
    }
  });
});

test('#100 LIVE-Sandbox: KERN — Kind mit fremder tenant_id zum Eltern wird abgelehnt', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    const { mid, pid } = await faltrixCtx(client);
    assert.ok(mid && pid, 'Faltrix-Maschine + Produkt vorhanden');
    await client.query(`SELECT automatenlager.fn_create_tenant('t_b', 'B GmbH', NULL)`);

    // slot_assignment fuer t_b, aber machine/product gehoeren t_faltrix -> FK lehnt ab.
    await expectReject(client,
      `INSERT INTO automatenlager.slot_assignments
         (product_slot_key, machine_id, mdb_code, product_id, valid_from, active, tenant_id)
       VALUES ('xtenant_${mid}', ${mid}, 98, ${pid}, now(), false, 't_b')`,
      /foreign key|violates/i,
      'Cross-Tenant-Verkettung (Kind t_b -> Eltern t_faltrix) wird von der DB abgelehnt');
  });
});

test('#100 LIVE-Sandbox: mandanten-treues Kind akzeptiert; nullbarer FK greift nur bei gesetzter Spalte', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    const { mid, pid, wid } = await faltrixCtx(client);

    // Passt zusammen (alles t_faltrix) -> akzeptiert.
    await client.query(
      `INSERT INTO automatenlager.slot_assignments
         (product_slot_key, machine_id, mdb_code, product_id, valid_from, active, tenant_id)
       VALUES ('ok_${mid}', ${mid}, 97, ${pid}, now(), false, 't_faltrix')`);

    // stock_batch im LAGER (machine_id NULL): composite machine-FK greift NICHT
    // (MATCH SIMPLE), warehouse-FK greift -> akzeptiert.
    await client.query(
      `INSERT INTO automatenlager.stock_batches
         (batch_key, product_id, initial_qty, remaining_qty, unit_cost_net, status, received_at, warehouse_id, tenant_id)
       VALUES ('lager_${wid}', ${pid}, 1, 1, 1.0, 'aktiv', now(), ${wid}, 't_faltrix')`);

    const n = await client.query(`SELECT count(*) c FROM automatenlager.stock_batches WHERE batch_key='lager_${wid}'`);
    assert.equal(Number(n.rows[0].c), 1, 'Lager-Charge ohne machine_id akzeptiert');
  });
});

test('#100 LIVE-Sandbox: Migration idempotent', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    await applyMigration(client, 13);
    const r = await client.query(
      `SELECT count(*) c FROM pg_constraint WHERE conname='slot_assignments_machine_tenant_fk'`);
    assert.equal(Number(r.rows[0].c), 1, 'composite FK existiert genau einmal nach 2. Lauf');
  });
});
