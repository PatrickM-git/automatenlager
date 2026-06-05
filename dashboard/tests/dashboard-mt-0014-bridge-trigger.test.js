'use strict';

// Issue #101 — Migration 0014 (Bruecken-Trigger: tenant_id-Vererbung + 0003/0005
// nachgezogen). LIVE-Sandbox mit ROLLBACK.

const assert = require('node:assert/strict');
const test = require('node:test');

const { inSandbox, applyMigration } = require('./helpers/migration-sandbox.js');

async function setup(client) {
  for (const n of [7, 8, 9, 10, 11, 12, 13, 14]) await applyMigration(client, n);
}
async function faltrixCtx(client) {
  const r = await client.query(`
    SELECT (SELECT machine_id FROM automatenlager.machines WHERE tenant_id='t_faltrix' LIMIT 1) mid,
           (SELECT product_id FROM automatenlager.products WHERE tenant_id='t_faltrix' LIMIT 1) pid,
           (SELECT warehouse_id FROM automatenlager.warehouses WHERE tenant_id='t_faltrix' AND is_default LIMIT 1) wid,
           (SELECT slot_assignment_id FROM automatenlager.slot_assignments WHERE tenant_id='t_faltrix' LIMIT 1) sid`);
  return r.rows[0];
}

test('#101 LIVE-Sandbox: tenant_id wird beim INSERT OHNE tenant_id aus dem Eltern geerbt', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    const { mid, pid, wid, sid } = await faltrixCtx(client);

    // stock_batches -> product_id -> products.tenant_id
    await client.query(
      `INSERT INTO automatenlager.stock_batches
         (batch_key, product_id, initial_qty, remaining_qty, unit_cost_net, status, received_at, warehouse_id)
       VALUES ('inh_sb', ${pid}, 1, 1, 1.0, 'aktiv', now(), ${wid})`);
    const sb = await client.query(`SELECT tenant_id FROM automatenlager.stock_batches WHERE batch_key='inh_sb'`);
    assert.equal(sb.rows[0].tenant_id, 't_faltrix', 'stock_batches erbt tenant_id von product');

    // sales_transactions -> machine_id -> machines.tenant_id (slot NULL -> Preis-Trigger feuert nicht)
    await client.query(
      `INSERT INTO automatenlager.sales_transactions
         (nayax_transaction_id, machine_id, product_name_raw, quantity, gross_amount, net_amount, vat_amount, settlement_at, processing_status)
       VALUES ('inh_tx', ${mid}, 'X', 1, 1.0, 0.9, 0.1, now(), 'matched')`);
    const st = await client.query(`SELECT tenant_id FROM automatenlager.sales_transactions WHERE nayax_transaction_id='inh_tx'`);
    assert.equal(st.rows[0].tenant_id, 't_faltrix', 'sales_transactions erbt tenant_id von machine');

    // prices -> slot_assignment_id -> slot_assignments.tenant_id
    await client.query(
      `INSERT INTO automatenlager.prices (slot_assignment_id, sale_price_gross, valid_from, source)
       VALUES (${sid}, 1.50, now(), 'manual')`);
    const pr = await client.query(`SELECT tenant_id FROM automatenlager.prices WHERE slot_assignment_id=${sid} AND source='manual'`);
    assert.equal(pr.rows[0].tenant_id, 't_faltrix', 'prices erbt tenant_id von slot_assignment');
  });
});

test('#101 LIVE-Sandbox: nachgezogene Trigger filtern/schreiben tenant-rein (Definition)', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    const deduct = await client.query(
      `SELECT pg_get_functiondef('automatenlager.fn_deduct_stock_on_machine_sale'::regproc) d`);
    assert.match(deduct.rows[0].d, /tenant_id\s*=\s*NEW\.tenant_id/, 'FIFO filtert nach tenant_id');

    const price = await client.query(
      `SELECT pg_get_functiondef('automatenlager.fn_update_price_from_sale'::regproc) d`);
    assert.match(price.rows[0].d, /tenant_id\s*=\s*NEW\.tenant_id/, 'Preislese filtert nach tenant_id');
    assert.match(price.rows[0].d, /tenant_id\)[\s\S]*NEW\.tenant_id/, 'Preis-INSERT schreibt tenant_id mit');
  });
});

test('#101 LIVE-Sandbox: FIFO-Trigger bucht funktional + mandantenrein ab', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    const { mid, wid } = await faltrixCtx(client);
    // Isoliertes frisches Produkt -> 'fifo_b' ist die EINZIGE FIFO-Quelle
    // (sonst buchte FIFO von aelteren echten Chargen desselben Produkts ab).
    const pid = (await client.query(
      `INSERT INTO automatenlager.products (product_key, name, vat_rate_pct, tenant_id)
       VALUES ('fifo_p', 'FIFO Test', 19, 't_faltrix') RETURNING product_id`)).rows[0].product_id;

    // Frischer Bestand (10) + aktiver Slot (qty 5) fuer dieses Produkt.
    await client.query(
      `INSERT INTO automatenlager.stock_batches
         (batch_key, product_id, initial_qty, remaining_qty, unit_cost_net, status, received_at, warehouse_id, tenant_id)
       VALUES ('fifo_b', ${pid}, 10, 10, 1.0, 'aktiv', now(), ${wid}, 't_faltrix')`);
    await client.query(
      `INSERT INTO automatenlager.slot_assignments
         (product_slot_key, machine_id, mdb_code, product_id, valid_from, active, current_machine_qty, tenant_id)
       VALUES ('fifo_s', ${mid}, 199, ${pid}, now(), true, 5, 't_faltrix')`);

    // Verkauf: current_machine_qty 5 -> 3 (2 Einheiten) -> FIFO bucht 2 ab.
    await client.query(
      `UPDATE automatenlager.slot_assignments SET current_machine_qty = 3 WHERE product_slot_key='fifo_s'`);
    const rem = await client.query(`SELECT remaining_qty FROM automatenlager.stock_batches WHERE batch_key='fifo_b'`);
    assert.equal(Number(rem.rows[0].remaining_qty), 8, 'FIFO hat 2 Einheiten vom eigenen Bestand abgebucht');
  });
});

test('#101 LIVE-Sandbox: Migration idempotent', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    await applyMigration(client, 14);
    const trg = await client.query(
      `SELECT count(*) c FROM pg_trigger WHERE tgname='trg_inherit_tenant_stock_batches' AND NOT tgisinternal`);
    assert.equal(Number(trg.rows[0].c), 1, 'Inherit-Trigger existiert genau einmal nach 2. Lauf');
  });
});
