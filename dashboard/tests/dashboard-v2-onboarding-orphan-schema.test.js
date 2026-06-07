'use strict';

/**
 * Regression: Die Orphan-/unknown_products-Abfrage muss dem REALEN
 * automatenlager-Schema entsprechen.
 *
 * Bug-Historie: queryProductOnboardingPg (lib/product-onboarding.js) selektierte
 * `st.product_key` aus automatenlager.sales_transactions — eine Spalte, die es
 * dort NICHT gibt. Die Query scheiterte still (`.catch(() => ({ rows: [] }))`),
 * sodass `/api/v2/onboarding` -> unknown_products IMMER leer blieb.
 *
 * Reales Schema (gegen Produktions-DB verifiziert): sales_transactions führt den
 * Roh-Produktnamen in `product_name_raw`; eine Spalte `product_key` existiert
 * nicht. Die korrigierte Query gruppiert über product_name_raw und liefert ihn
 * als `product_key` (SQL-Alias), damit Onboarding-Aufbereitung und Frontend
 * (u.product_key) unverändert weiterlaufen.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { buildUnknownProducts, buildProductOnboardingData } = require('../lib/product-onboarding.js');
const { parseRelationColumnRefs } = require('../lib/db-schema.js');

const ONBOARDING_SRC = fs.readFileSync(path.join(__dirname, '../lib/product-onboarding.js'), 'utf8');

// ── Quelltext-Regression: korrekte Spalte, keine Phantom-Spalte ───────────────

test('Orphan-Query selektiert product_name_raw und aliasiert es als product_key', () => {
  assert.match(ONBOARDING_SRC, /st\.product_name_raw\s+AS\s+product_key/i,
    'Die Orphan-Query muss product_name_raw AS product_key selektieren');
  assert.match(ONBOARDING_SRC, /GROUP BY\s+st\.product_name_raw/i,
    'GROUP BY muss auf product_name_raw laufen');
});

test('Orphan-Query filtert auf product_name_raw statt der Phantom-Spalte product_key', () => {
  // #128: seit dem Mandanten-Filter steht `st.tenant_id = $1 AND` vor dem Orphan-Filter.
  assert.match(ONBOARDING_SRC, /st\.product_id\s+IS\s+NULL/i);
  assert.match(ONBOARDING_SRC, /st\.product_name_raw\s+IS\s+NOT\s+NULL/i);
  assert.match(ONBOARDING_SRC, /st\.product_name_raw\s*<>\s*''/i);
});

test('Schema-Contract: sales_transactions.product_key wird NICHT mehr referenziert', () => {
  // Nutzt den projekteigenen SQL-Scanner (lib/db-schema.js): er bindet den Alias
  // `st` an automatenlager.sales_transactions und leitet die genutzten Spalten ab.
  const refs = parseRelationColumnRefs(ONBOARDING_SRC);
  assert.ok(refs.has('sales_transactions.product_name_raw'),
    'product_name_raw muss als genutzte Spalte erkannt werden');
  assert.ok(!refs.has('sales_transactions.product_key'),
    'product_key existiert in sales_transactions NICHT — darf nicht referenziert werden');
});

test('Orphan-Query schluckt Schema-Fehler nicht mehr still', () => {
  assert.doesNotMatch(ONBOARDING_SRC, /\.catch\(\s*\(\)\s*=>\s*\(\{\s*rows:\s*\[\]\s*\}\)\s*\)/,
    'Kein stilles .catch(() => ({ rows: [] })) auf der Orphan-Query');
});

// ── Verhalten: Orphan-Zeile (Live-Form) fließt in unknown_products ────────────

test('buildUnknownProducts: Orphan aus product_name_raw (z. B. "Unbekannt") wird aufbereitet', () => {
  // Zeilenform entspricht exakt der Live-Query-Ausgabe: product_name_raw AS product_key.
  const rows = [
    { product_key: 'Unbekannt', tx_count: 5 },
    { product_key: 'HARIBO GOLDB', tx_count: 12 },
  ];
  const result = buildUnknownProducts(rows);
  assert.equal(result.length, 2);
  assert.equal(result[0].product_key, 'HARIBO GOLDB'); // nach tx_count absteigend sortiert
  assert.equal(result[1].product_key, 'Unbekannt');
});

test('buildProductOnboardingData: product_name_raw-Orphan landet in unknown_products', () => {
  const orphanRows = [{ product_key: 'Unbekannt', tx_count: 5 }];
  const result = buildProductOnboardingData({ productRows: [], invoiceRows: [], orphanRows, totalInvoices: 0 });
  assert.equal(result.unknown_products.length, 1);
  assert.equal(result.unknown_products[0].product_key, 'Unbekannt');
  assert.equal(result.unknown_products[0].tx_count, 5);
});
