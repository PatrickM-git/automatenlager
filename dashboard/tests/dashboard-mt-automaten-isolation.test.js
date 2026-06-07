'use strict';

/**
 * Automaten/Standorte/Nayax-Lese-Isolation (Issue #127, Stufe 3) — acme/globex.
 * SPEC: docs/specs/multi-tenant-query-filter-stufe-3-v1.md (Pflicht-Testfälle 1–3, 6)
 *
 * Lesepfade durch die Tür: queryMachineProfilesPg / queryLocationsPg / queryNayaxDevicesPg
 * (alle Signatur (db, tenant)). Schreibpfade bleiben Stufe 4. LIVE im #94-Sandbox-Harness.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { inSandbox } = require('./helpers/migration-sandbox.js');
const { seedAcmeGlobex, doorForClient } = require('./helpers/tenant-fixtures.js');
const { queryMachineProfilesPg } = require('../lib/machine-profiles.js');
const { queryLocationsPg } = require('../lib/location-profiles.js');
const { queryNayaxDevicesPg } = require('../lib/nayax-devices.js');

test('#127 machine-profiles / locations / nayax-devices: acme sieht nur acme (nicht-vakuös)', async (t) => {
  await inSandbox(t, async (client) => {
    const db = doorForClient(client);
    await seedAcmeGlobex(client);

    for (const [name, fn] of [
      ['machine-profiles', queryMachineProfilesPg],
      ['locations', queryLocationsPg],
      ['nayax-devices', queryNayaxDevicesPg],
    ]) {
      const a = await fn(db, 'acme');
      const g = await fn(db, 'globex');
      assert.ok(a.length >= 1, `${name}: acme nicht leer`);
      assert.ok(g.length >= 1, `${name}: globex nicht leer (nicht-vakuös)`);
      assert.ok(!/globex/.test(JSON.stringify(a)), `${name}: acme sieht KEINE globex-Daten`);
      assert.ok(/acme/.test(JSON.stringify(a)), `${name}: acme sieht acme-Daten`);
      assert.ok(!/acme/.test(JSON.stringify(g)), `${name}: globex sieht KEINE acme-Daten`);
    }
  });
});

test('#127 fail-closed: kein Mandant ⇒ alle Lesepfade leer', async (t) => {
  await inSandbox(t, async (client) => {
    const db = doorForClient(client);
    await seedAcmeGlobex(client);
    for (const fn of [queryMachineProfilesPg, queryLocationsPg, queryNayaxDevicesPg]) {
      for (const tenant of ['', null, undefined]) {
        const r = await fn(db, tenant);
        assert.equal(r.length, 0, 'kein Mandant ⇒ leer');
      }
    }
  });
});
