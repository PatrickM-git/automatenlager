'use strict';

/**
 * GuV-Tagesposten-Aggregator-Job (Issue #161, Stufe 6 Slice 1) + Kostenbasis-
 * Korrektur (Issue #176). Ersatz für WF8.
 * SPEC: docs/specs/guv-kostenbasis-kleinunternehmer-restatement-v1.md
 *
 * Ebenen:
 *  (1) REINE Aggregation: computeGuvRows aggregiert je Tag/Automat/Produkt und
 *      stempelt cost_basis. #176: Kleinunternehmer (camelCase kanonisch) ⇒ Brutto-
 *      Kostenbasis aus dem Kategorie-MwSt-Satz + revenue_net = revenue_gross.
 *  (2) Konsistenz-Anker Live == Nacht (ersetzt das alte Schatten-Paritäts-Gate).
 *  (3) Factory/Verkabelung (createGuvAggregateJob über den tenant-runner).
 *  (4) LIVE im #94-Sandbox als automatenlager_app (RLS aktiv): acme/globex-Isolation
 *      + Idempotenz (nicht-vakuös) sowie ein KU-Mandant, der brutto bucht.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const guv = require('../lib/jobs/guv-aggregate.js');
const { inSandbox, applyMigration } = require('./helpers/migration-sandbox.js');
const { createTenantDb } = require('../lib/tenant-db.js');
const { seedAcmeGlobex, sandboxTxPool } = require('./helpers/tenant-fixtures.js');
const { costBasisMultiplier } = require('../lib/guv-ek.js');
const { buildEffectiveConfig, sanitizeOverride, resolveCategory } = require('../lib/category-config.js');

// Live-Pfad-Replik (economics.js Z.874-876): Wareneinsatz = round2(Netto-FIFO ×
// Kategorie-MwSt-Faktor). EXAKT dieselbe Ableitung wie der Nacht-Job — der Anker
// unten beweist Deckungsgleichheit auf identischem Input.
function liveCost(eff, kleinunternehmer, category, fifoNetCost) {
  const catMwst = resolveCategory(eff, category).mwstPct;
  const mult = costBasisMultiplier(catMwst, { kleinunternehmer });
  return Math.round(fifoNetCost * mult * 100) / 100;
}

// ── (1) Reine Aggregations-Parität (kein PG) ─────────────────────────────────

test('#176 parseConfig: liest camelCase kanonisch (WF8-snake-only-Bug behoben)', () => {
  // Der reale __default__-Wert ist camelCase {kleinunternehmerAktiv:true}; der
  // Nacht-Job sieht ihn ab #176 (gemeinsame Lesefunktion), bucht also nicht mehr
  // fälschlich netto.
  const c1 = guv.parseConfig({ kleinunternehmerAktiv: true });
  assert.equal(c1.kleinunternehmerAktiv, true, 'camelCase-true wird jetzt gesehen');
  assert.equal(c1.mwstSnack, 7);
  assert.equal(c1.mwstGetraenk, 19);
  // snake_case bleibt als Legacy-Fallback erhalten:
  assert.equal(guv.parseConfig({ kleinunternehmer_aktiv: 'TRUE' }).kleinunternehmerAktiv, true);
  // beide vorhanden ⇒ camelCase gewinnt:
  assert.equal(guv.parseConfig({ kleinunternehmerAktiv: false, kleinunternehmer_aktiv: true }).kleinunternehmerAktiv, false);
  assert.equal(guv.parseConfig({}).kleinunternehmerAktiv, false, 'leere Konfig ⇒ regelbesteuert (Default)');
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
  assert.equal(r.cost_basis, 'netto', 'regelbesteuert ⇒ cost_basis netto');
  assert.equal(r.source, 'wf8_guv_aggregator');
});

test('#161 compute: getraenk ⇒ revenue_net @19%', () => {
  const { rows } = guv.computeGuvRows({
    transactions: [baseTx({ umsatz_brutto: 11.9, quantity: 1, batch_id_abgebucht: '' })],
    batches: [], products: [{ product_key: 'P1', produktart: 'getraenk', sale_price_eur: '' }], config: {}, existingKeys: [],
  });
  assert.equal(rows[0].revenue_net, 10, 'round(11.9/1.19*100)/100 = 10.00');
});

test('#176 compute: Kleinunternehmer (camelCase) ⇒ Brutto-Kostenbasis, revenue_net = revenue_gross, cost_basis brutto', () => {
  const reg = guv.computeGuvRows({ transactions: [baseTx()], batches: batchesB1, products: productsP1, config: {}, existingKeys: [] }).rows[0];
  // camelCase (der reale __default__-Schlüssel) wird jetzt gesehen:
  const klein = guv.computeGuvRows({ transactions: [baseTx()], batches: batchesB1, products: productsP1, config: { kleinunternehmerAktiv: true }, existingKeys: [] }).rows[0];
  assert.equal(klein.revenue_net, klein.revenue_gross, 'Kleinunternehmer ⇒ vatRate 0 ⇒ revenue_net == gross');
  assert.ok(klein.cost_of_goods > reg.cost_of_goods, 'Brutto-Kostenbasis > Netto-Kostenbasis');
  // Snack 7 %: qty2 × ekNetto2.5 × 1,07 = 5.35
  assert.equal(klein.cost_of_goods, 5.35, 'KU+Snack: 2 × 2,5 × 1,07');
  assert.equal(klein.cost_basis, 'brutto', 'KU mit gültiger MwSt ⇒ cost_basis brutto');
  assert.equal(reg.cost_basis, 'netto', 'Regelbesteuerung ⇒ cost_basis netto');
});

test('#176 compute: KU+Getränk nutzt Kategorie-MwSt 19 % (nicht Charge/Produkt-VAT)', () => {
  // batch trägt mwst_satz 7, Produkt ist aber Getränk ⇒ Kategorie-Satz 19 % gewinnt.
  const klein = guv.computeGuvRows({
    transactions: [baseTx({ batch_id_abgebucht: 'B1' })],
    batches: [{ batch_id: 'B1', unit_cost: '2.5', mwst_satz: '7' }],
    products: [{ product_key: 'P1', produktart: 'getraenk', sale_price_eur: '5' }],
    config: { kleinunternehmerAktiv: true }, existingKeys: [],
  }).rows[0];
  assert.equal(klein.cost_of_goods, 5.95, 'KU+Getränk: 2 × 2,5 × 1,19 (Kategorie-MwSt 19 %)');
  assert.equal(klein.cost_basis, 'brutto');
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

// ── Konsistenz-Anker Live == Nacht (ersetzt das alte Schatten-Paritäts-Gate) ──

test('#176 Anker Live == Nacht: identischer Input ⇒ identische Kostenbasis (brutto==brutto, netto==netto)', () => {
  const eff = buildEffectiveConfig(sanitizeOverride({}));
  // qty 2 × ekNetto 2,5 = 5,0 Netto-FIFO je Produkt.
  for (const kleinunternehmer of [true, false]) {
    for (const category of ['snack', 'getraenk', 'gibtsnicht']) {
      const nacht = guv.computeGuvRows({
        transactions: [baseTx({ batch_id_abgebucht: 'B1' })],
        batches: [{ batch_id: 'B1', unit_cost: '2.5', mwst_satz: '7' }],
        products: [{ product_key: 'P1', produktart: category, sale_price_eur: '5' }],
        config: { kleinunternehmerAktiv: kleinunternehmer }, existingKeys: [],
      }).rows[0];
      const live = liveCost(eff, kleinunternehmer, category, 2 * 2.5);
      assert.equal(nacht.cost_of_goods, live,
        `Live==Nacht für KU=${kleinunternehmer}, Kategorie=${category}`);
      assert.equal(nacht.cost_basis, kleinunternehmer ? 'brutto' : 'netto');
    }
  }
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

    // #176: Config DETERMINISTISCH regelbesteuert setzen (sonst hinge der Test am
    // realen __default__-Wert, den der Job ab #176 wirklich liest).
    await client.query(
      `INSERT INTO automatenlager.classification_settings (tenant_id, config, updated_at)
         VALUES ('__default__', $1::jsonb, now())
       ON CONFLICT (tenant_id) DO UPDATE SET config = EXCLUDED.config, updated_at = now()`,
      [JSON.stringify({ kleinunternehmerAktiv: false })]);

    for (const n of [22, 23, 24, 25, 26, 28, 32]) await applyMigration(client, n); // RLS + cost_basis + mandant_id→tenant_id
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
        text: `SELECT guv_key, cost_of_goods, cost_basis FROM automatenlager.guv_daily WHERE tenant_id = $1 AND source = 'wf8_guv_aggregator'`,
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
      // #176: regelbesteuert ⇒ netto-Basis gestempelt.
      assert.equal(acmeKeys.find((r) => r.guv_key === '2026-06-05|vm_acme|p_acme').cost_basis, 'netto', 'regelbesteuert ⇒ cost_basis netto');

      // Idempotenz (#228): erneuter acme-Lauf fügt NICHTS Neues ein, sondern
      // aktualisiert die bestehende Tageszeile auf denselben Wert (Upsert).
      const acmeRerun = await guv.runGuvAggregateForTenant(db, 'acme');
      assert.equal(acmeRerun.inserted, 0, 'zweiter Lauf fügt nichts Neues ein');
      assert.equal(acmeRerun.updated, 1, 'zweiter Lauf aktualisiert die bestehende Zeile idempotent');
      assert.equal((await keysFor('acme')).length, acmeKeys.length, 'guv_daily-Zeilenzahl unverändert');
    } finally {
      await client.query('RESET ROLE');
    }
  });
});

test('#176 GuV LIVE: Kleinunternehmer-Mandant bucht BRUTTO (cost_basis brutto, revenue_net=gross)', async (t) => {
  await inSandbox(t, async (client) => {
    const { acme } = await seedAcmeGlobex(client); // Produkt 'snack', unit_cost_net 5
    await client.query(
      `INSERT INTO automatenlager.sales_transactions
         (nayax_transaction_id, machine_id, product_id, product_name_raw, quantity,
          gross_amount, net_amount, vat_amount, settlement_at, processing_status, tenant_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'OK',$10)`,
      ['fresh_ku_acme', acme.machineId, acme.productId, acme.productName, 2, 20, 20, 0, '2026-06-07T10:00:00Z', 'acme']);

    // Kleinunternehmer-Konfig (camelCase, wie der reale __default__-Wert).
    await client.query(
      `INSERT INTO automatenlager.classification_settings (tenant_id, config, updated_at)
         VALUES ('__default__', $1::jsonb, now())
       ON CONFLICT (tenant_id) DO UPDATE SET config = EXCLUDED.config, updated_at = now()`,
      [JSON.stringify({ kleinunternehmerAktiv: true })]);

    for (const n of [22, 23, 24, 25, 26, 28]) await applyMigration(client, n);
    await client.query('SET ROLE automatenlager_app');
    try {
      const db = createTenantDb({ pool: sandboxTxPool(client) });
      const run = await guv.runGuvAggregateForTenant(db, 'acme');
      assert.equal(run.inserted, 1, 'KU-Mandant bucht seinen frischen Tagesposten');

      const row = (await db.read({
        tenant: 'acme', tables: ['guv_daily'],
        text: `SELECT revenue_gross, revenue_net, cost_of_goods, cost_basis
                 FROM automatenlager.guv_daily
                WHERE tenant_id = $1 AND guv_key = '2026-06-07|vm_acme|p_acme'`,
      })).rows[0];
      assert.ok(row, 'Tagesposten vorhanden');
      assert.equal(row.cost_basis, 'brutto', 'KU ⇒ cost_basis brutto');
      assert.equal(Number(row.cost_of_goods), 10.7, 'KU+Snack: 2 × 5 × 1,07 (Brutto-Kostenbasis)');
      assert.equal(Number(row.revenue_net), Number(row.revenue_gross), 'KU ⇒ revenue_net = revenue_gross');
    } finally {
      await client.query('RESET ROLE');
    }
  });
});

test('B1-fix LIVE: leere Charge (remaining_qty=0) wird ignoriert — neuere Charge mit Bestand liefert den EK', async (t) => {
  await inSandbox(t, async (client) => {
    const { acme } = await seedAcmeGlobex(client);
    // Alte, bereits leere Charge (received früher, unit_cost absichtlich viel höher → sichtbarer Unterschied).
    await client.query(
      `INSERT INTO automatenlager.stock_batches
         (batch_key, product_id, initial_qty, remaining_qty, unit_cost_net, status, received_at, tenant_id)
       VALUES ('b_acme_old_depleted', $1, 30, 0, 9.00, 'aktiv', '2026-04-01', 'acme')`,
      [acme.productId]);
    // Die bestehende Charge aus seedAcmeGlobex (unit_cost=5, remaining=30, received '2026-05-01') bleibt.
    await client.query(
      `INSERT INTO automatenlager.sales_transactions
         (nayax_transaction_id, machine_id, product_id, product_name_raw, quantity,
          gross_amount, net_amount, vat_amount, settlement_at, processing_status, tenant_id)
       VALUES ('tx_b1fix', $1, $2, $3, 2, 20, 20, 0, '2026-06-05T10:00:00Z', 'OK', 'acme')`,
      [acme.machineId, acme.productId, acme.productName]);
    await client.query(
      `INSERT INTO automatenlager.classification_settings (tenant_id, config, updated_at)
         VALUES ('__default__', $1::jsonb, now())
       ON CONFLICT (tenant_id) DO UPDATE SET config = EXCLUDED.config, updated_at = now()`,
      [JSON.stringify({ kleinunternehmerAktiv: false })]);

    for (const n of [22, 23, 24, 25, 26, 28, 32]) await applyMigration(client, n);
    await client.query('SET ROLE automatenlager_app');
    try {
      const db = createTenantDb({ pool: sandboxTxPool(client) });
      const run = await guv.runGuvAggregateForTenant(db, 'acme');
      assert.equal(run.inserted, 1, 'ein Tagesposten eingefügt');
      const rows = (await db.read({
        tenant: 'acme', tables: ['guv_daily'],
        text: `SELECT cost_of_goods FROM automatenlager.guv_daily WHERE tenant_id = $1 AND guv_key LIKE '2026-06-05|%'`,
      })).rows;
      assert.equal(rows.length, 1, 'genau ein Tagesposten');
      // Neue nicht-leere Charge (unit_cost=5): qty2 × 5 = 10.
      // Ohne Fix würde die alte leere Charge (unit_cost=9) ausgewählt → cost=18.
      assert.equal(Number(rows[0].cost_of_goods), 10, 'Wareneinsatz aus der nicht-leeren Charge (5€), NICHT der leeren (9€)');
    } finally {
      await client.query('RESET ROLE');
    }
  });
});

// ── (4) Regression #228: spätere Mehrfachverkäufe NICHT mehr einfrieren ───────

test('GuV LIVE #228: 2. Verkauf desselben Produkts/Tags in spaeterem Lauf wird aufaddiert (kein Einfrieren)', async (t) => {
  await inSandbox(t, async (client) => {
    const { acme } = await seedAcmeGlobex(client);
    const sale = (txid, when) => client.query(
      `INSERT INTO automatenlager.sales_transactions
         (nayax_transaction_id, machine_id, product_id, product_name_raw, quantity,
          gross_amount, net_amount, vat_amount, settlement_at, processing_status, tenant_id)
       VALUES ($1,$2,$3,$4,1,2.00,2.00,0,$5,'OK','acme')`,
      [txid, acme.machineId, acme.productId, acme.productName, when]);
    await sale('frz_1', '2026-06-10T08:00:00Z');            // erster Verkauf des Tages
    await client.query(
      `INSERT INTO automatenlager.classification_settings (tenant_id, config, updated_at)
         VALUES ('__default__', $1::jsonb, now())
       ON CONFLICT (tenant_id) DO UPDATE SET config = EXCLUDED.config, updated_at = now()`,
      [JSON.stringify({ kleinunternehmerAktiv: false })]);
    for (const n of [22, 23, 24, 25, 26, 28, 32]) await applyMigration(client, n);

    const tagesposten = async (db) => (await db.read({
      tenant: 'acme', tables: ['guv_daily'],
      text: `SELECT quantity_sold, revenue_gross FROM automatenlager.guv_daily
             WHERE tenant_id = $1 AND guv_key = '2026-06-10|vm_acme|p_acme'`,
    })).rows[0];

    await client.query('SET ROLE automatenlager_app');
    try {
      const db = createTenantDb({ pool: sandboxTxPool(client) });

      // Lauf 1: nur der erste Verkauf liegt vor → 1 Stück gebucht.
      const run1 = await guv.runGuvAggregateForTenant(db, 'acme');
      assert.equal(run1.inserted, 1, 'Lauf 1 bucht den Tagesposten');
      assert.equal(Number((await tagesposten(db)).quantity_sold), 1, 'nach Lauf 1: 1 Stueck');

      // Ein ZWEITER Verkauf desselben Produkts am selben Tag trifft SPAETER ein.
      await client.query('RESET ROLE');
      await sale('frz_2', '2026-06-10T15:00:00Z');
      await client.query('SET ROLE automatenlager_app');

      // Lauf 2: muss jetzt BEIDE Verkäufe zeigen (Bug heute: friert bei 1 ein).
      await guv.runGuvAggregateForTenant(db, 'acme');
      const row = await tagesposten(db);
      assert.equal(Number(row.quantity_sold), 2, 'nach Lauf 2: beide Verkaeufe gebucht (kein Einfrieren)');
      assert.equal(Number(row.revenue_gross), 4, 'Umsatz brutto = 2 x 2,00 EUR');
      assert.equal((await db.read({
        tenant: 'acme', tables: ['guv_daily'],
        text: `SELECT count(*)::int AS n FROM automatenlager.guv_daily
               WHERE tenant_id = $1 AND guv_key = '2026-06-10|vm_acme|p_acme'`,
      })).rows[0].n, 1, 'weiterhin genau EINE Tageszeile (kein Duplikat)');
    } finally {
      await client.query('RESET ROLE');
    }
  });
});
