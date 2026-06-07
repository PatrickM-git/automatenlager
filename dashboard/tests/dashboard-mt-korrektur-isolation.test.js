'use strict';

/**
 * Korrektur/Onboarding-Lese-Isolation (Issue #128, Stufe 3) — acme/globex.
 * SPEC: docs/specs/multi-tenant-query-filter-stufe-3-v1.md (Pflicht-Testfälle 1–3)
 *
 * queryCorrectionCasesPg / queryProductOnboardingPg durch die Tür (db, tenant).
 * Schreib-Aktionen (Korrektur-Bestätigung) = Stufe 4. LIVE im #94-Sandbox-Harness.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { inSandbox } = require('./helpers/migration-sandbox.js');
const { seedAcmeGlobex, doorForClient } = require('./helpers/tenant-fixtures.js');
const { queryCorrectionCasesPg } = require('../lib/correction-cases.js');
const { queryProductOnboardingPg } = require('../lib/product-onboarding.js');

// Unzugeordneter (unbekannter) Verkauf je Mandant — macht den Korrektur-Lesepfad
// (unknownTxGroups) nicht-vakuös.
async function seedUnknownSale(client, t) {
  await client.query(
    `INSERT INTO automatenlager.sales_transactions
       (nayax_transaction_id, machine_id, product_id, product_name_raw, quantity,
        gross_amount, net_amount, vat_amount, settlement_at, processing_status, tenant_id)
       VALUES ($1, $2, NULL, $3, 1, 1.50, 1.26, 0.24, '2026-05-20T09:00:00Z', 'unmatched', $4)`,
    [`tx_unknown_${t.tenantId}`, t.machineId, `Mystery ${t.tenantId}`, t.tenantId],
  );
}

test('#128 correction-cases: acme sieht nur acme-Korrekturfälle (nicht-vakuös)', async (t) => {
  await inSandbox(t, async (client) => {
    const db = doorForClient(client);
    const { acme, globex } = await seedAcmeGlobex(client);
    await seedUnknownSale(client, acme);
    await seedUnknownSale(client, globex);

    const a = await queryCorrectionCasesPg(db, 'acme');
    const g = await queryCorrectionCasesPg(db, 'globex');
    assert.ok(a.unknownTxGroups.length >= 1, 'acme hat unbekannte Verkäufe');
    assert.ok(g.unknownTxGroups.length >= 1, 'globex hat unbekannte Verkäufe (nicht-vakuös)');
    assert.ok(!/globex/.test(JSON.stringify(a)), 'acme sieht KEINE globex-Korrekturdaten');
    assert.ok(/acme/.test(JSON.stringify(a)), 'acme sieht acme-Korrekturdaten');
    assert.ok(!/acme/.test(JSON.stringify(g)), 'globex sieht KEINE acme-Korrekturdaten');
  });
});

test('#128 product-onboarding: acme sieht nur acme-Produkte (nicht-vakuös)', async (t) => {
  await inSandbox(t, async (client) => {
    const db = doorForClient(client);
    await seedAcmeGlobex(client);
    const a = await queryProductOnboardingPg(db, 'acme');
    const g = await queryProductOnboardingPg(db, 'globex');
    assert.ok(a.productRows.length >= 1 && g.productRows.length >= 1, 'beide haben Produkte');
    assert.ok(a.productRows.every((r) => !/globex/.test(String(r.name))), 'acme ohne globex-Produkte');
    assert.ok(a.productRows.some((r) => /acme/.test(String(r.name))), 'acme sieht acme-Produkt');
  });
});

test('#128 fail-closed: kein Mandant ⇒ leere Korrektur-/Onboarding-Daten', async (t) => {
  await inSandbox(t, async (client) => {
    const db = doorForClient(client);
    const { acme } = await seedAcmeGlobex(client);
    await seedUnknownSale(client, acme);
    for (const tenant of ['', null, undefined]) {
      const c = await queryCorrectionCasesPg(db, tenant);
      assert.equal(c.proposals.length, 0);
      assert.equal(c.unknownTxGroups.length, 0);
      assert.equal(c.correctionWarnings.length, 0);
      const o = await queryProductOnboardingPg(db, tenant);
      assert.equal(o.productRows.length, 0);
      assert.equal(o.invoiceRows.length, 0);
      assert.equal(o.orphanRows.length, 0);
    }
  });
});
