'use strict';

// TDD für Issue #41: WF5-Report Google-Sheets-Read der Lagerchargen -> PostgreSQL.
// WF5 ("Automatenlager Check"-Mail) las die Lagerchargen aus dem Sheet, das
// gegenüber PG driftet: ausgebuchte Chargen (Write-off #21, PG-Status
// 'ausgesondert') standen im Sheet noch als 'aktiv' -> wurden weiter als
// "MHD abgelaufen" gemeldet (Nick Nacks batch 17, Twix salted caramel batch 7).
//
// Der Read wird auf `stock_batches` umgestellt und MUSS:
//  1. nur VERFÜGBARE Status liefern (zentrale stock-status.js: aktiv/active/reserve);
//     'ausgesondert'/'leer'/'wartet_nachkauf' fallen raus.
//  2. exakt das Sheet-Schema liefern, das `Code - MHD und Lagercharge pruefen`
//     konsumiert: batch_id, product_key, product_name, status, mhd, remaining_qty.
//  3. den Status auf 'aktiv' normalisieren — WF5s Folge-Filter lässt nur
//     ['aktiv','leer'] durch; ohne Normalisierung würden 'active'/'reserve'-
//     Chargen fälschlich übersprungen (neue Regression).
//  4. `mhd` aus der PG-Spalte `mhd_date` (ISO-Datum) liefern, nicht aus `mhd`.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  mapLagerchargenRows,
  buildLagerchargenReadQuery,
} = require('../lib/wf5-stock-reads.js');
const { AVAILABLE_BATCH_STATUSES } = require('../lib/stock-status.js');

// ── Query: aus stock_batches, nur verfügbare Status ───────────────────────────

test('buildLagerchargenReadQuery liest stock_batches+products, filtert auf verfügbare Status', () => {
  const q = buildLagerchargenReadQuery();
  const text = typeof q === 'string' ? q : q.text;
  assert.ok(text.includes('automatenlager.stock_batches'), 'liest stock_batches');
  assert.ok(text.includes('automatenlager.products'), 'joint products (product_key/Name)');
  // verfügbare Status sind im Filter, ausgebuchte NICHT
  for (const s of AVAILABLE_BATCH_STATUSES) {
    assert.ok(text.includes(`'${s}'`), `Status '${s}' im Filter`);
  }
  assert.ok(!/'ausgesondert'/.test(text), "'ausgesondert' nicht im Filter (Write-offs raus)");
  assert.ok(!/'wartet_nachkauf'/.test(text), "'wartet_nachkauf' nicht im Filter");
  assert.ok(/sb\.status\s+IN\s*\(/i.test(text), 'Status-IN-Filter vorhanden');
});

// ── Mapping: Sheet-Schema, Status-Normalisierung, mhd_date->mhd ───────────────

test('mapLagerchargenRows liefert das Sheet-Schema, das WF5 konsumiert', () => {
  const [r] = mapLagerchargenRows([{
    batch_id: 49,
    batch_key: 'B_SNICKERS_20260520_1',
    product_key: 'SKU_SNICKERS',
    product_name: 'Snickers',
    status: 'aktiv',
    mhd_date: new Date(2026, 9, 24), // 2026-10-24 lokal
    remaining_qty: 61,
  }]);
  assert.equal(r.product_key, 'SKU_SNICKERS');
  assert.equal(r.product_name, 'Snickers');
  assert.equal(r.status, 'aktiv');
  assert.equal(r.remaining_qty, '61', 'Menge als String wie im Sheet');
  assert.equal(r.mhd, '2026-10-24', 'mhd aus mhd_date als ISO-Datum');
  assert.ok('batch_id' in r, 'batch_id-Feld vorhanden (Dedup-Anker für Alerts)');
});

test('mapLagerchargenRows normalisiert active/reserve -> aktiv (WF5-Filter lässt nur aktiv/leer)', () => {
  const rows = mapLagerchargenRows([
    { batch_key: 'B_TWIX_ORIG', product_key: 'SKU_TWIX', product_name: 'Twix original', status: 'active', remaining_qty: 64, mhd_date: null },
    { batch_key: 'B_PICKUP', product_key: 'SKU_PICKUP', product_name: 'Pick Up', status: 'reserve', remaining_qty: 22, mhd_date: null },
  ]);
  assert.equal(rows[0].status, 'aktiv', "'active' -> 'aktiv' (sonst von WF5 übersprungen)");
  assert.equal(rows[1].status, 'aktiv', "'reserve' -> 'aktiv' (Backstock bleibt sichtbar)");
  assert.equal(rows[0].remaining_qty, '64');
  assert.equal(rows[1].remaining_qty, '22');
});

test('mapLagerchargenRows: fehlendes mhd_date -> leerer mhd-String (kein MHD-Alert)', () => {
  const [r] = mapLagerchargenRows([{
    batch_key: 'B_X', product_key: 'SKU_X', product_name: 'X',
    status: 'aktiv', mhd_date: null, remaining_qty: 5,
  }]);
  assert.equal(r.mhd, '', 'kein MHD-Datum -> kein "läuft ab"-Alert');
});

test('Map-Funktion: leere/fehlende Eingabe -> leeres Array', () => {
  assert.deepEqual(mapLagerchargenRows([]), []);
  assert.deepEqual(mapLagerchargenRows(undefined), []);
});
