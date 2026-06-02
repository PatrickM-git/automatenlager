'use strict';

// TDD: Standort löschen (mit Guard) + Automat aussondern (soft-delete).
//
// Hintergrund (verifiziert gegen Prod-DB):
//  - locations wird NUR von machines.location_id (NOT NULL) referenziert ->
//    ein Standort mit Automaten kann nicht gelöscht werden (würde Automaten
//    ohne Standort hinterlassen). Daher: löschen nur bei 0 Automaten.
//  - machines wird von sales_transactions/slot_assignments/guv_daily/warnings/
//    product_change_proposals referenziert (Automat 1: 332 Verkäufe). Hartes
//    Löschen = FK-Bruch + Historienverlust. Daher: AUSSONDERN (active=false).

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildLocationDeleteGuard } = require('../lib/location-profiles.js');
const { buildMachineActiveSql } = require('../lib/machine-create.js');

// ── #1 Standort-Lösch-Guard ───────────────────────────────────────────────────

test('buildLocationDeleteGuard: 0 Automaten -> löschen erlaubt', () => {
  const g = buildLocationDeleteGuard(0);
  assert.equal(g.allowed, true);
});

test('buildLocationDeleteGuard: >0 Automaten -> blockiert mit Hinweis', () => {
  const g = buildLocationDeleteGuard(3);
  assert.equal(g.allowed, false);
  assert.match(g.reason, /3/);
  assert.match(g.reason, /Automat/i);
});

test('buildLocationDeleteGuard: unbekannte Zahl defensiv -> blockiert', () => {
  assert.equal(buildLocationDeleteGuard(undefined).allowed, false);
  assert.equal(buildLocationDeleteGuard(null).allowed, false);
});

// ── #2 Automat aussondern / reaktivieren ──────────────────────────────────────

test('buildMachineActiveSql: aussondern setzt active=false per machine_key', () => {
  const { sql, values } = buildMachineActiveSql('457107528', false);
  assert.match(sql, /UPDATE automatenlager\.machines/i);
  assert.match(sql, /SET active\s*=\s*\$2/i);
  assert.match(sql, /WHERE machine_key\s*=\s*\$1/i);
  assert.deepEqual(values, ['457107528', false]);
});

test('buildMachineActiveSql: reaktivieren setzt active=true', () => {
  const { values } = buildMachineActiveSql('457107528', true);
  assert.deepEqual(values, ['457107528', true]);
});

test('buildMachineActiveSql: leerer machine_key wirft', () => {
  assert.throws(() => buildMachineActiveSql('', false), /machine_key/);
});
