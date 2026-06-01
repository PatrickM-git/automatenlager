'use strict';
const assert = require('node:assert/strict');
const test   = require('node:test');

const {
  buildEconomicsData,
  parseMachineFilter,
  buildSeriesFromBuckets,
  dayKeyBerlin,
} = require('../lib/economics.js');
const { buildEconomicsScope } = require('../lib/automaten-view.js');
const {
  buildReportTotals,
  buildReportCsv,
  buildReportFilename,
  formatDeNumber,
} = require('../lib/reports.js');

/* =========================================================================
   GuV-Verbesserungen: Tagesverlauf, Standort/Automat-Filter, Brutto-Export
   ========================================================================= */

/* ---- parseMachineFilter (Standort/Automat-Mehrfachauswahl) -------------- */

test('parseMachineFilter: null/leer -> leeres Array', () => {
  assert.deepEqual(parseMachineFilter(null), []);
  assert.deepEqual(parseMachineFilter(''), []);
  assert.deepEqual(parseMachineFilter(undefined), []);
});

test('parseMachineFilter: kommaseparierter String -> getrimmte Liste', () => {
  assert.deepEqual(parseMachineFilter('VM01,VM02 , VM03'), ['VM01', 'VM02', 'VM03']);
});

test('parseMachineFilter: Array wird dedupliziert und getrimmt', () => {
  assert.deepEqual(parseMachineFilter(['VM01', ' VM01 ', 'VM02', '']), ['VM01', 'VM02']);
});

/* ---- dayKeyBerlin ------------------------------------------------------- */

test('dayKeyBerlin: reiner Datumsstring wird durchgereicht', () => {
  assert.equal(dayKeyBerlin('2026-05-15'), '2026-05-15');
});

test('dayKeyBerlin: UTC-Zeitstempel wird in den Berliner Tag gebucht', () => {
  // 15.05. 22:00Z = 16.05. 00:00 Berlin (CEST, UTC+2)
  assert.equal(dayKeyBerlin('2026-05-15T22:00:00.000Z'), '2026-05-16');
});

test('dayKeyBerlin: ungültiger Wert -> leerer String', () => {
  assert.equal(dayKeyBerlin('keinDatum'), '');
  assert.equal(dayKeyBerlin(null), '');
});

/* ---- buildSeriesFromBuckets (Tages-/Monats-Serie) ---------------------- */

const DAY_BUCKETS = [
  { bucket: '2026-05-02', revenue_net: '20', db_net: '8',  revenue_gross: '21.40', gross_profit: '9',  qty: '2' },
  { bucket: '2026-05-01', revenue_net: '10', db_net: '4',  revenue_gross: '10.70', gross_profit: '4.5', qty: '1' },
];

test('buildSeriesFromBuckets: Tagesgranularität liefert sortierte Tagespunkte', () => {
  const series = buildSeriesFromBuckets(DAY_BUCKETS, 'day');
  assert.equal(series.length, 2);
  assert.deepEqual(series.map((s) => s.month), ['2026-05-01', '2026-05-02']);
  assert.equal(series[0].revenue_gross, 10.70);
  assert.equal(series[1].gross_profit, 9);
});

test('buildSeriesFromBuckets: Monatsgranularität verdichtet auf YYYY-MM', () => {
  const rows = [
    { bucket: '2026-04-01', revenue_gross: '100', gross_profit: '40', revenue_net: '90', db_net: '36', qty: '10' },
    { bucket: '2026-05-01', revenue_gross: '200', gross_profit: '80', revenue_net: '180', db_net: '72', qty: '20' },
  ];
  const series = buildSeriesFromBuckets(rows, 'month');
  assert.deepEqual(series.map((s) => s.month), ['2026-04', '2026-05']);
});

test('buildSeriesFromBuckets: margin_gross_pct wird je Bucket berechnet', () => {
  const series = buildSeriesFromBuckets(
    [{ bucket: '2026-05-01', revenue_gross: '200', gross_profit: '50', revenue_net: '0', db_net: '0', qty: '5' }],
    'day',
  );
  assert.equal(series[0].margin_gross_pct, 25.0); // 50 / 200 * 100
});

/* ---- buildEconomicsData: nutzt Bucket-Serie, bleibt rückwärtskompatibel - */

test('buildEconomicsData: mit pgRows.series (day) entsteht eine Tagesserie', () => {
  const result = buildEconomicsData(
    {
      byProduct: [{ product_id: 1, month: '2026-05-01', revenue_gross: '32.10', gross_profit: '13.5', revenue_net: '30', db_net: '12', qty: '3' }],
      bySlot: [],
      inventoryValue: [],
      series: DAY_BUCKETS,
      granularity: 'day',
    },
    { mode: 'month', from: '2026-05', to: '2026-05' },
  );
  assert.equal(result.granularity, 'day');
  assert.equal(result.series.length, 2);
  assert.deepEqual(result.series.map((s) => s.month), ['2026-05-01', '2026-05-02']);
});

