'use strict';

// Issue #102 — Migration 0015 (provider-Dimension + Geraete-Claiming).
// LIVE-Sandbox mit ROLLBACK.

const assert = require('node:assert/strict');
const test = require('node:test');

const { inSandbox, applyMigration, expectReject } = require('./helpers/migration-sandbox.js');

async function setup(client) {
  for (const n of [7, 8, 9, 10, 11, 12, 13, 14, 15]) await applyMigration(client, n);
}

test('#102 LIVE-Sandbox: provider-Spalten existieren mit Default nayax', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    for (const table of ['nayax_devices', 'sales_transactions']) {
      const r = await client.query(
        `SELECT column_default, is_nullable FROM information_schema.columns
          WHERE table_schema='automatenlager' AND table_name=$1 AND column_name='provider'`, [table]);
      assert.equal(r.rowCount, 1, `${table}.provider existiert`);
      assert.match(r.rows[0].column_default, /nayax/, `${table}.provider Default nayax`);
      assert.equal(r.rows[0].is_nullable, 'NO', `${table}.provider NOT NULL`);
    }
  });
});

test('#102 LIVE-Sandbox: provider-Default greift bei INSERT ohne provider', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    await client.query(
      `INSERT INTO automatenlager.nayax_devices (nayax_machine_id, machine_number) VALUES ('999888777', 'X')`);
    const r = await client.query(
      `SELECT provider FROM automatenlager.nayax_devices WHERE nayax_machine_id='999888777'`);
    assert.equal(r.rows[0].provider, 'nayax', 'provider-Default angewandt');
  });
});

test('#102 LIVE-Sandbox: zweiter Claim desselben (provider, nayax_machine_id) abgelehnt', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    const chk = await client.query(
      `SELECT 1 FROM pg_constraint WHERE conname='nayax_devices_claim_unique'`);
    assert.equal(chk.rowCount, 1, 'claim-unique existiert');

    const existing = (await client.query(
      `SELECT nayax_machine_id FROM automatenlager.nayax_devices LIMIT 1`)).rows[0].nayax_machine_id;
    await expectReject(client,
      `INSERT INTO automatenlager.nayax_devices (nayax_machine_id, machine_number, provider)
       VALUES ('${existing}', 'dup', 'nayax')`,
      /duplicate key|nayax_devices/i,
      'dasselbe Geraet systemweit nur einmal');
  });
});

test('#102 LIVE-Sandbox: Verkaufs-Idempotenz ist provider-aware', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    const def = await client.query(
      `SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='sales_transactions_tenant_provider_uk'`);
    assert.equal(def.rowCount, 1, 'provider-aware Unique existiert (additiv)');
    assert.match(def.rows[0].d, /UNIQUE \(tenant_id, provider, nayax_transaction_id\)/);
    // Übergang (Mini, vor deploy-gated 0031): der alte globale Unique bleibt
    // erhalten (ON CONFLICT (nayax_transaction_id), Story 23) UND muss dieselbe
    // Definition tragen wie immer. Endzustand (#214, 0031 committed): er ist
    // gedroppt — der provider-aware Unique oben ist der EINZIGE Idempotenz-Anker.
    const old = await client.query(
      `SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='sales_transactions_nayax_transaction_id_key'`);
    if (old.rowCount === 1) {
      assert.match(old.rows[0].d, /UNIQUE \(nayax_transaction_id\)/,
        'Übergang: alter globaler nayax_transaction_id-Unique bleibt (Schreibpfad-Kompat)');
    }
  });
});

test('#102 LIVE-Sandbox: Migration idempotent', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    await applyMigration(client, 15);
    const r = await client.query(
      `SELECT count(*) c FROM pg_constraint WHERE conname='nayax_devices_claim_unique'`);
    assert.equal(Number(r.rows[0].c), 1, 'claim-unique existiert genau einmal nach 2. Lauf');
  });
});
