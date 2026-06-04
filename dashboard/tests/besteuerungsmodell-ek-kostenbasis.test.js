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
const {
  wareneinsatzCostBasis, wareneinsatzNet, costBasisMultiplier,
} = require('../lib/guv-ek.js');
const {
  DEFAULT_CONFIG, mergeConfig, buildEffectiveConfig, resolveCategory, sanitizeOverride,
} = require('../lib/category-config.js');

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

// ── Config-Ebene (Mandant) ─────────────────────────────────────────────────

test('CODE-Default ist regelbesteuert (neuer Mandant ohne Override startet konservativ netto)', () => {
  assert.equal(DEFAULT_CONFIG.kleinunternehmerAktiv, false);
  assert.equal(mergeConfig().kleinunternehmerAktiv, false);
  assert.equal(buildEffectiveConfig({}).kleinunternehmerAktiv, false);
});

test('Mandant-Override schaltet Kleinunternehmer ein (Betreiber)', () => {
  const cfg = buildEffectiveConfig({ kleinunternehmerAktiv: true });
  assert.equal(cfg.kleinunternehmerAktiv, true);
});

test('MwSt-Satz je Kategorie aufgelöst (Getränke 19 %, Snack 7 %, unbekannt → defaultMwstPct)', () => {
  const cfg = mergeConfig();
  assert.equal(resolveCategory(cfg, 'getraenk').mwstPct, 19);
  assert.equal(resolveCategory(cfg, 'snack').mwstPct, 7);
  assert.equal(resolveCategory(cfg, 'spielzeug').mwstPct, cfg.defaultMwstPct);
});

test('sanitizeOverride nimmt kleinunternehmerAktiv (bool + String) und mwstPct, verwirft Müll', () => {
  assert.equal(sanitizeOverride({ kleinunternehmerAktiv: true }).kleinunternehmerAktiv, true);
  assert.equal(sanitizeOverride({ kleinunternehmerAktiv: 'true' }).kleinunternehmerAktiv, true);
  assert.equal(sanitizeOverride({ kleinunternehmerAktiv: 'false' }).kleinunternehmerAktiv, false);
  assert.equal(sanitizeOverride({ kleinunternehmerAktiv: 'vielleicht' }).kleinunternehmerAktiv, undefined);
  const cats = sanitizeOverride({ categories: { snack: { mwstPct: 7 } } }).categories;
  assert.equal(cats.snack.mwstPct, 7);
});

// ── economics.js-Komposition (exakt wie der Live-Pfad rechnet) ──────────────
// netto-FIFO-Wareneinsatz × costBasisMultiplier(Kategorie-MwSt, {kleinunternehmer}).

function liveCost(nettoCost, category, cfg) {
  const mwst = resolveCategory(cfg, category).mwstPct;
  const mult = costBasisMultiplier(mwst, { kleinunternehmer: cfg.kleinunternehmerAktiv });
  return Math.round(nettoCost * mult * 100) / 100;
}

test('Kleinunternehmer: Live-Wareneinsatz wird je Kategorie korrekt brutto', () => {
  const cfg = buildEffectiveConfig({ kleinunternehmerAktiv: true });
  assert.equal(liveCost(4.8, 'snack', cfg), 5.14);    // 4,80 × 1,07
  assert.equal(liveCost(4.0, 'getraenk', cfg), 4.76); // 4,00 × 1,19
});

test('Regelbesteuert: Live-Wareneinsatz bleibt netto (unverändert zur bisherigen Buchung)', () => {
  const cfg = buildEffectiveConfig({ kleinunternehmerAktiv: false });
  assert.equal(liveCost(4.8, 'snack', cfg), 4.8);
  assert.equal(liveCost(4.0, 'getraenk', cfg), 4.0);
});
