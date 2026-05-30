'use strict';
const assert = require('node:assert/strict');
const test   = require('node:test');

const { resolvePeriod, buildEconomicsData } = require('../lib/economics.js');
const { aggregateTopProducts, buildLineSeries } = require('../lib/guv-chart.js');

/* =========================================================================
   Issue #5 [v3-E] — GuV & Zeitraum-Wähler (Monat/Quartal/Jahr/Custom)
   Backend: resolvePeriod + buildEconomicsData additiv erweitern.
   ========================================================================= */

/* ---- AC: Quartal liefert korrekte Monatsgrenzen ------------------------- */

test('AC-Q: resolvePeriod mode=quarter resolves to the 3 months of Q2', () => {
  const p = resolvePeriod({ mode: 'quarter', year: '2026', quarter: '2' });
  assert.equal(p.from, '2026-04');
  assert.equal(p.to, '2026-06');
});

test('AC-Q: resolvePeriod mode=quarter handles Q1 and Q4 boundaries', () => {
  const q1 = resolvePeriod({ mode: 'quarter', year: '2026', quarter: '1' });
  assert.equal(q1.from, '2026-01');
  assert.equal(q1.to, '2026-03');
  const q4 = resolvePeriod({ mode: 'quarter', year: '2026', quarter: '4' });
  assert.equal(q4.from, '2026-10');
  assert.equal(q4.to, '2026-12');
});

/* ---- AC: Jahr liefert volle 12 Monate ----------------------------------- */

test('AC-Y: resolvePeriod mode=year spans January to December', () => {
  const p = resolvePeriod({ mode: 'year', year: '2025' });
  assert.equal(p.from, '2025-01');
  assert.equal(p.to, '2025-12');
});

/* ---- AC: Eigener Zeitraum (custom) -------------------------------------- */

test('AC-C: resolvePeriod mode=custom passes through given from/to range', () => {
  const p = resolvePeriod({ mode: 'custom', from: '2026-02', to: '2026-08' });
  assert.equal(p.from, '2026-02');
  assert.equal(p.to, '2026-08');
});

/* ---- AC (Regression, expliziter Testfall aus dem Issue):
   Fehlen die neuen Parameter -> exakt bisheriges Einzelmonats-Verhalten.  */

test('AC-R: resolvePeriod without new params keeps single-month behavior (from === to === current)', () => {
  const p = resolvePeriod({});
  assert.match(p.from, /^\d{4}-\d{2}$/);
  assert.match(p.to, /^\d{4}-\d{2}$/);
  assert.equal(p.from, p.to, 'default range must be a single month');
  assert.deepEqual(Object.keys(p).sort(), ['from', 'to'], 'period shape must stay {from, to}');
});

test('AC-R: invalid quarter/year falls back to single-month behavior', () => {
  const noYear = resolvePeriod({ mode: 'quarter', quarter: '2' });
  assert.equal(noYear.from, noYear.to, 'missing year must not produce a range');
  const badQuarter = resolvePeriod({ mode: 'quarter', year: '2026', quarter: '9' });
  assert.equal(badQuarter.from, badQuarter.to, 'invalid quarter must fall back to single month');
});

/* ---- AC: Monats-Zeitreihe für die Diagramme (Umsatz/GuV/Marge) ---------- */

const MULTI_MONTH_ROWS = [
  { product_id: 1, month: '2026-04-01', revenue_net: '100.00', revenue_gross: '107.00', db_net: '40.00', gross_profit: '45.00', qty: '10' },
  { product_id: 2, month: '2026-04-01', revenue_net: '50.00',  revenue_gross: '53.50',  db_net: '20.00', gross_profit: '22.00', qty: '5'  },
  { product_id: 1, month: '2026-05-01', revenue_net: '200.00', revenue_gross: '214.00', db_net: '80.00', gross_profit: '90.00', qty: '20' },
];

test('AC-S: buildEconomicsData adds a monthly series aggregating revenue/db across the period', () => {
  const result = buildEconomicsData(
    { byProduct: MULTI_MONTH_ROWS, bySlot: [], inventoryValue: [] },
    { mode: 'quarter', year: '2026', quarter: '2' },
  );
  assert.ok(Array.isArray(result.series), 'series must be an array');
  assert.equal(result.series.length, 2, 'two distinct months → two series points');

  const apr = result.series.find((s) => s.month === '2026-04');
  const may = result.series.find((s) => s.month === '2026-05');
  assert.equal(apr.revenue_net, 150.00, 'April revenue_net = 100 + 50');
  assert.equal(apr.db_net, 60.00, 'April db_net = 40 + 20');
  assert.equal(apr.revenue_gross, 160.50, 'April revenue_gross = 107 + 53.50');
  assert.equal(may.revenue_net, 200.00);
  assert.equal(may.db_net, 80.00);
});

