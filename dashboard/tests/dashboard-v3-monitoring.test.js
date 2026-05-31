'use strict';
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');
const test   = require('node:test');

const { buildMonitoringView } = require('../lib/monitoring-view.js');

/* ---- Fixtures ------------------------------------------------------------ */
const MONITORING_MIXED = {
  stale: { isStale: false },
  warnings: [
    { warning_id: 1, message: 'MHD-Risiko Slot 11' },
    { warning_id: 2, message: 'Niedriger Bestand Slot 23' },
  ],
  ampels: [
    { key: 'postgres',   label: 'PostgreSQL',  state: 'green',  message: 'Verbindung ok' },
    { key: 'n8n',        label: 'n8n',         state: 'red',    message: 'Container down' },
    { key: 'backups',    label: 'Backups',     state: 'yellow', message: 'Noch kein BACKUP_OK' },
    { key: 'validation', label: 'Validierung', state: 'green',  message: 'Keine Drift' },
    { key: 'workflows',  label: 'Workflows',   state: 'green',  message: 'Keine Fehler' },
    { key: 'monitoring', label: 'Monitoring',  state: 'yellow', message: 'Daten veraltet' },
  ],
};
const CORRECTION_CASES = [
  { case_id: 'warning_1', case_type: 'correction_warning', machine_id: 'M1', mdb_code: 11, message: 'Falscher Treffer' },
  { case_id: 'unknown_x', case_type: 'unknown_product',    machine_id: 'M2', mdb_code: 23, message: 'Unbekanntes Produkt' },
];

/* ---- AC-M1: Gesamt-Ampel = schlechtester Zustand ------------------------- */
test('AC-M1: buildMonitoringView overallState is red when any ampel is red', () => {
  const view = buildMonitoringView(MONITORING_MIXED, CORRECTION_CASES);
  assert.equal(view.overallState, 'red');
});

test('AC-M1b: overallState is yellow when no red but yellow present', () => {
  const mon = { ampels: [{ key: 'a', state: 'green' }, { key: 'b', state: 'yellow' }] };
  assert.equal(buildMonitoringView(mon, []).overallState, 'yellow');
});

test('AC-M1c: overallState is green when all ampels are green', () => {
  const mon = { ampels: [{ key: 'a', state: 'green' }, { key: 'b', state: 'green' }] };
  assert.equal(buildMonitoringView(mon, []).overallState, 'green');
});

/* ---- AC-M2: Zähler je Zustand -------------------------------------------- */
test('AC-M2: buildMonitoringView counts ampels per state', () => {
  const view = buildMonitoringView(MONITORING_MIXED, CORRECTION_CASES);
  assert.deepEqual(view.counts, { red: 1, yellow: 2, green: 3 });
  assert.equal(view.total, 6);
});

/* ---- AC-M3: Kompakte Verteilung für die Visualisierung ------------------- */
test('AC-M3: distribution is a compact ordered series suitable for a chart', () => {
  const view = buildMonitoringView(MONITORING_MIXED, CORRECTION_CASES);
  assert.deepEqual(view.distribution, [
    { state: 'red',    count: 1 },
    { state: 'yellow', count: 2 },
    { state: 'green',  count: 3 },
  ]);
});

/* ---- AC-M4: Filterbar nach Zustand --------------------------------------- */
test('AC-M4: stateFilter narrows the ampel list but leaves counts/overall intact', () => {
  const view = buildMonitoringView(MONITORING_MIXED, CORRECTION_CASES, { stateFilter: 'yellow' });
  assert.equal(view.ampels.length, 2);
  assert.ok(view.ampels.every((a) => a.state === 'yellow'));
  // Zähler und Gesamt-Ampel spiegeln IMMER den Gesamtbestand, nicht den Filter
  assert.deepEqual(view.counts, { red: 1, yellow: 2, green: 3 });
  assert.equal(view.overallState, 'red');
  assert.equal(view.activeFilter, 'yellow');
});

test('AC-M4b: stateFilter "all" (oder fehlend) zeigt alle Ampeln', () => {
  const all = buildMonitoringView(MONITORING_MIXED, CORRECTION_CASES, { stateFilter: 'all' });
  assert.equal(all.ampels.length, 6);
  assert.equal(all.activeFilter, 'all');
});

/* ---- AC-M5: Korrekturfälle-Integration ----------------------------------- */
test('AC-M5: buildMonitoringView integrates open correction cases', () => {
  const view = buildMonitoringView(MONITORING_MIXED, CORRECTION_CASES);
  assert.equal(view.correction.openCount, 2);
  assert.equal(view.correction.cases.length, 2);
  assert.equal(view.correction.cases[0].case_id, 'warning_1');
});

test('AC-M5b: no correction cases yields openCount 0', () => {
  const view = buildMonitoringView(MONITORING_MIXED, []);
  assert.equal(view.correction.openCount, 0);
  assert.deepEqual(view.correction.cases, []);
});

/* ---- AC-M6: Warnungen werden mitgezählt ---------------------------------- */
test('AC-M6: buildMonitoringView exposes warnings count and list', () => {
  const view = buildMonitoringView(MONITORING_MIXED, CORRECTION_CASES);
  assert.equal(view.warningsCount, 2);
  assert.equal(view.warnings.length, 2);
});

/* ---- AC-M7: Robustheit bei leeren/fehlenden Daten ------------------------ */
test('AC-M7: buildMonitoringView handles empty input gracefully', () => {
  const view = buildMonitoringView({}, undefined);
  assert.equal(view.overallState, 'green');
  assert.deepEqual(view.counts, { red: 0, yellow: 0, green: 0 });
  assert.equal(view.total, 0);
  assert.equal(view.correction.openCount, 0);
  assert.equal(view.warningsCount, 0);
  assert.equal(view.ampels.length, 0);
});

/* ---- AC-M8: Unbekannte Ampel-Zustände kippen nicht das Ergebnis ---------- */
test('AC-M8: unknown ampel states are ignored for severity, not counted as red', () => {
  const mon = { ampels: [{ key: 'a', state: 'green' }, { key: 'b', state: 'unknown' }] };
  const view = buildMonitoringView(mon, []);
  assert.equal(view.overallState, 'green');
  assert.equal(view.counts.red, 0);
});

/* ---- AC-M9: Frontend-Wiring (statische Präsenz) -------------------------- */
test('AC-M9: v3.js defines renderMonitoringPage and fetches monitoring + correction endpoints', () => {
  const js = fs.readFileSync(path.join(process.cwd(), 'public', 'v3.js'), 'utf8');
  assert.match(js, /renderMonitoringPage/, 'v3.js must define renderMonitoringPage');
  assert.match(js, /\/api\/v2\/monitoring/, 'v3.js must fetch /api/v2/monitoring');
  assert.match(js, /\/api\/v2\/correction-cases/, 'v3.js must fetch /api/v2/correction-cases');
  assert.match(js, /\/api\/v2\/correction-action\//, 'v3.js must reuse the correction-action flow');
});

test('AC-M10: v3.css defines monitoring layout classes', () => {
  const css = fs.readFileSync(path.join(process.cwd(), 'public', 'v3.css'), 'utf8');
  assert.match(css, /\.v3-mon-/, 'v3.css must define .v3-mon-* monitoring classes');
});
