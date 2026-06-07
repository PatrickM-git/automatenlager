'use strict';

/**
 * location-profiles Schreib-Isolation — Stufe 4, Slice 3a (Issue #135).
 * SPEC: docs/specs/multi-tenant-write-isolation-stufe-4-v1.md §"Direkte DB-Schreiber"
 *
 * upsertLocationPg/deleteLocationPg laufen jetzt durch die Mandanten-Tür (Mandant
 * als $1; UPSERT ON CONFLICT (tenant_id, location_key); DELETE WHERE tenant_id = $1;
 * deleteLocationPg atomar in db.tx). Nicht-vakuös gegen acme/globex im #94-Harness.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { createTenantDb } = require('../lib/tenant-db.js');
const { upsertLocationPg, deleteLocationPg, queryLocationsPg } = require('../lib/location-profiles.js');
const { inSandbox, applyMigration } = require('./helpers/migration-sandbox.js');
const { seedAcmeGlobex, sandboxTxPool } = require('./helpers/tenant-fixtures.js');

// Der Upsert nutzt ON CONFLICT (tenant_id, location_key) — der Constraint stammt aus
// Migration 0020 (#132), die auf der Mini noch nicht deployt ist (erst #139). In der
// Sandbox-Transaktion wird sie daher vorab angewendet (DDL vor Code, wie in Prod).
async function with0020(client) {
  await applyMigration(client, 20);
}

// Tür über den Sandbox-Client: pool.query (db.write/read) + pool.connect (db.tx,
// savepoint-basiert) auf demselben Client in der äußeren Rollback-Transaktion.
function doorForSandbox(client) {
  return createTenantDb({ pool: sandboxTxPool(client) });
}
async function ensureTenants(client) {
  await client.query(`INSERT INTO automatenlager.tenants (tenant_id, name) VALUES ('acme','A'),('globex','G') ON CONFLICT (tenant_id) DO NOTHING`);
}

test('#135 fail-closed: Upsert/Delete ohne Mandant WIRFT (kein „gespeichert")', async () => {
  const db = createTenantDb({ pool: { query: async () => ({ rows: [], rowCount: 0 }), connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release() {} }) } });
  await assert.rejects(() => upsertLocationPg(db, '', { name: 'X', status: 'aktiv' }), /Mandant/i);
  await assert.rejects(() => deleteLocationPg(db, '', 'loc_x'), /Mandant/i);
});

test('#135 read-after-write: acme legt Standort an → acme sieht ihn, globex NICHT', async (t) => {
  await inSandbox(t, async (client) => {
    await with0020(client);
    await ensureTenants(client);
    const db = doorForSandbox(client);
    await upsertLocationPg(db, 'acme', { name: 'Acme HQ', status: 'aktiv', location_key: 'loc_raw_acme' });
    const acme = await queryLocationsPg(db, 'acme');
    const globex = await queryLocationsPg(db, 'globex');
    assert.ok(acme.some((l) => l.location_key === 'loc_raw_acme'), 'acme sieht seinen Standort');
    assert.ok(!globex.some((l) => l.location_key === 'loc_raw_acme'), 'globex sieht ihn NICHT');
  });
});

test('#135 cross-tenant: gleicher location_key ⇒ getrennte Zeilen, kein Überschreiben', async (t) => {
  await inSandbox(t, async (client) => {
    await with0020(client);
    await ensureTenants(client);
    const db = doorForSandbox(client);
    await upsertLocationPg(db, 'acme', { name: 'Acme-Standort', status: 'aktiv', location_key: 'dup_key' });
    await upsertLocationPg(db, 'globex', { name: 'Globex-Standort', status: 'aktiv', location_key: 'dup_key' });
    const rows = await client.query(
      `SELECT tenant_id, name FROM automatenlager.locations WHERE location_key = 'dup_key' ORDER BY tenant_id`);
    assert.equal(rows.rows.length, 2, 'gleicher location_key bei zwei Mandanten ⇒ ZWEI Zeilen');
    assert.equal(rows.rows[0].name, 'Acme-Standort', 'acme-Zeile vom globex-Upsert NICHT überschrieben');
    assert.equal(rows.rows[1].name, 'Globex-Standort');
  });
});

test('#135 delete: Belegungs-Guard mandantengebunden, fremder Standort nicht löschbar, Owner-Regression', async (t) => {
  await inSandbox(t, async (client) => {
    await with0020(client);
    await seedAcmeGlobex(client); // loc_acme MIT vm_acme; loc_globex MIT vm_globex
    const db = doorForSandbox(client);

    // Belegter Standort (loc_acme hat vm_acme) ⇒ Guard blockt (mandanten-gezählt).
    await assert.rejects(() => deleteLocationPg(db, 'acme', 'loc_acme'), /Automat|umziehen|aussondern/i);

    // Owner-Regression: leeren Standort anlegen + löschen klappt.
    await upsertLocationPg(db, 'acme', { name: 'Leerer Standort', status: 'aktiv', location_key: 'loc_empty_acme' });
    const del = await deleteLocationPg(db, 'acme', 'loc_empty_acme');
    assert.equal(del.deleted, 'loc_empty_acme');

    // acme darf globex' Standort NICHT löschen ⇒ NOT_FOUND; globex-Zeile überlebt.
    await assert.rejects(() => deleteLocationPg(db, 'acme', 'loc_globex'), /nicht gefunden/i);
    const survives = await client.query(
      `SELECT count(*)::int AS n FROM automatenlager.locations WHERE location_key = 'loc_globex' AND tenant_id = 'globex'`);
    assert.equal(survives.rows[0].n, 1, 'globex-Standort überlebt acme-Löschversuch');
  });
});
