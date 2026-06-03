'use strict';

// TDD für Issue #57: Tagesverlauf=Fläche+kum. Gewinnlinie, Monats-/Jahres-
// vergleich=Kombi (gestapelte Balken + Marge-Overlay), Tooltip in Overlay-Ebene.
// Strukturelle Guards auf v3.js/v3.css (analog zu dashboard-v3-guv.test.js).

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

function v3js() { return fs.readFileSync(path.join(__dirname, '..', 'public', 'v3.js'), 'utf8'); }
function v3css() { return fs.readFileSync(path.join(__dirname, '..', 'public', 'v3.css'), 'utf8'); }

test('AC-57: neue Renderer existieren', () => {
  const js = v3js();
  assert.match(js, /function renderComboChartSvg/, 'Kombi-Chart-Renderer fehlt');
  assert.match(js, /function renderDayChartSvg/, 'Tagesverlauf-Renderer fehlt');
  assert.match(js, /function guvStackedBars/, 'Stapel-Helfer (Mirror) fehlt');
  assert.match(js, /function roundedTopBar/, 'abgerundete Balkenkante fehlt');
});

test('AC-57: Granularitäts-Weiche ist invertiert (Tag=Fläche, sonst=Kombi-Balken)', () => {
  const js = v3js();
  const panel = js.slice(js.indexOf('function guvChartsPanel'), js.indexOf('function guvChartsPanel') + 1400);
  assert.match(panel, /isDay[\s\S]*renderDayChartSvg/, 'Tagesansicht muss den Flächen-/Tagesverlauf-Renderer nutzen');
  assert.match(panel, /renderComboChartSvg/, 'Nicht-Tagesansicht muss das Kombi-Balkenchart nutzen');
});

test('AC-57: Kombi-Chart zeichnet gestapelte Balken + Marge-Overlay + rechte Achse', () => {
  const js = v3js();
  const fn = js.slice(js.indexOf('function renderComboChartSvg'), js.indexOf('function renderDayChartSvg'));
  assert.match(fn, /v3-guv-bar--cost/, 'Wareneinsatz-Segment (unten) fehlt');
  assert.match(fn, /v3-guv-bar--profit/, 'Gewinn-Segment (oben) fehlt');
  assert.match(fn, /v3-guv-line--margin/, 'Marge-Overlay-Linie fehlt');
  assert.match(fn, /v3-guv-axisy--right/, 'rechte (%) Achse fehlt');
});

test('AC-57: Tagesverlauf zeichnet Fläche + kumulierte Gewinnlinie', () => {
  const js = v3js();
  const fn = js.slice(js.indexOf('function renderDayChartSvg'), js.indexOf('function guvChartsPanel'));
  assert.match(fn, /v3-guv-area/, 'Umsatz-Fläche fehlt');
  assert.match(fn, /v3-guv-line--cum/, 'kumulierte Gewinnlinie fehlt');
  assert.match(fn, /v3-guv-axisy--right/, 'rechte Achse (kum. Gewinn) fehlt');
});

test('AC-57: Tooltip liegt in der Overlay-Ebene (zuletzt gezeichnet, über Balken/Linien)', () => {
  const js = v3js();
  const combo = js.slice(js.indexOf('function renderComboChartSvg'), js.indexOf('function renderDayChartSvg'));
  // Im finalen SVG-String müssen die Tooltips (tips) NACH Balken/Linie/Achse stehen.
  assert.match(combo, /bars \+ mline \+ markers \+ axis \+ tips/, 'Tooltips müssen als letzte Ebene konkateniert werden');
  const day = js.slice(js.indexOf('function renderDayChartSvg'), js.indexOf('function guvChartsPanel'));
  assert.match(day, /cumLine \+ axis \+ tips/, 'Tooltips müssen im Tagesverlauf als letzte Ebene stehen');
});

test('AC-57: v3.css stylt Kombi-Elemente + Legende konsistent', () => {
  const css = v3css();
  assert.match(css, /\.v3-guv-bar--cost/, 'Wareneinsatz-Balkenfarbe fehlt');
  assert.match(css, /\.v3-guv-bar--profit/, 'Gewinn-Balkenfarbe fehlt');
  assert.match(css, /\.v3-guv-line--margin/, 'Marge-Linie ungestylt');
  assert.match(css, /\.v3-guv-line--cum/, 'kumulierte Linie ungestylt');
  assert.match(css, /\.v3-guv-legend/, 'Chart-Legende fehlt');
});
