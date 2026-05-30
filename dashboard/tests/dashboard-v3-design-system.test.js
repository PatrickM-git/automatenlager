const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const PUBLIC = (file) => fs.readFileSync(path.join(process.cwd(), 'public', file), 'utf8');
const ROOT   = (file) => fs.readFileSync(path.join(process.cwd(), '..', file), 'utf8');

// ---------------------------------------------------------------------------
// AC 1: Font-Fix — tabellarische Ziffern + Strich-Null-Fix
// ---------------------------------------------------------------------------

test('v3-B font fix: font-variant-numeric tabular-nums applied on body.v3', () => {
  const css = PUBLIC('v3.css');
  assert.match(css, /font-variant-numeric:\s*tabular-nums/,
    'v3.css must set font-variant-numeric: tabular-nums');
  assert.match(css, /font-feature-settings:.*"tnum".*1.*"zero".*0/,
    'v3.css must set font-feature-settings with tnum and zero');
  assert.match(css, /body\.v3\s*\{[^}]*font-variant-numeric/s,
    'font-variant-numeric must be set on body.v3 so it cascades to all children');
});

test('v3-B font fix: font-feature-settings reinforced on numeric-heavy elements', () => {
  const css = PUBLIC('v3.css');
  assert.match(css, /\.v3-kpi-card__value\s*\{[^}]*font-feature-settings/s,
    '.v3-kpi-card__value must reinforce font-feature-settings');
  assert.match(css, /\.v3-table\s+td\s*\{[^}]*font-feature-settings/s,
    '.v3-table td must reinforce font-feature-settings');
  assert.match(css, /\.v3-table\s+thead\s+th\s*\{[^}]*font-feature-settings/s,
    '.v3-table thead th must reinforce font-feature-settings');
});

// ---------------------------------------------------------------------------
// AC 2: Konsistente CSS-Tokens — KPI-Card
// ---------------------------------------------------------------------------

