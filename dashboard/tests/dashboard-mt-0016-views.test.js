'use strict';

// Issue #103 — Migration 0016 (Views/MatViews tenant_id-fuehrend).
// LIVE-Sandbox mit ROLLBACK.

const assert = require('node:assert/strict');
const test = require('node:test');

const { inSandbox, applyMigration } = require('./helpers/migration-sandbox.js');

async function setup(client) {
  for (let n = 7; n <= 16; n++) await applyMigration(client, n);
}
async function relColumns(client, rel) {
  const r = await client.query(
    `SELECT a.attname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
      WHERE n.nspname='automatenlager' AND c.relname=$1`, [rel]);
  return r.rows.map((x) => x.attname);
}

test('#103 LIVE-Sandbox: alle drei Relationen fuehren tenant_id', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    for (const rel of ['v_warnings_open', 'v_slot_turnover', 'mv_inventory_value_daily']) {
      const cols = await relColumns(client, rel);
      assert.ok(cols.includes('tenant_id'), `${rel} fuehrt tenant_id`);
    }
  });
});

test('#103 LIVE-Sandbox: mv-Refresh mandantenbewusst (Unique-Index date, tenant_id, product_id)', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    const idx = await client.query(
      `SELECT indexdef FROM pg_indexes WHERE schemaname='automatenlager'
          AND tablename='mv_inventory_value_daily' AND indexname='mv_inventory_value_daily_pk'`);
    assert.equal(idx.rowCount, 1, 'mandantenbewusster Unique-Index existiert');
    assert.match(idx.rows[0].indexdef, /\(date, tenant_id, product_id\)/);

    // REFRESH CONCURRENTLY funktioniert dank des Unique-Index.
    await client.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY automatenlager.mv_inventory_value_daily`);
  });
});

test('#103 LIVE-Sandbox: Beispiel-Query liefert tenant_id je Zeile (mv mit Echtdaten)', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    // stock_batches tragen nach Backfill t_faltrix -> die mv muss tenant_id liefern.
    const rows = await client.query(
      `SELECT tenant_id, count(*) c FROM automatenlager.mv_inventory_value_daily GROUP BY tenant_id`);
    assert.ok(rows.rowCount >= 1, 'mv hat Zeilen');
    for (const r of rows.rows) {
      assert.ok(r.tenant_id && r.tenant_id !== '__default__', `tenant_id gesetzt (${r.tenant_id})`);
    }
  });
});

test('#103 LIVE-Sandbox: Migration idempotent (mv neu aufbaubar)', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    await applyMigration(client, 16);
    const cols = await relColumns(client, 'mv_inventory_value_daily');
    assert.ok(cols.includes('tenant_id'), 'mv weiterhin tenant_id-fuehrend nach 2. Lauf');
  });
});
