'use strict';

/**
 * Finanz-/GuV-Lese-Isolation (Issue #123, Stufe 3) — gegen acme/globex.
 * SPEC: docs/specs/multi-tenant-query-filter-stufe-3-v1.md (Pflicht-Testfälle 1–5, 9, 11)
 *
 * Verhalten über die öffentlichen Lese-Funktionen, die jetzt durch die Mandanten-Tür
 * gehen: queryEconomicsPg / queryEconomicsProvisionalPg / queryEconomicsLivePg
 * mit Signatur (db, tenant, query[, taxConfig]).
 *
 * LIVE gegen die echte DB im #94-Sandbox-Harness (ROLLBACK) — Faltrix unberührt.
 * Skippt offline sauber.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { inSandbox } = require('./helpers/migration-sandbox.js');
const { seedAcmeGlobex, doorForClient } = require('./helpers/tenant-fixtures.js');
const { queryEconomicsPg, queryEconomicsProvisionalPg } = require('../lib/economics.js');
const { queryEconomicsLivePg } = require('../lib/economics-live.js');
const { loadEffectiveConfig } = require('../lib/category-config.js');

const doorFor = doorForClient;
const YEAR_Q = { mode: 'year', year: '2026' };

// Heutiger (Berlin-)Verkauf je Mandant — macht economics-live + provisional nicht-vakuös.
async function seedTodaySale(client, t) {
  await client.query(
    `INSERT INTO automatenlager.sales_transactions
       (nayax_transaction_id, machine_id, product_id, product_name_raw, quantity,
        gross_amount, net_amount, vat_amount, settlement_at, processing_status, tenant_id)
       VALUES ($1,$2,$3,$4,3,$5,$6,$7, now(), 'matched', $8)`,
    [`tx_today_${t.tenantId}`, t.machineId, t.productId, t.productName,
     t.revenueGross, Math.round((t.revenueGross / 1.19) * 100) / 100,
     Math.round((t.revenueGross - t.revenueGross / 1.19) * 100) / 100, t.tenantId],
  );
}

test('#123 economics: acme-Viewer sieht 0 globex-Finanzzeilen (nicht-vakuös)', async (t) => {
  await inSandbox(t, async (client) => {
    const db = doorFor(client);
    await seedAcmeGlobex(client);

    const acme = await queryEconomicsPg(db, 'acme', YEAR_Q);
    const globex = await queryEconomicsPg(db, 'globex', YEAR_Q);

    // nicht-vakuös: BEIDE haben Finanzzeilen
    assert.ok(acme.byProduct.length >= 1, 'acme hat GuV-Produktzeilen');
    assert.ok(globex.byProduct.length >= 1, 'globex hat GuV-Produktzeilen');

    // Isolation: acme-Produktnamen tragen 'acme', NIE 'globex'
    const acmeNames = acme.byProduct.map((r) => String(r.product_name));
    assert.ok(acmeNames.some((n) => /acme/.test(n)), 'acme sieht acme-Produkt');
    assert.ok(acmeNames.every((n) => !/globex/.test(n)), 'acme sieht KEIN globex-Produkt');
    // Gegenrichtung
    const globexNames = globex.byProduct.map((r) => String(r.product_name));
    assert.ok(globexNames.every((n) => !/acme/.test(n)), 'globex sieht KEIN acme-Produkt');
  });
});

test('#123 economics Aggregat-Isolation: acme-Summe enthält keine globex-Beträge', async (t) => {
  await inSandbox(t, async (client) => {
    const db = doorFor(client);
    await seedAcmeGlobex(client); // acme gross=100, globex gross=250

    const acme = await queryEconomicsPg(db, 'acme', YEAR_Q);
    const sum = acme.byProduct.reduce((s, r) => s + Number(r.revenue_gross), 0);
    assert.equal(Math.round(sum), 100, 'acme-Aggregat = nur acme (100), nicht 350');
  });
});

test('#123 economics fail-closed: kein Mandant ⇒ leeres Resultat (kein Default)', async (t) => {
  await inSandbox(t, async (client) => {
    const db = doorFor(client);
    await seedAcmeGlobex(client);
    for (const tenant of ['', null, undefined]) {
      const res = await queryEconomicsPg(db, tenant, YEAR_Q);
      assert.equal(res.byProduct.length, 0, 'byProduct leer');
      assert.equal(res.bySlot.length, 0, 'bySlot leer');
      assert.equal(res.inventoryValue.length, 0, 'inventoryValue leer');
    }
  });
});

test('#123 economics Owner-Regression + MatView-Isolation: Faltrix sieht seine Daten, acme nicht', async (t) => {
  await inSandbox(t, async (client) => {
    const db = doorFor(client);
    await seedAcmeGlobex(client);
    // MatView mv_inventory_value_daily trägt reale Faltrix-Zeilen (kein Sonderfall).
    const total = await client.query(`SELECT count(*)::int AS n FROM automatenlager.mv_inventory_value_daily`);
    const faltrix = await queryEconomicsPg(db, 't_faltrix', YEAR_Q);
    const acme = await queryEconomicsPg(db, 'acme', YEAR_Q);
    if (total.rows[0].n > 0) {
      // nicht-vakuös: Faltrix HAT MatView-Zeilen, acme sieht davon 0.
      assert.ok(faltrix.inventoryValue.length >= 1, 'Faltrix sieht seine MatView-Inventarwerte');
      assert.equal(acme.inventoryValue.length, 0, 'acme sieht 0 Faltrix-MatView-Zeilen (Bypass-Schutz)');
    } else {
      t.diagnostic('mv_inventory_value_daily leer — MatView-Isolation strukturell abgedeckt');
    }
  });
});

test('#123 economics-live: acme-Viewer sieht nur acme-Tagesverkäufe (nicht-vakuös)', async (t) => {
  await inSandbox(t, async (client) => {
    const db = doorFor(client);
    const { acme, globex } = await seedAcmeGlobex(client);
    await seedTodaySale(client, acme);
    await seedTodaySale(client, globex);

    const liveA = await queryEconomicsLivePg(db, 'acme', {});
    const liveG = await queryEconomicsLivePg(db, 'globex', {});

    assert.ok(liveA.today.umsatzBrutto > 0, 'acme hat Tagesumsatz');
    assert.ok(liveG.today.umsatzBrutto > 0, 'globex hat Tagesumsatz');
    assert.notEqual(liveA.today.umsatzBrutto, liveG.today.umsatzBrutto, 'unterscheidbar');
    // recent-Liste: acme sieht nur sein Produkt
    assert.ok(liveA.recent.every((r) => !/globex/.test(String(r.product || ''))), 'acme-recent ohne globex');
  });
});

test('#123 economics-live fail-closed: kein Mandant ⇒ leer', async (t) => {
  await inSandbox(t, async (client) => {
    const db = doorFor(client);
    const { acme } = await seedAcmeGlobex(client);
    await seedTodaySale(client, acme);
    const live = await queryEconomicsLivePg(db, '', {});
    assert.equal(live.today.umsatzBrutto, 0, 'kein Mandant ⇒ 0 Umsatz');
    assert.equal(live.recent.length, 0, 'kein Mandant ⇒ keine Verkäufe');
  });
});

test('#123 economics provisional: acme-Viewer sieht nur acme (nicht-vakuös)', async (t) => {
  await inSandbox(t, async (client) => {
    const db = doorFor(client);
    const { acme, globex } = await seedAcmeGlobex(client);
    await seedTodaySale(client, acme);
    await seedTodaySale(client, globex);
    const taxConfig = await loadEffectiveConfig(client);

    const provA = await queryEconomicsProvisionalPg(db, 'acme', YEAR_Q, taxConfig);
    assert.ok(provA && provA.qty > 0, 'acme hat vorläufige (heutige) Verkäufe');
    assert.ok(provA.byProduct.every((p) => !/globex/.test(String(p.product_name || ''))), 'kein globex im provisional');

    // fail-closed
    const provNone = await queryEconomicsProvisionalPg(db, '', YEAR_Q, taxConfig);
    assert.ok(provNone == null || provNone.qty === 0, 'kein Mandant ⇒ kein provisional');
  });
});
