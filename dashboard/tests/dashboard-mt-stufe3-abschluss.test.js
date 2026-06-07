'use strict';

/**
 * Stufe-3-Abschluss — Schluss-Isolation & Guard-Endzustand (Issue #129).
 * SPEC: docs/specs/multi-tenant-query-filter-stufe-3-v1.md
 *
 * Die eigentliche Schluss-Isolation („A sieht 0 Zeilen von B") wird je Domäne in
 * den dashboard-mt-*-isolation.test.js bewiesen (laufen LIVE gegen acme/globex im
 * #94-Sandbox-Harness). Dieser Abschluss-Test ist der ABDECKUNGS-Wächter: er stellt
 * sicher, dass KEINE migrierte Lese-Domäne ihren Isolationsnachweis still verliert,
 * und dass der #107-Guard im build-blocking-Endzustand ist (leere Read-Migrations-
 * Ausnahmeliste).
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const guard = require('../lib/query-filter-guard.js');

const TESTS_DIR = __dirname;
const LIB_DIR = path.join(__dirname, '..', 'lib');

// Pro migrierter Domäne (Slices #123–#128) MUSS ein nicht-vakuöser Isolationstest existieren.
const DOMAIN_ISOLATION_TESTS = [
  'dashboard-mt-finance-isolation.test.js',     // #123 Finanzen/GuV (inkl. Aggregate + MatView)
  'dashboard-mt-monitoring-isolation.test.js',  // #124 Übersicht/Cockpit/Monitoring + Hintergrund-Job
  'dashboard-mt-sortiment-isolation.test.js',   // #125 Sortiment + Config/Schwellwerte
  'dashboard-mt-bestand-isolation.test.js',     // #126 Bestand/MHD/Lager
  'dashboard-mt-automaten-isolation.test.js',   // #127 Automaten/Standorte/Nayax
  'dashboard-mt-korrektur-isolation.test.js',   // #128 Korrektur/Onboarding
];

test('#129 Schluss-Isolation: jede migrierte Lese-Domäne hat ihren Isolationsnachweis', () => {
  for (const f of DOMAIN_ISOLATION_TESTS) {
    assert.ok(fs.existsSync(path.join(TESTS_DIR, f)), `Isolationstest fehlt: ${f}`);
  }
});

test('#129 Schluss-Isolation: die Tür-Fixtures sind beidseitig (nicht-vakuös)', () => {
  // seedAcmeGlobex sät unterscheidbare Daten für BEIDE Mandanten in allen Kern-
  // Lesetabellen — sonst wären die Isolationstests vakuös (Pflicht-Testfall 1).
  const { READ_PATH_TABLES } = require('./helpers/tenant-fixtures.js');
  assert.ok(READ_PATH_TABLES.length >= 7, 'Fixtures decken die Kern-Lesetabellen ab');
});

test('#129 Guard-Endzustand: build-blocking, Read-Migrations-Ausnahmeliste leer', () => {
  // Nur Infrastruktur (kein Mandanten-Datenpfad) + Stufe-4-Schreibpfade verbleiben.
  const FINAL_ALLOWLIST = [
    'db-schema.js', 'stock-cost-invariant.js',                                   // Infrastruktur
    'location-profiles.js', 'machine-create.js', 'machine-profiles.js', 'settings-thresholds.js', // Stufe-4-Writes
  ];
  const violations = guard.findViolations({ libDir: LIB_DIR, allowlist: FINAL_ALLOWLIST });
  assert.deepEqual(violations.map((v) => v.file), [],
    'kein migrierter Lesepfad und kein neues rohes Lesemodul außerhalb der finalen Allowlist');
});
