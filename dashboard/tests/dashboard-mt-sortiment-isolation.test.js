'use strict';

/**
 * Sortiment-Lese-Isolation (Issue #125, Stufe 3) — acme/globex.
 * SPEC: docs/specs/multi-tenant-query-filter-stufe-3-v1.md (Pflicht-Testfälle 1–3)
 *
 * Öffentliche Lese-Funktionen durch die Tür:
 *   queryAssortmentSlotsPg(db, tenant, query)
 *   loadEffectiveConfig/readOverride/writeOverride(db|client, mandantId)   (category-config)
 *   getThresholds(db|client, tenantId, machineId)                          (settings-thresholds)
 *
 * LIVE im #94-Sandbox-Harness (ROLLBACK). Skippt offline.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { inSandbox } = require('./helpers/migration-sandbox.js');
const { seedAcmeGlobex, doorForClient } = require('./helpers/tenant-fixtures.js');
const { queryAssortmentSlotsPg } = require('../lib/assortment-slots.js');
const { loadEffectiveConfig, readOverride, writeOverride } = require('../lib/category-config.js');
const { getThresholds, setThreshold } = require('../lib/settings-thresholds.js');

test('#125 assortment: acme-Viewer sieht nur acme-Slots (nicht-vakuös)', async (t) => {
  await inSandbox(t, async (client) => {
    const db = doorForClient(client);
    await seedAcmeGlobex(client);

    const a = await queryAssortmentSlotsPg(db, 'acme', {});
    const g = await queryAssortmentSlotsPg(db, 'globex', {});

    assert.ok(a.slots.length >= 1, 'acme hat Slots');
    assert.ok(g.slots.length >= 1, 'globex hat Slots (nicht-vakuös)');
    const aNames = a.slots.map((s) => String(s.product_name));
    assert.ok(aNames.some((n) => /acme/.test(n)), 'acme sieht acme-Produkt');
    assert.ok(aNames.every((n) => !/globex/.test(n)), 'acme sieht KEIN globex-Produkt');
    assert.ok(g.slots.map((s) => String(s.product_name)).every((n) => !/acme/.test(n)), 'globex ohne acme');
  });
});

test('#125 assortment fail-closed: kein Mandant ⇒ keine Slots', async (t) => {
  await inSandbox(t, async (client) => {
    const db = doorForClient(client);
    await seedAcmeGlobex(client);
    const none = await queryAssortmentSlotsPg(db, '', {});
    assert.equal(none.slots.length, 0, 'kein Mandant ⇒ keine Slots');
    assert.equal(none.lagerOhneSlot.length, 0, 'kein Mandant ⇒ keine Lagerware');
  });
});

test('#125 category-config: Override-Isolation je Mandant (nicht-vakuös)', async (t) => {
  await inSandbox(t, async (client) => {
    const db = doorForClient(client);
    await seedAcmeGlobex(client);

    // acme bekommt einen eigenen Override (durch die Tür geschrieben).
    await writeOverride(db, 'acme', { graceDays: 99 });

    const acmeCfg = await loadEffectiveConfig(db, 'acme');
    const globexCfg = await loadEffectiveConfig(db, 'globex');
    assert.equal(acmeCfg.graceDays, 99, 'acme liest seinen Override');
    assert.notEqual(globexCfg.graceDays, 99, 'globex sieht acme-Override NICHT (Default)');

    // Roh-Override bestätigt die Isolation auf Zeilenebene.
    assert.deepEqual(await readOverride(db, 'globex'), {}, 'globex hat keinen Override');
  });
});

test('#125 category-config: Default-Pfad liefert __default__-Config, NIE fremden Override', async (t) => {
  await inSandbox(t, async (client) => {
    const db = doorForClient(client);
    await seedAcmeGlobex(client);
    await writeOverride(db, 'acme', { graceDays: 99 });
    // Leerer/fehlender Mandant ⇒ __default__-Config (Config ist KEIN Kundendatum;
    // globaler Default ist gewollt). Entscheidend: NIE acme's Override (99).
    const def = await loadEffectiveConfig(db, '');
    assert.notEqual(def.graceDays, 99, 'Default-Pfad zeigt NICHT acme-Override (kein Leak)');
  });
});

test('#125 settings-thresholds: getThresholds-Isolation je Mandant (nicht-vakuös)', async (t) => {
  await inSandbox(t, async (client) => {
    const db = doorForClient(client);
    await seedAcmeGlobex(client);

    // acme bekommt einen globalen Schwellwert-Override (Schreibpfad client-basiert, #127).
    await setThreshold(client, 'acme', null, 'ladenhueterDays', 45);

    const a = await getThresholds(db, 'acme', null);
    const g = await getThresholds(db, 'globex', null);
    assert.equal(a.ladenhueterDays.source, 'global', 'acme hat globalen Override');
    assert.equal(Number(a.ladenhueterDays.value), 45);
    // Seit #131 trägt jeder Fixture-Mandant einen eigenen ladenhueterDays-Override
    // (globex=250 via revenueBase). globex sieht damit seinen EIGENEN Wert — also
    // nachweislich NICHT acmes 45 (stärkere, nicht-vakuöse Isolation als „default").
    assert.equal(g.ladenhueterDays.source, 'global', 'globex hat eigenen Override');
    assert.equal(Number(g.ladenhueterDays.value), 250, 'globex sieht seinen Wert (250), NICHT acmes 45');
  });
});
