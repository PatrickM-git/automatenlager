'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  classifyTurnover,
  SLOW_MOVER,
  quantile,
} = require('../lib/slow-mover.js');

// Hilfsfunktion: Slot mit kürzlichem Verkauf (nicht Ladenhüter).
function slot(key, turnover, daysSinceLastSale = 1) {
  const [machine_id, mdb_code] = key.split(':');
  return { machine_id, mdb_code, turnover, daysSinceLastSale };
}

// ── Quartil-Klassifikation (kontrollierte Eingaben) ───────────────────────────

test('classifyTurnover: oberstes Quartil = renner, unterstes = langsam_dreher, Mitte = normal', () => {
  // 8 Slots, Drehzahl 1..8, alle kürzlich verkauft.
  const slots = [1, 2, 3, 4, 5, 6, 7, 8].map((t, i) => slot(`VM01:${10 + i}`, t));
  const out = classifyTurnover(slots);
  const byTurnover = Object.fromEntries(out.map((s) => [s.turnover, s.turnover_class]));

  // Q1≈2.75, Q3≈6.25 → t>=6.25 renner (7,8); t<=2.75 langsam (1,2); Rest normal.
  assert.equal(byTurnover[8], 'renner');
  assert.equal(byTurnover[7], 'renner');
  assert.equal(byTurnover[1], 'langsam_dreher');
  assert.equal(byTurnover[2], 'langsam_dreher');
  assert.equal(byTurnover[4], 'normal');
  assert.equal(byTurnover[5], 'normal');
});

test('classifyTurnover: Granularität pro Slot/Automat — eine Klasse je Eingabezeile', () => {
  const slots = [1, 2, 3, 4, 5, 6, 7, 8].map((t, i) => slot(`VM0${(i % 2) + 1}:${10 + i}`, t));
  const out = classifyTurnover(slots);
  assert.equal(out.length, slots.length);
  for (const s of out) {
    assert.ok(['renner', 'normal', 'langsam_dreher', 'ladenhueter'].includes(s.turnover_class));
    assert.ok(s.machine_id && s.mdb_code, 'Slot-Identität bleibt erhalten');
  }
});

// ── Ladenhüter-Sonderregel (0 Verkäufe seit ≥ 30 Tagen) ───────────────────────

test('classifyTurnover: ≥30 Tage ohne Verkauf = ladenhueter, unabhängig von der Quartilseinordnung', () => {
  // Slot mit eigentlich hoher Drehzahl, aber letzter Verkauf vor 40 Tagen.
  const slots = [
    slot('VM01:10', 100, 40), // würde sonst renner sein
    slot('VM01:11', 5, 1),
    slot('VM01:12', 4, 1),
    slot('VM01:13', 3, 1),
    slot('VM01:14', 2, 1),
  ];
  const out = classifyTurnover(slots);
  assert.equal(out.find((s) => s.mdb_code === '10').turnover_class, 'ladenhueter');
});

test('classifyTurnover: Grenzfall genau 30 Tage = ladenhueter, 29 Tage nicht', () => {
  const base = [1, 2, 3, 4, 5, 6].map((t, i) => slot(`VM01:${20 + i}`, t, 1));
  const at30 = classifyTurnover([...base, slot('VM01:30', 5, 30)]);
  const at29 = classifyTurnover([...base, slot('VM01:31', 5, 29)]);
  assert.equal(at30.find((s) => s.mdb_code === '30').turnover_class, 'ladenhueter');
  assert.notEqual(at29.find((s) => s.mdb_code === '31').turnover_class, 'ladenhueter');
});

test('classifyTurnover: nie verkauft (daysSinceLastSale null) = ladenhueter', () => {
  const slots = [
    slot('VM01:10', 0, null),
    ...[1, 2, 3, 4].map((t, i) => slot(`VM01:${11 + i}`, t, 1)),
  ];
  const out = classifyTurnover(slots);
  assert.equal(out.find((s) => s.mdb_code === '10').turnover_class, 'ladenhueter');
});

// ── Zu wenige Datenpunkte für sinnvolle Quartile ──────────────────────────────

test('classifyTurnover: zu wenige aktive Slots (<4) → alle normal (keine Quartile)', () => {
  const slots = [slot('VM01:10', 1), slot('VM01:11', 50), slot('VM01:12', 99)];
  const out = classifyTurnover(slots);
  for (const s of out) assert.equal(s.turnover_class, 'normal');
});

test('classifyTurnover: keine Streuung (alle gleiche Drehzahl) → alle normal', () => {
  const slots = [5, 5, 5, 5, 5].map((t, i) => slot(`VM01:${10 + i}`, t));
  const out = classifyTurnover(slots);
  for (const s of out) assert.equal(s.turnover_class, 'normal');
});

test('classifyTurnover: leere Eingabe → leeres Array', () => {
  assert.deepEqual(classifyTurnover([]), []);
});

test('classifyTurnover: liest turnover_count, wenn turnover fehlt', () => {
  const slots = [10, 20, 30, 40, 50, 60, 70, 80].map((c, i) => ({
    machine_id: 'VM01', mdb_code: String(10 + i), turnover_count: c, daysSinceLastSale: 1,
  }));
  const out = classifyTurnover(slots);
  assert.equal(out.find((s) => s.mdb_code === '17').turnover_class, 'renner'); // 80
  assert.equal(out.find((s) => s.mdb_code === '10').turnover_class, 'langsam_dreher'); // 10
});

// ── Konfiguration / Definitionen (für /einstellungen + Glossar) ───────────────

test('SLOW_MOVER: Schwellwert Ladenhüter = 30 Tage, vier definierte Klassen', () => {
  assert.equal(SLOW_MOVER.ladenhueterDays, 30);
  const keys = SLOW_MOVER.classes.map((c) => c.key);
  assert.deepEqual(keys.sort(), ['ladenhueter', 'langsam_dreher', 'normal', 'renner']);
  for (const c of SLOW_MOVER.classes) {
    assert.ok(c.label && c.description, `Klasse ${c.key} braucht Label + Beschreibung`);
  }
});

test('quantile: lineare Interpolation, deterministisch', () => {
  const v = [1, 2, 3, 4, 5, 6, 7, 8];
  assert.equal(quantile(v, 0), 1);
  assert.equal(quantile(v, 1), 8);
  assert.equal(quantile(v, 0.25), 2.75);
  assert.equal(quantile(v, 0.75), 6.25);
});
