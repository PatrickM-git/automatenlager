'use strict';

/**
 * Drehgeschwindigkeits-Klassifikation — geldbasiert (Issue #64).
 * Gute Tests prüfen externes Verhalten (Eingabe-Slots + Config → turnover_class),
 * nicht Implementierungsinterna. Latten kommen aus den Branchen-Anker-Defaults
 * (lib/category-config.js).
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { classifyTurnover, SLOW_MOVER, VALID_CLASSES } = require('../lib/slow-mover.js');
const { buildEffectiveConfig } = require('../lib/category-config.js');

// Default-Latten (zur Kontrolle der Erwartungswerte in den Tests):
//   umsatz/slot/woche = 800/30/4.33 ≈ 6.158
//   snack    (52 %): expected 3.20 · renner ≥ 4.16 · langsam ≤ 1.92
//   getraenk (43 %): expected 2.65 · renner ≥ 3.44 · langsam ≤ 1.59
const CFG = buildEffectiveConfig({});

// Slot-Helfer: standardmäßig kürzlich verkauft, lange gelistet, EK vorhanden.
function slot(over = {}) {
  return {
    machine_id: 'VM01', mdb_code: '11',
    category: 'snack',
    daysSinceLastSale: 1,
    listedDays: 90,
    ek_missing: false,
    ...over,
  };
}

function classOf(over) {
  return classifyTurnover([slot(over)], CFG)[0].turnover_class;
}

// ── Geldbasierte Einordnung (Kern) ────────────────────────────────────────────

test('#64 Drink mit hoher Marge = renner, Kaugummi mit Mini-Marge = langsam_dreher', () => {
  // Energydrink: wenige Stück, aber hohe Marge/Woche → renner.
  assert.equal(classOf({ category: 'getraenk', marginPerWeek: 5.0 }), 'renner');
  // Kaugummi: viele Stück, aber Mini-Marge/Woche → langsam_dreher.
  assert.equal(classOf({ category: 'snack', marginPerWeek: 1.0 }), 'langsam_dreher');
});

test('#64 mittlere Marge = normal', () => {
  assert.equal(classOf({ category: 'snack', marginPerWeek: 3.0 }), 'normal');
});

test('#64 Kategorie-eigene Latten: gleicher €/Woche fällt je Kategorie anders', () => {
  // 3.7 €/Woche: für Snack (Renner-Latte 4.16) noch normal, für Getränk (3.44) schon renner.
  assert.equal(classOf({ category: 'snack', marginPerWeek: 3.7 }), 'normal');
  assert.equal(classOf({ category: 'getraenk', marginPerWeek: 3.7 }), 'renner');
});

test('#64 unbekannte Kategorie nutzt Fallback-Latte (Default-Marge 50 %)', () => {
  // Fallback expected = 6.158*0.5 = 3.08, renner ≥ 4.00.
  assert.equal(classOf({ category: 'spielzeug', marginPerWeek: 5.0 }), 'renner');
  assert.equal(classOf({ category: 'spielzeug', marginPerWeek: 1.0 }), 'langsam_dreher');
});

// ── db_window / Fenster-Pfad ──────────────────────────────────────────────────

test('#64 db_window ÷ Fensterwochen liefert die Marge/Woche', () => {
  // 16 € Marge über 4 Wochen = 4.0 €/Woche → snack renner-nah? 4.0 < 4.16 → normal.
  assert.equal(classOf({ category: 'snack', db_window: 16, windowWeeks: 4 }), 'normal');
  // 20 € / 4 = 5.0 → renner.
  assert.equal(classOf({ category: 'snack', db_window: 20, windowWeeks: 4 }), 'renner');
});

// ── Schonfrist (Vorrang vor Langsam) ──────────────────────────────────────────

test('#64 Schonfrist: neues Produkt (< graceDays) wird nie Langsam-Dreher, sondern neu', () => {
  assert.equal(classOf({ listedDays: 5, marginPerWeek: 0.1 }), 'neu');
});

test('#64 Schonfrist: frisch gelistetes, nie verkauftes Produkt ist neu (nicht ladenhueter)', () => {
  assert.equal(classOf({ listedDays: 3, daysSinceLastSale: null }), 'neu');
});

test('#64 nach Schonfrist greift wieder die normale Einordnung', () => {
  assert.equal(classOf({ listedDays: 20, marginPerWeek: 5.0 }), 'renner');
});

// ── Ladenhüter (Vorrang vor Geld-Klassen) ─────────────────────────────────────

test('#64 Ladenhüter hat Vorrang: 40 Tage kein Verkauf trotz hoher Marge = ladenhueter', () => {
  assert.equal(classOf({ daysSinceLastSale: 40, marginPerWeek: 10 }), 'ladenhueter');
});

test('#64 nie verkauft (über Schonfrist) = ladenhueter', () => {
  assert.equal(classOf({ daysSinceLastSale: null, listedDays: 90 }), 'ladenhueter');
});

test('#64 Grenzfall genau 30 Tage = ladenhueter, 29 Tage nicht', () => {
  assert.equal(classOf({ daysSinceLastSale: 30, marginPerWeek: 3 }), 'ladenhueter');
  assert.notEqual(classOf({ daysSinceLastSale: 29, marginPerWeek: 3 }), 'ladenhueter');
});

// ── EK fehlt (niemals raten) ──────────────────────────────────────────────────

test('#64 EK fehlt (explizit) → ek_fehlt, niemals geratene Klasse', () => {
  assert.equal(classOf({ ek_missing: true, marginPerWeek: 10 }), 'ek_fehlt');
});

test('#64 keine Marge-Basis berechenbar → ek_fehlt', () => {
  assert.equal(classOf({ marginPerWeek: null, db_window: null }), 'ek_fehlt');
});

// ── Default-Config / Onboarding ───────────────────────────────────────────────

test('#64 ohne Config-Argument greifen die Branchen-Anker-Defaults', () => {
  const out = classifyTurnover([slot({ category: 'getraenk', marginPerWeek: 5.0 })]);
  assert.equal(out[0].turnover_class, 'renner');
});

// ── Robustheit / Vertrag ──────────────────────────────────────────────────────

test('#64 leere Eingabe → leeres Array', () => {
  assert.deepEqual(classifyTurnover([], CFG), []);
});

test('#64 Eingabe bleibt unverändert, Identität erhalten, Klasse gültig', () => {
  const input = [slot({ marginPerWeek: 3.0 })];
  const out = classifyTurnover(input, CFG);
  assert.equal(input[0].turnover_class, undefined, 'Eingabe darf nicht mutiert werden');
  assert.ok(out[0].machine_id && out[0].mdb_code, 'Slot-Identität bleibt erhalten');
  assert.ok(VALID_CLASSES.includes(out[0].turnover_class));
});

// ── Klassenkatalog (für /einstellungen + Glossar + Frontend-Badges) ───────────

test('#64 SLOW_MOVER: sechs definierte Klassen mit Label + Beschreibung', () => {
  const keys = SLOW_MOVER.classes.map((c) => c.key).sort();
  assert.deepEqual(keys, ['ek_fehlt', 'ladenhueter', 'langsam_dreher', 'neu', 'normal', 'renner']);
  assert.equal(SLOW_MOVER.ladenhueterDays, 30);
  assert.equal(SLOW_MOVER.graceDays, 14);
  for (const c of SLOW_MOVER.classes) {
    assert.ok(c.label && c.description, `Klasse ${c.key} braucht Label + Beschreibung`);
  }
});
