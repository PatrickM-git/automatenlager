'use strict';

/**
 * machine-create + machine-profiles Schreib-Isolation — Stufe 4, Slice 3b (Issue #136).
 * SPEC: docs/specs/multi-tenant-write-isolation-stufe-4-v1.md §"Direkte DB-Schreiber"
 *
 * createMachinePg läuft in db.tx und prüft den Parent-Standort IN der Transaktion
 * (fremde location_id ⇒ 404, keine Maschine). UPSERT machines ON CONFLICT
 * (tenant_id, machine_key), machine_profiles (tenant_id, machine_id). Nicht-vakuös
 * gegen acme/globex im #94-Harness; Migration 0020 vorab (DDL vor Code).
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { createTenantDb } = require('../lib/tenant-db.js');
const { createMachinePg, setMachineActivePg, buildMachineCreatePayload } = require('../lib/machine-create.js');
const { upsertMachineProfilePg } = require('../lib/machine-profiles.js');
const { inSandbox, applyMigration } = require('./helpers/migration-sandbox.js');
const { seedAcmeGlobex, sandboxTxPool } = require('./helpers/tenant-fixtures.js');

function doorForSandbox(client) { return createTenantDb({ pool: sandboxTxPool(client) }); }
const payload = (o) => buildMachineCreatePayload(o);

test('#136 fail-closed: Schreiben ohne Mandant WIRFT (create/active/profile)', async () => {
  const noop = { query: async () => ({ rows: [], rowCount: 0 }), connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release() {} }) };
  const db = createTenantDb({ pool: noop });
  await assert.rejects(() => createMachinePg(db, '', payload({ machine_key: 'x', name: 'X', location_key: 'L' })), /Mandant/i);
  await assert.rejects(() => setMachineActivePg(db, '', 'x', false), /Mandant/i);
  await assert.rejects(() => upsertMachineProfilePg(db, '', { machine_id: 'x' }), /Mandant/i);
});

test('#136 read-after-write + cross-tenant: gleicher machine_key ⇒ getrennte Zeilen (machines + profiles)', async (t) => {
  await inSandbox(t, async (client) => {
    await applyMigration(client, 20);
    await applyMigration(client, 21); // tenant-treuer machine_profiles-Trigger mandanten-skopiert
    await seedAcmeGlobex(client); // loc_acme, loc_globex existieren
    const db = doorForSandbox(client);

    await createMachinePg(db, 'acme', payload({ machine_key: 'shared_vm', name: 'Acme VM', location_key: 'loc_acme' }));
    await createMachinePg(db, 'globex', payload({ machine_key: 'shared_vm', name: 'Globex VM', location_key: 'loc_globex' }));

    const machines = await client.query(
      `SELECT tenant_id, name FROM automatenlager.machines WHERE machine_key = 'shared_vm' ORDER BY tenant_id`);
    assert.equal(machines.rows.length, 2, 'gleicher machine_key bei zwei Mandanten ⇒ ZWEI Zeilen');
    assert.equal(machines.rows[0].name, 'Acme VM', 'acme-Zeile vom globex-Create NICHT überschrieben');
    assert.equal(machines.rows[1].name, 'Globex VM');

    const profiles = await client.query(
      `SELECT count(*)::int AS n FROM automatenlager.machine_profiles WHERE machine_id = 'shared_vm'`);
    assert.equal(profiles.rows[0].n, 2, 'machine_profiles je Mandant getrennt');
  });
});

test('#136 fremde location_id ⇒ NOT_FOUND (→404), KEINE Maschine (TOCTOU-sicher)', async (t) => {
  await inSandbox(t, async (client) => {
    await applyMigration(client, 20);
    await applyMigration(client, 21); // tenant-treuer machine_profiles-Trigger mandanten-skopiert
    await seedAcmeGlobex(client);
    const db = doorForSandbox(client);

    // acme legt eine Maschine an, die auf globex' Standort zeigt ⇒ abgewiesen.
    await assert.rejects(
      () => createMachinePg(db, 'acme', payload({ machine_key: 'evil_vm', name: 'Evil', location_key: 'loc_globex' })),
      (err) => err.code === 'NOT_FOUND',
      'fremder Standort ⇒ NOT_FOUND',
    );
    const n = await client.query(`SELECT count(*)::int AS n FROM automatenlager.machines WHERE machine_key = 'evil_vm'`);
    assert.equal(n.rows[0].n, 0, 'keine Maschine angelegt (Transaktion zurückgerollt)');
  });
});

test('#136 setMachineActive: acme kann globex-Maschine NICHT aussondern; Owner-Regression', async (t) => {
  await inSandbox(t, async (client) => {
    await applyMigration(client, 20);
    await applyMigration(client, 21); // tenant-treuer machine_profiles-Trigger mandanten-skopiert
    await seedAcmeGlobex(client); // vm_globex gehört globex (active default TRUE)
    const db = doorForSandbox(client);

    await assert.rejects(() => setMachineActivePg(db, 'acme', 'vm_globex', false), (err) => err.code === 'NOT_FOUND');
    const still = await client.query(`SELECT active FROM automatenlager.machines WHERE machine_key = 'vm_globex' AND tenant_id = 'globex'`);
    assert.notEqual(still.rows[0].active, false, 'globex-Maschine NICHT von acme deaktiviert');

    const own = await setMachineActivePg(db, 'globex', 'vm_globex', false); // Owner darf
    assert.equal(own.active, false, 'globex sondert eigene Maschine aus');
  });
});

test('#136 machine-profiles direkt: acme/globex-Profil für gleichen machine_id getrennt', async (t) => {
  await inSandbox(t, async (client) => {
    await applyMigration(client, 20);
    await applyMigration(client, 21); // tenant-treuer machine_profiles-Trigger mandanten-skopiert
    await seedAcmeGlobex(client);
    const db = doorForSandbox(client);

    // Maschinen je Mandant mit gleichem Key (tenant-treuer Trigger verlangt eine
    // eigene Maschine je Profil; nach 0020/0021 ist gleicher Key je Mandant erlaubt).
    await createMachinePg(db, 'acme', payload({ machine_key: 'P1', name: 'Acme P1', location_key: 'loc_acme' }));
    await createMachinePg(db, 'globex', payload({ machine_key: 'P1', name: 'Globex P1', location_key: 'loc_globex' }));

    await upsertMachineProfilePg(db, 'acme', { machine_id: 'P1', area: 'EG', nickname: 'Acme-Profil' });
    await upsertMachineProfilePg(db, 'globex', { machine_id: 'P1', area: '1.OG', nickname: 'Globex-Profil' });

    const a = await client.query(`SELECT nickname FROM automatenlager.machine_profiles WHERE machine_id='P1' AND tenant_id='acme'`);
    const g = await client.query(`SELECT nickname FROM automatenlager.machine_profiles WHERE machine_id='P1' AND tenant_id='globex'`);
    assert.equal(a.rows[0].nickname, 'Acme-Profil', 'acme-Profil unangetastet vom globex-Upsert');
    assert.equal(g.rows[0].nickname, 'Globex-Profil');
  });
});
