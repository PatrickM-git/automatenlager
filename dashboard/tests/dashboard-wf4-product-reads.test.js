'use strict';

// TDD für Issue #14: WF4 Google-Sheets-Reads -> PostgreSQL.
// Das Modul ersetzt die zwei Sheets-Reads von WF4 (Produkte + Produkt_Aliase)
// durch PG-Reads und liefert EXAKT das Sheet-Schema, damit der nachgelagerte
// WF4-Code (Produktkandidaten vorbereiten / Entscheidung auswerten /
// Änderungsart vorbereiten) unverändert bleibt. Google Sheets liefert alle
// Werte als Strings -> die Map-Funktionen normalisieren ebenso auf Strings.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  mapProductsRows,
  mapAliasesRows,
  buildProductsReadQuery,
  buildAliasesReadQuery,
} = require('../lib/wf4-product-reads.js');

// ── Read 1: "Produkte lesen" Ersatz ───────────────────────────────────────────

test('mapProductsRows: kritische Mappings (FK->Nayax-Nr, slot_key, Namen) wie im Sheet', () => {
  const rows = [{
    product_key: 'SKU_SNICKERS',
    name: 'SKU_SNICKERS',
    nayax_alias: 'Snickers',
    mdb_code: 11,
    machine_key: '457107528',          // Nayax-Nummer, NICHT der bigint-FK
    active: true,
    product_slot_key: 'PS_457107528_11_SKU_SNICKERS_20260502T000000Z',
    sale_price_gross: null,
    current_machine_qty: 8,
    machine_capacity: 10,
    target_stock: 9,
  }];

  const [r] = mapProductsRows(rows);

  // genau die Sheet-Feldnamen, die der WF4-Code liest
  assert.equal(r.machine_id, '457107528', 'machine_id muss die Nayax-Nummer sein');
  assert.equal(r.product_slot_id, 'PS_457107528_11_SKU_SNICKERS_20260502T000000Z');
  assert.equal(r.internal_product_name, 'SKU_SNICKERS');
  assert.equal(r.nayax_product_name, 'Snickers');
  assert.equal(r.product_key, 'SKU_SNICKERS');
  assert.equal(r.mdb_code, '11', 'mdb_code als String wie im Sheet');
  assert.equal(r.active, 'TRUE', 'boolean true -> Sheet-String TRUE');
  assert.equal(r.current_machine_qty, '8');
  assert.equal(r.machine_capacity, '10');
  assert.equal(r.target_stock, '9');
  assert.equal(r.sale_price_eur, '', 'leerer Preis (prices leer) -> Leerstring');
});

// ── Read 2: "Produkt_Aliase lesen" Ersatz ─────────────────────────────────────

test('mapAliasesRows: alias -> alias_name, product_key durchgereicht', () => {
  const rows = [
    { alias: 'Snickers', product_key: 'SKU_SNICKERS' },
    { alias: 'Duplo original', product_key: 'SKU_DUPLO_ORIGINAL' },
  ];

  const mapped = mapAliasesRows(rows);

  assert.equal(mapped.length, 2);
  assert.deepEqual(mapped[0], { alias_name: 'Snickers', product_key: 'SKU_SNICKERS' });
  assert.deepEqual(mapped[1], { alias_name: 'Duplo original', product_key: 'SKU_DUPLO_ORIGINAL' });
});

// ── Query-Builder: parametrisch + schema-qualifiziert (Drift-Guard) ───────────

test('buildProductsReadQuery: joint die nötigen Tabellen, schema-qualifiziert', () => {
  const q = buildProductsReadQuery({ machineKey: '457107528' });
  const text = typeof q === 'string' ? q : q.text;
  for (const rel of ['slot_assignments', 'products', 'machines', 'product_aliases']) {
    assert.ok(text.includes(`automatenlager.${rel}`), `Query muss automatenlager.${rel} joinen`);
  }
  // liefert die rohen Spalten, die mapProductsRows konsumiert
  assert.ok(/\bmachine_key\b/.test(text));
  assert.ok(/\bproduct_slot_key\b/.test(text));
  assert.ok(/nayax_alias/.test(text), 'Nayax-Alias als Spalte nayax_alias');
});

test('buildProductsReadQuery: machine_key parametrisch ($1), kein Hardcode', () => {
  const q = buildProductsReadQuery({ machineKey: '457107528' });
  assert.ok(typeof q === 'object' && Array.isArray(q.values), 'gibt {text, values} zurück');
  assert.ok(!q.text.includes('457107528'), 'kein Hardcode der Nayax-Nummer im SQL');
  assert.deepEqual(q.values, ['457107528']);
  assert.ok(/\$1/.test(q.text), 'Filter als Parameter $1');
});

test('buildProductsReadQuery: ohne machineKey -> kein Filter, keine Werte', () => {
  const q = buildProductsReadQuery();
  assert.deepEqual(q.values, []);
  assert.ok(!/\$1/.test(q.text), 'ohne machineKey kein Parameter');
});

test('buildAliasesReadQuery: schema-qualifiziert, liefert alias + product_key', () => {
  const q = buildAliasesReadQuery();
  const text = typeof q === 'string' ? q : q.text;
  assert.ok(text.includes('automatenlager.product_aliases'));
  assert.ok(text.includes('automatenlager.products'));
  assert.ok(/\balias\b/.test(text));
  assert.ok(/\bproduct_key\b/.test(text));
});

// ── Edge-Cases (Sheet-Treue) ──────────────────────────────────────────────────

test('mapProductsRows: inaktive Zeile -> active "FALSE", fehlender Nayax-Alias -> leer', () => {
  const [r] = mapProductsRows([{
    product_key: 'SKU_X', name: 'SKU_X', nayax_alias: null,
    mdb_code: null, machine_key: '457107528', active: false,
    product_slot_key: 'PS_457107528_99_SKU_X_OLD', sale_price_gross: null,
    current_machine_qty: 0, machine_capacity: null, target_stock: null,
  }]);
  assert.equal(r.active, 'FALSE');
  assert.equal(r.nayax_product_name, '');
  assert.equal(r.mdb_code, '');
  assert.equal(r.current_machine_qty, '0');
  assert.equal(r.machine_capacity, '');
  assert.equal(r.target_stock, '');
});

test('Map-Funktionen: leere/fehlende Eingabe -> leeres Array', () => {
  assert.deepEqual(mapProductsRows([]), []);
  assert.deepEqual(mapProductsRows(undefined), []);
  assert.deepEqual(mapAliasesRows(null), []);
});

test('mapProductsRows: numerischer Preis -> String wie im Sheet', () => {
  const [r] = mapProductsRows([{ machine_key: '457107528', active: true, sale_price_gross: '1.50' }]);
  assert.equal(r.sale_price_eur, '1.50');
});