test('buildEconomicsData: ohne pgRows.series bleibt es monatlich (Regression)', () => {
  const result = buildEconomicsData(
    {
      byProduct: [{ product_id: 1, month: '2026-05-01', revenue_net: '120.50', db_net: '45.20', qty: '12' }],
      bySlot: [],
      inventoryValue: [],
    },
    {},
  );
  assert.equal(result.granularity, 'month');
  assert.equal(result.series.length, 1);
  assert.equal(result.series[0].month, '2026-05');
});

/* ---- buildEconomicsScope (Auswahlbaum aus gejointen machines-Zeilen) ---- */

test('buildEconomicsScope: eine Zeile je Automat → interne ID + Profil-Label + Standort', () => {
  // Reale Datenlage: machines.machine_id="1" (= guv_daily), machine_key=Nayax-Nr,
  // Profil per machine_key drangejoint. Muss GENAU EINEN Automaten ergeben.
  const scope = buildEconomicsScope([
    { machine_id: '1', machine_key: '457107528', location_id: '1', location_name: 'DPFA Weiterbildung Chemnitz', area: '2.OG', type: 'Kombi', position: null, nickname: 'Hauptautomat' },
  ]);
  assert.equal(scope.machines.length, 1, 'genau ein physischer Automat');
  assert.equal(scope.machines[0].machine_id, '1', 'interne ID (= guv_daily-Bucket)');
  assert.equal(scope.machines[0].label, '2.OG · Kombi (Hauptautomat)');
  assert.equal(scope.machines[0].location_name, 'DPFA Weiterbildung Chemnitz');
  assert.equal(scope.locations.length, 1);
  assert.deepEqual(scope.locations[0].machine_ids, ['1']);
  assert.equal(scope.locations[0].machineCount, 1);
});

test('buildEconomicsScope: ohne Profil fällt das Label auf die machine_id zurück', () => {
  const scope = buildEconomicsScope([
    { machine_id: '7', machine_key: '999', location_id: '2', location_name: 'Lager Süd' },
  ]);
  assert.equal(scope.machines.length, 1);
  assert.equal(scope.machines[0].label, '7');
});

test('buildEconomicsScope: mehrere Automaten je Standort werden gruppiert', () => {
  const scope = buildEconomicsScope([
    { machine_id: '1', location_id: '1', location_name: 'A', area: 'EG', type: 'Snack' },
    { machine_id: '2', location_id: '1', location_name: 'A', area: '1.OG', type: 'Kombi' },
  ]);
  assert.equal(scope.machines.length, 2);
  const loc = scope.locations.find((l) => l.location_id === '1');
  assert.deepEqual(loc.machine_ids.slice().sort(), ['1', '2']);
  assert.equal(loc.machineCount, 2);
});

/* ---- Steuerberater-Report (Brutto, Summenzeile, DE-Format, BOM) -------- */

const REPORT_ROWS = [
  { product_name: 'Snickers', revenue_gross: 214.00, gross_profit: 90.0, margin_gross_pct: 42.1, qty: 20 },
  { product_name: 'Twix',     revenue_gross: 53.50,  gross_profit: 22.0, margin_gross_pct: 41.1, qty: 5 },
];

test('formatDeNumber: deutsches Komma-Format', () => {
  assert.equal(formatDeNumber(1234.5, 2), '1234,50');
  assert.equal(formatDeNumber(42.1, 1), '42,1');
  assert.equal(formatDeNumber('nope', 2), '');
});

test('buildReportTotals: summiert Brutto + gewichtete Gesamt-Marge', () => {
  const t = buildReportTotals(REPORT_ROWS);
  assert.equal(t.product_name, 'Summe');
  assert.equal(t.revenue_gross, 267.50);
  assert.equal(t.gross_profit, 112.0);
  assert.equal(t.qty, 25);
  assert.equal(t.margin_gross_pct, 41.9); // 112 / 267.5 * 100
});

test('buildReportCsv: BOM + Brutto-Header + Semikolon + Summenzeile', () => {
  const csv = buildReportCsv(REPORT_ROWS);
  assert.equal(csv.charCodeAt(0), 0xFEFF, 'beginnt mit UTF-8-BOM');
  const lines = csv.slice(1).split('\r\n');
  assert.match(lines[0], /Produkt;Umsatz brutto \(EUR\);GuV brutto \(EUR\);Marge %;Stück/);
  assert.match(lines[1], /Snickers;214,00;90,00;42,1;20/);
  assert.equal(lines.length, 4, 'Header + 2 Produkte + Summe');
  assert.match(lines[3], /^Summe;267,50;112,00;41,9;25$/);
});

test('buildReportCsv: leere Daten -> Header + Null-Summe', () => {
  const csv = buildReportCsv([]);
  const lines = csv.slice(1).split('\r\n');
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^Summe;0,00;0,00;0,0;0$/);
});

