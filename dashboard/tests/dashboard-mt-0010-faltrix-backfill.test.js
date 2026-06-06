'use strict';

// Issue #97 — Migration 0010 (realer Mandant Faltrix + Backfill + Default-Strategie).
// LIVE-Sandbox mit ROLLBACK: prueft den Backfill gegen die ECHTEN Daten, ohne sie
// zu mutieren.

const assert = require('node:assert/strict');
const test = require('node:test');

const { inSandbox, applyMigration } = require('./helpers/migration-sandbox.js');

const TENANT = 't_faltrix';
const DATA_TABLES = [
  'machines', 'locations', 'machine_profiles', 'slot_assignments',
  'products', 'product_aliases', 'product_change_proposals',
  'stock_batches', 'stock_movements', 'sales_transactions', 'guv_daily',
  'warnings', 'invoices', 'invoice_items', 'suppliers',
  'nayax_devices', 'workflow_state', 'prices',
];
async function setup(client) {
  for (const n of [7, 8, 9, 10]) await applyMigration(client, n);
}
async function columnDefault(client, table) {
  const r = await client.query(
    `SELECT column_default FROM information_schema.columns
      WHERE table_schema='automatenlager' AND table_name=$1 AND column_name='tenant_id'`, [table]);
  return r.rows[0] ? r.rows[0].column_default : undefined;
}

test('#97 LIVE-Sandbox: realer Mandant Faltrix + Default-Zentrallager existieren', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    const tn = await client.query(
      `SELECT name, contact_email, status FROM automatenlager.tenants WHERE tenant_id=$1`, [TENANT]);
    assert.equal(tn.rowCount, 1, 'Faltrix-Mandant existiert');
    assert.equal(tn.rows[0].name, 'Faltrix');
    assert.equal(tn.rows[0].contact_email, 'faltrixgbr@gmail.com');
    assert.equal(tn.rows[0].status, 'aktiv');

    const wh = await client.query(
      `SELECT name, is_default FROM automatenlager.warehouses WHERE tenant_id=$1 AND is_default`, [TENANT]);
    assert.equal(wh.rowCount, 1, 'genau ein Default-Zentrallager');
    assert.equal(wh.rows[0].name, 'Zentrallager');
  });
});

test('#97 LIVE-Sandbox: nach Backfill keine __default__-Zeile in Daten-Tabellen, Daten tragen t_faltrix', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    for (const table of DATA_TABLES) {
      const def = await client.query(
        `SELECT count(*) c FROM automatenlager.${table} WHERE tenant_id='__default__'`);
      assert.equal(Number(def.rows[0].c), 0, `${table}: keine __default__-Zeile mehr`);
    }
    // Stichprobe: products tragen jetzt den realen Mandanten (47 Echtdaten).
    const p = await client.query(
      `SELECT count(*) c FROM automatenlager.products WHERE tenant_id=$1`, [TENANT]);
    assert.ok(Number(p.rows[0].c) > 0, 'products tragen t_faltrix');
  });
});

test('#97 LIVE-Sandbox: Config-Tabellen kopiert auf t_faltrix, __default__-Vorlage bleibt (Override erhalten)', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    // classification_settings traegt in Stufe 1 weiter mandant_id (nicht umbenannt).
    const cs = await client.query(
      `SELECT mandant_id, config FROM automatenlager.classification_settings ORDER BY mandant_id`);
    const ids = cs.rows.map((r) => r.mandant_id);
    assert.ok(ids.includes('__default__'), '__default__-Vorlage bleibt (read-side fuer Stufe 1)');
    assert.ok(ids.includes(TENANT), 't_faltrix-Kopie existiert (fuer Stufe 2/3)');
    // Faltrix' echter Override (kleinunternehmerAktiv:true) ist in beiden erhalten.
    const faltrix = cs.rows.find((r) => r.mandant_id === TENANT);
    assert.equal(faltrix.config.kleinunternehmerAktiv, true, 'Kleinunternehmer-Status mitkopiert');
  });
});

test('#97 LIVE-Sandbox: nach 0010 trägt JEDE Daten-Tabelle DEFAULT t_faltrix (kein __default__, kein Insert-Bruch)', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    // Revidiert nach Review: 0010 setzt ueberall den transienten Default; das
    // DROP DEFAULT bei den abhaengigen Tabellen passiert erst in 0014 (nach
    // Trigger-Anlage) -> kein Fenster ohne Default UND ohne Trigger.
    for (const table of DATA_TABLES) {
      const d = await columnDefault(client, table);
      assert.match(String(d), /t_faltrix/, `${table}.tenant_id DEFAULT zeigt nach 0010 auf t_faltrix`);
    }
  });
});

test('#97 LIVE-Sandbox: Migration ist idempotent/wiederholbar', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    await applyMigration(client, 10); // erneut
    // weiterhin genau ein Faltrix + ein Zentrallager, keine __default__-Daten.
    const tn = await client.query(`SELECT count(*) c FROM automatenlager.tenants WHERE tenant_id=$1`, [TENANT]);
    assert.equal(Number(tn.rows[0].c), 1);
    const wh = await client.query(`SELECT count(*) c FROM automatenlager.warehouses WHERE tenant_id=$1`, [TENANT]);
    assert.equal(Number(wh.rows[0].c), 1, 'kein doppeltes Zentrallager nach 2. Lauf');
    const sales = await client.query(`SELECT count(*) c FROM automatenlager.sales_transactions WHERE tenant_id='__default__'`);
    assert.equal(Number(sales.rows[0].c), 0);
  });
});