test('AC-S: series is sorted ascending by month and carries a margin per month', () => {
  const result = buildEconomicsData(
    { byProduct: MULTI_MONTH_ROWS, bySlot: [], inventoryValue: [] },
    { mode: 'quarter', year: '2026', quarter: '2' },
  );
  assert.deepEqual(result.series.map((s) => s.month), ['2026-04', '2026-05']);
  const apr = result.series[0];
  // 60 / 150 * 100 = 40.0
  assert.equal(apr.margin_pct, 40.0);
});

test('AC-S: buildEconomicsData echoes the resolved mode (defaults to "month")', () => {
  const q = buildEconomicsData({ byProduct: [], bySlot: [], inventoryValue: [] }, { mode: 'quarter', year: '2026', quarter: '2' });
  assert.equal(q.mode, 'quarter');
  const d = buildEconomicsData({ byProduct: [], bySlot: [], inventoryValue: [] }, {});
  assert.equal(d.mode, 'month');
});

test('AC-S: series buckets pg timestamp months into the correct Berlin month', () => {
  // PostgreSQL liefert date_trunc('month',…)::DATE als Berlin-Mitternacht,
  // serialisiert nach JSON als UTC -> Vortag 22:00Z. Muss als Mai (2026-05) zählen.
  const rows = [
    { product_id: 1, month: '2026-04-30T22:00:00.000Z', revenue_net: '100', revenue_gross: '107', db_net: '40', gross_profit: '45', qty: '10' },
    { product_id: 2, month: '2026-04-30T22:00:00.000Z', revenue_net: '50',  revenue_gross: '53',  db_net: '20', gross_profit: '22', qty: '5'  },
  ];
  const result = buildEconomicsData({ byProduct: rows, bySlot: [], inventoryValue: [] }, {});
  assert.equal(result.series.length, 1, 'both rows fall into the same month');
  assert.equal(result.series[0].month, '2026-05', 'Berlin-midnight May 1 must bucket as 2026-05');
  assert.equal(result.series[0].revenue_gross, 160.00, '107 + 53');
});

test('AC-S: single-month data still produces a one-point series (backward compatible)', () => {
  const rows = [
    { product_id: 1, month: '2026-05-01', revenue_net: '120.50', db_net: '45.20', qty: '12' },
    { product_id: 2, month: '2026-05-01', revenue_net: '80.00',  db_net: '10.00', qty: '8'  },
  ];
  const result = buildEconomicsData({ byProduct: rows, bySlot: [], inventoryValue: [] }, {});
  assert.equal(result.series.length, 1);
  assert.equal(result.series[0].month, '2026-05');
  assert.equal(result.series[0].revenue_net, 200.50);
});

/* =========================================================================
   Top-N-Tabelle: Produkte über den Zeitraum aggregieren + ranken
   ========================================================================= */

test('AC-T: aggregateTopProducts sums a product across months and ranks by revenue_gross', () => {
  const rows = [
    { product_id: 1, product_name: 'Snickers', revenue_net: 100, db_net: 40, revenue_gross: 107,  gross_profit: 45, qty: 10 },
    { product_id: 1, product_name: 'Snickers', revenue_net: 200, db_net: 80, revenue_gross: 214,  gross_profit: 90, qty: 20 },
    { product_id: 2, product_name: 'Twix',     revenue_net: 50,  db_net: 20, revenue_gross: 53.5, gross_profit: 22, qty: 5  },
  ];
  const top = aggregateTopProducts(rows, { limit: 10 });
  assert.equal(top.length, 2, 'two distinct products');
  assert.equal(top[0].product_name, 'Snickers');
  assert.equal(top[0].revenue_gross, 321.00, '107 + 214');
  assert.equal(top[0].gross_profit, 135.00, '45 + 90');
  assert.equal(top[0].qty, 30);
  assert.equal(top[0].margin_gross_pct, 42.1, '135 / 321 * 100');
});

test('AC-T: aggregateTopProducts respects the Top-N limit', () => {
  const rows = [
    { product_id: 1, product_name: 'A', revenue_gross: 300, gross_profit: 100, qty: 3 },
    { product_id: 2, product_name: 'B', revenue_gross: 200, gross_profit: 80,  qty: 2 },
    { product_id: 3, product_name: 'C', revenue_gross: 100, gross_profit: 40,  qty: 1 },
  ];
  const top = aggregateTopProducts(rows, { limit: 2 });
  assert.deepEqual(top.map((r) => r.product_name), ['A', 'B']);
});

/* =========================================================================
   Zeitreihen-Linienchart: Werte deterministisch in SVG-Koordinaten mappen
   ========================================================================= */

