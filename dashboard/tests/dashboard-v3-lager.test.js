'use strict';
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');
const test   = require('node:test');

const { buildLagerData }    = require('../lib/lager.js');
const { buildBarChartData } = require('../lib/svg-chart.js');

/* ---- Fixtures ------------------------------------------------------------ */

const RAW_ROWS = [
  {
    batch_id: 10, batch_key: 'B10',
    product_id: 1, product_name: 'Snickers',
    mhd_date: '2026-05-20', remaining_qty: '3',
    warning_type: 'MHD_EXPIRED', warning_severity: 'critical',
    warning_message: 'MHD überschritten',
    machine_id: 'VM01', machine_name: 'Faltrix Mini',
    location_name: 'Kantine', mdb_code: '12',
  },
  {
    batch_id: 11, batch_key: 'B11',
    product_id: 2, product_name: 'Kitkat Chunky',
    mhd_date: '2026-06-20', remaining_qty: '9',
    warning_type: 'MHD_NEAR', warning_severity: 'warning',
    warning_message: 'MHD bald erreicht',
    machine_id: 'VM01', machine_name: 'Faltrix Mini',
    location_name: 'Kantine', mdb_code: '13',
  },
  {
    batch_id: 12, batch_key: 'B12',
    product_id: 3, product_name: 'Twix',
    mhd_date: '2026-09-01', remaining_qty: '20',
    warning_type: 'OK', warning_severity: 'info',
    warning_message: '',
    machine_id: 'VM02', machine_name: 'Faltrix Maxi',
    location_name: 'Eingang', mdb_code: '21',
    slow_mover_class: 'slow',
  },
];

/* =========================================================================
   AC-L2: buildLagerData – Parsing
   ========================================================================= */

test('AC-L2: buildLagerData returns cards array with correct fields', () => {
  const { cards, summary } = buildLagerData(RAW_ROWS);

  assert.equal(cards.length, 3, 'should return one card per row');

  const snickers = cards.find(c => c.product_name === 'Snickers');
  assert.ok(snickers, 'Snickers card must exist');
  assert.equal(snickers.batch_id, 10);
  assert.equal(snickers.remaining_qty, 3, 'remaining_qty must be numeric');
  assert.equal(snickers.severity, 'critical');
  assert.equal(snickers.machine_id, 'VM01');
  assert.equal(snickers.mhd_date, '2026-05-20');
});

test('AC-L2b: buildLagerData returns correct summary counts', () => {
  const { summary } = buildLagerData(RAW_ROWS);
  assert.equal(summary.total, 3);
  assert.equal(summary.critical, 1);
  assert.equal(summary.warning, 1);
});

test('AC-L2c: buildLagerData handles empty input', () => {
  const { cards, summary } = buildLagerData([]);
  assert.equal(cards.length, 0);
  assert.equal(summary.total, 0);
  assert.equal(summary.critical, 0);
  assert.equal(summary.warning, 0);
});

test('AC-L2d: buildLagerData handles null/undefined input', () => {
  const { cards } = buildLagerData(null);
  assert.equal(cards.length, 0);
});

/* =========================================================================
   AC-L3: Filter by severity / Dringlichkeit
   ========================================================================= */

test('AC-L3: filter severity=critical returns only critical cards', () => {
  const { cards, summary } = buildLagerData(RAW_ROWS, { severity: 'critical' });
  assert.equal(cards.length, 1);
  assert.ok(cards.every(c => c.severity === 'critical'));
  assert.equal(summary.total, 1);
});

test('AC-L3b: filter severity=warning returns only warning cards', () => {
  const { cards } = buildLagerData(RAW_ROWS, { severity: 'warning' });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].product_name, 'Kitkat Chunky');
});

test('AC-L3c: filter severity=null returns all cards', () => {
  const { cards } = buildLagerData(RAW_ROWS, { severity: null });
  assert.equal(cards.length, 3);
});

/* =========================================================================
   AC-L4: Filter by machine / Automat
   ========================================================================= */

test('AC-L4: filter machine_id returns only cards of that machine', () => {
  const { cards } = buildLagerData(RAW_ROWS, { machine_id: 'VM02' });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].product_name, 'Twix');
});

test('AC-L4b: filter machine_id=null returns all cards', () => {
  const { cards } = buildLagerData(RAW_ROWS, { machine_id: null });
  assert.equal(cards.length, 3);
});

/* =========================================================================
   AC-L5: Filter by product
   ========================================================================= */

test('AC-L5: filter product_id returns only cards of that product', () => {
  const { cards } = buildLagerData(RAW_ROWS, { product_id: 2 });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].product_name, 'Kitkat Chunky');
});

/* =========================================================================
   AC-L6: Filter synced — same filtered rows for table AND chart context
   ========================================================================= */

