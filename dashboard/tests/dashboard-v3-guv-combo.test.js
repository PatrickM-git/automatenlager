'use strict';

// TDD für Issue #57: EIN einheitlicher Chart-Stil über alle Zeiträume —
// gestapelte Balken (Wareneinsatz + Gewinn) + Marge-Overlay-Linie. Pro Segment
// (Wareneinsatz / Gewinn / Marge) eigener Treffer mit Highlight + Einzelwert,
// per Hover (Desktop) oder Tipp (Touch). Tooltip in Overlay-Ebene (über Balken).

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

function v3js() { return fs.readFileSync(path.join(__dirname, '..', 'public', 'v3.js'), 'utf8'); }
function v3css() { return fs.readFileSync(path.join(__dirname, '..', 'public', 'v3.css'), 'utf8'); }

test('AC-57: Kombi-Renderer + Helfer existieren', () => {
  const js = v3js();
  assert.match(js, /function renderComboChartSvg/, 'Kombi-Chart-Renderer fehlt');
  assert.match(js, /function guvStackedBars/, 'Stapel-Helfer (Mirror) fehlt');
  assert.match(js, /function roundedTopBar/, 'abgerundete Balkenkante fehlt');
});

test('AC-57: einheitlicher Stil – alle Zeiträume nutzen das Kombi-Chart', () => {
  const js = v3js();
  const panel = js.slice(js.indexOf('function guvChartsPanel'), js.indexOf('function guvChartsPanel') + 1400);
  assert.match(panel, /renderComboChartSvg/, 'guvChartsPanel muss das Kombi-Chart rendern');
  assert.doesNotMatch(panel, /renderDayChartSvg/, 'kein separater Tagesverlauf-Renderer mehr (Konsistenz)');
  // Tagesgranularität wird auf alle Tage des Zeitraums aufgefüllt, dann ins Kombi.
  assert.match(panel, /isDay[\s\S]*guvPeriodDays/, 'Tagesansicht füllt die X-Achse über alle Tage');
});

test('AC-57: Kombi-Chart zeichnet gestapelte Balken + Marge-Overlay + rechte Achse', () => {
  const fn = v3js();
  const combo = fn.slice(fn.indexOf('function renderComboChartSvg'), fn.indexOf('function guvChartsPanel'));
  assert.match(combo, /v3-guv-bar--cost/, 'Wareneinsatz-Segment (unten) fehlt');
  assert.match(combo, /v3-guv-bar--profit/, 'Gewinn-Segment (oben) fehlt');
  assert.match(combo, /v3-guv-line--margin/, 'Marge-Overlay-Linie fehlt');
  assert.match(combo, /v3-guv-axisy--right/, 'rechte (%) Achse fehlt');
});

test('AC-57: pro Segment ein eigener Treffer mit Highlight + EINEM Wert', () => {
  const fn = v3js();
  const combo = fn.slice(fn.indexOf('function renderComboChartSvg'), fn.indexOf('function guvChartsPanel'));
  assert.match(combo, /data-guv-seg/, 'Segmente müssen einzeln antippbar sein');
  assert.match(combo, /v3-guv-seg__hit/, 'Treffer­fläche pro Segment fehlt');
  assert.match(combo, /v3-guv-seg__hl/, 'Highlight pro Segment fehlt');
  // Genau ein Wert je Tooltip (nicht alles in einer Zeile):
  assert.match(combo, /Wareneinsatz '/, 'Wareneinsatz-Einzelwert fehlt');
  assert.match(combo, /Gewinn '/, 'Gewinn-Einzelwert fehlt');
  assert.match(combo, /Marge '/, 'Marge-Einzelwert fehlt');
});

test('AC-57: Tap-Toggle (Touch) ist verdrahtet', () => {
  const js = v3js();
  assert.match(js, /function bindChartTips/, 'bindChartTips fehlt');
  assert.match(js, /bindChartTips\(\)/, 'bindChartTips muss nach dem Render gebunden werden');
  assert.match(js, /is-tapped/, 'Tap-Zustand fehlt');
});

test('AC-57: Tooltips liegen in der Overlay-Ebene (zuletzt gezeichnet)', () => {
  const fn = v3js();
  const combo = fn.slice(fn.indexOf('function renderComboChartSvg'), fn.indexOf('function guvChartsPanel'));
  assert.match(combo, /bars \+ mline \+ markers \+ axis \+ tips/, 'Tooltips müssen als letzte Ebene konkateniert werden');
});

test('AC-57: v3.css stylt Kombi + Segment-Interaktion + Legende', () => {
  const css = v3css();
  assert.match(css, /\.v3-guv-bar--cost/, 'Wareneinsatz-Balkenfarbe fehlt');
  assert.match(css, /\.v3-guv-bar--profit/, 'Gewinn-Balkenfarbe fehlt');
  assert.match(css, /\.v3-guv-line--margin/, 'Marge-Linie ungestylt');
  assert.match(css, /\.v3-guv-seg__hl/, 'Segment-Highlight ungestylt');
  assert.match(css, /\.v3-guv-seg\.is-tapped/, 'Tap-Zustand ungestylt');
  assert.match(css, /\.v3-guv-legend/, 'Chart-Legende fehlt');
});
