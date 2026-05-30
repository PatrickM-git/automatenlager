'use strict';
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');
const test   = require('node:test');

const { buildCockpitData } = require('../lib/cockpit.js');

/* ---- Fixtures ------------------------------------------------------------ */
const OVERVIEW_4PRIO = {
  metrics: {
    openWarningsCount: 2,
    mhdRiskCount:      1,
    lowStockCount:     3,
    revenueNetToday:   42.5,
    dbNetToday:        12.3,
    quantityToday:     15,
  },
  priorities: [
    { id: 'warnings-open', severity: 'critical', title: 'Offene Warnungen', message: '2 offene Warnung(en)', count: 2 },
    { id: 'mhd-risk',      severity: 'warning',  title: 'MHD-Risiko',       message: '1 Produkt(e) mit MHD-Risiko', count: 1 },
    { id: 'low-stock',     severity: 'warning',  title: 'Niedriger Bestand',message: '3 Slot(s) unter Zielbestand', count: 3 },
    { id: 'economics',     severity: 'info',     title: 'Wirtschaft heute',  message: '42,50 EUR Umsatz', count: 15 },
  ],
};
const MONITORING_RED = {
  ampels: [
    { key: 'postgres', state: 'green',  label: 'PostgreSQL', message: 'ok' },
    { key: 'n8n',      state: 'red',    label: 'n8n',        message: 'Container down' },
    { key: 'backups',  state: 'yellow', label: 'Backups',    message: 'stale' },
  ],
};

/* ---- AC-CC1: Top-3-Limit ------------------------------------------------- */
test('AC-CC1: buildCockpitData limits topPriorities to 3 even when more exist', () => {
  const result = buildCockpitData(OVERVIEW_4PRIO, MONITORING_RED);
  assert.equal(result.topPriorities.length, 3);
});

/* ---- AC-CC2: Ampel — schlechtester Zustand gewinnt ----------------------- */
test('AC-CC2: buildCockpitData returns ampelState red when any ampel is red', () => {
  const result = buildCockpitData(OVERVIEW_4PRIO, MONITORING_RED);
  assert.equal(result.ampelState, 'red');
});

test('AC-CC2b: buildCockpitData returns ampelState yellow when no red but yellow present', () => {
  const mon = { ampels: [{ key: 'a', state: 'green' }, { key: 'b', state: 'yellow' }] };
  assert.equal(buildCockpitData(OVERVIEW_4PRIO, mon).ampelState, 'yellow');
});

test('AC-CC2c: buildCockpitData returns ampelState green when all ampels are green', () => {
  const mon = { ampels: [{ key: 'a', state: 'green' }, { key: 'b', state: 'green' }] };
  assert.equal(buildCockpitData(OVERVIEW_4PRIO, mon).ampelState, 'green');
});

/* ---- AC-CC3: KPI-Werte --------------------------------------------------- */
test('AC-CC3: buildCockpitData returns 4 KPIs with correct keys and values', () => {
  const result = buildCockpitData(OVERVIEW_4PRIO, MONITORING_RED);
  assert.equal(result.kpis.length, 4);
  assert.deepEqual(result.kpis.map((k) => k.key), ['warnings', 'mhd-risk', 'low-stock', 'revenue']);

  const warn = result.kpis.find((k) => k.key === 'warnings');
  assert.equal(warn.value, 2);

  const rev = result.kpis.find((k) => k.key === 'revenue');
  assert.equal(rev.value, 42.5);
  assert.equal(rev.unit, 'EUR');
});

/* ---- AC-CC4: Robustheit mit leeren Daten --------------------------------- */
test('AC-CC4: buildCockpitData handles empty input gracefully', () => {
  const result = buildCockpitData({}, {});
  assert.equal(result.topPriorities.length, 0);
  assert.equal(result.ampelState, 'green');
  assert.equal(result.kpis.length, 4);
  assert.equal(result.kpis.find((k) => k.key === 'warnings').value, 0);
});

/* ---- AC-CC5: v3.js enthält renderCockpitPage ----------------------------- */
test('AC-CC5: v3.js defines renderCockpitPage function', () => {
  const js = fs.readFileSync(path.join(process.cwd(), 'public', 'v3.js'), 'utf8');
  assert.match(js, /renderCockpitPage/, 'v3.js must define renderCockpitPage');
});

/* ---- AC-CC6: v3.js ruft /api/v2/overview + /api/v2/monitoring auf ------- */
test('AC-CC6: v3.js fetches /api/v2/overview and /api/v2/monitoring for heute', () => {
  const js = fs.readFileSync(path.join(process.cwd(), 'public', 'v3.js'), 'utf8');
  assert.match(js, /\/api\/v2\/overview/,   'v3.js must fetch /api/v2/overview');
  assert.match(js, /\/api\/v2\/monitoring/, 'v3.js must fetch /api/v2/monitoring');
});

/* ---- AC-CC7: v3.css enthält Cockpit-Klassen ------------------------------ */
test('AC-CC7: v3.css defines cockpit layout and component classes', () => {
  const css = fs.readFileSync(path.join(process.cwd(), 'public', 'v3.css'), 'utf8');
  assert.match(css, /\.v3-cockpit-kpis/,   'missing .v3-cockpit-kpis');
  assert.match(css, /\.v3-cockpit-ampel/,  'missing .v3-cockpit-ampel');
  assert.match(css, /\.v3-cockpit-action/, 'missing .v3-cockpit-action');
});
