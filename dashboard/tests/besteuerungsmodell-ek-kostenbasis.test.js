'use strict';

// Issue #56: Konfigurierbares Besteuerungsmodell (Kleinunternehmer vs.
// regelbesteuert) steuert die EK-Kostenbasis im Wareneinsatz.
//
// Vertrag (extern, kein Implementierungsdetail):
//   wareneinsatzCostBasis(qty, unitCostNet, mwstSatz, { kleinunternehmer })
//   - regelbesteuert (kleinunternehmer=false): Wareneinsatz = qty * NETTO-EK
//     (Vorsteuer wird erstattet -> netto ist der echte Aufwand)
//   - Kleinunternehmer (kleinunternehmer=true): Wareneinsatz = qty * BRUTTO-EK
//     (gezahlte MwSt ist echte, nicht erstattete Kosten)
// Die Netto-Variante MUSS byte-genau dem bisherigen wareneinsatzNet entsprechen
// (keine Verschiebung historischer guv_daily-Werte ohne Modellwechsel).

const assert = require('node:assert/strict');
const test = require('node:test');
const { wareneinsatzCostBasis, wareneinsatzNet } = require('../lib/guv-ek.js');

test('regelbesteuert: Wareneinsatz = Menge × Netto-EK (unverändert zu wareneinsatzNet)', () => {
  // 10 Stück, 0,48 € netto, 7 % MwSt -> rein netto = 4,80 €, MwSt ignoriert
  const cost = wareneinsatzCostBasis(10, 0.48, 7, { kleinunternehmer: false });
  assert.equal(cost, 4.8);
  assert.equal(cost, wareneinsatzNet(10, 0.48));
});

test('Kleinunternehmer: Wareneinsatz = Menge × Brutto-EK (netto × (1+MwSt))', () => {
  // 10 Stück, 0,48 € netto, 7 % -> brutto 0,5136 -> 5,136 -> gerundet 5,14 €
  const cost = wareneinsatzCostBasis(10, 0.48, 7, { kleinunternehmer: true });
  assert.equal(cost, 5.14);
});

test('Kleinunternehmer mit 19 % MwSt bucht entsprechend höher als regelbesteuert', () => {
  const ku = wareneinsatzCostBasis(4, 1.0, 19, { kleinunternehmer: true });
  const reg = wareneinsatzCostBasis(4, 1.0, 19, { kleinunternehmer: false });
  assert.equal(reg, 4.0); // 4 × 1,00 netto
  assert.equal(ku, 4.76); // 4 × 1,19 brutto
  assert.ok(ku > reg, 'Kleinunternehmer-Wareneinsatz muss höher sein');
});

test('Kleinunternehmer ohne gültige MwSt (0/fehlend) fällt auf Netto zurück (keine erfundene Aufschlagshöhe)', () => {
  assert.equal(wareneinsatzCostBasis(10, 0.48, 0, { kleinunternehmer: true }), 4.8);
  assert.equal(wareneinsatzCostBasis(10, 0.48, null, { kleinunternehmer: true }), 4.8);
});

test('Default-Optionen (kein opts) = regelbesteuert (netto)', () => {
  assert.equal(wareneinsatzCostBasis(10, 0.48, 7), 4.8);
});

test('Nullmengen/kein EK -> 0 (wie wareneinsatzNet)', () => {
  assert.equal(wareneinsatzCostBasis(0, 0.48, 7, { kleinunternehmer: true }), 0);
  assert.equal(wareneinsatzCostBasis(10, 0, 7, { kleinunternehmer: true }), 0);
});
