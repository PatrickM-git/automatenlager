'use strict';

// Issue #105 — Migration 0017 (machine_profiles-Validierungs-Trigger + restliche
// composite FKs). LIVE-Sandbox mit ROLLBACK.

const assert = require('node:assert/strict');
const test = require('node:test');

const { inSandbox, applyMigration, expectReject } = require('./helpers/migration-sandbox.js');

async function setup(client) {
  for (let n = 7; n <= 17; n++) await applyMigration(client, n);
}
async function faltrixCtx(client) {
  const r = await client.query(`
    SELECT (SELECT machine_id FROM automatenlager.machines WHERE tenant_id='t_faltrix' LIMIT 1) mid,
           (SELECT product_id FROM automatenlager.products WHERE tenant_id='t_faltrix' LIMIT 1) pid,
           (SELECT location_id FROM automatenlager.locations WHERE tenant_id='t_faltrix' LIMIT 1) lid`);
  return r.rows[0];
}
// Frische Maschine (t_faltrix) mit eindeutigem machine_key -> kein UNIQUE-Konflikt.
async function freshMachine(client, key, lid) {
  await client.query(
    `INSERT INTO automatenlager.machines (machine_key, name, location_id, tenant_id)
     VALUES ('${key}', 'T', ${lid}, 't_faltrix')`);
  return key;
}

test('#105 LIVE-Sandbox: machine_profiles lehnt mandantenfremde tenant_id ab (Validierungs-Trigger)', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    const { lid } = await faltrixCtx(client);
    await client.query(`SELECT automatenlager.fn_create_tenant('t_b','B',NULL)`);
    const mk = await freshMachine(client, 'MK_A', lid);

    // Maschine gehoert t_faltrix; Profil mit tenant_id t_b -> Trigger-EXCEPTION.
    await expectReject(client,
      `INSERT INTO automatenlager.machine_profiles (machine_id, tenant_id) VALUES ('${mk}','t_b')`,
      /passt nicht zur Maschine|machine_profiles/i,
      'explizit falsche tenant_id wird abgelehnt');
  });
});

test('#105 LIVE-Sandbox: machine_profiles akzeptiert korrekte + erbt weggelassene tenant_id', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    const { lid } = await faltrixCtx(client);
    const mk1 = await freshMachine(client, 'MK_B', lid);
    // korrekt gesetzt
    await client.query(`INSERT INTO automatenlager.machine_profiles (machine_id, tenant_id) VALUES ('${mk1}','t_faltrix')`);

    const mk2 = await freshMachine(client, 'MK_C', lid);
    // weggelassen -> geerbt -> validiert
    await client.query(`INSERT INTO automatenlager.machine_profiles (machine_id) VALUES ('${mk2}')`);
    const got = await client.query(`SELECT tenant_id FROM automatenlager.machine_profiles WHERE machine_id='${mk2}'`);
    assert.equal(got.rows[0].tenant_id, 't_faltrix', 'weggelassene tenant_id korrekt geerbt');
  });
});

test('#105 LIVE-Sandbox: alle neuen composite FKs existieren und sind tenant-fuehrend', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    for (const name of ['guv_daily_machine_tenant_fk', 'guv_daily_product_tenant_fk',
      'warnings_machine_tenant_fk', 'warnings_product_tenant_fk', 'warnings_slot_tenant_fk',
      'product_aliases_product_tenant_fk', 'product_change_proposals_machine_tenant_fk',
      'product_change_proposals_product_tenant_fk', 'stock_movements_batch_tenant_fk']) {
      const r = await client.query(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname=$1`, [name]);
      assert.equal(r.rowCount, 1, `${name} existiert`);
      assert.match(r.rows[0].d, /FOREIGN KEY \(tenant_id,/, `${name} ist composite`);
    }
  });
});

test('#105 LIVE-Sandbox: Cross-Tenant-Insert in guv_daily wird abgelehnt', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    const { mid, pid } = await faltrixCtx(client);
    await client.query(`SELECT automatenlager.fn_create_tenant('t_b','B',NULL)`);
    await expectReject(client,
      `INSERT INTO automatenlager.guv_daily
         (guv_key, posting_date, machine_id, product_id, quantity_sold, revenue_gross, revenue_net, cost_of_goods, gross_profit, source, tenant_id)
       VALUES ('gk_x', current_date, ${mid}, ${pid}, 1, 1.0, 0.9, 0.5, 0.4, 'test', 't_b')`,
      /foreign key|violates/i,
      'guv_daily mit fremder tenant_id zur Maschine abgelehnt');
  });
});

test('#105 LIVE-Sandbox: Migration idempotent', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    await applyMigration(client, 17);
    const fk = await client.query(`SELECT count(*) c FROM pg_constraint WHERE conname='stock_movements_batch_tenant_fk'`);
    assert.equal(Number(fk.rows[0].c), 1, 'FK existiert genau einmal nach 2. Lauf');
    const trg = await client.query(
      `SELECT count(*) c FROM pg_trigger WHERE tgname='trg_validate_tenant_machine_profiles' AND NOT tgisinternal`);
    assert.equal(Number(trg.rows[0].c), 1, 'Validierungs-Trigger existiert genau einmal');
  });
});
