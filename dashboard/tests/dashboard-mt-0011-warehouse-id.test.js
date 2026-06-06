'use strict';

// Issue #98 — Migration 0011 (stock_batches.warehouse_id, Charge in Automat ODER
// Lager). LIVE-Sandbox mit ROLLBACK.

const assert = require('node:assert/strict');
const test = require('node:test');

const { inSandbox, applyMigration, expectReject } = require('./helpers/migration-sandbox.js');

async function setup(client) {
  for (const n of [7, 8, 9, 10, 11]) await applyMigration(client, n);
}

test('#98 LIVE-Sandbox: warehouse_id (FK + CHECK) existiert', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    const col = await client.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema='automatenlager' AND table_name='stock_batches' AND column_name='warehouse_id'`);
    assert.equal(col.rowCount, 1, 'warehouse_id existiert');

    const chk = await client.query(
      `SELECT 1 FROM pg_constraint WHERE conname='stock_batches_one_location'
          AND conrelid='automatenlager.stock_batches'::regclass`);
    assert.equal(chk.rowCount, 1, 'CHECK stock_batches_one_location aktiv');

    const fk = await client.query(
      `SELECT confdeltype FROM pg_constraint
        WHERE conrelid='automatenlager.stock_batches'::regclass AND contype='f'
          AND pg_get_constraintdef(oid) LIKE '%warehouses%'`);
    assert.ok(fk.rowCount >= 1, 'FK auf warehouses existiert');
    assert.equal(fk.rows[0].confdeltype, 'n', 'ON DELETE SET NULL');
  });
});

test('#98 LIVE-Sandbox: Backfill — bisherige machine_id-NULL-Chargen zeigen aufs Default-Zentrallager', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    // Vor dem Backfill waren alle Chargen machine_id IS NULL (altes Zentrallager).
    // Nach 0011 darf KEINE Charge mit verfuegbarem Bestand ortlos sein.
    const orphan = await client.query(
      `SELECT count(*) c FROM automatenlager.stock_batches
        WHERE machine_id IS NULL AND warehouse_id IS NULL AND remaining_qty > 0`);
    assert.equal(Number(orphan.rows[0].c), 0, 'kein verfuegbarer Bestand ist ortlos');

    // Die zugewiesenen warehouse_id zeigen aufs Default-Zentrallager des Mandanten.
    const wrong = await client.query(
      `SELECT count(*) c FROM automatenlager.stock_batches sb
         JOIN automatenlager.warehouses w ON w.warehouse_id = sb.warehouse_id
        WHERE sb.warehouse_id IS NOT NULL AND (w.tenant_id <> sb.tenant_id OR NOT w.is_default)`);
    assert.equal(Number(wrong.rows[0].c), 0, 'alle warehouse_id zeigen aufs eigene Default-Zentrallager');
  });
});

test('#98 LIVE-Sandbox: DB lehnt Charge mit machine_id UND warehouse_id ab (CHECK)', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    // einen realen Mandanten + sein Zentrallager + ein Produkt + eine Maschine greifen
    const ctx = await client.query(
      `SELECT (SELECT warehouse_id FROM automatenlager.warehouses WHERE is_default LIMIT 1) wid,
              (SELECT machine_id FROM automatenlager.machines LIMIT 1) mid,
              (SELECT product_id FROM automatenlager.products LIMIT 1) pid,
              (SELECT tenant_id FROM automatenlager.products LIMIT 1) tid`);
    const { wid, mid, pid, tid } = ctx.rows[0];
    assert.ok(wid && mid && pid, 'Test-Kontext vorhanden');
    await expectReject(client,
      `INSERT INTO automatenlager.stock_batches
         (batch_key, product_id, initial_qty, remaining_qty, unit_cost_net, status, received_at, machine_id, warehouse_id, tenant_id)
       VALUES ('sb_check_${mid}', ${pid}, 1, 1, 1.0, 'aktiv', now(), ${mid}, ${wid}, '${tid}')`,
      /stock_batches_one_location|check constraint/i,
      'Charge mit Automat UND Lager wird abgelehnt');
  });
});

test('#98 LIVE-Sandbox: aktive Charge hat genau einen Ort (Daten-Invariante)', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    // "aktiv" = verfuegbarer Bestand (remaining_qty > 0). Genau ein Ort = num_nonnulls = 1.
    const bad = await client.query(
      `SELECT count(*) c FROM automatenlager.stock_batches
        WHERE remaining_qty > 0 AND num_nonnulls(machine_id, warehouse_id) <> 1`);
    assert.equal(Number(bad.rows[0].c), 0, 'jede aktive Charge hat genau einen Ort');
  });
});

test('#98 LIVE-Sandbox: Migration idempotent', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    await applyMigration(client, 11);
    const chk = await client.query(
      `SELECT count(*) c FROM pg_constraint WHERE conname='stock_batches_one_location'
          AND conrelid='automatenlager.stock_batches'::regclass`);
    assert.equal(Number(chk.rows[0].c), 1, 'CHECK existiert genau einmal nach 2. Lauf');
  });
});
