'use strict';

/**
 * Per-Mandant-Job-Runner (Issue #160, Stufe 6 Slice 0).
 * SPEC: docs/specs/multi-tenant-n8n-abloesung-stufe-6-v1.md §"Datenzugriff — alles durch die Tür"
 *
 * Der Runner iteriert die Mandanten-Registry (lib/tenant-directory.js) und führt
 * einen Job JE MANDANT durch die Mandanten-Tür aus (GUC gesetzt) — exakt wie
 * alert-digest heute (expliziter Mandant, NIE ein Default). Fail-closed: kein/
 * leerer Mandant ⇒ übersprungen; Verzeichnis nicht bereit ⇒ nichts läuft.
 *
 * Zwei Ebenen: (1) schnelle Verhaltens-Unit-Tests mit Fakes; (2) LIVE im
 * #94-Sandbox-Harness als `automatenlager_app` (RLS aktiv) — der nicht-vakuöse
 * acme/globex-Isolationsbeweis (skippt offline).
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { createTenantJobRunner } = require('../lib/jobs/tenant-runner.js');
const { inSandbox, applyMigration } = require('./helpers/migration-sandbox.js');
const { seedAcmeGlobex, doorForClient } = require('./helpers/tenant-fixtures.js');

// ── (1) Verhaltens-Units (kein PG) ───────────────────────────────────────────

// Fake-Tür: echot den Mandanten, mit dem read() aufgerufen wurde (beweist, dass
// JEDER Lauf seinen eigenen Mandanten setzt).
function fakeDoor() {
  const seen = [];
  return {
    seen,
    read: async ({ tenant }) => { seen.push(tenant); return { rows: [{ tenant }], rowCount: 1 }; },
  };
}

test('#160 Runner: führt den Job pro Mandant der Registry aus (expliziter Mandant je Lauf)', async () => {
  const db = fakeDoor();
  const directory = { listTenantIds: () => ['acme', 'globex'] };
  const runner = createTenantJobRunner({ db, directory });
  const job = (door, tenant) => door.read({ tenant, tables: ['products'], text: 'SELECT 1 WHERE tenant_id=$1' });

  const out = await runner.runForAll(job);
  assert.deepEqual(out.tenants, ['acme', 'globex'], 'beide Mandanten gelaufen');
  assert.deepEqual(db.seen, ['acme', 'globex'], 'je Lauf wurde der EIGENE Mandant gesetzt');
  assert.equal(out.perTenant.acme.rows[0].tenant, 'acme');
  assert.equal(out.perTenant.globex.rows[0].tenant, 'globex');
});

test('#160 Runner fail-closed: Verzeichnis nicht bereit/leer ⇒ NICHTS läuft', async () => {
  const db = fakeDoor();
  const empty = createTenantJobRunner({ db, directory: { listTenantIds: () => [] } });
  const out = await empty.runForAll((door, t) => door.read({ tenant: t, tables: ['x'], text: 'q' }));
  assert.deepEqual(out.tenants, [], 'kein Mandant ⇒ kein Lauf');
  assert.deepEqual(db.seen, [], 'die Tür wurde nie angefasst (kein Default-Mandant)');

  // Verzeichnis ganz ohne listTenantIds (z. B. null) ⇒ ebenfalls leer, kein Crash.
  const noDir = createTenantJobRunner({ db: fakeDoor(), directory: null });
  const out2 = await noDir.runForAll(() => { throw new Error('darf nie laufen'); });
  assert.deepEqual(out2.tenants, []);
});

test('#160 Runner fail-closed: leere/whitespace Mandanten werden übersprungen, nicht gesetzt', async () => {
  const db = fakeDoor();
  const directory = { listTenantIds: () => ['', '  ', null, 'acme'] };
  const runner = createTenantJobRunner({ db, directory });
  const out = await runner.runForAll((door, t) => door.read({ tenant: t, tables: ['x'], text: 'q' }));
  assert.deepEqual(out.tenants, ['acme'], 'nur der echte Mandant läuft');
  assert.deepEqual(db.seen, ['acme'], 'kein leerer Mandant erreicht die Tür');
  assert.equal(out.skipped.length, 3, 'die drei Leer-Einträge sind übersprungen');
});

test('#160 Runner: ein fehlschlagender Mandanten-Lauf isoliert die anderen (per-Mandant-Status)', async () => {
  const db = {
    read: async ({ tenant }) => { if (tenant === 'globex') throw new Error('globex kaputt'); return { rows: [{ tenant }] }; },
  };
  const directory = { listTenantIds: () => ['acme', 'globex', 'initech'] };
  const runner = createTenantJobRunner({ db, directory });
  const out = await runner.runForAll((door, t) => door.read({ tenant: t, tables: ['x'], text: 'q' }), { continueOnError: true });
  assert.deepEqual(out.tenants.sort(), ['acme', 'initech'], 'erfolgreiche Mandanten gelaufen');
  assert.ok(out.errors.some((e) => e.tenant === 'globex' && /globex kaputt/.test(e.error)), 'Fehler je Mandant erfasst');
});

// ── (2) LIVE: acme/globex-Isolation als automatenlager_app (RLS aktiv) ───────────
test('#160 Runner LIVE: pro-Mandant durch die Tür isoliert (acme≠globex, nicht-vakuös, RLS aktiv)', async (t) => {
  await inSandbox(t, async (client) => {
    await seedAcmeGlobex(client);                       // beide Mandanten tragen Produkte
    for (const n of [22, 23, 24, 25, 26]) await applyMigration(client, n); // RLS scharf
    await client.query('SET ROLE automatenlager_app');  // eingeengte App-Rolle (kein BYPASSRLS)
    try {
      const db = doorForClient(client);
      const directory = { listTenantIds: () => ['acme', 'globex'] };
      const runner = createTenantJobRunner({ db, directory });

      const probe = (door, tenant) => door.read({
        tenant, tables: ['products'],
        text: 'SELECT name FROM automatenlager.products WHERE tenant_id = $1 ORDER BY name',
      });
      const out = await runner.runForAll(probe);

      const acmeNames = out.perTenant.acme.rows.map((r) => r.name);
      const globexNames = out.perTenant.globex.rows.map((r) => r.name);
      assert.ok(acmeNames.includes('Cola acme'), 'acme-Lauf sieht acme-Produkt (nicht-vakuös)');
      assert.ok(globexNames.includes('Cola globex'), 'globex-Lauf sieht globex-Produkt (nicht-vakuös)');
      assert.ok(!acmeNames.includes('Cola globex'), 'acme-Lauf sieht KEIN globex-Produkt (Isolation)');
      assert.ok(!globexNames.includes('Cola acme'), 'globex-Lauf sieht KEIN acme-Produkt (Isolation)');
    } finally {
      await client.query('RESET ROLE');
    }
  });
});
