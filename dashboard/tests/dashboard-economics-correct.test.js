'use strict';

/**
 * G&V VK/EK pro Stück anzeigen + editierbar (#193).
 * (1) reine Ableitung perUnit + validateCorrection;
 * (2) Live EK/VK-Korrektur durch die Tür (acme/globex-Isolation, go-forward).
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const eco = require('../lib/economics.js');
const ec = require('../lib/economics-correct.js');
const { inSandbox, applyMigration } = require('./helpers/migration-sandbox.js');
const { createTenantDb } = require('../lib/tenant-db.js');
const { seedAcmeGlobex, sandboxTxPool } = require('./helpers/tenant-fixtures.js');

// ── Ebene 1: perUnit-Ableitung ───────────────────────────────────────────────
test('#193 perUnit: Betrag/Menge gerundet; Menge 0 ⇒ null', () => {
  assert.equal(eco.perUnit(21.6, 12), 1.8);
  assert.equal(eco.perUnit(5, 0), null);
  assert.equal(eco.perUnit(5, null), null);
});

test('#193 parseProductRow: liefert vk_per_unit (brutto/qty) + ek_per_unit (cost_of_goods/qty)', () => {
  // revenue_net 100, db_net 40 ⇒ cost_of_goods 60; revenue_gross 119; qty 10
  const r = eco.parseProductRow({ product_id: 1, product_name: 'X', revenue_net: 100, db_net: 40, revenue_gross: 119, gross_profit: 59, qty: 10 });
  assert.equal(r.vk_per_unit, 11.9, 'VK brutto/Stück');
  assert.equal(r.ek_per_unit, 6, 'EK netto/Stück = (100-40)/10');
});

// ── Ebene 1: validateCorrection ──────────────────────────────────────────────
test('#193 validateCorrection: gültig vs. fehlerhaft', () => {
  assert.equal(ec.validateCorrection({ field: 'ek', value: 0.71, productId: 5 }).ok, true);
  assert.equal(ec.validateCorrection({ field: 'vk', value: 2.0, productId: 5 }).ok, true);
  assert.equal(ec.validateCorrection({ field: 'xx', value: 1, productId: 5 }).ok, false);
  assert.equal(ec.validateCorrection({ field: 'ek', value: 0, productId: 5 }).ok, false);
  assert.equal(ec.validateCorrection({ field: 'ek', value: 1, productId: 0 }).ok, false);
});

// ── Ebene 2: Live EK-Korrektur durch die Tür ─────────────────────────────────
test('#193 applyEkCorrection LIVE: aktive Charge des Produkts korrigiert; globex unberührt', async (t) => {
  await inSandbox(t, async (client) => {
    const { acme, globex } = await seedAcmeGlobex(client);
    for (const n of [22, 23, 24, 25, 26, 27, 28, 29, 30, 31]) await applyMigration(client, n);
    const db = createTenantDb({ pool: sandboxTxPool(client) });

    const res = await ec.applyEkCorrection(db, 'acme', { productId: acme.productId, unitCostNet: 0.71 });
    assert.equal(res.batchesUpdated, 1, 'eine aktive Charge korrigiert');

    const a = await db.read({ tenant: 'acme', tables: ['stock_batches'], text: `SELECT unit_cost_net FROM automatenlager.stock_batches WHERE tenant_id=$1 AND batch_key='b_acme'` });
    assert.equal(Number(a.rows[0].unit_cost_net), 0.71);

    // ISOLATION: globex-Charge unverändert (Fixture-EK)
    const g = await db.read({ tenant: 'globex', tables: ['stock_batches'], text: `SELECT unit_cost_net FROM automatenlager.stock_batches WHERE tenant_id=$1 AND batch_key='b_globex'` });
    assert.notEqual(Number(g.rows[0].unit_cost_net), 0.71, 'globex unberührt');
  });
});

// ── Ebene 2: Live VK-Korrektur durch die Tür ─────────────────────────────────
test('#193 applyVkCorrection LIVE: aktive Preiszeile der aktiven Slots korrigiert; globex unberührt', async (t) => {
  await inSandbox(t, async (client) => {
    const { acme, globex } = await seedAcmeGlobex(client);
    for (const n of [22, 23, 24, 25, 26, 27, 28, 29, 30, 31]) await applyMigration(client, n);
    // aktive Preiszeile je Mandant auf dem Seed-Slot anlegen
    for (const ten of [acme, globex]) {
      await client.query(
        `INSERT INTO automatenlager.prices (slot_assignment_id, sale_price_gross, valid_from, source, tenant_id)
         SELECT slot_assignment_id, 1.50, '2026-01-01', 'test', $1
           FROM automatenlager.slot_assignments WHERE tenant_id=$1 AND product_slot_key=$2`,
        [ten.tenantId, ten.slotKey],
      );
    }
    const db = createTenantDb({ pool: sandboxTxPool(client) });

    const res = await ec.applyVkCorrection(db, 'acme', { productId: acme.productId, salePriceGross: 2.20 });
    assert.equal(res.pricesUpdated, 1, 'eine aktive Preiszeile korrigiert');

    const a = await db.read({ tenant: 'acme', tables: ['prices'], text: `SELECT sale_price_gross FROM automatenlager.prices WHERE tenant_id=$1 AND valid_to IS NULL` });
    assert.equal(Number(a.rows[0].sale_price_gross), 2.20);

    const g = await db.read({ tenant: 'globex', tables: ['prices'], text: `SELECT sale_price_gross FROM automatenlager.prices WHERE tenant_id=$1 AND valid_to IS NULL` });
    assert.equal(Number(g.rows[0].sale_price_gross), 1.50, 'globex unverändert');
  });
});
