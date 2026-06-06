'use strict';

// Issue #115 — Migration 0018 (Seed tenant_users + platform_admins, Stufe 2).
// LIVE-Sandbox mit ROLLBACK: die Seed-Migration wird in einer Transaktion gegen
// die echte DB angewendet, geprueft, danach ROLLBACK — die DB bleibt unveraendert.
// Skip offline. Verifiziert: Row-Existenz + Werte, optionale Partner/Auffueller
// per GUC, Idempotenz beim Re-Run.

const assert = require('node:assert/strict');
const test = require('node:test');

const { inSandbox, applyMigration } = require('./helpers/migration-sandbox.js');

const ADMIN = 'patrickmatthes2609@gmail.com'; // Eigentuemer 1 (Mini-Serve-Login)
const OWNER2 = 'lantspeku@gmail.com';        // Eigentuemer 2 (zweiter GbR-Geschaeftsfuehrer)

async function setup(client) {
  for (let n = 7; n <= 18; n++) await applyMigration(client, n);
}

async function tenantUser(client, login) {
  const r = await client.query(
    `SELECT tenant_id, role, active FROM automatenlager.tenant_users WHERE login = $1`, [login]);
  return r.rows;
}

test('#115 LIVE-Sandbox: beide Eigentuemer-Defaults -> t_faltrix in tenant_users + platform_admins', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);

    for (const owner of [ADMIN, OWNER2]) {
      const rows = await tenantUser(client, owner);
      assert.equal(rows.length, 1, `genau eine tenant_users-Zeile fuer ${owner}`);
      assert.equal(rows[0].tenant_id, 't_faltrix', `${owner} -> t_faltrix`);
      assert.equal(rows[0].role, 'eigentuemer', `${owner} role eigentuemer`);
      assert.equal(rows[0].active, true, 'active=true');

      const pa = await client.query(
        `SELECT active FROM automatenlager.platform_admins WHERE login = $1`, [owner]);
      assert.equal(pa.rowCount, 1, `${owner} als platform_admin`);
      assert.equal(pa.rows[0].active, true, 'platform_admin active=true');
    }
  });
});

test('#115 LIVE-Sandbox: Partner/Auffueller per GUC -> t_faltrix mit Rollen', async (t) => {
  await inSandbox(t, async (client) => {
    // GUCs gelten fuer die Sandbox-Session/-Transaktion -> 0018 sieht sie.
    await client.query(`SET automatenlager.seed_partner_login  = 'partner@faltrix.test'`);
    await client.query(`SET automatenlager.seed_operator_login = 'Auffueller@Faltrix.Test'`);
    await setup(client);

    const partner = await tenantUser(client, 'partner@faltrix.test');
    assert.equal(partner.length, 1, 'Partner-Zeile vorhanden');
    assert.equal(partner[0].tenant_id, 't_faltrix');
    assert.equal(partner[0].role, 'partner');

    // Login wird lowercase normalisiert (Konsistenz mit loginTenant in #116).
    const op = await tenantUser(client, 'auffueller@faltrix.test');
    assert.equal(op.length, 1, 'Auffueller-Zeile lowercase normalisiert');
    assert.equal(op[0].role, 'auffueller');

    // Partner/Auffueller sind KEINE platform_admins (nur die beiden Eigentuemer).
    const pa = await client.query(
      `SELECT count(*)::int c FROM automatenlager.platform_admins WHERE login NOT IN ($1, $2)`, [ADMIN, OWNER2]);
    assert.equal(pa.rows[0].c, 0, 'nur die Eigentuemer sind platform_admins');
  });
});

test('#115 LIVE-Sandbox: ohne GUC nur die beiden Eigentuemer (Partner/Auffueller NICHT geraten)', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    // Nur die beiden Eigentuemer-Defaults sind in tenant_users (keine erratenen Logins).
    const all = await client.query(
      `SELECT login FROM automatenlager.tenant_users WHERE tenant_id='t_faltrix' ORDER BY login`);
    const logins = all.rows.map((r) => r.login).sort();
    assert.deepEqual(logins, [ADMIN, OWNER2].sort(), 'ohne GUC genau die zwei Eigentuemer');
  });
});

test('#115 LIVE-Sandbox: idempotent — zweiter Lauf wirft nicht und dupliziert nicht', async (t) => {
  await inSandbox(t, async (client) => {
    await client.query(`SET automatenlager.seed_partner_login = 'partner@faltrix.test'`);
    await setup(client);
    await applyMigration(client, 18); // zweiter Lauf

    const admin = await tenantUser(client, ADMIN);
    assert.equal(admin.length, 1, 'Eigentuemer genau einmal nach 2. Lauf');
    const partner = await tenantUser(client, 'partner@faltrix.test');
    assert.equal(partner.length, 1, 'Partner genau einmal nach 2. Lauf');
    const pa = await client.query(
      `SELECT count(*)::int c FROM automatenlager.platform_admins WHERE login=$1`, [ADMIN]);
    assert.equal(pa.rows[0].c, 1, 'platform_admin genau einmal nach 2. Lauf');
  });
});
