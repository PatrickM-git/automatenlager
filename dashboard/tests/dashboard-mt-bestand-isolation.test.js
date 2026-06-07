'use strict';

/**
 * Bestand/MHD/Lager-Lese-Isolation (Issue #126, Stufe 3) — acme/globex.
 * SPEC: docs/specs/multi-tenant-query-filter-stufe-3-v1.md (Pflicht-Testfälle 1–3)
 *
 * queryInventoryMhdPg(db, tenant, query) durch die Tür. LIVE im #94-Sandbox-Harness
 * (ROLLBACK). Skippt offline.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { inSandbox } = require('./helpers/migration-sandbox.js');
const { seedAcmeGlobex, doorForClient } = require('./helpers/tenant-fixtures.js');
const { queryInventoryMhdPg } = require('../lib/inventory-mhd.js');

test('#126 inventory-mhd: acme-Viewer sieht nur acme-Lagerbestand (allBatches, nicht-vakuös)', async (t) => {
  await inSandbox(t, async (client) => {
    const db = doorForClient(client);
    await seedAcmeGlobex(client); // beide haben eine aktive Charge (remaining_qty 30)

    const a = await queryInventoryMhdPg(db, 'acme', {});
    const g = await queryInventoryMhdPg(db, 'globex', {});

    assert.ok(a.allBatches.length >= 1, 'acme hat Lagerchargen');
    assert.ok(g.allBatches.length >= 1, 'globex hat Lagerchargen (nicht-vakuös)');
    const aNames = a.allBatches.map((r) => String(r.product_name));
    assert.ok(aNames.some((n) => /acme/.test(n)), 'acme sieht acme-Produkt');
    assert.ok(aNames.every((n) => !/globex/.test(n)), 'acme sieht KEIN globex-Produkt');
    assert.ok(g.allBatches.map((r) => String(r.product_name)).every((n) => !/acme/.test(n)), 'globex ohne acme');
  });
});

test('#126 inventory-mhd MHD-Risiko nicht-vakuös: acme sieht nur acme-MHD-Chargen', async (t) => {
  await inSandbox(t, async (client) => {
    const db = doorForClient(client);
    const { acme, globex } = await seedAcmeGlobex(client);
    // Je eine bald ablaufende Charge (MHD in 5 Tagen) — macht den MHD-Lesepfad nicht-vakuös.
    for (const t2 of [acme, globex]) {
      await client.query(
        `INSERT INTO automatenlager.stock_batches
           (batch_key, product_id, initial_qty, remaining_qty, unit_cost_net, status, received_at, mhd_date, tenant_id)
           VALUES ($1, $2, 10, 10, 1.0, 'active', '2026-05-01', CURRENT_DATE + INTERVAL '5 days', $3)`,
        [`b_mhd_${t2.tenantId}`, t2.productId, t2.tenantId],
      );
    }
    const a = await queryInventoryMhdPg(db, 'acme', {});
    assert.ok(a.mhdRisks.length >= 1, 'acme hat MHD-Risiko-Chargen');
    assert.ok(a.mhdRisks.map((r) => String(r.product_name)).every((n) => !/globex/.test(n)), 'acme-MHD ohne globex');
  });
});

test('#126 inventory-mhd fail-closed: kein Mandant ⇒ alle Lesepfade leer', async (t) => {
  await inSandbox(t, async (client) => {
    const db = doorForClient(client);
    await seedAcmeGlobex(client);
    for (const tenant of ['', null, undefined]) {
      const r = await queryInventoryMhdPg(db, tenant, {});
      assert.equal(r.allBatches.length, 0, 'kein Mandant ⇒ keine Chargen');
      assert.equal(r.mhdRisks.length, 0, 'kein Mandant ⇒ keine MHD-Risiken');
      assert.equal(r.lowStock.length, 0, 'kein Mandant ⇒ keine Low-Stock-Slots');
    }
  });
});
