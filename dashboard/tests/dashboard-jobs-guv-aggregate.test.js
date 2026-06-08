'use strict';

/**
 * GuV-Tagesposten-Aggregator-Job (Issue #161, Stufe 6 Slice 1) — Ersatz für WF8.
 * SPEC: docs/specs/multi-tenant-n8n-abloesung-stufe-6-v1.md §"Pro-Workflow-Disposition"
 *
 * Drei Ebenen:
 *  (1) REINE Aggregations-Parität: computeGuvRows ist faithful zu WF8 ("Code - GuV
 *      aggregieren" + "Prepare PGW - guv_daily"). Inkl. der bewussten Faithfulness-
 *      Befunde (snake_case-Konfig ⇒ kleinunternehmer effektiv FALSE; Zwischen-Rundung).
 *  (2) Factory/Verkabelung (createGuvAggregateJob über den tenant-runner).
 *  (3) LIVE im #94-Sandbox als automatenlager_app (RLS aktiv): acme/globex-Isolation
 *      + Idempotenz, NICHT-VAKUÖS (jeder Mandant bucht aus SEINER eigenen Charge).
 *
 * Die byte-genaue Gleichheit mit WF8 auf ECHTEN Produktionsdaten beweist zusätzlich
 * der read-only Paritäts-Harness tools/shadow-guv-parity.js (Cutover-Gate, Task #5).
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const guv = require('../lib/jobs/guv-aggregate.js');
const { inSandbox, applyMigration } = require('./helpers/migration-sandbox.js');
const { createTenantDb } = require('../lib/tenant-db.js');
const { seedAcmeGlobex, sandboxTxPool } = require('./helpers/tenant-fixtures.js');

// ── (1) Reine Aggregations-Parität (kein PG) ─────────────────────────────────

test('#161 parseConfig: liest snake_case (FAITHFUL) — camelCase wird wie in WF8 ignoriert', () => {
  // Der reale __default__-Wert ist camelCase {kleinunternehmerAktiv:true}; WF8s SQL
  // liest cfg->>"kleinunternehmer_aktiv" ⇒ sieht IMMER den Default 'FALSE'.
  const c1 = guv.parseConfig({ kleinunternehmerAktiv: true });
  assert.equal(c1.kleinunternehmerAktiv, false, 'camelCase-true wird (faithful) NICHT gesehen');
  assert.equal(c1.mwstSnack, 7);
  assert.equal(c1.mwstGetraenk, 19);
  // snake_case wird gesehen:
  assert.equal(guv.parseConfig({ kleinunternehmer_aktiv: 'TRUE' }).kleinunternehmerAktiv, true);
  assert.equal(guv.parseConfig({ mwst_snack: '5', mwst_getraenk: '20' }).mwstSnack, 5);
  assert.equal(guv.parseConfig({}).mwstGetraenk, 19, 'leere Konfig ⇒ Defaults');
});

const baseTx = (over = {}) => ({
  settlement_datetime_gmt: '2026-06-01T10:00:00Z', machine_id: 'M1', product_key: 'P1',
  mdb_code_extracted: '5', mdb_code: '5', quantity: 2, umsatz_brutto: 10,
  vk_preis_brutto: '5', status: 'OK', batch_id_abgebucht: 'B1', ...over,
});
const batchesB1 = [{ batch_id: 'B1', unit_cost: '2.5', mwst_satz: '7' }];
const productsP1 = [{ product_key: 'P1', produktart: 'snack', sale_price_eur: '5' }];

test('#161 compute: Regelbesteuerung (snack) — Aggregat, Netto-Kosten, revenue_net @7%', () => {
  const { rows } = guv.computeGuvRows({
    transactions: [baseTx(), baseTx({ quantity: 1, umsatz_brutto: 5 })],
    batches: batchesB1, products: productsP1, config: {}, existingKeys: [],
  });
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.guv_key, '2026-06-01|M1|P1');
  assert.equal(r.posting_date, '2026-06-01');
  assert.equal(r.machine_key, 'M1');
  assert.equal(r.mdb_code, '5');
  assert.equal(r.product_key, 'P1');
  assert.equal(r.quantity_sold, 3, 'Σ qty');
  assert.equal(r.revenue_gross, 15, 'Σ umsatz_brutto');
  assert.equal(r.cost_of_goods, 7.5, 'kleinunternehmer FALSE ⇒ qty*ekNetto (2.5)');
  assert.equal(r.gross_profit, 7.5, 'r2(Σumsatz − Σwarenein)');
  assert.equal(r.revenue_net, 14.02, 'snack ⇒ vat 7%: round(15/1.07*100)/100');
  assert.equal(r.source, 'wf8_guv_aggregator');
});

test('#161 compute: getraenk ⇒ revenue_net @19%', () => {
  const { rows } = guv.computeGuvRows({
    transactions: [baseTx({ umsatz_brutto: 11.9, quantity: 1, batch_id_abgebucht: '' })],
    batches: [], products: [{ product_key: 'P1', produktart: 'getraenk', sale_price_eur: '' }], config: {}, existingKeys: [],
  });
  assert.equal(rows[0].revenue_net, 10, 'round(11.9/1.19*100)/100 = 10.00');
});

test('#161 compute: Kleinunternehmer (snake TRUE) ⇒ Brutto-Kostenbasis, revenue_net = revenue_gross', () => {
  const reg = guv.computeGuvRows({ transactions: [baseTx()], batches: batchesB1, products: productsP1, config: {}, existingKeys: [] }).rows[0];
  const klein = guv.computeGuvRows({ transactions: [baseTx()], batches: batchesB1, products: productsP1, config: { kleinunternehmer_aktiv: 'TRUE' }, existingKeys: [] }).rows[0];
  assert.equal(klein.revenue_net, klein.revenue_gross, 'Kleinunternehmer ⇒ vatRate 0 ⇒ revenue_net == gross');
  assert.ok(klein.cost_of_goods > reg.cost_of_goods, 'Brutto-Kostenbasis > Netto-Kostenbasis');
});

test('#161 compute: status≠OK übersprungen; sentinel-Datum 2001- übersprungen; kein-Preis übersprungen', () => {
  const out = guv.computeGuvRows({
    transactions: [
      baseTx({ status: 'matched' }),                                   // ≠OK
      baseTx({ settlement_datetime_gmt: '2001-01-01T00:00:00Z' }),     // Sentinel
      baseTx({ umsatz_brutto: 0, vk_preis_brutto: '', product_key: 'P_NO' }), // kein Preis
    ],
    batches: batchesB1, products: productsP1, config: {}, existingKeys: [],
  });
  assert.equal(out.rows.length, 0, 'alle drei übersprungen ⇒ keine Zeile');
  assert.equal(out.stats.skippedStatus, 1);
  assert.equal(out.stats.skippedInvalid, 1);
  assert.equal(out.stats.skippedNoPrice, 1);
});

test('#161 compute: mdb_code "" ⇒ null; EK aus erster Charge greift', () => {
  const { rows } = guv.computeGuvRows({
    transactions: [baseTx({ mdb_code_extracted: '', mdb_code: '' })],
    batches: batchesB1, products: productsP1, config: {}, existingKeys: [],
  });
  assert.equal(rows[0].mdb_code, null, 'leerer mdb_code ⇒ null (pgw_write castet ::INTEGER)');
  assert.equal(rows[0].cost_of_goods, 5, 'qty 2 * ekNetto 2.5');
});

test('#161 compute: skipExisting überspringt vorhandene Keys (Produktion) — nicht im Schatten', () => {
  const existingKeys = [{ date: '2026-06-01', machine_id: 'M1', product_key: 'P1' }];
  const prod = guv.computeGuvRows({ transactions: [baseTx()], batches: batchesB1, products: productsP1, config: {}, existingKeys, skipExisting: true });
  assert.equal(prod.rows.length, 0, 'vorhandener Key übersprungen');
  assert.equal(prod.stats.skippedExisting, 1);
  const shadow = guv.computeGuvRows({ transactions: [baseTx()], batches: batchesB1, products: productsP1, config: {}, existingKeys, skipExisting: false });
  assert.equal(shadow.rows.length, 1, 'Schattenpfad rechnet ALLE Keys (für den Vergleich)');
});

// ── (2) Factory / Verkabelung ────────────────────────────────────────────────

test('#161 createGuvAggregateJob: ohne tenantRunner ⇒ TypeError (fail-closed)', () => {
  assert.throws(() => guv.createGuvAggregateJob({}), /tenantRunner/);
});

test('#161 createGuvAggregateJob: aggregiert inserted über Mandanten (continueOnError)', async () => {
  const fakeRunner = {
    runForAll: async (jobFn, opts) => {
      assert.equal(opts.continueOnError, true, 'ein fehlschlagender Mandant stoppt die anderen nicht');
      return { tenants: ['acme', 'globex'], perTenant: { acme: { inserted: 2 }, globex: { inserted: 3 } }, errors: [] };
    },
  };
  const job = guv.createGuvAggregateJob({ tenantRunner: fakeRunner });
  assert.equal(job.key, 'wf-guv-aggregate');
  const res = await job.run();
  assert.equal(res.tenants, 2);
  assert.equal(res.inserted, 5, '2 + 3 inserted aufsummiert');
});

// ── (3) LIVE: acme/globex-Isolation als automatenlager_app (RLS aktiv) ───────────

test('#161 GuV LIVE: pro Mandant durch die Tür isoliert + idempotent (RLS aktiv, nicht-vakuös)', async (t) => {
  await inSandbox(t, async (client) => {
    const { acme, globex } = await seedAcmeGlobex(client); // machine/product/batch je Mandant
    // Frische, NICHT-übersprungene Verkäufe (processing_status 'OK' = der reale
    // Gut-Status; ≠OK würde WF8 überspringen), je Mandant ein eigenes Datum/Betrag,
    // aus der je-Mandant-Charge bewertet.
    const freshSale = async (tid, machineId, productId, productName, date, gross, qty) => client.query(
      `INSERT INTO automatenlager.sales_transactions
         (nayax_transaction_id, machine_id, product_id, product_name_raw, quantity,
          gross_amount, net_amount, vat_amount, settlement_at, processing_status, tenant_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'OK',$10)`,
      [`fresh_${tid}`, machineId, productId, productName, qty, gross, gross, 0, `${date}T10:00:00Z`, tid]);
    await freshSale('acme', acme.machineId, acme.productId, acme.productName, '2026-06-05', 20, 2);
    await freshSale('globex', globex.machineId, globex.productId, globex.productName, '2026-06-06', 45, 3);

    for (const n of [22, 23, 24, 25, 26]) await applyMigration(client, n); // RLS scharf
    await client.query('SET ROLE automatenlager_app');                     // eingeengte App-Rolle
    try {
      const db = createTenantDb({ pool: sandboxTxPool(client) });          // read + tx über SAVEPOINTs

      const acmeRun = await guv.runGuvAggregateForTenant(db, 'acme');
      const globexRun = await guv.runGuvAggregateForTenant(db, 'globex');
      assert.equal(acmeRun.inserted, 1, 'acme bucht genau seinen frischen Tagesposten');
      assert.equal(globexRun.inserted, 1, 'globex bucht genau seinen frischen Tagesposten');

      // Je Mandant durch die Tür gegenlesen: jeder sieht NUR seinen neuen Key.
      const keysFor = async (tid) => (await db.read({
        tenant: tid, tables: ['guv_daily'],
        text: `SELECT guv_key, cost_of_goods FROM automatenlager.guv_daily WHERE tenant_id = $1 AND source = 'wf8_guv_aggregator'`,
      })).rows;
      const acmeKeys = await keysFor('acme');
      const globexKeys = await keysFor('globex');
      const acmeKeySet = new Set(acmeKeys.map((r) => r.guv_key));
      const globexKeySet = new Set(globexKeys.map((r) => r.guv_key));

      assert.ok(acmeKeySet.has('2026-06-05|vm_acme|p_acme'), 'acme sieht seinen Tagesposten (nicht-vakuös)');
      assert.ok(globexKeySet.has('2026-06-06|vm_globex|p_globex'), 'globex sieht seinen Tagesposten (nicht-vakuös)');
      assert.ok(!acmeKeySet.has('2026-06-06|vm_globex|p_globex'), 'acme sieht KEINEN globex-Posten (Isolation)');
      assert.ok(!globexKeySet.has('2026-06-05|vm_acme|p_acme'), 'globex sieht KEINEN acme-Posten (Isolation)');

      // NICHT-VAKUÖS: jeder bucht aus SEINER eigenen Charge (acme unit_cost_net 5 → 2*5=10;
      // globex unit_cost_net 12.5 → 3*12.5=37.5) — beweist den tenant-scoped Chargen-Join.
      const acmeCost = Number(acmeKeys.find((r) => r.guv_key === '2026-06-05|vm_acme|p_acme').cost_of_goods);
      const globexCost = Number(globexKeys.find((r) => r.guv_key === '2026-06-06|vm_globex|p_globex').cost_of_goods);
      assert.equal(acmeCost, 10, 'acme-Kosten aus acme-Charge');
      assert.equal(globexCost, 37.5, 'globex-Kosten aus globex-Charge');

      // Idempotenz: erneuter acme-Lauf bucht 0 (existingKeys-Skip + ON CONFLICT).
      const acmeRerun = await guv.runGuvAggregateForTenant(db, 'acme');
      assert.equal(acmeRerun.inserted, 0, 'zweiter Lauf schreibt nichts (idempotent)');
      assert.equal((await keysFor('acme')).length, acmeKeys.length, 'guv_daily-Zeilenzahl unverändert');
    } finally {
      await client.query('RESET ROLE');
    }
  });
});
