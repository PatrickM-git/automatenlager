'use strict';

/**
 * settings-thresholds Schreib-Isolation — Stufe 4, Slice 3c (Issue #137).
 * SPEC: docs/specs/multi-tenant-write-isolation-stufe-4-v1.md §"Direkte DB-Schreiber" + Pflichtfall 4
 *
 * setThreshold/resetThreshold/resetAllThresholds laufen durch die Mandanten-Tür
 * (Mandant als $1; Constraint settings_thresholds_unique war schon mandantensauber,
 * keine DDL). Schwerpunkt: Side-Effects-Isolation — eine acme-Schreibung erzeugt
 * KEINE globex-Effekte. Nicht-vakuös gegen acme/globex im #94-Harness.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { createTenantDb } = require('../lib/tenant-db.js');
const { setThreshold, resetThreshold, resetAllThresholds, getThresholds } = require('../lib/settings-thresholds.js');
const { inSandbox } = require('./helpers/migration-sandbox.js');
const { seedAcmeGlobex, doorForClient } = require('./helpers/tenant-fixtures.js');

test('#137 fail-closed: Schreiben/Löschen ohne Mandant WIRFT', async () => {
  const db = createTenantDb({ query: async () => ({ rows: [], rowCount: 0 }) });
  await assert.rejects(() => setThreshold(db, '', null, 'ladenhueterDays', 30), /Mandant/i);
  await assert.rejects(() => resetThreshold(db, '', null, 'ladenhueterDays'), /Mandant/i);
  await assert.rejects(() => resetAllThresholds(db, '', null), /Mandant/i);
});

test('#137 read-after-write + Isolation: acme-Schwelle ≠ globex-Schwelle, kein Leak', async (t) => {
  await inSandbox(t, async (client) => {
    await seedAcmeGlobex(client); // global ladenhueterDays: acme=100, globex=250 (Fixture)
    const db = doorForClient(client);
    await setThreshold(db, 'acme', null, 'ladenhueterDays', 45); // acme ändert seine globale Schwelle
    const a = await getThresholds(db, 'acme', null);
    const g = await getThresholds(db, 'globex', null);
    assert.equal(a.ladenhueterDays.source, 'global');
    assert.equal(Number(a.ladenhueterDays.value), 45, 'acme sieht seine geänderte Schwelle');
    assert.equal(Number(g.ladenhueterDays.value), 250, 'globex unverändert (kein Cross-Tenant-Effekt)');
  });
});

test('#137 reset-Isolation: acme-Reset trifft nur acme; globex-Schwelle bleibt', async (t) => {
  await inSandbox(t, async (client) => {
    await seedAcmeGlobex(client);
    const db = doorForClient(client);
    await resetThreshold(db, 'acme', null, 'ladenhueterDays');
    const a = await getThresholds(db, 'acme', null);
    const g = await getThresholds(db, 'globex', null);
    assert.equal(a.ladenhueterDays.source, 'default', 'acme-Override entfernt ⇒ Default');
    assert.equal(Number(g.ladenhueterDays.value), 250, 'globex-Schwelle unberührt');
  });
});

test('#137 Side-Effects-Isolation (Pflichtfall 4): acme-Maschinen-Schwelle erzeugt KEINE globex-Effekte', async (t) => {
  await inSandbox(t, async (client) => {
    const { acme } = await seedAcmeGlobex(client);
    const db = doorForClient(client);
    const globexCounts = async () => (await client.query(`SELECT
        (SELECT count(*)::int FROM automatenlager.settings_thresholds WHERE tenant_id='globex') AS thr,
        (SELECT count(*)::int FROM automatenlager.warnings           WHERE tenant_id='globex') AS warn`)).rows[0];

    const before = await globexCounts();
    await setThreshold(db, 'acme', acme.machineId, 'ladenhueterDays', 30); // acme-Maschinen-Override
    const after = await globexCounts();

    assert.deepEqual(after, before, 'keine globex-Schwellen/-Warnungen durch die acme-Schreibung');
    const a = await getThresholds(db, 'acme', acme.machineId);
    assert.equal(a.ladenhueterDays.source, 'machine', 'acme sieht seine Maschinen-Schwelle');
    assert.equal(Number(a.ladenhueterDays.value), 30);
  });
});
