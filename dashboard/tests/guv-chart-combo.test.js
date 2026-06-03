'use strict';

// TDD für Issue #57: GuV-Charts aufwerten.
// Testbare Geometrie-Bausteine in lib/guv-chart.js (v3.js spiegelt die Logik):
//  - buildCumulative: kumulierte Gewinnlinie für den Tagesverlauf
//  - buildStackedBars: Aufteilung je Periode in Wareneinsatz (unten) + Gewinn
//    (oben) für das Kombi-Balkenchart im Monats-/Jahresvergleich

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildCumulative, buildStackedBars } = require('../lib/guv-chart.js');

test('buildCumulative: laufende Summe je Bucket', () => {
  const series = [
    { month: '2026-06-01', gross_profit: 10 },
    { month: '2026-06-02', gross_profit: 5 },
    { month: '2026-06-03', gross_profit: -3 },
  ];
  const out = buildCumulative(series, 'gross_profit');
  assert.deepEqual(out.map((d) => d.cumulative), [10, 15, 12]);
  assert.equal(out[0].month, '2026-06-01');
  assert.equal(out[1].value, 5);
});

test('buildCumulative: leere/fehlende Reihe -> []', () => {
  assert.deepEqual(buildCumulative([], 'gross_profit'), []);
  assert.deepEqual(buildCumulative(null, 'gross_profit'), []);
});

test('buildStackedBars: total = Wareneinsatz (unten) + Gewinn (oben)', () => {
  const series = [
    { month: '2026-01', revenue_gross: 100, gross_profit: 30 },
    { month: '2026-02', revenue_gross: 50, gross_profit: 20 },
  ];
  const out = buildStackedBars(series, { totalKey: 'revenue_gross', profitKey: 'gross_profit' });
  assert.equal(out[0].total, 100);
  assert.equal(out[0].profit, 30);
  assert.equal(out[0].cost, 70); // 100 - 30
  assert.equal(out[0].cost + out[0].profit, out[0].total);
  assert.equal(out[1].cost, 30);
});

test('buildStackedBars: Verlust (Gewinn < 0) -> Gewinn 0, Wareneinsatz <= total', () => {
  const series = [{ month: '2026-03', revenue_gross: 40, gross_profit: -10 }];
  const out = buildStackedBars(series, { totalKey: 'revenue_gross', profitKey: 'gross_profit' });
  assert.equal(out[0].profit, 0);
  assert.equal(out[0].cost, 40); // ganzer Balken = Kosten, kein Gewinnsegment
  assert.ok(out[0].cost <= out[0].total + 1e-9);
});

test('buildStackedBars: Gewinn größer als Umsatz wird auf total gedeckelt', () => {
  const series = [{ month: '2026-04', revenue_gross: 20, gross_profit: 25 }];
  const out = buildStackedBars(series, { totalKey: 'revenue_gross', profitKey: 'gross_profit' });
  assert.equal(out[0].profit, 20);
  assert.equal(out[0].cost, 0);
});

test('buildStackedBars: leere Reihe -> []', () => {
  assert.deepEqual(buildStackedBars([], { totalKey: 'revenue_gross', profitKey: 'gross_profit' }), []);
});
