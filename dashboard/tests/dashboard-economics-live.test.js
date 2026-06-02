'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');

const {
  shapeLiveData,
  displayName,
  clampRecentLimit,
} = require('../lib/economics-live.js');

/* =========================================================================
   Live-Umsatz (quasi-live) — reine Formungslogik für /api/v2/economics/live
   ========================================================================= */

test('displayName: SKU-Stammname wird zu Klartext', () => {
  assert.equal(displayName('SKU_TWIX_ORIGINAL', 'egal'), 'Twix Original');
});

test('displayName: ohne Stammname wird der rohe Nayax-Name vom (MDB = Preis)-Suffix befreit', () => {
  assert.equal(displayName(null, 'Studentenfutter(43 = 2.00)'), 'Studentenfutter');
  assert.equal(displayName(null, 'Erdnüsse(44 = 1.50)'), 'Erdnüsse');
});

test('displayName: roher Name ohne Suffix bleibt unverändert', () => {
  assert.equal(displayName(null, 'Snickers Creamy'), 'Snickers Creamy');
});

test('displayName: nur Klammerausdruck → Rohname bleibt erhalten (kein Leerstring)', () => {
  assert.equal(displayName(null, '(43 = 2.00)'), '(43 = 2.00)');
});

test('shapeLiveData: Tages-KPIs werden numerisch normalisiert', () => {
  const out = shapeLiveData({
    todayRow: { verkaeufe: '7', stueck: '9', umsatz_brutto: '13.50' },
    recentRows: [],
  });
  assert.deepEqual(out.today, { verkaeufe: 7, stueck: 9, umsatzBrutto: 13.5 });
  assert.equal(out.recent.length, 0);
  assert.equal(out.lastSaleAt, null);
});

test('shapeLiveData: fehlende Tageszeile → Nullwerte', () => {
  const out = shapeLiveData({ todayRow: null, recentRows: [] });
  assert.deepEqual(out.today, { verkaeufe: 0, stueck: 0, umsatzBrutto: 0 });
});

test('shapeLiveData: jüngste Verkäufe werden gemappt, lastSaleAt = erster Eintrag', () => {
  const t1 = '2026-06-02T10:05:00.000Z';
  const t2 = '2026-06-02T10:01:00.000Z';
  const out = shapeLiveData({
    todayRow: { verkaeufe: 2, stueck: 2, umsatz_brutto: 3 },
    recentRows: [
      { nayax_transaction_id: 6053280724, settlement_at: t1, machine_id: 1, quantity: 1, gross_amount: '2.00', product_name_raw: 'Studentenfutter(43 = 2.00)', product_name: null },
      { nayax_transaction_id: 6053274666, settlement_at: new Date(t2), machine_id: 1, quantity: 1, gross_amount: 1, product_name_raw: 'Maltesers(62 = 1.50)', product_name: 'SKU_MALTESERS' },
    ],
  });
  assert.equal(out.recent.length, 2);
  assert.equal(out.recent[0].txId, '6053280724');
  assert.equal(out.recent[0].product, 'Studentenfutter');
  assert.equal(out.recent[0].grossAmount, 2);
  assert.equal(out.recent[0].machineId, '1');
  // Date-Objekt wird zu ISO-String normalisiert
  assert.equal(out.recent[1].settlementAt, t2);
  assert.equal(out.recent[1].product, 'Maltesers'); // Stammname gewinnt
  assert.equal(out.lastSaleAt, t1);
});

test('shapeLiveData: quantity default 1 wenn ungültig', () => {
  const out = shapeLiveData({
    todayRow: null,
    recentRows: [{ nayax_transaction_id: 1, settlement_at: null, machine_id: null, quantity: 0, gross_amount: 0, product_name_raw: 'X', product_name: null }],
  });
  assert.equal(out.recent[0].quantity, 1);
  assert.equal(out.recent[0].machineId, null);
  assert.equal(out.recent[0].settlementAt, null);
});

test('clampRecentLimit: Default und Grenzen', () => {
  assert.equal(clampRecentLimit(undefined), 15);
  assert.equal(clampRecentLimit('0'), 15);
  assert.equal(clampRecentLimit('-5'), 15);
  assert.equal(clampRecentLimit('25'), 25);
  assert.equal(clampRecentLimit('9999'), 100); // Deckel
});
