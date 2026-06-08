'use strict';

/**
 * Nayax-Devices-Sync (Issue #161, Stufe 6 Slice 1) — Ersatz für WF-Nayax-Devices-Sync.
 * Unit-Parität (map/resolve/fetch) + LIVE-Upsert durch die Tür (RLS, Isolation, idempotent).
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const nx = require('../lib/jobs/nayax-devices-sync.js');
const { inSandbox, applyMigration } = require('./helpers/migration-sandbox.js');
const { createTenantDb } = require('../lib/tenant-db.js');
const { seedAcmeGlobex, sandboxTxPool } = require('./helpers/tenant-fixtures.js');

// ── Unit ─────────────────────────────────────────────────────────────────────

test('#161 mapDevices: Feld-Fallbacks + leere IDs verworfen (faithful)', () => {
  const rows = nx.mapDevices([
    { MachineID: '100', MachineNumber: 'A1', MachineName: 'Foyer' },
    { machineId: '200', MachineNo: 'B2', Description: 'Keller' },
    { MachineNumber: 'X', MachineName: 'ohne ID' }, // keine ID ⇒ raus
    { MachineID: '  ' }, // leer ⇒ raus
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { nayax_machine_id: '100', machine_number: 'A1', machine_name: 'Foyer' });
  assert.deepEqual(rows[1], { nayax_machine_id: '200', machine_number: 'B2', machine_name: 'Keller' });
});

test('#161 resolveNayaxTenant: explizit > einziger Registry-Mandant; mehrdeutig ⇒ null', () => {
  assert.equal(nx.resolveNayaxTenant({ NAYAX_TENANT_ID: 't_faltrix' }, { listTenantIds: () => ['a', 'b'] }), 't_faltrix');
  assert.equal(nx.resolveNayaxTenant({}, { listTenantIds: () => ['nur_einer'] }), 'nur_einer');
  assert.equal(nx.resolveNayaxTenant({}, { listTenantIds: () => ['a', 'b'] }), null, 'mehrdeutig ⇒ fail-closed');
  assert.equal(nx.resolveNayaxTenant({}, { listTenantIds: () => [] }), null);
});

test('#161 fetchNayaxMachines: URL/Header korrekt; Array- und {Data:[]}-Form; non-ok wirft', async () => {
  let seen = null;
  const arrFetch = async (url, opts) => { seen = { url, opts }; return { ok: true, status: 200, json: async () => [{ MachineID: '1' }] }; };
  const a = await nx.fetchNayaxMachines({ token: 'TOK', headerName: 'Authorization', fetchImpl: arrFetch, resultsLimit: 500 });
  assert.match(seen.url, /\/machines\?ResultsLimit=500$/);
  assert.equal(seen.opts.headers.Authorization, 'TOK', 'Token im Authorization-Header');
  assert.equal(a.length, 1);

  const objFetch = async () => ({ ok: true, status: 200, json: async () => ({ Data: [{ MachineID: '7' }, { MachineID: '8' }] }) });
  const b = await nx.fetchNayaxMachines({ token: 'T', fetchImpl: objFetch });
  assert.equal(b.length, 2, '{Data:[…]}-Form entpackt');

  const errFetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  await assert.rejects(() => nx.fetchNayaxMachines({ token: 'T', fetchImpl: errFetch }), /Nayax HTTP 401/);
});

test('#161 createNayaxDevicesSyncJob: skip ohne Token bzw. ohne eindeutigen Mandanten', async () => {
  const db = { tx: async () => { throw new Error('darf nicht schreiben'); } };
  const noToken = nx.createNayaxDevicesSyncJob({ db, env: {}, directory: { listTenantIds: () => ['x'] } });
  assert.match((await noToken.run()).skipped, /NAYAX_API_TOKEN/);
  const noTenant = nx.createNayaxDevicesSyncJob({ db, env: { NAYAX_API_TOKEN: 't' }, directory: { listTenantIds: () => ['a', 'b'] } });
  assert.match((await noTenant.run()).skipped, /Mandant/);
});

// ── LIVE: Upsert durch die Tür, RLS-Isolation, Idempotenz ────────────────────
test('#161 Nayax-Sync LIVE: Upsert für EINEN Mandanten, isoliert + idempotent (RLS aktiv)', async (t) => {
  await inSandbox(t, async (client) => {
    await seedAcmeGlobex(client); // jeder Mandant hat bereits nayax-Gerät nx_<tid>
    for (const n of [22, 23, 24, 25, 26]) await applyMigration(client, n);
    await client.query('SET ROLE automatenlager_app');
    try {
      const db = createTenantDb({ pool: sandboxTxPool(client) });
      const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ([
        { MachineID: 'NX-NEU-ACME', MachineNumber: 'A-9', MachineName: 'Neu Acme' },
      ]) });
      const job = nx.createNayaxDevicesSyncJob({
        db, env: { NAYAX_API_TOKEN: 'tok', NAYAX_TENANT_ID: 'acme' }, fetchImpl: fakeFetch,
      });

      const r1 = await job.run();
      assert.equal(r1.tenant, 'acme');
      assert.equal(r1.upserted, 1, 'ein Gerät gebucht');

      const idsFor = async (tid) => (await db.read({
        tenant: tid, tables: ['nayax_devices'],
        text: `SELECT nayax_machine_id FROM automatenlager.nayax_devices WHERE tenant_id = $1`,
      })).rows.map((r) => r.nayax_machine_id);

      const acmeIds = await idsFor('acme');
      const globexIds = await idsFor('globex');
      assert.ok(acmeIds.includes('NX-NEU-ACME'), 'acme sieht das neue Gerät (nicht-vakuös)');
      assert.ok(!globexIds.includes('NX-NEU-ACME'), 'globex sieht es NICHT (Isolation)');

      // Idempotenz: zweiter Lauf = DO UPDATE, keine zusätzliche Zeile.
      const before = (await idsFor('acme')).length;
      const r2 = await job.run();
      assert.equal(r2.upserted, 1);
      assert.equal((await idsFor('acme')).length, before, 'Zeilenzahl unverändert (Upsert)');
    } finally {
      await client.query('RESET ROLE');
    }
  });
});