test('buildReportFilename: Einzelmonat vs. Zeitraum', () => {
  assert.equal(buildReportFilename('2026-05', '2026-05', 'csv'), 'guv-bericht-2026-05.csv');
  assert.equal(buildReportFilename('2026-04', '2026-05', 'csv'), 'guv-bericht-2026-04-bis-2026-05.csv');
});

/* =========================================================================
   AC-UI: statische Struktur-Checks der v3-GuV-Verbesserungen
   (cwd-unabhängig über __dirname aufgelöst)
   ========================================================================= */

const fs   = require('node:fs');
const path = require('node:path');
function v3js()  { return fs.readFileSync(path.join(__dirname, '..', 'public', 'v3.js'),  'utf8'); }
function v3css() { return fs.readFileSync(path.join(__dirname, '..', 'public', 'v3.css'), 'utf8'); }

test('AC-UI: Chart zeichnet Y-Achse + Gridlines', () => {
  const css = v3css();
  assert.match(css, /\.v3-guv-grid/, 'Gridlines müssen gestylt sein');
  assert.match(css, /\.v3-guv-axisy/, 'Y-Achsen-Werte müssen gestylt sein');
  assert.match(v3js(), /v3-guv-grid/, 'Chart-SVG muss Gridlines rendern');
});

test('AC-UI: Tages-Labels (Tagesverlauf) werden formatiert', () => {
  const js = v3js();
  assert.match(js, /function dayLabel/, 'dayLabel muss existieren');
  assert.match(js, /function bucketLabel/, 'bucketLabel muss Tag/Monat erkennen');
});

test('AC-UI: Diagramm-Karussell mit Punkt-Indikatoren', () => {
  const js = v3js(), css = v3css();
  assert.match(js, /data-guv-cardot/, 'Punkt-Indikatoren müssen gerendert werden');
  assert.match(js, /data-guv-charts/, 'Karussell-Container muss markiert sein');
  assert.match(js, /bindCarousel/, 'Karussell muss verdrahtet sein');
  assert.match(css, /\.v3-guv-cardot/, 'Indikatoren müssen gestylt sein');
  assert.match(css, /scroll-snap-type/, 'Handy-Karussell muss Snap-Scroll nutzen');
});

test('AC-UI: Standort-/Automaten-Filter (Mehrfachauswahl) verdrahtet', () => {
  const js = v3js(), css = v3css();
  assert.match(js, /\/api\/v2\/economics\/scope/, 'Filter lädt den Scope-Endpunkt');
  assert.match(js, /guvFilterControl/, 'Filter-Control muss existieren');
  assert.match(js, /data-guv-mid/, 'Automaten-Checkboxen');
  assert.match(js, /data-guv-loc/, 'Standort-Checkboxen (expandieren auf Automaten)');
  assert.match(css, /\.v3-guv-filter/, 'Filter muss gestylt sein');
  assert.match(css, /\.v3-guv-opt/, 'Optionen müssen gestylt sein');
});

test('AC-UI: Automat-Dropdown schließt bei Klick außerhalb / Escape', () => {
  const js = v3js();
  assert.match(js, /box\.open = false/, 'Dropdown muss programmatisch geschlossen werden können');
  assert.match(js, /Escape/, 'Escape muss das Dropdown schließen');
});

test('AC-UI: machines-Filter fließt in Daten- und Export-URL', () => {
  const js = v3js();
  assert.match(js, /machines=/, 'Query muss den machines-Parameter setzen');
  assert.match(js, /guvPeriodParams/, 'gemeinsame Parameter für Daten + Export');
});

test('AC-UI: Zahlen-Kopfzellen sind rechtsbündig (kein Versatz zu den Daten)', () => {
  const css = v3css();
  assert.match(css, /\.v3-guv-table thead th\.v3-guv-table__num\s*\{[^}]*text-align:\s*right/,
    'numerische thead-Zellen müssen rechtsbündig sein (überschreibt die left-Default-Regel)');
});

test('AC-UI: Top-N-Auswahl bietet auch "Alle" (keine Begrenzung)', () => {
  const js = v3js();
  assert.match(js, /value="all"/, 'Limit-Dropdown muss eine "Alle"-Option haben');
  assert.match(js, /q\.limit === 'all'/, 'guvComputeRows muss bei "Alle" alle Zeilen liefern');
});

test('AC-UI: Export-Buttons (CSV/Excel + PDF) vorhanden und verdrahtet', () => {
  const js = v3js(), css = v3css();
  assert.match(js, /data-guv-export/, 'Export-Buttons müssen markiert sein');
  assert.match(js, /\/api\/v2\/reports\/export/, 'CSV nutzt den Export-Endpunkt');
  assert.match(js, /function guvPrintReport/, 'PDF-Druck-Layout muss existieren');
  assert.match(css, /\.v3-guv-export/, 'Export-Buttons müssen gestylt sein');
});
