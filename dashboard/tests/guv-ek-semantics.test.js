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

const { ekFromNet, wareneinsatzNet, readKleinunternehmer, costBasisMultiplier } = require('../lib/guv-ek.js');
const { buildEffectiveConfig, sanitizeOverride, resolveCategory } = require('../lib/category-config.js');

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

// ── #176: gemeinsame Lesefunktion für das Besteuerungsmodell (Konflikt-Regel) ──

test('#176 readKleinunternehmer: Konflikt-Matrix — camelCase ist kanonisch, gewinnt', () => {
  // camelCase=true, snake=false → true (camelCase gewinnt)
  assert.equal(readKleinunternehmer({ kleinunternehmerAktiv: true, kleinunternehmer_aktiv: false }), true);
  // camelCase=false, snake=true → false (camelCase gewinnt)
  assert.equal(readKleinunternehmer({ kleinunternehmerAktiv: false, kleinunternehmer_aktiv: true }), false);
  // nur snake=true → true (Legacy-Fallback)
  assert.equal(readKleinunternehmer({ kleinunternehmer_aktiv: true }), true);
  // nur snake=false → false
  assert.equal(readKleinunternehmer({ kleinunternehmer_aktiv: false }), false);
  // beide fehlen → definierter Default false
  assert.equal(readKleinunternehmer({}), false);
  assert.equal(readKleinunternehmer(null), false);
  // nur camelCase=true → true
  assert.equal(readKleinunternehmer({ kleinunternehmerAktiv: true }), true);
});

test('#176 readKleinunternehmer: akzeptiert bool und String "true"/"false" (case-insensitiv)', () => {
  assert.equal(readKleinunternehmer({ kleinunternehmerAktiv: 'TRUE' }), true);
  assert.equal(readKleinunternehmer({ kleinunternehmerAktiv: 'False' }), false);
  assert.equal(readKleinunternehmer({ kleinunternehmer_aktiv: 'true' }), true);
  assert.equal(readKleinunternehmer({ kleinunternehmerAktiv: ' true ' }), true);
});

test('#176 readKleinunternehmer: bei doppeltem Schlüssel wird genau ein Warning geloggt', () => {
  const warnings = [];
  const logger = { warn: (m) => warnings.push(m) };
  const out = readKleinunternehmer({ kleinunternehmerAktiv: true, kleinunternehmer_aktiv: false }, { logger });
  assert.equal(out, true, 'camelCase gewinnt');
  assert.equal(warnings.length, 1, 'genau ein Warning');
  assert.equal(warnings[0], 'Config contains both kleinunternehmerAktiv and kleinunternehmer_aktiv; using camelCase.');
});

test('#176 readKleinunternehmer: nur EIN Schlüssel ⇒ kein Warning', () => {
  const warnings = [];
  const logger = { warn: (m) => warnings.push(m) };
  readKleinunternehmer({ kleinunternehmerAktiv: true }, { logger });
  readKleinunternehmer({ kleinunternehmer_aktiv: true }, { logger });
  readKleinunternehmer({}, { logger });
  assert.equal(warnings.length, 0, 'kein Warning ohne Konflikt');
});

// ── #176: reine Brutto-Rechnung aus dem Kategorie-MwSt-Satz (ohne DB) ──────────

test('#176 Brutto-Kostenbasis (Kategorie-MwSt): KU+Snack ×1,07, KU+Getränk ×1,19, KU+unbekannt ×1,19', () => {
  const eff = buildEffectiveConfig(sanitizeOverride({})); // Defaults: snack 7 %, getraenk 19 %, default 19 %
  const ku = { kleinunternehmer: true };
  const snackMwst = resolveCategory(eff, 'snack').mwstPct;
  const drinkMwst = resolveCategory(eff, 'getraenk').mwstPct;
  const unknownMwst = resolveCategory(eff, 'gibtsnicht').mwstPct;
  assert.equal(snackMwst, 7);
  assert.equal(drinkMwst, 19);
  assert.equal(unknownMwst, 19, 'unbekannte Kategorie ⇒ defaultMwstPct 19');
  assert.equal(costBasisMultiplier(snackMwst, ku), 1.07);
  assert.equal(costBasisMultiplier(drinkMwst, ku), 1.19);
  assert.equal(costBasisMultiplier(unknownMwst, ku), 1.19);
});

test('#176 Brutto-Kostenbasis: regelbesteuert bleibt netto (Faktor 1, unverändert)', () => {
  const reg = { kleinunternehmer: false };
  assert.equal(costBasisMultiplier(7, reg), 1);
  assert.equal(costBasisMultiplier(19, reg), 1);
});
