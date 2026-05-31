'use strict';

/**
 * Drehzahl-/Slow-Mover-Badges + Filter im v3-Frontend.
 * -----------------------------------------------------
 * Das v3-Frontend ist eine Browser-IIFE; wie die übrigen v3-Tests prüfen wir die
 * Verdrahtung quellbasiert (kein DOM). Geprüft wird:
 *   - die Klassen-Badges (v3-badge--turnover-<key>) auf Lager-Karten UND Slot-Zellen
 *     (statt des generischen „Slow-Mover"-Badges),
 *   - der Drehzahl-Klassen-Filter auf Lager- und Slots-Seite (User Story 37),
 *   - der client-seitige Klassen-Join der Lager-Seite aus den Sortiment-Slots,
 *   - die zugehörigen CSS-Klassen inkl. Dimm-Logik des Slot-Filters.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { SLOW_MOVER } = require('../lib/slow-mover.js');

const V3_JS = fs.readFileSync(path.join(process.cwd(), 'public', 'v3.js'), 'utf8');
const V3_CSS = fs.readFileSync(path.join(process.cwd(), 'public', 'v3.css'), 'utf8');

// ── Badges ────────────────────────────────────────────────────────────────────

test('AC-TB1: v3.js besitzt einen turnoverBadge-Helfer mit Klassen-Badge', () => {
  assert.match(V3_JS, /function turnoverBadge\s*\(/, 'turnoverBadge-Helfer muss existieren');
  assert.match(V3_JS, /v3-badge--turnover-/, 'Klassen-Badge muss gerendert werden');
});

test('AC-TB2: das generische „Slow-Mover"-Badge ist durch das Klassen-Badge ersetzt', () => {
  // Die Lager-Karte darf nicht mehr stumpf „Slow-Mover" anzeigen, sondern die Klasse.
  assert.doesNotMatch(V3_JS, />Slow-Mover<\/span>/, 'kein generisches Slow-Mover-Label mehr');
  assert.match(V3_JS, /turnoverBadge\(turnoverKey/, 'Lager-Karte nutzt das Klassen-Badge');
});

test('AC-TB3: jede definierte Klasse hat ein Label im Frontend', () => {
  for (const c of SLOW_MOVER.classes) {
    assert.ok(V3_JS.includes("'" + c.key + "'") || V3_JS.includes('"' + c.key + '"'),
      `Klasse ${c.key} muss im Frontend referenziert sein`);
  }
});

// ── Slot-Zelle ──────────────────────────────────────────────────────────────────

test('AC-TB4: Slot-Zelle trägt die Drehzahl-Klasse als data-Attribut und kompaktes Badge', () => {
  assert.match(V3_JS, /data-slot-turnover="/, 'Slot-Zelle braucht data-slot-turnover (Filter-Ziel)');
  assert.match(V3_JS, /turnoverBadge\(slot\.turnover_class,\s*true\)/, 'Slot-Zelle rendert kompaktes Klassen-Badge');
});

// ── Filter (User Story 37) ──────────────────────────────────────────────────────

test('AC-TB5: Slots-Seite hat einen Drehzahl-Klassen-Filter', () => {
  assert.match(V3_JS, /data-slots-turnover="/, 'Slots-Filter-Chips müssen existieren');
  assert.match(V3_JS, /data-turnover-filter/, 'Filter setzt data-turnover-filter auf den Stage-Wrapper');
});

test('AC-TB6: Lager-Seite hat einen Drehzahl-Klassen-Filter', () => {
  assert.match(V3_JS, /data-lager-turnover="/, 'Lager-Filter-Chips müssen existieren');
  assert.match(V3_JS, /filters\.turnover_class/, 'Lager-Filter wertet turnover_class aus');
});

// ── Lager-Join: Klasse aus den Sortiment-Slots ──────────────────────────────────

test('AC-TB7: Lager-Seite joint die Drehzahl-Klasse aus /api/v2/assortment-slots', () => {
  assert.match(V3_JS, /\/api\/v2\/assortment-slots/, 'Lager lädt zusätzlich die Sortiment-Slots');
  assert.match(V3_JS, /classByKey/, 'Klassen-Lookup nach machine_id+mdb_code');
  assert.match(V3_JS, /turnover_class:\s*tclass/, 'Karte erhält die gejointe Klasse');
});

// ── CSS ─────────────────────────────────────────────────────────────────────────

test('AC-TB8: v3.css definiert alle Klassen-Badges, Filterleiste und Dimm-Logik', () => {
  for (const c of SLOW_MOVER.classes) {
    assert.match(V3_CSS, new RegExp('v3-badge--turnover-' + c.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `CSS-Badge für ${c.key} fehlt`);
  }
  assert.match(V3_CSS, /\.v3-slots-filter\b/, 'Slots-Filterleiste fehlt');
  assert.match(V3_CSS, /\.v3-slot__turnover\b/, 'kompaktes Slot-Badge fehlt');
  assert.match(V3_CSS, /\[data-turnover-filter\]/, 'Dimm-Logik des Slot-Filters fehlt');
});
