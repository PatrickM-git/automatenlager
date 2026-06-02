'use strict';

// TDD für Issue #39: WF3 Produkt-/Alias-Matching Google-Sheets-Read -> PostgreSQL.
// WF3 matcht Nayax-Verkäufe gegen den Produktstand. Bisher las es das "Produkte"-
// Sheet, das gegenüber PG driftet (z. B. neu in PG angelegter Haribo-Slot MDB 34
// fehlte im Sheet -> UNKNOWN_PRODUCT / 0 €). Der Read wird auf PG umgestellt und
// MUSS exakt das Sheet-Schema liefern, das WF3s Matcher konsumiert
// (`Code - FIFO berechnen`: nayax_product_name/internal_product_name/product_key/
//  product_slot_id/machine_id/mdb_code/active "TRUE|FALSE"), damit FIFO-/Match-
// Logik unverändert bleibt. Schema-Vertrag wird mit WF4 (#14) geteilt.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  mapProductsRows,
  buildProductsReadQuery,
} = require('../lib/wf3-product-reads.js');

// ── Matching-Kontrakt: genau die Felder, die WF3s Matcher liest ───────────────

test('mapProductsRows liefert exakt die Felder, die WF3 (FIFO/Match) konsumiert', () => {
  const [r] = mapProductsRows([{
    product_key: 'SKU_SNICKERS',
    name: 'Snickers',
    nayax_alias: 'Snickers',
    mdb_code: 11,
    machine_key: '457107528',
    active: true,
    product_slot_key: 'PS_457107528_11_SKU_SNICKERS_20260502T000000Z',
    sale_price_gross: null,
    current_machine_qty: 8,
    machine_capacity: 10,
    target_stock: 9,
  }]);

  // productName(product) = nayax_product_name || internal_product_name || product_key
  assert.equal(r.nayax_product_name, 'Snickers');
  assert.equal(r.internal_product_name, 'Snickers');
  assert.equal(r.product_key, 'SKU_SNICKERS');
  // activeProductsForMachine: clean(p.active).toUpperCase() === 'TRUE'
  assert.equal(r.active, 'TRUE');
  // getMainMachineFromSlot / direkter machine_id-Match
  assert.equal(r.machine_id, '457107528');
  assert.equal(r.product_slot_id, 'PS_457107528_11_SKU_SNICKERS_20260502T000000Z');
  // findProductByName MDB-Tiebreak: clean(p.mdb_code) === clean(mdbCode)
  assert.equal(r.mdb_code, '11');
});

// ── Der konkrete AC-Fall: Haribo Goldbären MDB 34 ist matchbar ────────────────

test('Haribo Goldbären (MDB 34, aktiv in PG) wird zu einer name-matchbaren, aktiven Zeile', () => {
  // So liefert PG die Zeile (verifiziert gegen Live-DB, product_id 21):
  const rows = mapProductsRows([{
    product_key: 'SKU_HARIBO_GOLDBAEREN',
    name: 'Haribo Goldbären',
    nayax_alias: 'Haribo Goldbären',     // PRIMÄRER Nayax-Alias = NAME, nicht die NayaxProductID
    mdb_code: 34,
    machine_key: '457107528',
    active: true,
    product_slot_key: 'PS_457107528_34_SKU_HARIBO_GOLDBAEREN_20260602T150056Z',
    sale_price_gross: null,
    current_machine_qty: 6, machine_capacity: 8, target_stock: 8,
  }]);

  const r = rows[0];
  // Vorbedingungen, damit WF3s findProductByName('457107528','Haribo Goldbären','34') trifft:
  assert.equal(r.active, 'TRUE', 'aktiver Slot -> in activeProductsForMachine');
  assert.equal(r.machine_id, '457107528', 'Maschine matcht den Verkauf');
  assert.equal(r.nayax_product_name, 'Haribo Goldbären', 'Name (kein numerischer NayaxProductID-Alias) -> namesMatch greift');
  assert.equal(r.mdb_code, '34', 'MDB-Tiebreak trifft den richtigen Slot');
});

// ── Query: liest aus PG, primärer Nayax-Alias = NAME (kein UNKNOWN_PRODUCT) ────

test('buildProductsReadQuery liest aus PG und nimmt den primären Nayax-Alias als Namen', () => {
  const q = buildProductsReadQuery({ machineKey: '457107528' });
  const text = typeof q === 'string' ? q : q.text;
  for (const rel of ['slot_assignments', 'products', 'machines', 'product_aliases']) {
    assert.ok(text.includes(`automatenlager.${rel}`), `Query muss automatenlager.${rel} joinen`);
  }
  // Genau der primäre Nayax-Alias (NAME), nicht der nayax_id-Alias (Zahl) ->
  // sonst bräche WF3s Name-Matching (Haribo-Regression).
  assert.ok(/source\s*=\s*'nayax'/.test(text), "Alias-Quelle 'nayax'");
  assert.ok(/is_primary\s*=\s*TRUE/.test(text), 'nur primärer Alias (verhindert numerischen NayaxProductID-Namen)');
});

test('buildProductsReadQuery: machine_key parametrisch ($1), kein Hardcode', () => {
  const q = buildProductsReadQuery({ machineKey: '457107528' });
  assert.ok(typeof q === 'object' && Array.isArray(q.values));
  assert.ok(!q.text.includes('457107528'), 'kein Hardcode der Nayax-Nummer (multi-automaten-fähig)');
  assert.deepEqual(q.values, ['457107528']);
});

// ── Sheet-Treue (Strings, inaktive Zeilen bleiben für Historie erhalten) ──────

test('inaktive Zeile -> active "FALSE", fehlender Alias -> leer (Sheet-Treue)', () => {
  const [r] = mapProductsRows([{
    product_key: 'SKU_X', name: 'X', nayax_alias: null, mdb_code: null,
    machine_key: '457107528', active: false,
    product_slot_key: 'PS_457107528_99_SKU_X_OLD',
    sale_price_gross: null, current_machine_qty: 0,
  }]);
  assert.equal(r.active, 'FALSE');
  assert.equal(r.nayax_product_name, '');
  assert.equal(r.mdb_code, '');
});
