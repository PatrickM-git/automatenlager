'use strict';

// Issue #94 — Migration 0007 (tenants, tenant_users, platform_admins).
// Verifiziert das Mandanten-Fundament gegen die ECHTE DB in einer Rollback-
// Transaktion (Sandbox-Helper): die Tabellen werden angelegt, Constraints
// geprueft, danach ROLLBACK — die DB bleibt unveraendert. Skip offline.

const assert = require('node:assert/strict');
const test = require('node:test');

const { inSandbox, applyMigration } = require('./helpers/migration-sandbox.js');

async function relExists(client, name) {
  const r = await client.query(
    `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='automatenlager' AND c.relname=$1 AND c.relkind='r'`, [name]);
  return r.rowCount === 1;
}
async function columns(client, name) {
  const r = await client.query(
    `SELECT a.attname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
      WHERE n.nspname='automatenlager' AND c.relname=$1`, [name]);
  return r.rows.map((x) => x.attname);
}

test('#94 LIVE-Sandbox: 0007 legt die drei Strukturtabellen an, ROLLBACK laesst DB unveraendert', async (t) => {
  await inSandbox(t, async (client) => {
    await applyMigration(client, 7);

    assert.ok(await relExists(client, 'tenants'), 'tenants existiert');
    assert.ok(await relExists(client, 'tenant_users'), 'tenant_users existiert');
    assert.ok(await relExists(client, 'platform_admins'), 'platform_admins existiert');

    // platform_admins traegt bewusst KEINE tenant_id (mandantenuebergreifend).
    const paCols = await columns(client, 'platform_admins');
    assert.ok(!paCols.includes('tenant_id'), 'platform_admins hat keine tenant_id-Spalte');
    assert.ok(paCols.includes('login'), 'platform_admins hat login (PK)');

    // tenants-Defaults
    const tCols = await columns(client, 'tenants');
    for (const c of ['tenant_id', 'name', 'status', 'contact_email', 'created_at']) {
      assert.ok(tCols.includes(c), `tenants.${c} existiert`);
    }
  });
});

test('#94 LIVE-Sandbox: status-Default aktiv, contact_email nullable, doppelte (tenant_id,login) abgelehnt', async (t) => {
  await inSandbox(t, async (client) => {
    await applyMigration(client, 7);

    // Insert ohne status/contact_email -> Default 'aktiv', NULL erlaubt.
    await client.query(`INSERT INTO automatenlager.tenants (tenant_id, name) VALUES ('t_sb', 'Sandbox GmbH')`);
    const row = await client.query(`SELECT status, contact_email FROM automatenlager.tenants WHERE tenant_id='t_sb'`);
    assert.equal(row.rows[0].status, 'aktiv', 'status-Default ist aktiv');
    assert.equal(row.rows[0].contact_email, null, 'contact_email ist nullable');

    // FK tenant_users.tenant_id -> tenants
    await client.query(`INSERT INTO automatenlager.tenant_users (tenant_id, login, role) VALUES ('t_sb','a@x.de','eigentuemer')`);
    // Doppelte (tenant_id, login) -> Unique-Verstoss
    await assert.rejects(
      client.query(`INSERT INTO automatenlager.tenant_users (tenant_id, login, role) VALUES ('t_sb','a@x.de','auffueller')`),
      /tenant_users_unique|duplicate key/i,
      'doppelte (tenant_id, login) wird abgelehnt');
  });
});

test('#94 LIVE-Sandbox: tenant_users.tenant_id ohne existierenden Mandanten abgelehnt (FK)', async (t) => {
  await inSandbox(t, async (client) => {
    await applyMigration(client, 7);
    await assert.rejects(
      client.query(`INSERT INTO automatenlager.tenant_users (tenant_id, login, role) VALUES ('t_ghost','b@x.de','gast')`),
      /foreign key|violates/i,
      'Mitgliedschaft auf nicht-existenten Mandanten wird per FK abgelehnt');
  });
});