test('AC-T: buildLineSeries maps values into the drawing box (max→top, min→bottom)', () => {
  const series = [
    { month: '2026-04', revenue_gross: 100 },
    { month: '2026-05', revenue_gross: 300 },
    { month: '2026-06', revenue_gross: 200 },
  ];
  const chart = buildLineSeries(series, 'revenue_gross', { width: 300, height: 100, pad: 10 });
  assert.equal(chart.points.length, 3);
  assert.equal(chart.min, 100);
  assert.equal(chart.max, 300);
  assert.equal(chart.points[0].x, 10,  'first point at left pad');
  assert.equal(chart.points[2].x, 290, 'last point at width - pad');
  assert.equal(chart.points[1].y, 10,  'max value maps to top (y = pad)');
  assert.equal(chart.points[0].y, 90,  'min value maps to bottom (y = height - pad)');
  assert.ok(typeof chart.path === 'string' && chart.path.indexOf('M') === 0, 'path is an SVG path string');
  assert.ok(chart.area.indexOf('Z') > 0, 'area path is closed');
});

test('AC-T: buildLineSeries handles a single data point without dividing by zero', () => {
  const chart = buildLineSeries([{ month: '2026-05', revenue_gross: 50 }], 'revenue_gross', { width: 200, height: 80, pad: 8 });
  assert.equal(chart.points.length, 1);
  assert.ok(Number.isFinite(chart.points[0].x));
  assert.ok(Number.isFinite(chart.points[0].y));
});

test('AC-T: buildLineSeries returns empty structure for empty series', () => {
  const chart = buildLineSeries([], 'revenue_gross', { width: 200, height: 80, pad: 8 });
  assert.deepEqual(chart.points, []);
  assert.equal(chart.path, '');
});

/* =========================================================================
   AC-UI: /guv-Seite in der v3-Shell (statische Struktur-Checks)
   ========================================================================= */

const fs   = require('node:fs');
const path = require('node:path');

function v3js()  { return fs.readFileSync(path.join(process.cwd(), 'public', 'v3.js'),  'utf8'); }
function v3css() { return fs.readFileSync(path.join(process.cwd(), 'public', 'v3.css'), 'utf8'); }

test('AC-UI: v3.js renders a real GuV page (not the placeholder)', () => {
  const js = v3js();
  assert.match(js, /renderGuvPage/, 'v3.js must define renderGuvPage');
  assert.match(js, /\/api\/v2\/economics/, 'GuV page must load the economics endpoint');
});

test('AC-UI: v3.js sends the period mode to the economics endpoint', () => {
  const js = v3js();
  assert.match(js, /mode=/, 'economics URL must include mode param');
  for (const mode of ['month', 'quarter', 'year', 'custom']) {
    assert.match(js, new RegExp(`['"]${mode}['"]`), `period mode "${mode}" must be referenced`);
  }
});

test('AC-UI: v3.js period picker exposes selectable period buttons', () => {
  const js = v3js();
  assert.match(js, /data-period=/, 'period picker must expose data-period buttons');
});

test('AC-UI: v3.js GuV page renders gross figures (Brutto wie Legacy) and margin', () => {
  const js = v3js();
  assert.match(js, /revenue_gross/, 'must show gross revenue');
  assert.match(js, /margin_gross_pct/, 'must show gross margin');
});

test('AC-UI: v3.js GuV page draws a time-series line/area chart from series', () => {
  const js = v3js();
  assert.match(js, /series/, 'GuV page must consume the series field');
  assert.match(js, /renderLineChartSvg|buildLineSeries/, 'GuV page must render a line chart');
});

test('AC-UI: v3.css defines GuV page styles consistent with v3 tokens', () => {
  const css = v3css();
  assert.match(css, /\.v3-guv/, 'v3.css must define .v3-guv styles');
  assert.match(css, /\.v3-guv-period/, 'v3.css must style the period picker');
  assert.match(css, /\.v3-guv-line|\.v3-guv-area/, 'v3.css must style the time-series chart');
});

test('AC-UI: chart points expose hover targets with a value tooltip', () => {
  const js = v3js();
  assert.match(js, /v3-guv-pt/, 'chart must render hoverable point groups');
  assert.match(js, /v3-guv-pt__tip/, 'chart must render a tooltip per point');
});

test('AC-UI: v3.css styles the chart hover tooltip (revealed on hover)', () => {
  const css = v3css();
  assert.match(css, /\.v3-guv-pt__tip/, 'v3.css must style the chart tooltip');
  assert.match(css, /\.v3-guv-pt:hover/, 'tooltip must be revealed on hover');
});

test('AC-UI: GuV page shows the active period range label', () => {
  const js = v3js();
  assert.match(js, /v3-guv-range/, 'page must render a visible period range label');
});