test('v3-B KPI-Card component class defined in v3.css', () => {
  const css = PUBLIC('v3.css');
  assert.match(css, /\.v3-kpi-card\s*\{/, '.v3-kpi-card class must be defined');
  assert.match(css, /\.v3-kpi-card__label\s*\{/, '.v3-kpi-card__label must be defined');
  assert.match(css, /\.v3-kpi-card__value\s*\{/, '.v3-kpi-card__value must be defined');
  assert.match(css, /\.v3-kpi-card__delta\s*\{/, '.v3-kpi-card__delta must be defined');
});

test('v3-B KPI-Card uses design tokens, not hardcoded colours', () => {
  const css = PUBLIC('v3.css');
  // Prüfe, dass die KPI-Card-Klasse Token-Variablen referenziert
  assert.match(css, /\.v3-kpi-card\s*\{[^}]*var\(--card\)/s,
    '.v3-kpi-card must use --card token for its background');
  assert.match(css, /\.v3-kpi-card\s*\{[^}]*var\(--shadow-card\)/s,
    '.v3-kpi-card must use --shadow-card token');
  assert.match(css, /\.v3-kpi-card::before\s*\{[^}]*var\(--brand\)/s,
    '.v3-kpi-card::before accent bar must use --brand token');
});

test('v3-B KPI-Card grid uses auto-fill for responsive layout', () => {
  const css = PUBLIC('v3.css');
  assert.match(css, /\.v3-kpi-grid\s*\{/, '.v3-kpi-grid container must be defined');
  assert.match(css, /auto-fill/, '.v3-kpi-grid must use auto-fill for responsive columns');
  assert.match(css, /\.v3-kpi-card--warn\s*\{/, 'warn variant must be defined');
  assert.match(css, /\.v3-kpi-card--crit\s*\{/, 'crit variant must be defined');
  assert.match(css, /\.v3-kpi-card--ok::before/, 'ok variant accent bar must be defined');
});

// ---------------------------------------------------------------------------
// AC 2: Konsistente CSS-Tokens — Table
// ---------------------------------------------------------------------------

test('v3-B Table component classes defined in v3.css', () => {
  const css = PUBLIC('v3.css');
  assert.match(css, /\.v3-table-wrap\s*\{/, '.v3-table-wrap scroll container must be defined');
  assert.match(css, /\.v3-table\s*\{/, '.v3-table must be defined');
  assert.match(css, /\.v3-table\s+thead\s+th\s*\{/, 'table header cells must be styled');
  assert.match(css, /\.v3-table\s+td\s*\{/, 'table data cells must be styled');
  assert.match(css, /\.v3-num\s*\{/, '.v3-num numeric column helper must be defined');
});

test('v3-B Table has sticky header and responsive scroll setup', () => {
  const css = PUBLIC('v3.css');
  assert.match(css, /position:\s*sticky/, 'table header must be position: sticky');
  assert.match(css, /overflow-x:\s*auto/, 'table-wrap must have overflow-x: auto for mobile scroll');
  assert.match(css, /background-attachment:\s*local/, 'table-wrap must use local attachment for scroll shadows');
  assert.match(css, /min-width:\s*480px/, 'table must have min-width so it scrolls on mobile');
});

test('v3-B Table uses design tokens for colours', () => {
  const css = PUBLIC('v3.css');
  assert.match(css, /\.v3-table\s+tbody\s+tr:nth-child\(even\)[^}]*var\(--paper\)/s,
    'Table zebra rows must use --paper token');
  assert.match(css, /\.v3-table\s+tbody\s+tr:hover[^}]*var\(--brand-tint\)/s,
    'Table row hover must use --brand-tint token');
  assert.match(css, /\.v3-num--ok\s*\{[^}]*var\(--ok\)/s,
    '.v3-num--ok must use --ok token');
  assert.match(css, /\.v3-num--warn\s*\{[^}]*var\(--warn\)/s,
    '.v3-num--warn must use --warn token');
  assert.match(css, /\.v3-num--crit\s*\{[^}]*var\(--crit\)/s,
    '.v3-num--crit must use --crit token');
});

// ---------------------------------------------------------------------------
// AC 2: Konsistente CSS-Tokens — Chip
// ---------------------------------------------------------------------------

test('v3-B Chip component classes defined in v3.css', () => {
  const css = PUBLIC('v3.css');
  assert.match(css, /\.v3-chip\s*\{/, '.v3-chip base class must be defined');
  assert.match(css, /\.v3-chip--ok\s*\{/, '.v3-chip--ok variant must be defined');
  assert.match(css, /\.v3-chip--warn\s*\{/, '.v3-chip--warn variant must be defined');
  assert.match(css, /\.v3-chip--crit\s*\{/, '.v3-chip--crit variant must be defined');
  assert.match(css, /\.v3-chip--brand\s*\{/, '.v3-chip--brand variant must be defined');
});

test('v3-B Chip active state defined via multiple selectors', () => {
  const css = PUBLIC('v3.css');
  assert.match(css, /\.v3-chip--active/, 'explicit .v3-chip--active class must exist');
  assert.match(css, /\[aria-pressed="true"\]/, 'aria-pressed active state must be defined');
  assert.match(css, /\[aria-selected="true"\]/, 'aria-selected active state must be defined');
});

test('v3-B Chip interactive variant defined for button and anchor', () => {
  const css = PUBLIC('v3.css');
  assert.match(css, /button\.v3-chip/, 'button.v3-chip interactive styles must exist');
  assert.match(css, /a\.v3-chip/, 'a.v3-chip interactive styles must exist');
  assert.match(css, /focus-visible/, 'chip must have focus-visible keyboard style');
});

// ---------------------------------------------------------------------------
// AC 2: Konsistente CSS-Tokens — Filter-Bar
// ---------------------------------------------------------------------------

test('v3-B Filter-Bar component defined in v3.css', () => {
  const css = PUBLIC('v3.css');
  assert.match(css, /\.v3-filter-bar\s*\{/, '.v3-filter-bar must be defined');
  assert.match(css, /scroll-snap-type:\s*x/, 'filter-bar must use scroll-snap-type: x for mobile snap');
  assert.match(css, /mask-image/, 'filter-bar must use mask-image for fade-out edges');
  assert.match(css, /\.v3-filter-bar--sticky\s*\{/, '.v3-filter-bar--sticky variant must be defined');
});

test('v3-B Filter-Bar hides scrollbar and enables touch scroll', () => {
  const css = PUBLIC('v3.css');
  assert.match(css, /\.v3-filter-bar\s*\{[^}]*scrollbar-width:\s*none/s,
    '.v3-filter-bar must hide scrollbar (Firefox)');
  assert.match(css, /\.v3-filter-bar::-webkit-scrollbar\s*\{[^}]*display:\s*none/s,
    '.v3-filter-bar::-webkit-scrollbar must be hidden (Chrome/Safari)');
  assert.match(css, /\.v3-filter-bar\s*\{[^}]*-webkit-overflow-scrolling:\s*touch/s,
    '.v3-filter-bar must use momentum scrolling on iOS');
});

// ---------------------------------------------------------------------------
// AC 3: Mobil sauber bedienbar — präventive Konfigurationsdateien
// ---------------------------------------------------------------------------

test('v3-B .editorconfig exists at repo root with UTF-8 and consistent line endings', () => {
  const content = ROOT('.editorconfig');
  assert.match(content, /charset\s*=\s*utf-8/i, '.editorconfig must set charset = utf-8');
  assert.match(content, /end_of_line\s*=\s*lf/i, '.editorconfig must enforce LF line endings');
  assert.match(content, /trim_trailing_whitespace\s*=\s*true/i, '.editorconfig must trim trailing whitespace');
  assert.match(content, /insert_final_newline\s*=\s*true/i, '.editorconfig must insert final newline');
});

test('v3-B .gitattributes exists at repo root and enforces text normalization', () => {
  const content = ROOT('.gitattributes');
  assert.match(content, /\*.*text=auto/, '.gitattributes must set text=auto for all files');
  assert.match(content, /\*\.css.*eol=lf/i, '.gitattributes must enforce LF for CSS files');
  assert.match(content, /\*\.js.*eol=lf/i, '.gitattributes must enforce LF for JS files');
  assert.match(content, /\*\.html.*eol=lf/i, '.gitattributes must enforce LF for HTML files');
});