test('AC-L6: combined filters restrict cards consistently', () => {
  const { cards: vm01 } = buildLagerData(RAW_ROWS, { machine_id: 'VM01' });
  const { cards: vm01crit } = buildLagerData(RAW_ROWS, { machine_id: 'VM01', severity: 'critical' });
  // VM01 has 2 rows; applying severity=critical must further reduce to 1
  assert.equal(vm01.length, 2);
  assert.equal(vm01crit.length, 1);
  // The single filtered card is consistent — same data either way
  assert.equal(vm01crit[0].product_name, vm01.find(c => c.severity === 'critical').product_name);
});

/* =========================================================================
   AC-L7: Slow-Mover-Badge – Feld wird durchgereicht
   ========================================================================= */

test('AC-L7: slow_mover_class is passed through when present', () => {
  const { cards } = buildLagerData(RAW_ROWS);
  const twix = cards.find(c => c.product_name === 'Twix');
  assert.equal(twix.slow_mover_class, 'slow');
});

test('AC-L7b: slow_mover_class is null when not present in row', () => {
  const { cards } = buildLagerData(RAW_ROWS);
  const snickers = cards.find(c => c.product_name === 'Snickers');
  assert.equal(snickers.slow_mover_class, null);
});

/* =========================================================================
   AC-L8: buildBarChartData – SVG-kompatible Datenstruktur
   ========================================================================= */

const CHART_ITEMS = [
  { product_name: 'Snickers',      remaining_qty: 3,  severity: 'critical' },
  { product_name: 'Kitkat Chunky', remaining_qty: 9,  severity: 'warning'  },
  { product_name: 'Twix',          remaining_qty: 20, severity: 'info'     },
];

test('AC-L8: buildBarChartData returns bars array and max', () => {
  const { bars, max } = buildBarChartData(CHART_ITEMS, {
    labelKey: 'product_name',
    valueKey: 'remaining_qty',
  });

  assert.equal(typeof max, 'number', 'max must be a number');
  assert.ok(Array.isArray(bars), 'bars must be an array');
  assert.ok(bars.length > 0);
  assert.ok(bars.every(b => 'label' in b && 'value' in b && 'pct' in b));
});

test('AC-L8b: buildBarChartData sorts bars by value descending', () => {
  const { bars } = buildBarChartData(CHART_ITEMS, {
    labelKey: 'product_name',
    valueKey: 'remaining_qty',
  });
  assert.equal(bars[0].label, 'Twix', 'highest value must be first');
  assert.equal(bars[bars.length - 1].label, 'Snickers', 'lowest value must be last');
});

test('AC-L8c: buildBarChartData top bar always has pct=100', () => {
  const { bars, max } = buildBarChartData(CHART_ITEMS, {
    labelKey: 'product_name',
    valueKey: 'remaining_qty',
  });
  assert.equal(bars[0].pct, 100, 'top bar must be 100%');
  assert.equal(max, 20);
});

test('AC-L8d: buildBarChartData preserves severity field', () => {
  const { bars } = buildBarChartData(CHART_ITEMS, {
    labelKey: 'product_name',
    valueKey: 'remaining_qty',
  });
  const snickers = bars.find(b => b.label === 'Snickers');
  assert.equal(snickers.severity, 'critical');
});

/* =========================================================================
   AC-L9: buildBarChartData – Robustheit
   ========================================================================= */

test('AC-L9: buildBarChartData handles empty array', () => {
  const { bars, max } = buildBarChartData([], { labelKey: 'l', valueKey: 'v' });
  assert.deepEqual(bars, []);
  assert.equal(max, 0);
});

test('AC-L9b: buildBarChartData respects maxBars limit', () => {
  const items = Array.from({ length: 15 }, (_, i) => ({ l: `P${i}`, v: i + 1 }));
  const { bars } = buildBarChartData(items, { labelKey: 'l', valueKey: 'v', maxBars: 8 });
  assert.ok(bars.length <= 8, 'must not exceed maxBars');
});

/* =========================================================================
   AC-L10: v3.js defines renderLagerPage
   ========================================================================= */

test('AC-L10: v3.js defines renderLagerPage function', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'public', 'v3.js'), 'utf8');
  assert.match(src, /function renderLagerPage\s*\(/,
    'v3.js must define renderLagerPage function');
});

/* =========================================================================
   AC-L11: v3.css defines required lager CSS classes
   ========================================================================= */

test('AC-L11: v3.css defines lager card and filter classes', () => {
  const css = fs.readFileSync(path.join(process.cwd(), 'public', 'v3.css'), 'utf8');
  assert.match(css, /\.v3-lager-card\s*\{/, '.v3-lager-card must be defined');
  assert.match(css, /\.v3-lager-card--crit/, '.v3-lager-card--crit variant must be defined');
  assert.match(css, /\.v3-lager-card--warn/, '.v3-lager-card--warn variant must be defined');
  assert.match(css, /\.v3-badge--slow-mover\s*\{/, '.v3-badge--slow-mover must be defined');
  assert.match(css, /\.v3-lager-bar\s*\{/, '.v3-lager-bar filter bar must be defined');
  assert.match(css, /\.v3-lager-chart-panel\s*\{/, '.v3-lager-chart-panel must be defined');
  assert.match(css, /\.v3-lager-grid\s*\{/, '.v3-lager-grid must be defined');
});
