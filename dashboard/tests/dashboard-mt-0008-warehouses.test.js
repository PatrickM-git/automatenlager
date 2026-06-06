'use strict';

// Issue #95 — Migration 0008 (warehouses + fn_create_tenant).
// LIVE-Sandbox gegen die echte DB, ROLLBACK garantiert keine Mutation. Skip offline.

const assert = require('node:assert/strict');
const test = require('node:test');

const { inSandbox, applyMigration, expectReject } = require('./helpers/migration-sandbox.js');

async function setup(client) {
  await applyMigration(client, 7);
  await applyMigration(client, 8);
}

test('#95 LIVE-Sandbox: fn_create_tenant legt Mandant + genau ein Default-Zentrallager an', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    await client.query(`SELECT automatenlager.fn_create_tenant('t_w', 'Wargo GmbH', 'w@x.de')`);

    const t1 = await client.query(`SELECT name, status, contact_email FROM automatenlager.tenants WHERE tenant_id='t_w'`);
    assert.equal(t1.rows[0].name, 'Wargo GmbH');
    assert.equal(t1.rows[0].contact_email, 'w@x.de');

    const wh = await client.query(
      `SELECT name, is_default, location_id, active FROM automatenlager.warehouses WHERE tenant_id='t_w'`);
    assert.equal(wh.rowCount, 1, 'genau ein Lager');
    assert.equal(wh.rows[0].name, 'Zentrallager');
    assert.equal(wh.rows[0].is_default, true);
    assert.equal(wh.rows[0].location_id, null, 'location_id ist optional/NULL');
    assert.equal(wh.rows[0].active, true);
  });
});

test('#95 LIVE-Sandbox: fn_create_tenant ist idempotent (zweiter Aufruf bricht nicht, kein Duplikat)', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    await client.query(`SELECT automatenlager.fn_create_tenant('t_w', 'Wargo GmbH', 'w@x.de')`);
    await client.query(`SELECT automatenlager.fn_create_tenant('t_w', 'Wargo GmbH', 'w@x.de')`);
    const n = await client.query(`SELECT count(*) c FROM automatenlager.warehouses WHERE tenant_id='t_w'`);
    assert.equal(Number(n.rows[0].c), 1, 'weiterhin genau ein Zentrallager');
  });
});

test('#95 LIVE-Sandbox: zweites is_default-Lager je Mandant wird abgelehnt (partieller Unique-Index)', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    await client.query(`SELECT automatenlager.fn_create_tenant('t_w', 'Wargo GmbH', NULL)`);
    await expectReject(client,
      `INSERT INTO automatenlager.warehouses (tenant_id, name, is_default) VALUES ('t_w','Garage',TRUE)`,
      /idx_warehouses_one_default|duplicate key/i,
      'zweites Default-Lager fuer denselben Mandanten abgelehnt');
    // Ein NICHT-Default-Lager mit anderem Namen ist dagegen erlaubt.
    await client.query(`INSERT INTO automatenlager.warehouses (tenant_id, name, is_default) VALUES ('t_w','Garage',FALSE)`);
    const n = await client.query(`SELECT count(*) c FROM automatenlager.warehouses WHERE tenant_id='t_w'`);
    assert.equal(Number(n.rows[0].c), 2, 'zwei Lager (ein Default + ein normales)');
  });
});

test('#95 LIVE-Sandbox: zwei Mandanten duerfen je ein eigenes Zentrallager haben (Name pro Mandant)', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    await client.query(`SELECT automatenlager.fn_create_tenant('t_a', 'A', NULL)`);
    await client.query(`SELECT automatenlager.fn_create_tenant('t_b', 'B', NULL)`);
    // tenant-gefiltert auf die zwei in dieser Sandbox angelegten Mandanten — ein
    // globaler Count braeche, sobald die committed DB ein Default-Zentrallager
    // (z. B. t_faltrix seit 0010) enthaelt.
    const n = await client.query(
      `SELECT count(*) c FROM automatenlager.warehouses
        WHERE name='Zentrallager' AND is_default AND tenant_id IN ('t_a','t_b')`);
    assert.equal(Number(n.rows[0].c), 2, 'beide Mandanten haben ihr eigenes Zentrallager');
  });
});
