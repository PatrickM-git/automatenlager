'use strict';

// Issue #106 — Migration 0019 (mv_db_per_product_monthly + mv_db_per_slot_monthly
// tenant_id-fuehrend). LIVE-Sandbox mit ROLLBACK (Muster wie #103/0016).

const assert = require('node:assert/strict');
const test = require('node:test');

const { inSandbox, applyMigration } = require('./helpers/migration-sandbox.js');

async function setup(client) {
  for (let n = 7; n <= 19; n++) await applyMigration(client, n);
}
async function relColumns(client, rel) {
  const r = await client.query(
    `SELECT a.attname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
      WHERE n.nspname='automatenlager' AND c.relname=$1`, [rel]);
  return r.rows.map((x) => x.attname);
}

const MVS = ['mv_db_per_product_monthly', 'mv_db_per_slot_monthly'];

test('#106 LIVE-Sandbox: beide MatViews fuehren tenant_id', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    for (const mv of MVS) {
      const cols = await relColumns(client, mv);
      assert.ok(cols.includes('tenant_id'), `${mv} fuehrt tenant_id`);
    }
  });
});

test('#106 LIVE-Sandbox: mandantenbewusste Unique-Indizes + REFRESH CONCURRENTLY', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    const prod = await client.query(
      `SELECT indexdef FROM pg_indexes WHERE schemaname='automatenlager'
          AND tablename='mv_db_per_product_monthly' AND indexname='mv_db_per_product_monthly_pk'`);
    assert.equal(prod.rowCount, 1, 'product-pk existiert');
    assert.match(prod.rows[0].indexdef, /\(month, tenant_id, product_id\)/);

    const slot = await client.query(
      `SELECT indexdef FROM pg_indexes WHERE schemaname='automatenlager'
          AND tablename='mv_db_per_slot_monthly' AND indexname='mv_db_per_slot_monthly_pk'`);
    assert.equal(slot.rowCount, 1, 'slot-pk existiert');
    assert.match(slot.rows[0].indexdef, /\(month, tenant_id, machine_id, mdb_code, product_id\)/);

    // REFRESH CONCURRENTLY funktioniert dank mandantenbewusstem Unique-Index.
    await client.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY automatenlager.mv_db_per_product_monthly`);
    await client.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY automatenlager.mv_db_per_slot_monthly`);
  });
});

test('#106 LIVE-Sandbox: Beispiel-Query liefert tenant_id je Zeile (kein __default__)', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    for (const mv of MVS) {
      const rows = await client.query(
        `SELECT tenant_id, count(*) c FROM automatenlager.${mv} GROUP BY tenant_id`);
      for (const r of rows.rows) {
        assert.ok(r.tenant_id && r.tenant_id !== '__default__', `${mv}: tenant_id gesetzt (${r.tenant_id})`);
      }
    }
  });
});

test('#106 LIVE-Sandbox: Migration idempotent (MVs neu aufbaubar)', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    await applyMigration(client, 19); // zweiter Lauf
    for (const mv of MVS) {
      const cols = await relColumns(client, mv);
      assert.ok(cols.includes('tenant_id'), `${mv} weiterhin tenant_id-fuehrend nach 2. Lauf`);
    }
  });
});

test('#106: beide MatViews im Schema-Contract (EXPECTED_RELATIONS)', () => {
  const { EXPECTED_RELATIONS } = require('../lib/db-schema.js');
  for (const mv of MVS) {
    const entry = EXPECTED_RELATIONS.find((r) => r.name === mv);
    assert.ok(entry, `${mv} in EXPECTED_RELATIONS`);
    assert.equal(entry.kind, 'matview', `${mv} als matview deklariert`);
  }
});
