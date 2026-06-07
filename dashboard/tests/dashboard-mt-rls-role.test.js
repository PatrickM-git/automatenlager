'use strict';

/**
 * RLS-App-Rolle (Migration 0022) — Stufe 5, Slice 2 (Issue #145).
 * SPEC: docs/specs/multi-tenant-rls-stufe-5-v1.md §"Rollen & Verbindungen"
 *
 * Live gegen die Mini-DB im #94-Sandbox-Harness (ROLLBACK — CREATE/ALTER ROLE,
 * GRANT/REVOKE sind in PostgreSQL transaktional und werden garantiert verworfen).
 * Beweist: automatenlager_app ist eingeengt (kein super/bypassrls), hat die
 * operativen Rechte (via app_writer-Mitgliedschaft + DELETE-Lücke), KEINEN
 * Registry-Zugriff, und n8n_app erhält BYPASSRLS.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { connectOrSkip, withRollback, applyMigration, expectReject } = require('./helpers/migration-sandbox.js');

const OPERATIVE = ['products', 'stock_batches', 'sales_transactions', 'slot_assignments',
  'machines', 'locations', 'machine_profiles', 'invoices', 'guv_daily', 'warnings',
  'stock_movements', 'suppliers', 'nayax_devices', 'settings_thresholds'];
const REGISTRY = ['tenants', 'tenant_users', 'platform_admins'];

async function priv(client, role, table, p) {
  const r = await client.query(`SELECT has_table_privilege($1, 'automatenlager.'||$2, $3) AS ok`, [role, table, p]);
  return r.rows[0].ok;
}

test('#145 Migration 0022: automatenlager_app ist eingeengt (kein super/bypassrls, login)', async (t) => {
  const client = await connectOrSkip(t); if (!client) return;
  try {
    await withRollback(client, async () => {
      await applyMigration(client, 22);
      const r = await client.query(
        `SELECT rolsuper, rolbypassrls, rolcanlogin, rolcreatedb, rolcreaterole
           FROM pg_roles WHERE rolname='automatenlager_app'`);
      assert.equal(r.rowCount, 1, 'Rolle existiert');
      assert.equal(r.rows[0].rolsuper, false, 'kein Superuser');
      assert.equal(r.rows[0].rolbypassrls, false, 'KEIN BYPASSRLS (RLS-unterworfen)');
      assert.equal(r.rows[0].rolcanlogin, true, 'kann sich anmelden');
      assert.equal(r.rows[0].rolcreatedb, false);
      assert.equal(r.rows[0].rolcreaterole, false);
    });
  } finally { await client.end(); }
});

test('#145 Migration 0022: operative Grants vorhanden (SELECT/INSERT/UPDATE + DELETE-Lücke)', async (t) => {
  const client = await connectOrSkip(t); if (!client) return;
  try {
    await withRollback(client, async () => {
      await applyMigration(client, 22);
      for (const tbl of OPERATIVE) {
        for (const p of ['SELECT', 'INSERT', 'UPDATE']) {
          assert.equal(await priv(client, 'automatenlager_app', tbl, p), true, `${p} auf ${tbl}`);
        }
      }
      // DELETE nur dort, wo die App wirklich löscht.
      assert.equal(await priv(client, 'automatenlager_app', 'locations', 'DELETE'), true, 'DELETE auf locations');
      assert.equal(await priv(client, 'automatenlager_app', 'settings_thresholds', 'DELETE'), true, 'DELETE auf settings_thresholds');
    });
  } finally { await client.end(); }
});

test('#145 Migration 0022: KEIN Registry-Direktzugriff für die App-Rolle', async (t) => {
  const client = await connectOrSkip(t); if (!client) return;
  try {
    await withRollback(client, async () => {
      await applyMigration(client, 22);
      for (const tbl of REGISTRY) {
        assert.equal(await priv(client, 'automatenlager_app', tbl, 'SELECT'), false, `kein SELECT auf ${tbl}`);
        assert.equal(await priv(client, 'automatenlager_app', tbl, 'INSERT'), false, `kein INSERT auf ${tbl}`);
      }
    });
  } finally { await client.end(); }
});

test('#145 Migration 0022: n8n_app erhält BYPASSRLS (bleibt außerhalb des Backstops bis Stufe 6)', async (t) => {
  const client = await connectOrSkip(t); if (!client) return;
  try {
    await withRollback(client, async () => {
      await applyMigration(client, 22);
      const r = await client.query(`SELECT rolbypassrls FROM pg_roles WHERE rolname='n8n_app'`);
      assert.equal(r.rowCount, 1, 'n8n_app existiert');
      assert.equal(r.rows[0].rolbypassrls, true, 'n8n_app hat jetzt BYPASSRLS');
    });
  } finally { await client.end(); }
});

test('#145 SET ROLE smoke: App-Rolle liest operative Tabellen, Registry verweigert (live)', async (t) => {
  const client = await connectOrSkip(t); if (!client) return;
  try {
    await withRollback(client, async () => {
      await applyMigration(client, 22);
      await client.query('SET ROLE automatenlager_app');
      // operativer Read funktioniert (noch ohne Policies ⇒ sieht alles)
      await client.query('SELECT 1 FROM automatenlager.products LIMIT 1');
      // Registry-Read verweigert (permission denied, 42501)
      await expectReject(client, 'SELECT 1 FROM automatenlager.tenants LIMIT 1', /permission denied/i,
        'App-Rolle darf Registry nicht direkt lesen');
      await client.query('RESET ROLE');
    });
  } finally { await client.end(); }
});
