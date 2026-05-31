'use strict';

// Frontend-Wiring fuer Issue #17: "Aus Nayax abgleichen"-Button im v3-/slots.
// Statische Praesenz-Checks (wie dashboard-v3-bulk-refill.test.js); die Logik
// selbst ist in lib/nayax-abgleich.js getestet, die Endpunkte in
// dashboard-v2-nayax-abgleich.test.js. Hier: Knopf da, ruft die richtigen
// Endpunkte, zeigt Umbuchung+Menge+Onboarding, Uebernahme admin-only + Confirm,
// reine Vanilla-JS, Design-konsistent (v3-slots-fill*-Klassen wiederverwendet).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const JS = () => fs.readFileSync(path.join(process.cwd(), 'public', 'v3.js'), 'utf8');

test('v3.js: Knopf "Aus Nayax abgleichen" je Automat', () => {
  const js = JS();
  assert.match(js, /data-slots-nayax-abgleich/, 'Knopf mit data-slots-nayax-abgleich');
  assert.match(js, /Aus Nayax abgleichen/, 'Beschriftung vorhanden');
});

test('v3.js: Vorschau ruft /preview, Uebernahme ruft /apply', () => {
  const js = JS();
  assert.match(js, /\/api\/v2\/nayax-abgleich\/preview/, 'Vorschau-Endpunkt');
  assert.match(js, /\/api\/v2\/nayax-abgleich\/apply/, 'Apply-Endpunkt');
});

test('v3.js: Vorschau zeigt Produktwechsel (Umbuchung), Mengen und Onboarding-Liste', () => {
  const js = JS();
  assert.match(js, /assignment_changes/, 'Produktwechsel/Umbuchung');
  assert.match(js, /qty_changes/, 'Mengenaenderungen');
  assert.match(js, /onboarding/, 'Onboarding-Liste (neue/unmatchbare Produkte)');
});

test('v3.js: Uebernahme sendet expected_guard (Drift-Schutz) + expliziter Confirm', () => {
  const js = JS();
  assert.match(js, /expected_guard/, 'Drift-Schutz: gesehener Guard wird mitgesendet');
  assert.match(js, /data-abgleich-confirm/, 'expliziter Uebernehmen-Confirm-Button');
});

test('v3.js: Funktionen + dedizierte, design-konsistente Panel-Klasse', () => {
  const js = JS();
  assert.match(js, /nayaxAbgleichStart/, 'Start-Funktion (auch fuer Gaeste/Preview)');
  assert.match(js, /data-slots-abgleichpanel/, 'eigenes Panel-Element');
  assert.match(js, /v3-slots-fill/, 'reuse der bestehenden v3-slots-fill*-Klassen (Konsistenz)');
});
