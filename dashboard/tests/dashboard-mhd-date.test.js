'use strict';

// Determinismus: positiver UTC-Offset, wo der Off-by-1 auftritt (wie Prod = Europe/Berlin).
process.env.TZ = 'Europe/Berlin';

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildInventoryMhdData } = require('../lib/inventory-mhd.js');

// node-pg liefert DATE-Spalten als JS-Date zur LOKALEN Mitternacht. Vorher rutschte
// toIsoDate() via toISOString() auf den Vortag (DB 2026-05-27 -> Anzeige '2026-05-26').
test('MHD: Date-Objekt (node-pg DATE) -> lokales Kalenderdatum, kein UTC-Off-by-1', () => {
  const mhd = new Date(2026, 4, 27); // 27.05.2026 lokale Mitternacht
  const data = buildInventoryMhdData({
    mhdRisks: [{ batch_id: 17, product_id: 43, product_name: 'Nick Nacks', mhd_date: mhd, remaining_qty: 21, warning_type: 'MHD_EXPIRED' }],
  });
  assert.equal(data.mhdRisks.length, 1);
  assert.equal(data.mhdRisks[0].mhd_date, '2026-05-27');
});

test('MHD: Jahreswechsel-Grenzfall (31.12. lokale Mitternacht) bleibt 31.12.', () => {
  const mhd = new Date(2026, 11, 31);
  const data = buildInventoryMhdData({
    mhdRisks: [{ batch_id: 1, product_id: 1, product_name: 'X', mhd_date: mhd, remaining_qty: 1, warning_type: 'MHD_NEAR' }],
  });
  assert.equal(data.mhdRisks[0].mhd_date, '2026-12-31');
});

test('MHD: ISO-String wird unverändert übernommen (erste 10 Zeichen)', () => {
  const data = buildInventoryMhdData({
    mhdRisks: [{ batch_id: 7, product_id: 10, product_name: 'Twix', mhd_date: '2026-05-31', remaining_qty: 15, warning_type: 'MHD_NEAR' }],
  });
  assert.equal(data.mhdRisks[0].mhd_date, '2026-05-31');
});

test('MHD: leeres/fehlendes Datum -> leerer String', () => {
  const data = buildInventoryMhdData({
    mhdRisks: [{ batch_id: 9, product_id: 2, product_name: 'Y', mhd_date: null, remaining_qty: 3, warning_type: 'MHD_NEAR' }],
  });
  assert.equal(data.mhdRisks[0].mhd_date, '');
});
