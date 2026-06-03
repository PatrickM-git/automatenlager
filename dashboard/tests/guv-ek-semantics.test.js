'use strict';

// TDD für Issue #51: EINE eindeutige EK-Semantik.
//
// Belegt am realen Rechnungsbeleg (20.05.2026): die Stückpreise auf der Rechnung
// sind NETTO (Summe der Zeilen = NETTO-WARENWERT, erst danach wird MwSt addiert).
// Beispiel Snickers: STÜCK INT KD PREIS 0,480 (netto, Steuergruppe B = 7 %) ->
// genau dieser Wert steht im Sheet als `unit_cost` / DB `stock_batches.unit_cost_net`.
//
// `dashboard/lib/guv-ek.js` ist die EINE dokumentierte Definition: `unit_cost` ist
// netto. Daraus werden netto/brutto und der gebuchte Wareneinsatz konsistent
// abgeleitet. WF8 und economics.js müssen sich an diese Definition halten.

const assert = require('node:assert/strict');
const test = require('node:test');

const { ekFromNet, wareneinsatzNet } = require('../lib/guv-ek.js');

test('ekFromNet: unit_cost ist netto -> brutto wird obendrauf gerechnet (Snickers 7 %)', () => {
  const ek = ekFromNet(0.48, 7);
  assert.equal(ek.ekNetto, 0.48);
  assert.equal(ek.ekBrutto, 0.5136); // 0,48 * 1,07
});

test('ekFromNet: Getränk 19 % (Cola netto 0,58)', () => {
  const ek = ekFromNet(0.58, 19);
  assert.equal(ek.ekNetto, 0.58);
  assert.equal(ek.ekBrutto, 0.6902); // 0,58 * 1,19
});

test('ekFromNet: brutto/(1+mwst) ergibt wieder exakt netto (Konsistenz, AC3)', () => {
  for (const [net, rate] of [[0.48, 7], [0.58, 19], [1.23, 19], [0.75, 7]]) {
    const { ekNetto, ekBrutto } = ekFromNet(net, rate);
    assert.ok(Math.abs(ekBrutto / (1 + rate / 100) - ekNetto) < 1e-9,
      `netto ${net} @ ${rate}%: ${ekBrutto}/(1+${rate}%) != ${ekNetto}`);
  }
});

test('ekFromNet: mwst 0 (Kleinunternehmer) -> brutto == netto', () => {
  const ek = ekFromNet(0.48, 0);
  assert.equal(ek.ekNetto, 0.48);
  assert.equal(ek.ekBrutto, 0.48);
});

test('ekFromNet: ungültige/fehlende Eingaben sind sicher (0)', () => {
  assert.deepEqual(ekFromNet(null, 7), { ekNetto: 0, ekBrutto: 0 });
  assert.deepEqual(ekFromNet('', null), { ekNetto: 0, ekBrutto: 0 });
  assert.deepEqual(ekFromNet(-1, 7), { ekNetto: 0, ekBrutto: 0 });
});

test('wareneinsatzNet: gebuchter Wareneinsatz = netto-EK × Menge (AC6)', () => {
  // 2 Kolli × 32 Stück = 64 Snickers à 0,48 netto = 30,72 (= guv_daily.cost_of_goods)
  assert.equal(wareneinsatzNet(64, 0.48), 30.72);
});

test('wareneinsatzNet == ek_preis_netto × Menge (cost_of_goods konsistent zu ek_preis_netto, AC3)', () => {
  const qty = 64;
  const { ekNetto } = ekFromNet(0.48, 7);
  assert.equal(wareneinsatzNet(qty, 0.48), Math.round(ekNetto * qty * 100) / 100);
});

test('wareneinsatzNet: ungültige Eingaben -> 0', () => {
  assert.equal(wareneinsatzNet(null, 0.48), 0);
  assert.equal(wareneinsatzNet(64, null), 0);
  assert.equal(wareneinsatzNet(-5, 0.48), 0);
});
